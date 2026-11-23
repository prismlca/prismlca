/**
 * `launch --copy`: a session on a copy of the person's own PrismLCA — their data folder (Brightway
 * projects, models, chats, search index) and their profile (settings, model list, window state) — so a
 * check or a practice run sees real background data without being able to change it.
 *
 * The copy shares blocks with the originals where the filesystem can (btrfs, XFS, APFS): seconds and
 * almost no space for gigabytes. Where it cannot, launch says so and copies in full only when asked to.
 *
 * **Copying while the person's app runs.** The person's PrismLCA may be open and writing — SQLite
 * databases, JSON files replaced by renaming. A file copied in the middle of a write would be torn. The
 * rule: every file to be copied is listed (size, times, inode) before the copy and again after it, and
 * the copy counts only if both lists are the same. Then no file changed while it was copied, and the copy
 * is what the folders held at one moment — what a power cut at that moment would leave, which SQLite (its
 * journal is copied with it and rolled back on the first open) and the app's replace-by-rename writes are
 * built to survive. If something changed, the copy is thrown away and taken again; after a few tries
 * launch gives up and says which files kept changing.
 *
 * What is not copied: Chromium's caches (rebuilt on demand), markers of the person's running app (its
 * single-instance lock and socket would hand this instance's start over to it; its MCP endpoint names its
 * port and token), a staged update, web cookies and Chromium's per-run browser state, and the stored
 * provider keys (keys.ts copies those, only when asked). Links are not followed: one would lead back into
 * the person's folders.
 */
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statfsSync,
  statSync,
  utimesSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix, relative, win32 } from 'node:path'
import { realDirs } from './doctor'
import { KEY_FILES } from './keys'

/** Where the person's app keeps its data and which profile folders it may use (packaged first). */
export function personFolders(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = homedir()
): { data: string; profiles: string[] } {
  const [devProfile, packagedProfile, data] = realDirs(env, platform, home)
  return { data, profiles: [packagedProfile, devProfile] }
}

/**
 * The profile the person's app uses. An installed app keeps it in a folder named after the product, an
 * app started from a checkout in one named after the package; when both exist, the one used last wins.
 */
export function chooseProfile(candidates: string[]): string | null {
  const used = (dir: string): number => {
    for (const f of ['settings.json', 'Local State', 'Preferences']) {
      try {
        return statSync(join(dir, f)).mtimeMs
      } catch {
        /* the next one */
      }
    }
    return existsSync(dir) ? 0 : -1
  }
  const ranked = candidates.map((dir) => ({ dir, at: used(dir) })).filter((c) => c.at >= 0)
  ranked.sort((a, b) => b.at - a.at)
  return ranked[0]?.dir ?? null
}

/** The folder copies are made in: the user's cache folder, which sits on the same disk as their data. */
export function copiesDir(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = homedir()
): string {
  if (platform === 'win32') {
    return win32.join(env.LOCALAPPDATA ?? win32.join(home, 'AppData', 'Local'), 'prismlca', 'control-prism')
  }
  if (platform === 'darwin') return posix.join(home, 'Library', 'Caches', 'prismlca', 'control-prism')
  return posix.join(env.XDG_CACHE_HOME || posix.join(home, '.cache'), 'prismlca', 'control-prism')
}

/** Top-level names in the profile that are never copied (see the module comment). */
const PROFILE_SKIP = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUPersistentCache',
  'Shared Dictionary',
  'Service Worker',
  'blob_storage',
  'Crashpad',
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  'lockfile',
  'DevToolsActivePort',
  'mcp-endpoint.json',
  'pending-update.json',
  '.updaterId',
  'Cookies',
  'Cookies-journal',
  'Network',
  'Trust Tokens',
  'Trust Tokens-journal',
  // Browser state of one run: sessionStorage is never restored after a restart, and the network and
  // navigation records are Chromium's own. They change while the person's app is open.
  'Session Storage',
  'DIPS',
  'DIPS-journal',
  'Network Persistent State',
  'TransportSecurity',
  'SharedStorage',
  'SharedStorage-wal',
  'declarative_performance_observer.db',
  'declarative_performance_observer.db-journal',
  // The plain-text key file of old versions: never copied, also not with the keys.
  'openrouter-key'
])

/** Whether `rel` (a path inside the profile, `/`-separated) stays out of the copy. The key store always
 *  does: keys.ts copies it, and only when asked. */
export function skipInProfile(rel: string): boolean {
  const top = rel.split('/')[0]
  if (PROFILE_SKIP.has(top) || KEY_FILES.includes(top)) return true
  return /^mcp-launch.*\.log$/.test(top) || top.endsWith('.tmp')
}

/** Whether `rel` (a path inside the data folder) stays out: only the backend's instance lock, which names
 *  the person's running backend. */
export function skipInData(rel: string): boolean {
  return rel === '.prism-instance.lock'
}

export interface Entry {
  rel: string
  dir: boolean
  size: bigint
  /** size, modification and change time, inode: what a write or a replace changes. */
  stamp: string
}

export class CopyError extends Error {}

/** Every entry under `root` that is copied, in walking order (a folder before its contents). */
export function listTree(root: string, skip: (rel: string) => boolean): Entry[] {
  const entries: Entry[] = []
  const visit = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir).sort()
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && dir !== root) return
      throw e
    }
    for (const name of names) {
      const full = join(dir, name)
      const rel = relative(root, full).split(/[\\/]/).join('/')
      if (skip(rel)) continue
      let s
      try {
        s = lstatSync(full, { bigint: true })
      } catch (e) {
        // Gone between the folder's listing and this look (a journal SQLite just removed): not there.
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw e
      }
      if (s.isSymbolicLink()) {
        throw new CopyError(
          `${full} is a link; a copy of it would lead back into your own folders, so nothing is copied`
        )
      }
      if (!s.isDirectory() && !s.isFile()) continue // sockets, pipes: nothing to copy
      const stamp = s.isDirectory() ? 'dir' : `${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.ino}`
      entries.push({ rel, dir: s.isDirectory(), size: s.isDirectory() ? 0n : s.size, stamp })
      if (s.isDirectory()) visit(full)
    }
  }
  visit(root)
  return entries
}

/** The entries whose state differs between two listings (changed, added or gone). */
export function changedBetween(before: Entry[], after: Entry[]): string[] {
  const a = new Map(after.map((e) => [e.rel, e.stamp]))
  const b = new Map(before.map((e) => [e.rel, e.stamp]))
  const changed = before.filter((e) => a.get(e.rel) !== e.stamp).map((e) => e.rel)
  for (const e of after) if (!b.has(e.rel)) changed.push(e.rel)
  return changed
}

const CLONE_UNSUPPORTED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'ENOSYS', 'ENOTTY'])

export class CloneUnsupported extends CopyError {}

/** A listed file was gone when its turn came: the folder changed during the copy. */
export class SourceChanged extends CopyError {
  constructor(readonly rel: string) {
    super(`${rel} went away while it was copied`)
  }
}

/** Copies the listed entries from `src` to `dst`, sharing blocks — or in full when `full`. Keeps
 *  modification times: the app compares some of them. */
export function copyEntries(src: string, dst: string, entries: Entry[], full: boolean): void {
  mkdirSync(dst, { recursive: true })
  const mode = full ? constants.COPYFILE_FICLONE : constants.COPYFILE_FICLONE_FORCE
  for (const e of entries) {
    const from = join(src, e.rel)
    const to = join(dst, e.rel)
    if (e.dir) {
      mkdirSync(to, { recursive: true })
      continue
    }
    try {
      copyFileSync(from, to, mode)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      // Listed a moment ago and gone now: the folder changed during the copy.
      if (code === 'ENOENT' && !existsSync(from)) throw new SourceChanged(e.rel)
      if (!full && CLONE_UNSUPPORTED.has(code)) {
        throw new CloneUnsupported(
          `${dst} cannot share blocks with ${src} (${code}: the filesystem cannot clone, or they are on ` +
            'different disks)'
        )
      }
      throw err
    }
    let s
    try {
      s = statSync(from)
    } catch {
      throw new SourceChanged(e.rel)
    }
    utimesSync(to, s.atime, s.mtime)
  }
}

export interface CopyPlan {
  data: string
  profile: string
  /** Where the session's install lives; the copy fills its `data` and `user-data`. */
  install: { data: string; userData: string }
  full: boolean
}

export interface CopyReport {
  from: { data: string; profile: string }
  at: string
  files: number
  bytes: number
  /** Tries it took until nothing changed during the copy. */
  attempts: number
  shared: boolean
}

export interface CopyPacing {
  tries?: number
  pauseMs?: number
  /** Runs after each part's files are copied and before they are listed again (tests write there). */
  during?: (part: 'data' | 'profile') => void
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const size = (bytes: number): string =>
  bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB` : `${Math.ceil(bytes / 2 ** 20)} MB`

/** Takes the copy, again until nothing changed while it ran (see the module comment). */
export async function takeCopy(
  plan: CopyPlan,
  log: (line: string) => void,
  { tries = 4, pauseMs = 3000, during = () => {} }: CopyPacing = {}
): Promise<CopyReport> {
  if (!existsSync(plan.data))
    throw new CopyError(`there is no PrismLCA data to copy: ${plan.data} does not exist`)
  const parts = [
    { name: 'data' as const, src: plan.data, dst: plan.install.data, skip: skipInData },
    {
      name: 'profile' as const,
      src: plan.profile,
      dst: plan.install.userData,
      skip: skipInProfile
    }
  ]
  for (let attempt = 1; ; attempt++) {
    const at = new Date().toISOString()
    const before = parts.map((p) => listTree(p.src, p.skip))
    const files = before.flat().filter((e) => !e.dir)
    const bytes = Number(files.reduce((n, e) => n + e.size, 0n))
    if (plan.full) {
      const free = statfsSync(dirname(parts[0].dst))
      const available = Number(free.bavail) * Number(free.bsize)
      if (bytes > available)
        throw new CopyError(`a full copy needs ${size(bytes)}, and ${size(available)} are free there`)
    }
    let vanished: string | null = null
    for (const [i, p] of parts.entries()) {
      rmSync(p.dst, { recursive: true, force: true })
      try {
        copyEntries(p.src, p.dst, before[i], plan.full)
      } catch (e) {
        if (!(e instanceof SourceChanged)) throw e
        vanished = join(p.src, e.rel)
        break
      }
      during(p.name)
    }
    const changed = vanished
      ? [vanished]
      : parts.flatMap((p, i) =>
          changedBetween(before[i], listTree(p.src, p.skip)).map((rel) => join(p.src, rel))
        )
    if (changed.length === 0) {
      return {
        from: { data: plan.data, profile: plan.profile },
        at,
        files: files.length,
        bytes,
        attempts: attempt,
        shared: !plan.full
      }
    }
    for (const p of parts) rmSync(p.dst, { recursive: true, force: true })
    const named = `${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ` and ${changed.length - 5} more` : ''}`
    if (attempt >= tries) {
      throw new CopyError(
        `your PrismLCA kept writing while it was copied (${tries} tries; changed: ${named}). Let it finish ` +
          'what it is doing — a calculation, an import, a chat — or close it, then launch again.'
      )
    }
    log(`your PrismLCA wrote while it was copied (${named}); copying again in ${pauseMs / 1000} s`)
    await sleep(pauseMs)
  }
}
