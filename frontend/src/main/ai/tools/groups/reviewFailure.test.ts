import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolCtx } from '../context'
import { TOOL_BY_NAME } from '../index'
import { NO_CRITICAL_REVIEW } from './reviewFailure'

type Review = Awaited<ReturnType<NonNullable<ToolCtx['review']>>>

const TIMEOUT: Review = { text: '', outcome: 'timeout', reasoning_chars: 152_000, attempts: 2, ms: 960_000 }
const EMPTY: Review = { text: '', outcome: 'empty', reasoning_chars: 41_000, attempts: 2, ms: 113_000 }
const ERROR: Review = {
  text: '',
  outcome: 'error',
  error: 'HTTP 503',
  reasoning_chars: 0,
  attempts: 2,
  ms: 2_000
}
const OK: Review = { text: 'Blocking: none', outcome: 'ok', reasoning_chars: 0, attempts: 1, ms: 70_000 }

/**
 * A chat on one model: `processes` is what the model's process listing answers, `next` what the reviewer
 * answers — both changeable between calls, as a write to the model or a slow reviewer would change them.
 */
function chat(chatId: string | undefined, reviewModel = 'mistral-large-4') {
  const state = {
    processes: [{ code: 'a', name: 'wheelbarrow', exchanges: [{ amount: 1 }] }] as unknown,
    next: TIMEOUT,
    reviews: 0,
    reviewModel
  }
  const call = async (): Promise<any> =>
    JSON.parse(
      (await TOOL_BY_NAME.review_model.run({}, {
        api: async (method, path) => {
          if (path.includes('/model/activities/')) {
            if (state.processes instanceof Error) throw state.processes
            return state.processes
          }
          if (method === 'POST' && path === '/api/v1/provenance/review') return { id: 'r1' }
          return {}
        },
        ui: async () => ({}),
        activeDb: 'wheelbarrow',
        chatId,
        reviewModel: state.reviewModel,
        review: async () => (state.reviews++, state.next)
      } as ToolCtx)) as string
    )
  return { state, call }
}

/**
 * One review by a slow reasoner timed out twice (600 s + 360 s), the assistant called the tool again at
 * once, and the same sixteen minutes went by a second time. A review without a result is not repeated on
 * the same model with the same reviewer in the same chat; anything that could change the outcome lets it
 * run again.
 */
describe('a review without a result is not run again on an unchanged model', () => {
  it('answers a second call at once with the first outcome, without the reviewer', async () => {
    const { state, call } = chat('chat-1')
    const first = await call()
    expect(first.review_failed).toBe('timeout')
    expect(state.reviews).toBe(1)

    const second = await call()
    expect(state.reviews).toBe(1) // the reviewer was not asked again
    expect(second.review).toBeNull()
    expect(second.review_failed).toBe('timeout')
    expect(second.not_run_again).toBe(true)
    // It quotes what the first attempt found, so the model can tell the user how long it ran.
    expect(second.detail).toContain(first.detail)
    expect(second.note).toMatch(/^Continue without a review and tell the user/)
  })

  it('runs again once the model has been written to', async () => {
    const { state, call } = chat('chat-2')
    await call()
    state.processes = [{ code: 'a', name: 'wheelbarrow', exchanges: [{ amount: 2 }] }]
    state.next = OK
    const after = await call()
    expect(state.reviews).toBe(2)
    expect(after.review).toBe('Blocking: none')
  })

  it('runs again with another review model', async () => {
    const { state, call } = chat('chat-3')
    await call()
    state.reviewModel = 'claude-sonnet-5-5'
    await call()
    expect(state.reviews).toBe(2)
  })

  it('remembers an empty answer as well, but never a provider that could not be reached', async () => {
    const empty = chat('chat-4')
    empty.state.next = EMPTY
    await empty.call()
    expect((await empty.call()).not_run_again).toBe(true)
    expect(empty.state.reviews).toBe(1)

    const down = chat('chat-5')
    down.state.next = ERROR
    const first = await down.call()
    expect(first.note).toMatch(/Call review_model again later/)
    await down.call()
    expect(down.state.reviews).toBe(2)
  })

  it('forgets the failure after a review with a result', async () => {
    const { state, call } = chat('chat-6')
    const original = state.processes
    await call() // timed out
    state.processes = [{ code: 'a', name: 'wheelbarrow', exchanges: [{ amount: 2 }] }]
    state.next = OK
    await call() // reviewed
    state.processes = original // undone: the model is the one that timed out before
    state.next = TIMEOUT
    await call()
    expect(state.reviews).toBe(3)
  })

  it('holds back only in the same chat, and never when the processes could not be read', async () => {
    const a = chat('chat-7')
    await a.call()
    const b = chat('chat-8')
    await b.call()
    expect(b.state.reviews).toBe(1)

    const unread = chat('chat-9')
    unread.state.processes = new Error('backend exploded')
    await unread.call()
    const again = await unread.call()
    expect(unread.state.reviews).toBe(2)
    expect(again.note).not.toMatch(/gives this same answer/)

    const outside = chat(undefined)
    await outside.call()
    await outside.call()
    expect(outside.state.reviews).toBe(2)
  })
})

/**
 * After both attempts had timed out, the assistant wrote "an internal AI second opinion was obtained" into
 * critical_review — against the note it had just been given. The answer now names the sentence that belongs
 * there, the same one the health check gives.
 */
describe('a review without a result says what goes into critical_review', () => {
  it('names the honest sentence and keeps the attempt out of the field', async () => {
    for (const next of [TIMEOUT, EMPTY, ERROR]) {
      const { state, call } = chat(`chat-field-${next.outcome}`)
      state.next = next
      const out = await call()
      expect(out.note).toContain(`"${NO_CRITICAL_REVIEW}"`)
      expect(out.note).toMatch(/do not present the study as reviewed/)
      expect(out.note).toMatch(/This attempt does not belong in model_info critical_review/)
      expect(out.note).toMatch(
        /leave that field as it is if it names a critical review by independent experts/
      )
    }
  })

  it('gives the same sentence as the health check', () => {
    const backend = readFileSync(
      join(__dirname, '../../../../../../backend/src/prism_lca/engine/health_study.py'),
      'utf8'
    )
    const m = /^NO_CRITICAL_REVIEW = "(.+)"$/m.exec(backend)
    expect(m?.[1]).toBe(NO_CRITICAL_REVIEW)
  })
})
