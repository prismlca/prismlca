import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The writer's lists of findings have to agree with the backend's: "raised but not blocking" when the
 * gate decides alone, and "no second reader can overrule" when a reader has read the chapter.
 *
 * The backend decides what blocks; the writer's copies decide what goes back to the model as a
 * correction assignment. They had drifted once: the writer lacked `antithesis_habit` and sent a style
 * remark back as a mandatory fix. The contract list has the same shape of risk: a kind the writer does
 * not know as contract goes to the reader as a suspicion the reader may wave through, while the backend
 * still refuses the store. Read as text on purpose — a list is a list.
 */
const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8')

/** The quoted names inside the bracketed literal that follows `head`. */
function setIn(source: string, head: string, open: string, close: string): Set<string> {
  const start = source.indexOf(head)
  if (start < 0) throw new Error(`${head} not found`)
  const a = source.indexOf(open, start)
  const b = source.indexOf(close, a)
  const body = source.slice(a, b)
  return new Set([...body.matchAll(/['"]([a-z_]+)['"]/g)].map((m) => m[1]))
}

/** Kinds only the frontend ever produces — the backend never emits them, so they are not in its set. */
const FRONTEND_BORN = new Set(['figure_refused', 'check_failed'])

describe('the writer and the backend agree on which findings block', () => {
  const backend = setIn(
    read('../../../../backend/src/prism_lca/engine/report_prompts.py'),
    'ADVISORY_FINDINGS = frozenset(',
    '{',
    '}'
  )
  const writer = setIn(read('./writer/dialogue.ts'), 'export const ADVISORY_FINDINGS = new Set([', '[', ']')

  it('reads both lists', () => {
    expect(backend.size).toBeGreaterThan(3)
    expect(writer.size).toBeGreaterThan(3)
  })

  it('every advisory kind of the backend is advisory in the writer', () => {
    for (const kind of backend) expect(writer.has(kind), `writer lacks ${kind}`).toBe(true)
  })

  it('the writer adds only its own kinds', () => {
    for (const kind of writer) {
      if (!backend.has(kind))
        expect(FRONTEND_BORN.has(kind), `${kind} is in a frontend list but not the backend's`).toBe(true)
    }
  })

  it('the writer knows exactly the contract the backend blocks on after a reading', () => {
    const contract = setIn(
      read('../../../../backend/src/prism_lca/engine/report_review.py'),
      'CONTRACT_FINDINGS = frozenset(',
      '{',
      '}'
    )
    const mine = setIn(read('./writer/dialogue.ts'), 'export const CONTRACT_FINDINGS = new Set([', '[', ']')
    expect(contract.size).toBeGreaterThan(3)
    expect([...mine].sort()).toEqual([...contract].sort())
  })
})
