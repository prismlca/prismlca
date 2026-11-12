/**
 * The catalogue and OpenRouter's live prices are two channels. `ai:models` feeds every model choice in the
 * app (the chat's picker, the plan card, the cost ledger) and must answer at once without asking anyone;
 * the prices are a lookup per model at OpenRouter, asked only by the Models table and only with a key.
 * Before the split the catalogue waited for the prices, and opening the chat asked OpenRouter for them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'prism-info-ipc-'))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getPath: () => dir, getAppPath: () => dir, isPackaged: false },
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn), on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] }
}))

const client = vi.hoisted(() => ({
  key: null as string | null,
  fetchPricing: vi.fn(async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { input: 1, output: 2 }]))
  )
}))
vi.mock('../ai/client', () => ({
  getApiKey: () => client.key,
  fetchPricing: client.fetchPricing
}))

const { registerInfoIpc } = await import('./info')
registerInfoIpc({} as never)
const call = (channel: string): unknown => handlers.get(channel)!({})

beforeEach(() => {
  client.key = 'k'
  client.fetchPricing.mockClear()
})

describe('the catalogue and the prices', () => {
  it('answers the catalogue at once, without asking OpenRouter for anything', () => {
    const rows = call('ai:models') as Array<{
      id: string
      provider?: string
      pricing: unknown
      pricingSource?: string
    }>
    // Not a promise: nothing to wait for.
    expect(Array.isArray(rows)).toBe(true)
    expect(client.fetchPricing).not.toHaveBeenCalled()
    // OpenRouter rows carry no price; the direct providers' rows their hand-kept list price.
    expect(
      rows.filter((r) => (r.provider ?? 'openrouter') === 'openrouter').every((r) => r.pricing === null)
    ).toBe(true)
    const listed = rows.filter((r) => r.pricingSource === 'list')
    expect(listed.length).toBeGreaterThan(0)
  })

  it('asks for OpenRouter prices only with a key, and only for the OpenRouter chat models', async () => {
    client.key = null
    expect(await call('ai:openrouterPrices')).toEqual({})
    expect(client.fetchPricing).not.toHaveBeenCalled()

    client.key = 'k'
    const prices = (await call('ai:openrouterPrices')) as Record<string, unknown>
    const asked = client.fetchPricing.mock.calls[0][0] as string[]
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((id) => !id.startsWith('openai/whisper'))).toBe(true)
    const rows = call('ai:models') as Array<{ id: string; provider?: string }>
    const direct = rows.filter((r) => (r.provider ?? 'openrouter') !== 'openrouter').map((r) => r.id)
    expect(asked.some((id) => direct.includes(id))).toBe(false)
    expect(Object.keys(prices)).toEqual(asked)
  })
})
