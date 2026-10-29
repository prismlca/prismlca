/**
 * The key handlers as the renderer reaches them — registered against a fake ipcMain and called by
 * channel. `secrets.test.ts` proves the store masks; this proves the IPC answers with the mask and
 * never with the key (`ai:keyStatus` answering `resolve` instead of `status` would
 * hand the renderer the whole key with every test still green).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'prism-keys-ipc-'))
type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData },
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8').slice(4)
  }
}))
// The chat client pulls the provider stack in; the handlers only need its two entry points.
vi.mock('../ai/client', () => ({ getApiKey: () => 'sk-or-v1-abcdefghij1f4c', resetApiKey: () => undefined }))

const { registerKeyIpc } = await import('./keys')
const pushed: Array<{ path: string; body: unknown }> = []

beforeEach(() => {
  handlers.clear()
  pushed.length = 0
  writeFileSync(join(userData, 'secrets.json'), JSON.stringify({ v: 1, keys: {} }))
  delete process.env.OPENROUTER_API_KEY
  delete process.env.OPENAI_API_KEY
  registerKeyIpc({
    apiRequest: async (_m, path, body) => {
      pushed.push({ path, body })
      return { status: 200, body: {} }
    },
    getWindow: () => null
  })
})

describe('the key IPC', () => {
  it('stores a key, pushes it to the backend, and answers the renderer with a mask only', async () => {
    const set = handlers.get('ai:setKey')!
    const r = (await set(null, 'sk-or-v1-abcdefghij1f4c', 'openrouter')) as {
      ok: boolean
      status: { present: boolean; hint: string }
    }
    expect(r.ok).toBe(true)
    expect(r.status.present).toBe(true)
    expect(r.status.hint).toBe('sk-or-v…1f4c')
    expect(JSON.stringify(r)).not.toContain('abcdefghij')
    // The backend gets the key the chat will actually use — the one place the full key travels.
    expect(pushed).toEqual([
      {
        path: '/api/v1/system/provider-key',
        body: { provider: 'openrouter', key: 'sk-or-v1-abcdefghij1f4c' }
      }
    ])

    const status = (await handlers.get('ai:keyStatus')!(null, 'openrouter')) as { hint: string }
    expect(status.hint).toBe('sk-or-v…1f4c')
    expect(JSON.stringify(status)).not.toContain('abcdefghij')
    expect(await handlers.get('ai:hasKey')!(null)).toBe(true)
  })

  it('treats an unknown provider name as OpenRouter rather than as a new entry', async () => {
    const status = (await handlers.get('ai:keyStatus')!(null, 'someone-else')) as { present: boolean }
    expect(status.present).toBe(false)
    const clear = (await handlers.get('ai:clearKey')!(null, 'someone-else')) as { ok: boolean }
    expect(clear.ok).toBe(true)
    expect(pushed.at(-1)?.body).toEqual({ provider: 'openrouter', key: '' })
  })
})
