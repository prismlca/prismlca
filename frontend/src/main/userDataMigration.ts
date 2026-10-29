import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

/**
 * The product was renamed from "Prism LCA" to "PrismLCA" on 30.09.2026, and Electron derives the
 * userData folder from `productName`: a packaged build now reads `…/PrismLCA` where every earlier
 * install wrote `…/Prism LCA` (settings.json, secrets.json, models.json, the usage ledgers). Without
 * this, an update would come up with no key, default settings and an empty model catalogue — and
 * the old folder would sit next to it, full.
 *
 * So, once: when the new folder holds none of our files yet and the old one exists, copy the old
 * folder's top-level FILES over. Files only — Chromium's own subfolders (Cache, GPUCache, …) belong
 * to the profile that created them, and nothing of ours lives in a subfolder. The old folder stays
 * as it is: a downgrade still finds it, and there is no point deleting what a user may want to look
 * at. Dev runs are unaffected (they use `name: prism-lca`, which did not change).
 *
 * Returns the names of the files copied — empty when nothing was done.
 */
export function adoptLegacyUserData(current: string, legacy: string): string[] {
  if (!legacy || legacy === current || !existsSync(legacy)) return []
  let entries: string[]
  try {
    entries = readdirSync(legacy)
  } catch {
    return []
  }
  const files = entries.filter((n) => {
    try {
      return statSync(join(legacy, n)).isFile()
    } catch {
      return false
    }
  })
  if (files.length === 0) return []
  // "None of ours yet": no file the old folder holds exists in the new one. Chromium may already
  // have created the new folder with its own files by the time this runs; those do not count.
  if (files.some((n) => existsSync(join(current, n)))) return []
  const copied: string[] = []
  try {
    mkdirSync(current, { recursive: true })
    for (const n of files) {
      copyFileSync(join(legacy, n), join(current, n))
      copied.push(n)
    }
  } catch {
    // A half copy is reported as such (the caller logs the names). The next start will not retry the
    // rest — one copied file already makes the new folder "ours" — which is deliberate: silently
    // re-copying on every start could overwrite a settings.json the user has changed since.
  }
  return copied
}
