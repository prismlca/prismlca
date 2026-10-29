import { describe, expect, it } from 'vitest'
import {
  RESULT_BASE_CHARS,
  RESULT_HARD_MAX_CHARS,
  RESULT_PER_ITEM_CHARS,
  capToolResult,
  itemCount,
  resultBudget
} from './resultBudget'

describe('resultBudget', () => {
  it('gives a single result exactly what it always had', () => {
    expect(resultBudget(1)).toBe(RESULT_BASE_CHARS)
  })

  it('scales with the number of batch items', () => {
    expect(resultBudget(12)).toBeGreaterThan(resultBudget(1))
    // Five items, because twelve now reach the hard ceiling: one search query serialises to
    // 10,400-19,600 characters, so PER_ITEM was raised from 6,000 to 15,000.
    expect(resultBudget(5, 2_000_000)).toBe(RESULT_BASE_CHARS + RESULT_PER_ITEM_CHARS * 4)
  })

  it('never exceeds the hard ceiling, however big the batch', () => {
    expect(resultBudget(1_000)).toBe(RESULT_HARD_MAX_CHARS)
  })

  it('reads a batch size off the payload', () => {
    expect(itemCount({ total: 12, succeeded: 12, failed: 0, results: [1, 2, 3] })).toBe(12)
    expect(itemCount({ hits: [1, 2, 3, 4] })).toBe(4)
    expect(itemCount({ query: 'x' })).toBe(1)
    expect(itemCount('not an object')).toBe(1)
  })
})

describe('capToolResult', () => {
  it('leaves a normal result completely alone', () => {
    const text = JSON.stringify({ hits: [{ name: 'market for steel' }] })
    expect(capToolResult(text)).toEqual({ text })
  })

  // The measured case, and the first thing the scaling had to fix: a 12-query `search_background`
  // returned 34,939 characters against a flat 30,000 cap, and the old slice ended the JSON inside an
  // object — the model got something it could not parse. At twelve items the budget is 96,000, so this
  // result now arrives whole. That is the fix; the trimming below is only for what is bigger still.
  it('no longer touches a result that used to be cut silently', () => {
    const text = JSON.stringify({
      total: 12,
      succeeded: 12,
      failed: 0,
      results: Array.from({ length: 12 }, (_, i) => ({ i, ok: true, result: 'x'.repeat(2_900) }))
    })
    expect(text.length).toBeGreaterThan(RESULT_BASE_CHARS) // over the OLD cap
    expect(capToolResult(text).truncated).toBeUndefined() // under the new one
  })

  it('keeps every query of an oversized batch and shortens their hit lists instead', () => {
    const results = Array.from({ length: 12 }, (_, i) => ({
      i,
      ok: true,
      result: { hits: Array.from({ length: 25 }, (_, j) => ({ name: `dataset ${i}-${j}`.repeat(120) })) }
    }))
    const text = JSON.stringify({ total: 12, succeeded: 12, failed: 0, results })
    expect(text.length).toBeGreaterThan(resultBudget(12))

    const capped = capToolResult(text)
    expect(capped.truncated?.kind).toBe('within_entries')
    expect(capped.text.length).toBeLessThanOrEqual(resultBudget(12))
    // The whole point: it still parses, and no query was answered with silence.
    const parsed = JSON.parse(capped.text) as {
      results: Array<{ result: { hits: unknown[]; truncated?: { of: number; field: string } } }>
    }
    expect(parsed.results).toHaveLength(12)
    for (const r of parsed.results) {
      expect(r.result.hits.length).toBeGreaterThan(0)
      expect(r.result.hits.length).toBeLessThan(25)
      expect(r.result.truncated?.of).toBe(25)
      expect(r.result.truncated?.field).toBe('hits')
    }
  })

  it('shrinks the giant instead of dropping the code that was asked for', () => {
    // Measured: get_process_details for three codes returned 4,965 + 3,101 + 37,169
    // characters — the third carries 90 exchanges. The old rule dropped it whole, which was the one
    // dataset the caller wanted, and left ~33,800 characters of budget unspent.
    const small = (code: string, n: number): unknown => ({
      code,
      activity: { name: `market for ${code}`, unit: 'kilogram' },
      exchanges: Array.from({ length: n }, (_, j) => ({
        uid: `${code}-${j}`,
        amount: j,
        name: 'x'.repeat(500)
      }))
    })
    // Scaled to the budget of the day rather than pinned to the original byte counts: PER_ITEM
    // rose from 6,000 to 15,000 since, and the shape of the finding is what matters.
    const text = JSON.stringify({
      results: [small('glass', 5), small('fibreboard', 4), small('waste-wood', 130)]
    })
    expect(text.length).toBeGreaterThan(resultBudget(3))

    const capped = capToolResult(text)
    expect(capped.truncated?.kind).toBe('within_entries')
    const parsed = JSON.parse(capped.text) as {
      results: Array<{ code: string; exchanges: unknown[]; truncated?: { of: number } }>
    }
    // All three codes came back — that is the finding.
    expect(parsed.results.map((r) => r.code)).toEqual(['glass', 'fibreboard', 'waste-wood'])
    expect(parsed.results[0].exchanges).toHaveLength(5) // the small ones are untouched
    expect(parsed.results[1].exchanges).toHaveLength(4)
    expect(parsed.results[2].exchanges.length).toBeLessThan(130) // the giant paid
    expect(parsed.results[2].truncated?.of).toBe(130)
    // And the budget is actually used, rather than three quarters of it left lying about.
    expect(capped.text.length).toBeGreaterThan(resultBudget(3) * 0.8)
  })

  it('drops whole skills rather than half a sentence', () => {
    // get_skill returned 31,716 characters and an instruction ended mid-word ("The study was charged f").
    const skills = Array.from({ length: 6 }, (_, i) => ({
      name: `skill ${i}`,
      description: 'd',
      content: 'x'.repeat(20_000)
    }))
    const text = JSON.stringify({ skills })
    expect(text.length).toBeGreaterThan(resultBudget(6))
    const capped = capToolResult(text)
    expect(capped.truncated?.kind).toBe('entries')
    const parsed = JSON.parse(capped.text) as { skills: Array<{ content: string }> }
    // Every skill that survived is whole — that is what "structurally" buys.
    for (const s of parsed.skills) expect(s.content.length).toBe(20_000)
  })

  it('marks a cut in plain text instead of ending mid-sentence silently', () => {
    const text = 'a'.repeat(RESULT_BASE_CHARS + 5_000)
    const capped = capToolResult(text)
    expect(capped.truncated?.kind).toBe('characters')
    expect(capped.text).toMatch(/\[TRUNCATED: \d+ of \d+ characters/)
    expect(capped.text).toMatch(/INCOMPLETE/)
    expect(capped.text.length).toBeLessThanOrEqual(RESULT_BASE_CHARS)
  })

  it('falls back to a marked character cut when there is no list to trim', () => {
    const text = JSON.stringify({ comment: 'x'.repeat(RESULT_BASE_CHARS + 1_000) })
    const capped = capToolResult(text)
    expect(capped.truncated?.kind).toBe('characters')
    expect(capped.text).toMatch(/TRUNCATED/)
  })

  it('honours an explicit budget, for callers that know better', () => {
    const text = JSON.stringify({ hits: Array.from({ length: 40 }, (_, i) => ({ n: `hit ${i}` })) })
    const capped = capToolResult(text, 200)
    expect(capped.text.length).toBeLessThanOrEqual(200)
  })

  it('does not claim a truncation it did not make', () => {
    const text = JSON.stringify({ total: 3, results: [1, 2, 3] })
    expect(capToolResult(text).truncated).toBeUndefined()
  })
})

describe('a batch may not crowd out the conversation it is part of (V104/V109)', () => {
  // The unit of the second argument is CHARACTERS OF CONVERSATION (compactThreshold), not tokens of
  // reply. These are the figures the shipped models actually produce.
  const QWEN_1M = 2_000_000 // 1,000,000 context tokens × 0.5 × 4 chars
  // A model whose window we do not know: the conservative fallback. Every model in the catalogue
  // with a declared window now has a megatoken, so this — not a 200k Claude — is the small case.
  const SMALL_CONTEXT = 400_000 // FALLBACK_COMPACT_CHARS
  const UNKNOWN_MODEL = 400_000

  it('leaves the batch scaling alone on a large-context model', () => {
    // Eight queries would earn 135,000 characters and are held at the hard ceiling — not by the
    // share of the conversation, which on a million-token model is 400,000. This is the case V104
    // was breaking.
    expect(resultBudget(8, QWEN_1M)).toBe(RESULT_HARD_MAX_CHARS)
    expect(resultBudget(4, QWEN_1M)).toBe(RESULT_BASE_CHARS + RESULT_PER_ITEM_CHARS * 3)
    // …and the four results a real modelling run once lost all fit now.
    expect(resultBudget(3, QWEN_1M)).toBeGreaterThanOrEqual(35_956) // get_skill, 3 skills
    expect(resultBudget(4, QWEN_1M)).toBeGreaterThanOrEqual(42_706) // research_web, 4 questions
    expect(resultBudget(12, QWEN_1M)).toBeGreaterThanOrEqual(80_210) // search, 12 queries
    expect(resultBudget(14, QWEN_1M)).toBeGreaterThanOrEqual(99_047) // search, 14 queries
  })

  it('still caps a wide batch on a smaller-context model', () => {
    // 400,000 × 0.2 = 80,000, and that share binds well before the ceiling does.
    expect(resultBudget(12, SMALL_CONTEXT)).toBe(80_000)
    expect(resultBudget(8, SMALL_CONTEXT)).toBe(80_000)
    expect(resultBudget(3, SMALL_CONTEXT)).toBe(RESULT_BASE_CHARS + RESULT_PER_ITEM_CHARS * 2)
    expect(resultBudget(12, UNKNOWN_MODEL)).toBe(80_000)
  })

  it('never squeezes a single call below its base budget', () => {
    // A tiny context must not turn one ordinary answer into a stub — the finding was about width.
    expect(resultBudget(1, 1_000)).toBe(RESULT_BASE_CHARS)
    expect(resultBudget(12, 1_000)).toBe(RESULT_BASE_CHARS)
  })

  it('behaves exactly as before when the context size is unknown', () => {
    expect(resultBudget(8)).toBe(resultBudget(8, undefined))
    expect(resultBudget(3)).toBe(RESULT_BASE_CHARS + RESULT_PER_ITEM_CHARS * 2)
  })

  it('applies the context cap through capToolResult', () => {
    // Twelve queries earn 96,000 characters, which is over the 80,000 a 200k-token model allows and
    // well inside what a million-token one does. ~90,000 of payload therefore separates the two.
    const text = JSON.stringify({
      total: 12,
      results: Array.from({ length: 12 }, (_, i) => ({ i, hits: 'x'.repeat(7_400) }))
    })
    expect(text.length).toBeGreaterThan(80_000)
    expect(capToolResult(text, undefined, SMALL_CONTEXT).text.length).toBeLessThanOrEqual(80_000)
    // …and does not touch it on a model with room. This is the real-run case, verbatim.
    expect(capToolResult(text, undefined, QWEN_1M).truncated).toBeUndefined()
  })

  it('the reply limit is no longer what decides (V109)', () => {
    // 50,000 was the shipped "Max tokens per reply". Read as characters of conversation it would be
    // absurd, and the guard against that is the base floor — the point is that this number has no
    // business here at all, and a run configured with it is no longer punished for it.
    expect(resultBudget(12, QWEN_1M)).toBeGreaterThan(35_000)
  })
})

describe('a dropped entry says which one it was (V109/V114)', () => {
  const research = (n: number, size: number): string =>
    JSON.stringify({
      total: n,
      results: Array.from({ length: n }, (_, i) => ({
        i,
        ok: true,
        result: { question: `Question number ${i + 1}`, text: 'x'.repeat(size) }
      }))
    })

  it('names the questions that were dropped from a research batch', () => {
    const capped = capToolResult(research(4, 30_000), 40_000)
    expect(capped.truncated?.kind).toBe('entries')
    const parsed = JSON.parse(capped.text)
    expect(parsed.truncated.dropped).toBeDefined()
    // Whatever survived, every dropped entry is named, and the names are the questions.
    expect(parsed.truncated.dropped.length).toBe(parsed.truncated.dropped_entries)
    for (const label of parsed.truncated.dropped) expect(label).toMatch(/^Question number \d$/)
    expect(parsed.truncated.note).toContain('What was dropped, in order:')
  })

  it('names dropped skills by their name', () => {
    const text = JSON.stringify({
      skills: [
        { name: 'LCA model building', instructions: 'x'.repeat(30_000) },
        { name: 'Goal & scope', instructions: 'x'.repeat(30_000) },
        { name: 'End-of-life & what-if scenarios', instructions: 'x'.repeat(30_000) }
      ]
    })
    const parsed = JSON.parse(capToolResult(text, 40_000).text)
    // Dropping happens from the end, so the last skill is the one that goes — exactly the one a
    // real modelling run once lost, and the model could not tell which it was.
    expect(parsed.truncated.dropped).toContain('End-of-life & what-if scenarios')
  })

  it('stays quiet when the entries carry no name to give', () => {
    const text = JSON.stringify({ results: Array.from({ length: 4 }, () => 'x'.repeat(30_000)) })
    const parsed = JSON.parse(capToolResult(text, 40_000).text)
    expect(parsed.truncated.dropped).toBeUndefined()
    expect(parsed.truncated.note).not.toContain('What was dropped')
  })
})
