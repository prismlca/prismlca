/**
 * Provider API keys, encrypted at rest — the main process is the only place a key exists in the clear.
 *
 * `safeStorage` is Electron's own wrapper around the OS credential store: **Keychain** on macOS,
 * **DPAPI** on Windows, and on Linux the desktop keyring (gnome-libsecret or kwallet) *if one is
 * running*. It is the only option that needs no native dependency — which matters here, because the
 * app is packaged with electron-builder next to a PyInstaller backend and ships unsigned; `keytar` is
 * unmaintained and a libsecret binding would have to be built per platform.
 *
 * The Linux caveat is real and is NOT hidden from the user: with no keyring, Chromium falls back to a
 * `basic_text` backend that "encrypts" with a hard-coded password, which is obfuscation and not
 * protection. `describe()` reports the selected backend so Settings can say where the key actually
 * lives instead of claiming it is safe. What we never do is write a key in plain text ourselves: if
 * encryption is unavailable altogether, storing is REFUSED and the user is pointed at the
 * environment variable, which at least does not outlive the session on disk.
 *
 * On disk: one `secrets.json` in `userData`, values base64 of the ciphertext. A key is only ever
 * returned to the main process — never over IPC, never into a log, never into an error message.
 */
import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The providers a key can be stored for. The file format was a map from the start, so OpenAI's
 *  arrival was exactly what the original note promised: a new key, not a migration. Both keys may
 *  be stored at once — switching the active provider in Settings must never forget the other one. */
export type Provider = 'openrouter' | 'openai' | 'ors' | 'mapbox'

/** The two AI providers; the other two slots hold the transport-distance keys (openrouteservice
 *  and Mapbox), which never reach the chat client or the backend — see main/distance. */
export type AiProvider = 'openrouter' | 'openai'

/** The environment variable that can pin each provider's key for one run. */
const ENV_VAR: Record<Provider, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  ors: 'ORS_API_KEY',
  mapbox: 'MAPBOX_API_KEY'
}

type Stored = { v: 1; keys: Partial<Record<Provider, string>> }

const FILE = (): string => join(app.getPath('userData'), 'secrets.json')

/** The pre-settings location: a plain-text file users were told to create by hand. Read once and
 *  migrated into the encrypted store, then removed — leaving it would defeat the encryption. */
const LEGACY = (): string => join(app.getPath('userData'), 'openrouter-key')

function read(): Stored {
  try {
    const raw = JSON.parse(readFileSync(FILE(), 'utf-8')) as Stored
    if (raw && raw.v === 1 && raw.keys && typeof raw.keys === 'object') return raw
  } catch {
    /* absent, or written by a future version — treated as empty rather than crashing the app */
  }
  return { v: 1, keys: {} }
}

function write(data: Stored): void {
  const f = FILE()
  mkdirSync(dirname(f), { recursive: true })
  // 0o600: the ciphertext is not a secret on macOS/Windows, but on a Linux basic_text fallback it
  // very nearly is, and a file only the user can read costs nothing.
  // tmp + rename, like the settings file: the write used to truncate secrets.json first, so a failure
  // half-way lost every stored key at once, and the next read took the damaged file for an empty
  // store.
  const tmp = `${f}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, f)
}

/** Can we encrypt at all? False means we refuse to store rather than writing plain text. */
export function canStore(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false // called before `app.whenReady()`, or no crypto backend at all
  }
}

/**
 * Which store the OS gave us, for the sentence Settings prints under the field.
 *
 * `getSelectedStorageBackend()` exists on Linux only (and only in newer Electron), hence the guard;
 * elsewhere the backend is implied by the platform. `trusted: false` is the honest flag for the
 * hard-coded-password fallback — the UI must not call that "stored securely".
 */
export function describe(): { available: boolean; backend: string; trusted: boolean } {
  if (!canStore()) return { available: false, backend: 'none', trusted: false }
  if (process.platform === 'darwin') return { available: true, backend: 'keychain', trusted: true }
  if (process.platform === 'win32') return { available: true, backend: 'dpapi', trusted: true }
  let backend = 'unknown'
  try {
    const get = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend
    if (typeof get === 'function') backend = get.call(safeStorage)
  } catch {
    /* older Electron on Linux: backend stays "unknown", which reads as "we cannot promise" */
  }
  // "basic_text" is Chromium's no-keyring fallback: a hard-coded password, i.e. obfuscation.
  return { available: true, backend, trusted: backend !== 'basic_text' && backend !== 'unknown' }
}

/** A dev checkout's `.secrets/<provider>-key`, deliberately NOT migrated into the store: it belongs to
 *  the working copy, not to the installed app, and moving it would break the next fresh clone. */
function devFile(p: Provider): string | null {
  try {
    const v = readFileSync(join(app.getAppPath(), '..', '.secrets', `${p}-key`), 'utf-8').trim()
    return v || null
  } catch {
    return null
  }
}

/**
 * Where the key comes from, in the order that decides it — the **one** resolution order in the app.
 *
 * It exists because there were briefly two: `getApiKey()` looked at the environment, the store and the
 * dev file, while the status shown in Settings looked only at the first two. A developer with a key in
 * `.secrets/openrouter-key` therefore had a working assistant and a Settings panel claiming there was
 * no key — the worst kind of wrong, because it invites you to fix something that is not broken.
 *
 * Precedence: the environment overrides everything (a shell can pin a key for one run), a stored key
 * beats the checkout file (entering one in Settings must take effect), and the dev file is last.
 */
export function resolve(p: Provider): { key: string | null; source: 'env' | 'stored' | 'devfile' | 'none' } {
  const env = (process.env[ENV_VAR[p]] || '').trim()
  if (env) return { key: env, source: 'env' }
  const stored = getSecret(p)
  if (stored) return { key: stored, source: 'stored' }
  const dev = devFile(p)
  if (dev) return { key: dev, source: 'devfile' }
  return { key: null, source: 'none' }
}

/** The key in the clear, for the main process only. Migrates a legacy plain-text file on first read. */
export function getSecret(p: Provider): string | null {
  const data = read()
  const enc = data.keys[p]
  if (enc) {
    try {
      const v = safeStorage.decryptString(Buffer.from(enc, 'base64')).trim()
      if (v) return v
    } catch {
      // Wrong machine, wiped keyring, or a keyring that changed backends: the ciphertext is now
      // undecryptable. Report "no key" so the UI asks for it again — never surface the crypto error,
      // which users read as data loss.
      return null
    }
  }
  if (p === 'openrouter') {
    try {
      const legacy = readFileSync(LEGACY(), 'utf-8').trim()
      if (legacy) {
        if (canStore()) {
          setSecret(p, legacy)
          try {
            rmSync(LEGACY())
          } catch {
            /* keep the migrated copy if it cannot be removed — the store already has it */
          }
        }
        return legacy
      }
    } catch {
      /* no legacy file */
    }
  }
  return null
}

/** Store a key. Empty string clears it. Throws when the platform cannot encrypt. */
export function setSecret(p: Provider, key: string): void {
  const v = key.trim()
  const data = read()
  if (!v) {
    delete data.keys[p]
    write(data)
    return
  }
  if (!canStore())
    throw new Error(
      'This system has no secure credential store, so PrismLCA will not write your key to disk. ' +
        `Set ${ENV_VAR[p]} in the environment instead.`
    )
  data.keys[p] = safeStorage.encryptString(v).toString('base64')
  write(data)
}

export function clearSecret(p: Provider): void {
  setSecret(p, '')
  if (p === 'openrouter' && existsSync(LEGACY())) {
    // Otherwise the next read migrates the same key straight back in and "Remove" looks broken.
    try {
      rmSync(LEGACY())
    } catch {
      /* nothing we can do; the status below will still show a key */
    }
  }
}

/**
 * What the renderer is allowed to know: that a key is there, roughly which one, and where it lives.
 *
 * The hint keeps the first 7 characters (`sk-or-v` — enough to see it is an OpenRouter key rather
 * than an OpenAI one pasted by mistake) and the last 4, so a user with two accounts can tell which
 * is configured without the key being reconstructible.
 */
export function status(p: Provider): {
  present: boolean
  hint: string
  source: 'env' | 'stored' | 'devfile' | 'none'
  backend: string
  trusted: boolean
  available: boolean
} {
  const d = describe()
  // Exactly what the client resolves, so the panel can never disagree with what is actually used —
  // including `source`, because "a key is set but not the one you can remove here" is worth saying.
  const { key, source } = resolve(p)
  return {
    present: !!key,
    hint: mask(key || ''),
    source,
    backend: d.backend,
    trusted: d.trusted,
    available: d.available
  }
}

function mask(key: string): string {
  if (!key) return ''
  if (key.length <= 11) return '•'.repeat(key.length)
  return `${key.slice(0, 7)}…${key.slice(-4)}`
}
