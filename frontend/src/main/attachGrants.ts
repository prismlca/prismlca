/**
 * Which files the renderer may hand to `ai:attach`.
 *
 * `ai:attach` reads a path with the main process's rights and stores the bytes in the project, where
 * the renderer can fetch them back through the backend bridge. Without a binding, a renderer that
 * names `~/.ssh/id_ed25519` gets it. So main only reads a path the user handed over in THIS session:
 *
 * - **Dialog**: `prism:pickFiles` (the chat's paperclip) grants what the OS dialog returned. That path
 *   never came from the renderer, so the binding holds even against a hostile page.
 * - **Drop**: the preload resolves a dropped `File` with `webUtils.getPathForFile` and grants it
 *   through `prism:grantDropped`. The page itself can only pass `File` objects to the preload, and a
 *   `File` the page builds is not backed by a disk path — so a script in the page cannot grant an
 *   arbitrary path either. It does NOT hold against code running in the preload or a compromised
 *   renderer process, which can send any IPC message it likes; that is the accepted residue
 *   (docs/ARCHITEKTUR.md, §3 "Security boundary: renderer ↔ main process").
 *
 * Each grant is good for one read: attaching the same file again means picking or dropping it again,
 * which is what the user does anyway.
 *
 * Each grant is stored under two keys, the path as picked (`resolve`d) and the file's REAL path
 * (`realpath`, symlinks resolved at grant time). `take` first looks the path up as given — a path
 * without a grant is refused there, before anything touches the disk (an ungranted UNC path must
 * not trigger a network lookup). Only then does it resolve the path again, compare with the real
 * path stored at grant time, and hand back that real path, which is what main reads. Comparing a
 * merely normalised path and reading the original would let a symlink bent between pick and read
 * point the read at another file. A path that no longer resolves is refused.
 *
 * Both ends are async (`fs.promises.realpath`): a slow network share must not stall the main
 * process. Not handled: `realpath` does not fold case, so on a case-insensitive file system the
 * same file picked as `A.pdf` and attached as `a.pdf` is refused (safe, not friendly); Windows and
 * UNC paths are untested.
 */
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

const real = async (p: string): Promise<string | null> => {
  try {
    return await realpath(p)
  } catch {
    return null
  }
}

/** A session's worth of pickings, generously. Past this the oldest grant goes first. */
const MAX_GRANTS = 500

interface Grant {
  real: string
  n: number
  keys: string[]
}

export class PathGrants {
  private readonly byKey = new Map<string, Grant>()

  /** Allow each path to be read once more. Non-strings, empty strings and paths that do not
   *  resolve to an existing file are ignored. Resolves once every grant is in place. */
  async grant(paths: readonly unknown[]): Promise<void> {
    for (const p of paths) {
      if (typeof p !== 'string' || !p) continue
      const asGiven = resolve(p)
      const r = await real(p)
      if (!r) continue
      // By either name: a symlink picked beside its target is the same file, and a separate grant
      // under the shared real path would overwrite the target's — taking one then refused the other.
      const known = this.byKey.get(asGiven) ?? this.byKey.get(r)
      const g: Grant = known && known.real === r ? known : { real: r, n: 0, keys: [] }
      for (const k of [asGiven, r]) if (!g.keys.includes(k)) g.keys.push(k)
      g.n += 1
      // Re-insert so the map's order stays oldest-first for the cap below.
      for (const k of g.keys) {
        this.byKey.delete(k)
        this.byKey.set(k, g)
      }
    }
    while (this.byKey.size > MAX_GRANTS) {
      const oldest = this.byKey.values().next().value as Grant
      this.drop(oldest)
    }
  }

  /** Use up one grant for `path` and return the real path to read — null if it has no grant left,
   *  no longer resolves, or now resolves to another file than the one granted. Read the returned
   *  path, never `path` itself. */
  async take(path: string): Promise<string | null> {
    const g = this.byKey.get(resolve(path))
    if (!g || g.n <= 0) return null
    // The grant is spent either way: a bent link is not retried.
    g.n -= 1
    if (g.n <= 0) this.drop(g)
    const r = await real(path)
    return r && r === g.real ? r : null
  }

  clear(): void {
    this.byKey.clear()
  }

  private drop(g: Grant): void {
    for (const k of g.keys) if (this.byKey.get(k) === g) this.byKey.delete(k)
  }
}

/** The one registry of this process: filled by the chat's file dialog and the drop channel,
 *  drained by `ai:attach`. */
export const attachGrants = new PathGrants()
