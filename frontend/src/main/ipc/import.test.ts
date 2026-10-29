import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The matching run as the wizard reaches it — registered against a fake ipcMain, the matcher
 * replaced by one whose timing the test controls. What is under test is the run's bookkeeping, not
 * the model: which batches are applied, what is counted, and which settings reach the matcher.
 */
type Handler = (...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) }
}))
const stored = { provider: 'openrouter', matchModel: 'm', maxTokens: 30_000, maxCostUsd: 0 }
vi.mock('../settings', () => ({ getSettings: () => stored }))
vi.mock('../ai/usage', () => ({ recordUsage: () => {} }))

interface FakeOpts {
  model: string
  signal?: AbortSignal
  maxTokens?: number
}
const seen: FakeOpts[] = []
/** What the technosphere batch does when the run is stopped under it: 'cut' — its answer was still
 *  arriving, so the real matcher throws MatchStopped; 'complete' — its answers had finished and only
 *  the stream's closing was outstanding, so it returns them. */
const fake = { onStop: 'cut' as 'cut' | 'complete' }
vi.mock('../ai/importMatcher', () => ({
  BATCH: 20,
  matchBatch: async (rows: { dataset: string; index: number; kind: string }[], opts: FakeOpts) => {
    seen.push(opts)
    if (rows[0].kind !== 'biosphere') {
      await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve()))
      if (fake.onStop === 'cut') throw new Error('stopped while the answer was arriving')
    }
    return rows.map((r) => ({
      dataset: r.dataset,
      index: r.index,
      code: rows[0].kind === 'biosphere' ? 'co2-air' : null,
      confidence: rows[0].kind === 'biosphere' ? 'medium' : 'open',
      evidence: rows[0].kind === 'biosphere' ? 'same substance' : 'no usable answer from the model'
    }))
  }
}))

const { registerImportIpc } = await import('./import')

const row = (index: number, kind: string): unknown => ({
  dataset: 'Vacuum infusion',
  index,
  kind,
  name: `row ${index}`,
  unit: 'kg',
  compartment: [],
  candidates: [{ database: 'db', code: `c${index}`, label: 'x', name: 'x', categories: [], unit: 'kg' }],
  needs_model: true
})

describe('the import matching run', () => {
  const decided: unknown[] = []

  beforeEach(() => {
    handlers.clear()
    seen.length = 0
    decided.length = 0
    fake.onStop = 'cut'
    stored.matchModel = 'm'
    registerImportIpc({
      apiRequest: async (method: string, path: string, body?: unknown) => {
        if (method === 'GET') {
          // One flow, eighteen materials: the 1/19 + 18 split of the real stop.
          return {
            status: 200,
            body: {
              rows: [row(1, 'biosphere'), ...Array.from({ length: 18 }, (_, i) => row(i + 2, 'technosphere'))]
            }
          }
        }
        decided.push(body)
        return { status: 200, body: {} }
      },
      getWindow: () => null
    })
  })

  it('drops the batch a stop cut short instead of counting it as answered', async () => {
    const run = handlers.get('import:match')!() as Promise<{ done: number; total: number; error?: string }>
    await vi.waitFor(() => expect(decided).toHaveLength(1)) // the flow batch has landed
    handlers.get('import:match:stop')!()
    const result = await run

    expect(decided).toHaveLength(1) // the cut batch's "no usable answer" rows were never written
    expect(result.done).toBe(1)
    expect(result.total).toBe(19)
    expect(result.error).toMatch(/Stopped by you\. 1 of 19 rows/)
  })

  it('applies a batch whose answers had finished, even when the stop came first', async () => {
    fake.onStop = 'complete'
    const run = handlers.get('import:match')!() as Promise<{ done: number; error?: string }>
    await vi.waitFor(() => expect(decided).toHaveLength(1))
    handlers.get('import:match:stop')!()
    const result = await run
    expect(decided).toHaveLength(2) // paid for in full, so kept — not bought a second time
    expect(result.done).toBe(19)
    expect(result.error).toBeUndefined() // nothing was left unasked
  })

  it('runs GPT-6 Luna when no matching model was chosen', async () => {
    stored.matchModel = ''
    const run = handlers.get('import:match')!() as Promise<unknown>
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    handlers.get('import:match:stop')!()
    await run
    expect(seen[0].model).toBe('openai/gpt-6-luna')
  })

  it('hands the user’s "Max tokens per reply" to the matcher', async () => {
    const run = handlers.get('import:match')!() as Promise<unknown>
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    handlers.get('import:match:stop')!()
    await run
    expect(seen.map((o) => o.maxTokens)).toEqual([30_000, 30_000])
  })
})
