/**
 * Where each client keeps the file our entry goes into, on this machine. Responsible for the search
 * alone: what is on disk comes in through a probe, so every layout is testable on any host — a
 * Windows machine's folders included.
 *
 * Claude Code and Codex have one place each, which an environment variable can move. Claude Desktop
 * on Windows has had three, depending on how it was installed and how recent it is, and reads only
 * one of them: an entry written to another is silently ignored.
 */
import { posix, win32 } from 'node:path'
import type { ClientId } from './clientConfig'

export interface PathProbe {
  platform: NodeJS.Platform
  home: string
  env: Record<string, string | undefined>
  /** The names in a directory; empty when it does not exist or cannot be read. */
  list: (dir: string) => string[]
  /** When a file was last written (ms), or null when it does not exist. */
  mtime: (path: string) => number | null
}

const DESKTOP_FILE = 'claude_desktop_config.json'
/** What the desktop app itself writes into the folder it lives in; our own entry is no such sign. */
const DESKTOP_STATE = ['config.json', 'Local State']
/** Left behind in a folder the app has moved its data out of; the suffix names the folder it went to. */
const LEFT_MARKER = /^\.user-data-left\.(.*)$/

/** A directory a variable names, when it names one: a relative or empty value moves nothing. */
function fromEnv(probe: PathProbe, name: string): string | null {
  const value = probe.env[name]?.trim()
  const p = probe.platform === 'win32' ? win32 : posix
  return value && p.isAbsolute(value) ? value : null
}

export function clientConfigPath(id: ClientId, probe: PathProbe): string {
  const p = probe.platform === 'win32' ? win32 : posix
  switch (id) {
    case 'claude-code':
      // CLAUDE_CONFIG_DIR moves `.claude.json` together with the `.claude` directory.
      return p.join(fromEnv(probe, 'CLAUDE_CONFIG_DIR') ?? probe.home, '.claude.json')
    case 'codex':
      // The CLI, the IDE extension and the desktop app share CODEX_HOME.
      return p.join(fromEnv(probe, 'CODEX_HOME') ?? p.join(probe.home, '.codex'), 'config.toml')
    case 'claude-desktop':
      return p.join(claudeDesktopDir(probe), DESKTOP_FILE)
  }
}

function claudeDesktopDir(probe: PathProbe): string {
  if (probe.platform === 'win32') return windowsClaudeDesktopDir(probe)
  if (probe.platform === 'darwin') return posix.join(probe.home, 'Library', 'Application Support', 'Claude')
  return posix.join(fromEnv(probe, 'XDG_CONFIG_HOME') ?? posix.join(probe.home, '.config'), 'Claude')
}

/**
 * The folder Claude Desktop reads on this Windows machine. Its three homes, newest first:
 *
 *   %LOCALAPPDATA%\Claude-Data\claude_<id>\                              recent Store builds
 *   %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\       older Store builds (redirected)
 *   %APPDATA%\Claude\                                                    the classic installer
 *
 * The choice follows what the app left on disk, never the mere existence of a folder (an earlier
 * write of ours may have created one):
 *   1. the folder holding the app's own state, the most recently written when several do;
 *   2. otherwise a folder with anything in it, newest home first;
 *   3. otherwise the folder a marker names, or — on a machine with nothing of the app — the classic
 *      place, where a first installation would look.
 * A folder the app moved its data out of carries a marker file and is out of the choice — unless the
 * app wrote its state there again after the move (a return to an older installer).
 */
function windowsClaudeDesktopDir(probe: PathProbe): string {
  const { home, list, mtime } = probe
  const local = fromEnv(probe, 'LOCALAPPDATA') ?? win32.join(home, 'AppData', 'Local')
  const roaming = fromEnv(probe, 'APPDATA') ?? win32.join(home, 'AppData', 'Roaming')

  const dataRoot = win32.join(local, 'Claude-Data')
  const moved = list(dataRoot)
    .filter((n) => /^claude_/i.test(n))
    .sort()
    .map((n) => win32.join(dataRoot, n))
  const packagesRoot = win32.join(local, 'Packages')
  const packaged = list(packagesRoot)
    .filter((n) => /(^|\.)Claude_[a-z0-9]+$/i.test(n))
    .sort()
    .map((n) => win32.join(packagesRoot, n, 'LocalCache', 'Roaming', 'Claude'))
  const classic = win32.join(roaming, 'Claude')
  const homes = [...moved, ...packaged, classic]

  const names = new Map(homes.map((dir) => [dir, list(dir)]))
  const newest = (dir: string, files: string[]): number | null => {
    const times = files.map((f) => mtime(win32.join(dir, f)) ?? 0)
    return times.length ? Math.max(...times) : null
  }
  /** When the app last wrote its own state there, or null when it never did. */
  const lastUsed = (dir: string): number | null =>
    newest(
      dir,
      DESKTOP_STATE.filter((f) => (names.get(dir) ?? []).includes(f))
    )
  const left = (dir: string): boolean => {
    const departed = newest(
      dir,
      (names.get(dir) ?? []).filter((n) => LEFT_MARKER.test(n))
    )
    return departed !== null && (lastUsed(dir) ?? 0) <= departed
  }

  const stayed = homes.filter((dir) => !left(dir))
  // 1. Where the app keeps its state. The sort is stable: on a tie the newer home stays first.
  const inUse = stayed.filter((dir) => lastUsed(dir) !== null)
  if (inUse.length) return [...inUse].sort((a, b) => (lastUsed(b) ?? 0) - (lastUsed(a) ?? 0))[0]
  // 2. A folder with anything in it.
  const present = stayed.find((dir) => (names.get(dir) ?? []).length > 0)
  if (present) return present
  // 3. Every folder found was moved out of: the markers say where to, even when nothing is there yet.
  const named = homes
    .flatMap((dir) => (names.get(dir) ?? []).flatMap((n) => LEFT_MARKER.exec(n)?.[1] ?? []))
    .find((n) => /^claude_[a-z0-9]+$/i.test(n))
  return named ? win32.join(dataRoot, named) : classic
}
