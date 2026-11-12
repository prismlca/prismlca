import { describe, expect, it } from 'vitest'
import { batchResult } from './format'
import { failedItems, softError } from '../execute'

const ok = (i: number) => ({ ok: true, item: i, result: { i } })
const bad = (i: number) => ({ ok: false, item: i, error: `item ${i} refused` })

describe('batchResult', () => {
  it('a batch where every item failed is a refusal, not "the rest were applied" (V464)', () => {
    // GPT-6 Luna resent such a batch four times word for word: it came back as a success.
    const out = batchResult([bad(0), bad(1), bad(2), bad(3)])
    const parsed = JSON.parse(out)
    expect(parsed.error).toBe(
      "All 4 items failed — none succeeded. Read each item's error below and fix those items before sending them again."
    )
    expect(out).not.toMatch(/the rest were applied/)
    expect(parsed.hint).toBeUndefined()
    // The executor reads `error` as a refusal (status "rejected", MCP isError) and still counts the items.
    expect(softError(out)).toBe(parsed.error)
    expect(failedItems(out)).toBe(4)
    expect(parsed.results.map((r: { error: string }) => r.error)).toEqual([
      'item 0 refused',
      'item 1 refused',
      'item 2 refused',
      'item 3 refused'
    ])
  })

  it('says it in the singular for a batch of one', () => {
    expect(JSON.parse(batchResult([bad(0)])).error).toMatch(/^All 1 item failed/)
  })

  it('keeps a partial failure a success with the hint, and a clean batch plain', () => {
    const partial = JSON.parse(batchResult([ok(0), bad(1)]))
    expect(partial.error).toBeUndefined()
    expect(partial.hint).toBe('Some items failed; the rest were applied. Fix and retry only the failed ones.')
    expect(partial).toMatchObject({ total: 2, succeeded: 1, failed: 1 })
    const clean = JSON.parse(batchResult([ok(0), ok(1)]))
    expect(clean.error).toBeUndefined()
    expect(clean.hint).toBeUndefined()
    // An empty batch failed nothing.
    expect(JSON.parse(batchResult([])).error).toBeUndefined()
  })
})
