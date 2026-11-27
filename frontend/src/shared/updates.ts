/**
 * The manual update check's state, as main holds it and the About page shows it (main/updater.ts).
 * One definition for main, the preload bridge and the renderer.
 */
export type UpdateState =
  | { phase: 'idle'; current: string }
  /** A dev build or an unpacked run: there is no installed app to update. */
  | { phase: 'unavailable'; current: string; reason: string }
  | { phase: 'checking'; current: string }
  | { phase: 'up-to-date'; current: string; checkedAt: number }
  /** `manualOnly`: this kind of installation (a deb or rpm package) is updated from the release page, not
   *  from inside the app — installing it would need root. */
  | { phase: 'available'; current: string; version: string; notes?: ReleaseNotes; manualOnly?: boolean }
  | { phase: 'downloading'; current: string; version: string; percent: number }
  /** `note`: why the last "Restart and install" did not go ahead (work still running). */
  | { phase: 'downloaded'; current: string; version: string; note?: string }
  /** The backend is being stopped and the installer started; the app quits next. */
  | { phase: 'installing'; current: string; version: string }
  /** The last start wrote down an update to `version`, but this is still the old version. */
  | { phase: 'incomplete'; current: string; version: string }
  /** `restart`: the backend is already stopped, so the app has to restart before it works again.
   *  `version`: the version a failed download was for, so the page can offer its release page instead. */
  | { phase: 'error'; current: string; message: string; restart?: boolean; version?: string }

/**
 * A newer version's release notes as data, not HTML: main reads them from the release feed
 * (main/releaseNotes.ts) and the About page builds its own elements from them. `cut`: the notes were longer
 * than the page shows; the rest is on the release page.
 */
export type ReleaseNotes = { blocks: NoteBlock[]; cut?: true }

/** One block of the notes. A list item is a sequence of blocks: its text, and any list nested in it.
 *  A code block keeps its lines and indentation. */
export type NoteBlock =
  | { kind: 'heading'; spans: NoteSpan[] }
  | { kind: 'paragraph'; spans: NoteSpan[] }
  | { kind: 'code'; text: string }
  | { kind: 'list'; ordered: boolean; items: NoteBlock[][] }

/** A run of text with one formatting. `href` is always an https address; it opens in the browser. */
export type NoteSpan = { text: string; strong?: true; em?: true; code?: true; href?: string }

/** The answer main's install step needs before it may replace the program files (index.ts). */
export type PrepareInstallResult =
  | { ok: true }
  /** `stopped`: the backend was stopped (or killed) along the way — the app cannot go on as it is. */
  | { ok: false; stopped: boolean; message: string }
