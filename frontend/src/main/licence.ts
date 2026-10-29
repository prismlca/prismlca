import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { shell } from 'electron'
// `asarUnpack`: the OS opens these files with its own viewer, and no viewer can read inside app.asar.
// electron-builder.yml unpacks them; the query makes the path point at app.asar.unpacked. Without
// the unpack step neither file would be in any package (`files: out/**` only); PRISM_SMOKE now fails when
// they are missing (bundledLegalFilesMissing).
import licencePath from '../../resources/LICENSE.txt?asset&asarUnpack'
import noticesPath from '../../resources/THIRD-PARTY-NOTICES.md?asset&asarUnpack'

/**
 * PrismLCA is licensed under the GNU Affero General Public License v3.0 with an additional permission under
 * section 7 (at the end of the file, after the unchanged AGPL text). The
 * text ships with the app (`resources/LICENSE.txt`, a copy of the repo's `LICENSE`), and the splash
 * screen and the start page's footer link to it — a local file, opened by the OS, never a web page:
 * the licence must be readable with no network and no domain.
 */
export { LICENCE_LABEL, NOTICES_LABEL } from '../shared/licence'

/** The legal files the AGPL and the notices require in every copy — the ones that are not where the
 *  app will look for them. Empty when all is well. */
export function bundledLegalFilesMissing(): string[] {
  return [licencePath, noticesPath].filter((p) => !existsSync(p))
}

/** Open the bundled licence text with the OS's default handler. Resolves with an `error` a caller
 *  can show when the OS refuses (no handler for .txt, for example). */
export async function openLicence(): Promise<{ error?: string }> {
  const failure = await shell.openPath(licencePath)
  return failure ? { error: `Could not open the licence file: ${failure}` } : {}
}

/** Open the bundled third-party notices (`resources/THIRD-PARTY-NOTICES.md`) the same way, with the
 *  same `error` shape. */
export async function openNotices(): Promise<{ error?: string }> {
  const failure = await shell.openPath(noticesPath)
  return failure ? { error: `Could not open the third-party notices: ${failure}` } : {}
}

/**
 * The "## Summary" section of the notices — the two tables (Python and npm packages with their
 * licences) that a reader actually wants to see. The whole file is 2 MB of licence texts, far too
 * much to render in a sheet and nothing anyone reads at a stretch; the sheet shows this and offers
 * the file for the rest. Ends at the next second-level heading.
 */
export function summarySection(md: string): string {
  const start = md.indexOf('\n## Summary')
  if (start < 0) return ''
  const rest = md.slice(start + 1)
  const next = rest.indexOf('\n## ', 1)
  return (next < 0 ? rest : rest.slice(0, next)).trim()
}

/** The summary above, read from the bundled file; `error` when the file is unreadable. */
export async function noticesSummary(): Promise<{ text: string; error?: string }> {
  try {
    return { text: summarySection(await readFile(noticesPath, 'utf8')) }
  } catch (e) {
    return { text: '', error: `Could not read the third-party notices: ${(e as Error).message}` }
  }
}
