/**
 * Spell checking, offline by design.
 *
 * Chromium ships a Hunspell spell checker and, left alone, downloads its dictionaries from a Google
 * CDN on first use — the user's IP and chosen language go to Google without anyone having asked.
 * PrismLCA instead bundles the dictionaries for the five report languages (en, de, fr, es, pt — the
 * only languages a report can be written in, so the only ones a text field needs) and points the
 * "downloader" at that local folder. No network request is ever made for spell checking.
 *
 * The dictionaries are the ones Chromium itself uses (`.bdic`, from the chromium
 * hunspell_dictionaries repository via the Chrome CDN), stored under `resources/dictionaries/` with
 * the exact file names Chromium asks for. Their licences are listed in `LICENSES.md` beside them —
 * all free to redistribute; the GPL ones travel as separate data files, which is aggregation, not
 * linking.
 *
 * Which languages are checked is a user setting (`spellcheckLanguages`, Settings → Display),
 * write-through like everything else; an empty list switches the checker off. macOS would use the
 * system spell checker and ignore all of this — guarded anyway, though no macOS build exists.
 */
import { app, Menu, session, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ALL_SPELLCHECK_DICTS } from '../shared/spellcheck'
import { getSettings } from './settings'

function dictionaryDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'dictionaries')
    : join(app.getAppPath(), 'resources', 'dictionaries')
}

/** Point the session at the bundled dictionaries and apply the stored language choice.
 *  Call once after `whenReady`, before any window loads. */
/** Set once the bundled dictionaries were found missing: from then on every settings write that
 *  reaches applySpellcheckLanguages keeps the checker OFF — the seed after the first window load
 *  used to switch it back on, and with it Chromium's default download source. */
let dictionariesMissing = false

export function initSpellcheck(): void {
  if (process.platform === 'darwin') return // the system spell checker owns this on macOS
  const ses = session.defaultSession
  const dir = dictionaryDir()
  if (existsSync(dir)) {
    // Trailing slash required: Chromium appends the dictionary file name to this base URL.
    const base = pathToFileURL(dir).toString()
    ses.setSpellCheckerDictionaryDownloadURL(base.endsWith('/') ? base : `${base}/`)
  } else {
    // Never fall back to Google's CDN silently — better no squiggles than an unasked request.
    console.error('[spellcheck] bundled dictionaries missing at', dir, '— spell checking disabled')
    dictionariesMissing = true
    ses.setSpellCheckerEnabled(false)
    return
  }
  applySpellcheckLanguages()
}

/** Apply the setting to the live session — called at startup and on every settings write. */
export function applySpellcheckLanguages(languages?: string[]): void {
  if (process.platform === 'darwin') return
  // The settings mirror runs once at module load, before whenReady — no session exists yet, and
  // initSpellcheck() applies the stored choice as soon as it does.
  if (!app.isReady()) return
  const ses = session.defaultSession
  if (dictionariesMissing) {
    ses.setSpellCheckerEnabled(false)
    return
  }
  const wanted = (languages ?? getSettings().spellcheckLanguages).filter((l) =>
    ALL_SPELLCHECK_DICTS.includes(l)
  )
  ses.setSpellCheckerEnabled(wanted.length > 0)
  if (wanted.length) ses.setSpellCheckerLanguages(wanted)
}

/**
 * The context menu that makes the red squiggle useful: suggestions, "Add to dictionary", and the
 * ordinary edit verbs. Electron shows no context menu at all unless one is built here.
 */
export function attachSpellcheckMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const template: Electron.MenuItemConstructorOptions[] = []

    for (const s of params.dictionarySuggestions.slice(0, 5)) {
      template.push({ label: s, click: () => win.webContents.replaceMisspelling(s) })
    }
    if (params.misspelledWord) {
      if (template.length) template.push({ type: 'separator' })
      template.push({
        label: 'Add to dictionary',
        click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      })
    }

    if (params.isEditable) {
      if (template.length) template.push({ type: 'separator' })
      template.push(
        { role: 'cut', enabled: params.selectionText.length > 0 },
        { role: 'copy', enabled: params.selectionText.length > 0 },
        { role: 'paste' }
      )
    } else if (params.selectionText.trim()) {
      if (template.length) template.push({ type: 'separator' })
      template.push({ role: 'copy' })
    }

    // Nothing to offer (a click on empty page furniture) → no menu, like before.
    if (template.length) Menu.buildFromTemplate(template).popup({ window: win })
  })
}
