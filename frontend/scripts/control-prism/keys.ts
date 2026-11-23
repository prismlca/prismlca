/**
 * The person's stored provider keys in a session — only when launch is asked for them (`--keys`).
 *
 * A driven instance otherwise has no key at all: the end-to-end launch drops every key variable from the
 * environment and the checkout's key files, and a fresh profile has no key store. That is right for a
 * check, which must not spend money unasked, and it makes chat runs impossible. `--keys` copies the
 * person's key store (`secrets.json`, the ciphertext the app's safeStorage wrote) into the session's
 * profile. It decrypts there because the instance is the same app for the same user: the keyring on
 * Linux, the Keychain on macOS — which the instance then uses instead of the test store Playwright sets
 * (launch's `keyStore: 'system'`); on Windows the key that decrypts it lives in the profile's `Local State`,
 * which goes along. Environment variables and the checkout's key files stay out either way.
 *
 * The keys are named, never shown: doctor lists which providers are stored and whether the instance can
 * read them. They leave the session's profile when it stops, also when its folders are kept.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { RunningApp } from '../../e2e/app'

/** The key store of main/secrets.ts in a profile. */
export const KEY_FILES = ['secrets.json']

/** Copies the key store of `profile` into `userData` (and, on Windows, what decrypts it). Returns the
 *  providers it holds. */
export function copyKeys(profile: string, userData: string, platform = process.platform): string[] {
  const store = join(profile, KEY_FILES[0])
  if (!existsSync(store)) return []
  mkdirSync(userData, { recursive: true })
  copyFileSync(store, join(userData, KEY_FILES[0]))
  const state = join(profile, 'Local State')
  if (platform === 'win32' && existsSync(state) && !existsSync(join(userData, 'Local State'))) {
    copyFileSync(state, join(userData, 'Local State'))
  }
  return storedProviders(userData)
}

function readStore(userData: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(userData, KEY_FILES[0]), 'utf8')) as {
      keys?: Record<string, unknown>
    }
    return Object.fromEntries(
      Object.entries(raw.keys ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string')
    )
  } catch {
    return {}
  }
}

/** The providers with a stored key in `userData` — names only. */
export function storedProviders(userData: string): string[] {
  return Object.keys(readStore(userData)).sort()
}

/** Removes the key store from a session's profile, and says whether there was one. Throws when a file
 *  stays: every cleanup removes the keys first and stops there, so the session is still there to retry. */
export function forgetKeys(userData: string): boolean {
  const store = join(userData, KEY_FILES[0])
  const had = existsSync(store)
  for (const f of KEY_FILES.flatMap((k) => [k, `${k}.tmp`])) {
    const path = join(userData, f)
    try {
      rmSync(path, { force: true, maxRetries: 5, retryDelay: 200 })
    } catch (e) {
      throw new Error(`could not remove the stored keys ${path}: ${(e as Error).message}`)
    }
  }
  return had
}

/**
 * Whether the running instance can decrypt each stored key. The ciphertext goes to the app's main
 * process and only a yes or no comes back; the key itself never leaves the app.
 */
export async function readableKeys(
  running: RunningApp,
  userData: string
): Promise<{ provider: string; readable: boolean }[]> {
  const store = readStore(userData)
  if (Object.keys(store).length === 0) return []
  return running.app.evaluate(({ safeStorage }, stored) => {
    return Object.entries(stored).map(([provider, cipher]) => {
      try {
        return { provider, readable: safeStorage.decryptString(Buffer.from(cipher, 'base64')).length > 0 }
      } catch {
        return { provider, readable: false }
      }
    })
  }, store)
}
