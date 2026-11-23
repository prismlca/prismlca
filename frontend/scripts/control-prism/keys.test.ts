import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyKeys, forgetKeys, storedProviders } from './keys'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

function profile(store?: string): { profile: string; userData: string } {
  const root = mkdtempSync(join(tmpdir(), 'cp-keys-test-'))
  dirs.push(root)
  const p = join(root, 'prism-lca')
  mkdirSync(p)
  if (store !== undefined) writeFileSync(join(p, 'secrets.json'), store)
  writeFileSync(join(p, 'Local State'), '{"os_crypt":{}}')
  return { profile: p, userData: join(root, 'session', 'user-data') }
}

const STORE = JSON.stringify({ v: 1, keys: { openrouter: 'YQ==', anthropic: 'Yg==' } })

describe('keys', () => {
  it('copies the key store and names its providers, never their keys', () => {
    const { profile: p, userData } = profile(STORE)
    expect(copyKeys(p, userData, 'linux')).toEqual(['anthropic', 'openrouter'])
    expect(existsSync(join(userData, 'secrets.json'))).toBe(true)
    // Outside Windows the keyring decrypts; Local State holds nothing for it.
    expect(existsSync(join(userData, 'Local State'))).toBe(false)
  })

  it("takes Local State along on Windows, where the profile's own key decrypts the store", () => {
    const { profile: p, userData } = profile(STORE)
    copyKeys(p, userData, 'win32')
    expect(existsSync(join(userData, 'Local State'))).toBe(true)
  })

  it('copies nothing when the person has no stored key', () => {
    const { profile: p, userData } = profile()
    expect(copyKeys(p, userData, 'linux')).toEqual([])
    expect(existsSync(join(userData, 'secrets.json'))).toBe(false)
  })

  it('reads a damaged store as empty', () => {
    const { profile: p, userData } = profile('{not json')
    copyKeys(p, userData, 'linux')
    expect(storedProviders(userData)).toEqual([])
  })

  it('says so when the store cannot be removed, instead of leaving it quietly', () => {
    const { userData } = profile()
    mkdirSync(join(userData, 'secrets.json', 'inside'), { recursive: true })
    expect(() => forgetKeys(userData)).toThrow(/could not remove the stored keys .*secrets\.json/)
  })

  it('removes the store and its half-written sibling, and says whether there was one', () => {
    const { profile: p, userData } = profile(STORE)
    copyKeys(p, userData, 'linux')
    writeFileSync(join(userData, 'secrets.json.tmp'), 'half')
    expect(forgetKeys(userData)).toBe(true)
    expect(existsSync(join(userData, 'secrets.json'))).toBe(false)
    expect(existsSync(join(userData, 'secrets.json.tmp'))).toBe(false)
    expect(forgetKeys(userData)).toBe(false)
  })
})
