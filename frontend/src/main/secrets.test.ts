/**
 * The key store, checked where it matters: that a key is never written in the clear, that the renderer
 * can only ever learn a mask, and that the honest-labelling logic actually flags Chromium's
 * no-keyring fallback instead of calling it encryption.
 *
 * `safeStorage` is faked with a reversible transform, which is enough — what is under test is our
 * handling around it, not Electron's crypto.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'prism-secrets-'))
let available = true
let backend = 'gnome_libsecret'
let platform = 'linux'

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    // A stand-in cipher: reversible, and clearly not the plain text.
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf-8'),
    decryptString: (b: Buffer) => {
      const s = b.toString('utf-8')
      if (!s.startsWith('enc:')) throw new Error('not our ciphertext')
      return s.slice(4)
    }
  }
}))

const secrets = await import('./secrets')
const FILE = join(userData, 'secrets.json')
const LEGACY = join(userData, 'openrouter-key')

beforeEach(() => {
  available = true
  backend = 'gnome_libsecret'
  platform = 'linux'
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  writeFileSync(FILE, JSON.stringify({ v: 1, keys: {} }))
  try {
    writeFileSync(LEGACY, '')
  } catch {
    /* fine */
  }
  delete process.env.OPENROUTER_API_KEY
  try {
    rmSync(join(userData, '..', '.secrets'), { recursive: true })
  } catch {
    /* not there */
  }
})

describe('the key store', () => {
  it('round-trips a key without ever writing it in the clear', () => {
    secrets.setSecret('openrouter', 'sk-or-v1-abcdefghij1f4c')
    expect(secrets.getSecret('openrouter')).toBe('sk-or-v1-abcdefghij1f4c')
    const onDisk = readFileSync(FILE, 'utf-8')
    expect(onDisk).not.toContain('sk-or-v1-abcdefghij1f4c')
    // base64 of "enc:…" — the value went through the cipher rather than being written as typed
    expect(onDisk).toMatch(/"openrouter": "ZW5jO/)
  })

  it('tells the renderer a mask and never the key', () => {
    secrets.setSecret('openrouter', 'sk-or-v1-abcdefghij1f4c')
    const s = secrets.status('openrouter')
    expect(s.present).toBe(true)
    expect(s.hint).toBe('sk-or-v…1f4c')
    expect(JSON.stringify(s)).not.toContain('abcdefghij')
  })

  it('says the environment is in charge when it is, so Remove is not blamed for doing nothing', () => {
    secrets.setSecret('openrouter', 'sk-or-v1-stored000000')
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-fromtheenv0000'
    expect(secrets.status('openrouter').source).toBe('env')
    expect(secrets.status('openrouter').hint).toBe('sk-or-v…0000')
  })

  it('refuses to store rather than writing plain text when the platform cannot encrypt', () => {
    available = false
    expect(() => secrets.setSecret('openrouter', 'sk-or-v1-nowhere000000')).toThrow(/OPENROUTER_API_KEY/)
    expect(readFileSync(FILE, 'utf-8')).not.toContain('nowhere')
    expect(secrets.status('openrouter').available).toBe(false)
  })

  it('does not call the no-keyring fallback encryption', () => {
    backend = 'basic_text' // Chromium's hard-coded-password store
    expect(secrets.describe()).toMatchObject({ available: true, backend: 'basic_text', trusted: false })
    backend = 'kwallet6'
    expect(secrets.describe().trusted).toBe(true)
  })

  it('migrates the old plain-text file into the store and removes it', () => {
    writeFileSync(FILE, JSON.stringify({ v: 1, keys: {} }))
    writeFileSync(LEGACY, 'sk-or-v1-legacy0000000\n')
    expect(secrets.getSecret('openrouter')).toBe('sk-or-v1-legacy0000000')
    expect(readFileSync(FILE, 'utf-8')).toMatch(/"openrouter": "ZW5jO/)
    expect(() => readFileSync(LEGACY, 'utf-8')).toThrow() // gone, or the encryption was pointless
  })

  it('clears a key, and the legacy file cannot resurrect it', () => {
    writeFileSync(LEGACY, 'sk-or-v1-legacy0000000')
    secrets.setSecret('openrouter', 'sk-or-v1-abcdefghij1f4c')
    secrets.clearSecret('openrouter')
    expect(secrets.getSecret('openrouter')).toBeNull()
    expect(secrets.status('openrouter').present).toBe(false)
  })

  it('sees a dev checkout key, so Settings cannot claim there is none', () => {
    // The bug this locks down: `getApiKey()` looked at .secrets/, `status()` did not — so a developer
    // had a working assistant and a panel insisting no key was configured.
    mkdirSync(join(userData, '..', '.secrets'), { recursive: true })
    writeFileSync(join(userData, '..', '.secrets', 'openrouter-key'), 'sk-or-v1-fromcheckout0\n')
    const r = secrets.resolve('openrouter')
    expect(r.key).toBe('sk-or-v1-fromcheckout0')
    expect(r.source).toBe('devfile')
    expect(secrets.status('openrouter')).toMatchObject({ present: true, source: 'devfile' })
  })

  it('lets a stored key take over from the checkout file, and the environment over both', () => {
    mkdirSync(join(userData, '..', '.secrets'), { recursive: true })
    writeFileSync(join(userData, '..', '.secrets', 'openrouter-key'), 'sk-or-v1-fromcheckout0')
    secrets.setSecret('openrouter', 'sk-or-v1-storedkey0000')
    expect(secrets.resolve('openrouter')).toMatchObject({ key: 'sk-or-v1-storedkey0000', source: 'stored' })
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-fromtheenv0000'
    expect(secrets.resolve('openrouter')).toMatchObject({ key: 'sk-or-v1-fromtheenv0000', source: 'env' })
  })

  it('reports no key instead of an error when the ciphertext no longer decrypts', () => {
    // Another machine, a wiped keyring, a changed backend: the bytes are there but useless.
    writeFileSync(
      FILE,
      JSON.stringify({ v: 1, keys: { openrouter: Buffer.from('garbage').toString('base64') } })
    )
    expect(secrets.getSecret('openrouter')).toBeNull()
  })
})

describe('the distance key slots', () => {
  it('store ors and mapbox keys beside the AI keys without touching them', () => {
    secrets.setSecret('openrouter', 'sk-or-v1-abcdefghij1f4c')
    secrets.setSecret('ors', 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImFiYyJ9')
    secrets.setSecret('mapbox', 'pk.eyJ1IjoidGVzdCIsImEiOiJjbHh4In0.abcd')
    expect(secrets.getSecret('openrouter')).toBe('sk-or-v1-abcdefghij1f4c')
    expect(secrets.getSecret('ors')).toMatch(/^eyJvcmci/)
    expect(secrets.status('mapbox')).toMatchObject({ present: true, source: 'stored' })
    expect(secrets.status('mapbox').hint).toMatch(/^pk\.eyJ1…abcd$/)
    const raw = readFileSync(FILE, 'utf-8')
    expect(raw).not.toContain('pk.eyJ1IjoidGVzdCIs')
    secrets.clearSecret('ors')
    expect(secrets.getSecret('ors')).toBeNull()
    expect(secrets.getSecret('mapbox')).not.toBeNull()
  })

  it('the environment pins a distance key for one run', () => {
    process.env.ORS_API_KEY = 'from-env-1234567890'
    try {
      expect(secrets.resolve('ors')).toEqual({ key: 'from-env-1234567890', source: 'env' })
    } finally {
      delete process.env.ORS_API_KEY
    }
  })
})

describe('atomic store writes', () => {
  it('leaves no temp file behind and never a truncated store', async () => {
    const { existsSync } = await import('node:fs')
    secrets.setSecret('openrouter', 'sk-or-atomic')
    expect(existsSync(`${FILE}.tmp`)).toBe(false)
    const stored = JSON.parse(readFileSync(FILE, 'utf-8'))
    expect(stored.v).toBe(1)
    expect(secrets.getSecret('openrouter')).toBe('sk-or-atomic')
  })
})
