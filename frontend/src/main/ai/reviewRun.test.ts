import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamChatOpts, StreamEvent } from './providers/types'
import { FIRST_ATTEMPT_MS, RESTART_MS, restartEffort, restartNote, runReview } from './reviewRun'

/**
 * The review's clock: ten minutes for the first attempt, one restart with a six-minute deadline it is
 * told about, low effort only where the catalogue row offers it, and what is kept when time runs out.
 * Run on a fake clock — the real one would make each case a quarter of an hour.
 */

/** One scripted attempt: events to send, then either finish or hang until the request is aborted. */
type Script = { events: StreamEvent[]; hang?: boolean }

function fakeStream(scripts: Script[]): {
  stream: (o: StreamChatOpts) => AsyncIterable<StreamEvent>
  calls: StreamChatOpts[]
} {
  const calls: StreamChatOpts[] = []
  const stream = (o: StreamChatOpts): AsyncIterable<StreamEvent> => {
    const script = scripts[calls.length] ?? { events: [] }
    calls.push(o)
    return (async function* () {
      for (const ev of script.events) yield ev
      if (script.hang)
        // A model that keeps thinking: the stream only ends when its signal fires, quietly — the
        // engine returns rather than throws on an abort.
        await new Promise<void>((resolve) => {
          if (o.signal?.aborted) resolve()
          else o.signal?.addEventListener('abort', () => resolve())
        })
    })()
  }
  return { stream, calls }
}

const base = { system: 'SYS', dossier: 'DOSSIER', model: 'test/reviewer-without-row' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('runReview', () => {
  it('returns the first answer as it is: no effort, no deadline note, one attempt', async () => {
    const { stream, calls } = fakeStream([
      {
        events: [
          { type: 'reasoning', chars: 1200 },
          { type: 'delta', text: 'Blocking: none.' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const r = await runReview({ ...base, stream })
    expect(r).toMatchObject({ outcome: 'ok', text: 'Blocking: none.', attempts: 1, reasoning_chars: 1200 })
    expect(r.partial).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0].reasoningEffort).toBeUndefined()
    expect(calls[0].messages[1].content).toBe('DOSSIER')
  })

  it('stops the first attempt after ten minutes and restarts once, told its six-minute deadline', async () => {
    const { stream, calls } = fakeStream([
      { events: [{ type: 'reasoning', chars: 50_000 }], hang: true },
      {
        events: [
          { type: 'delta', text: 'Should fix: the lid.' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const done = runReview({ ...base, stream })
    await vi.advanceTimersByTimeAsync(FIRST_ATTEMPT_MS - 1)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    const r = await done
    expect(r).toMatchObject({ outcome: 'ok', text: 'Should fix: the lid.', attempts: 2 })
    expect(r.partial).toBeUndefined()
    const restart = String(calls[1].messages[1].content)
    expect(restart.startsWith('DOSSIER')).toBe(true)
    expect(restart).toContain('ran for 10 minutes')
    expect(restart).toContain('You have 6 minutes')
    // A model without a catalogue row gets no effort at all: it keeps its own default.
    expect(calls[1].reasoningEffort).toBeUndefined()
  })

  it('keeps what the restart wrote when its deadline passes, marked as cut off', async () => {
    const { stream } = fakeStream([
      { events: [], hang: true },
      { events: [{ type: 'delta', text: 'Blocking: the battery proxy.' }], hang: true }
    ])
    const done = runReview({ ...base, stream })
    await vi.advanceTimersByTimeAsync(FIRST_ATTEMPT_MS + RESTART_MS)
    const r = await done
    expect(r).toMatchObject({ outcome: 'ok', text: 'Blocking: the battery proxy.', partial: true })
  })

  it('times out when neither attempt wrote anything', async () => {
    const { stream } = fakeStream([
      { events: [{ type: 'reasoning', chars: 9000 }], hang: true },
      { events: [{ type: 'reasoning', chars: 4000 }], hang: true }
    ])
    const done = runReview({ ...base, stream })
    await vi.advanceTimersByTimeAsync(FIRST_ATTEMPT_MS + RESTART_MS)
    const r = await done
    expect(r).toMatchObject({ outcome: 'timeout', text: '', attempts: 2, reasoning_chars: 13_000 })
  })

  it("falls back to the first attempt's own text when it was stopped mid-way and the restart wrote nothing", async () => {
    const { stream } = fakeStream([
      { events: [{ type: 'delta', text: 'Blocking: half a finding' }], hang: true },
      { events: [], hang: true }
    ])
    const done = runReview({ ...base, stream })
    await vi.advanceTimersByTimeAsync(FIRST_ATTEMPT_MS + RESTART_MS)
    expect(await done).toMatchObject({ outcome: 'ok', text: 'Blocking: half a finding', partial: true })
  })

  it('an empty answer gets the same restart — one mechanism for both causes', async () => {
    const { stream, calls } = fakeStream([
      { events: [{ type: 'finish', reason: 'length' }] },
      { events: [{ type: 'delta', text: 'Blocking: none' }] }
    ])
    const r = await runReview({ ...base, stream })
    expect(r).toMatchObject({ outcome: 'ok', attempts: 2 })
    const restart = String(calls[1].messages[1].content)
    expect(restart).toContain('contained no text at all')
    expect(restart).toContain('You have 6 minutes')
    expect(calls[1].retry).toBeDefined() // retries stay inside the restart's deadline
  })

  it('reports an empty review when the restart finishes empty too', async () => {
    const { stream } = fakeStream([
      { events: [{ type: 'finish', reason: 'length' }] },
      { events: [{ type: 'finish', reason: 'length' }] }
    ])
    expect(await runReview({ ...base, stream })).toMatchObject({
      outcome: 'empty',
      finish_reason: 'length',
      attempts: 2
    })
  })

  it('a failed stream is restarted without telling the reviewer why; a second failure is an error', async () => {
    const calls: StreamChatOpts[] = []
    const stream = (o: StreamChatOpts): AsyncIterable<StreamEvent> => {
      calls.push(o)
      return (async function* () {
        throw new Error('HTTP 502')
      })()
    }
    const r = await runReview({ ...base, stream })
    expect(r).toMatchObject({ outcome: 'error', error: 'HTTP 502', attempts: 2 })
    const restart = String(calls[1].messages[1].content)
    expect(restart).not.toContain('no text at all')
    expect(restart).toContain('You have 6 minutes')
  })

  it('a stream that breaks off mid-answer is restarted, and its text is the fallback, marked as cut off', async () => {
    const calls: StreamChatOpts[] = []
    const stream = (o: StreamChatOpts): AsyncIterable<StreamEvent> => {
      calls.push(o)
      const first = calls.length === 1
      return (async function* () {
        if (first) yield { type: 'delta', text: 'Blocking: the widget' } as StreamEvent
        throw new Error('connection reset')
      })()
    }
    const r = await runReview({ ...base, stream })
    expect(calls).toHaveLength(2)
    expect(r).toMatchObject({ outcome: 'ok', text: 'Blocking: the widget', partial: true, attempts: 2 })
  })

  it('a stop from the caller ends the review at once, without a restart', async () => {
    const stop = new AbortController()
    const { stream, calls } = fakeStream([{ events: [{ type: 'delta', text: 'Blocking:' }], hang: true }])
    const done = runReview({ ...base, stream, signal: stop.signal })
    const settled = expect(done).rejects.toThrow(/stopped/)
    await vi.advanceTimersByTimeAsync(1000)
    stop.abort()
    await settled
    expect(calls).toHaveLength(1)
  })

  it('tells the run bar how far the reviewer has got, and when it restarts', async () => {
    const notes: string[] = []
    const { stream } = fakeStream([
      {
        events: [
          { type: 'reasoning', chars: 600 },
          { type: 'reasoning', chars: 600 },
          { type: 'reasoning', chars: 13_000 }
        ],
        hang: true
      },
      { events: [{ type: 'delta', text: 'x'.repeat(1500) }] }
    ])
    const done = runReview({ ...base, stream, onProgress: (n) => notes.push(n) })
    await vi.advanceTimersByTimeAsync(FIRST_ATTEMPT_MS)
    await done
    expect(notes[0]).toBe('reasoning, 1.2k characters')
    expect(notes[1]).toBe('reasoning, 14.2k characters')
    expect(notes).toContain('second try, 6 min limit — starting')
    expect(notes.at(-1)).toBe('second try, 6 min limit — writing, 1.5k characters')
  })
})

describe('restartEffort', () => {
  it('asks for "low" only where the catalogue row lists it', () => {
    // GLM 5.3 Flash lists low; MiMo-V2.6-Pro lists none; DeepSeek V4.1 Flash only higher ones; an
    // unknown id has no row.
    expect(restartEffort('z-ai/glm-5.3-flash', 'openrouter')).toBe('low')
    expect(restartEffort('xiaomi/mimo-v2.6-pro', 'openrouter')).toBeUndefined()
    expect(restartEffort('deepseek/deepseek-v4.1-flash', 'openrouter')).toBeUndefined() // high/xhigh only
    expect(restartEffort('nobody/unknown-model', 'openrouter')).toBeUndefined()
  })
})

describe('restartNote', () => {
  it('names the deadline in minutes and asks for findings as they come', () => {
    const n = restartNote('timeout', RESTART_MS)
    expect(n).toContain('You have 6 minutes')
    expect(n).toContain('only what is already written is kept')
  })

  it('keeps a review already received when the spend ceiling trips on its closing usage event', async () => {
    const run = new AbortController()
    const stop = new AbortController()
    const signal = AbortSignal.any([stop.signal, run.signal])
    const { stream, calls } = fakeStream([
      {
        events: [
          { type: 'delta', text: 'Blocking: the proxy for X carries 60 %.' },
          { type: 'finish', reason: 'stop' },
          { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.5 } }
        ]
      }
    ])
    const r = await runReview({ ...base, stream, signal, stop: stop.signal, onCost: () => run.abort() })
    expect(r).toMatchObject({ outcome: 'ok', text: 'Blocking: the proxy for X carries 60 %.', attempts: 1 })
    expect(r.partial).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('counts a review as whole when the engine hands out its finish after the ceiling tripped on its usage', async () => {
    // The engine holds `finish` back until the stream ends; when the provider had completed the reply it
    // hands it out even after the stop — this is that order.
    const run = new AbortController()
    const stop = new AbortController()
    const signal = AbortSignal.any([stop.signal, run.signal])
    const { stream } = fakeStream([
      {
        events: [
          { type: 'delta', text: 'Blocking: none.' },
          { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.5 } },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const r = await runReview({ ...base, stream, signal, stop: stop.signal, onCost: () => run.abort() })
    expect(r).toMatchObject({ outcome: 'ok', text: 'Blocking: none.', attempts: 1 })
    expect(r.partial).toBeUndefined()
  })

  it('marks text cut off when the ceiling trips elsewhere mid-review, and starts no second attempt', async () => {
    // Another call of the run (a research leg, the main loop) spends the last of the budget while the
    // reviewer is still writing: no usage report of its own, no finish — cut off.
    const run = new AbortController()
    const stop = new AbortController()
    const signal = AbortSignal.any([stop.signal, run.signal])
    const { stream, calls } = fakeStream([
      { events: [{ type: 'delta', text: 'Blocking: one.' }], hang: true }
    ])
    const p = runReview({ ...base, stream, signal, stop: stop.signal })
    await vi.advanceTimersByTimeAsync(10)
    run.abort()
    const r = await p
    expect(r).toMatchObject({ outcome: 'ok', text: 'Blocking: one.', partial: true, attempts: 1 })
    expect(calls).toHaveLength(1)
  })

  it("still throws on the user's Stop, whatever arrived", async () => {
    const stop = new AbortController()
    const { stream } = fakeStream([{ events: [{ type: 'delta', text: 'Blocking: one.' }], hang: true }])
    const p = runReview({ ...base, stream, signal: stop.signal, stop: stop.signal })
    await vi.advanceTimersByTimeAsync(10)
    stop.abort()
    await expect(p).rejects.toThrow(/stopped before it finished/)
  })

  it('marks a review cut short by the output limit, also when the ceiling tripped on its usage', async () => {
    const run = new AbortController()
    const stop = new AbortController()
    const signal = AbortSignal.any([stop.signal, run.signal])
    const { stream } = fakeStream([
      {
        events: [
          { type: 'delta', text: 'Blocking: one.' },
          { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.5 } },
          { type: 'finish', reason: 'length' }
        ]
      }
    ])
    const r = await runReview({ ...base, stream, signal, stop: stop.signal, onCost: () => run.abort() })
    expect(r).toMatchObject({ outcome: 'ok', text: 'Blocking: one.', partial: true })
  })

  it('marks a first answer that ended on the output limit as cut short', async () => {
    const { stream, calls } = fakeStream([
      {
        events: [
          { type: 'delta', text: 'Blocking: one.' },
          { type: 'finish', reason: 'length' }
        ]
      }
    ])
    const r = await runReview({ ...base, stream })
    expect(r).toMatchObject({ outcome: 'ok', text: 'Blocking: one.', partial: true, attempts: 1 })
    expect(calls).toHaveLength(1)
  })

  it('marks a reply that ended with no reason at all as cut short', async () => {
    // A stream can close with text and [DONE] but no finish_reason: nothing says the reply was whole.
    const { stream } = fakeStream([{ events: [{ type: 'delta', text: 'Blocking: one.' }] }])
    const r = await runReview({ ...base, stream })
    expect(r).toMatchObject({ outcome: 'ok', text: 'Blocking: one.', partial: true })
  })
})
