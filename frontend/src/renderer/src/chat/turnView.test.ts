import { describe, expect, it } from 'vitest'
import type { AiEvent } from '../lib/ai'
import { emptyTurn, foldTurn, handleTurnEvent, onChatEvent, turnOf, type TurnView } from './turnView'

/** Fold a run of events, each at its own time, from no view at all. */
const fold = (events: Array<[AiEvent, number]>, from?: TurnView): TurnView | undefined =>
  events.reduce<TurnView | undefined>((v, [ev, at]) => foldTurn(v, ev, at), from)

const tool = (name: string, phase: 'start' | 'progress' | 'done' | 'error', extra = {}): AiEvent => ({
  chatId: 'c',
  type: 'tool',
  name,
  phase,
  ...extra
})

describe('the turn view of one chat', () => {
  it('keeps every row with the time it started, and closes the newest open row of that tool', () => {
    const v = fold([
      [tool('search', 'start', { args: '{"q":"PET"}' }), 1_000],
      [tool('search', 'done', { ms: 900, preview: '3 hits' }), 1_900],
      [tool('search', 'start'), 2_000],
      [tool('calculate', 'start'), 2_100],
      [tool('search', 'progress', { detail: 'page 2' }), 2_500]
    ])!
    expect(v.live.map((t) => [t.name, t.status ?? 'running'])).toEqual([
      ['search', 'ok'],
      ['search', 'running'],
      ['calculate', 'running']
    ])
    expect(v.started).toEqual([1_000, 2_000, 2_100])
    expect(v.live[0]).toMatchObject({ args: '{"q":"PET"}', ms: 900, preview: '3 hits' })
    expect(v.live[1].detail).toBe('page 2')
  })

  it('marks a returned refusal rejected and a thrown one failed', () => {
    const v = fold([
      [tool('edit_exchange', 'start'), 0],
      [tool('edit_exchange', 'done', { soft: 'unit mismatch' }), 1],
      [tool('calculate', 'start'), 2],
      [tool('calculate', 'error', { detail: 'HTTP 500' }), 3]
    ])!
    expect(v.live.map((t) => [t.status, t.detail])).toEqual([
      ['rejected', 'unit mismatch'],
      ['error', 'HTTP 500']
    ])
  })

  it('starts the thinking clock anew after each call and on a restarted round, never on text', () => {
    const v = fold([
      [tool('search', 'start'), 1_000],
      [tool('search', 'done'), 4_000]
    ])!
    expect(v.thinkingAt).toBe(4_000)
    const restarted = foldTurn(
      { ...v, reasoning: 800 },
      { chatId: 'c', type: 'round-restart', reason: 'empty' },
      9_000
    )!
    expect(restarted).toMatchObject({ thinkingAt: 9_000, reasoning: 0, restarts: 1 })
    const writing = foldTurn(restarted, { chatId: 'c', type: 'delta', text: 'Done' }, 9_500)!
    expect(writing).toMatchObject({ thinkingAt: 9_000, restarts: 0, streaming: 'Done' })
  })

  it('drops the view with done or error, and a later event begins a fresh one', () => {
    const v = fold([[{ chatId: 'c', type: 'delta', text: 'partial' }, 1]])!
    expect(foldTurn(v, { chatId: 'c', type: 'error', message: 'HTTP 502' }, 2)).toBeUndefined()
    expect(foldTurn(v, { chatId: 'c', type: 'done', text: 'partial' }, 2)).toBeUndefined()
    expect(foldTurn(undefined, tool('search', 'start'), 10)).toMatchObject({
      streaming: '',
      live: [{ name: 'search' }],
      thinkingAt: 10
    })
  })

  it("ends with its run, but a newer send's view outlives the old run's end", () => {
    const run = (runId: string, state: 'running' | 'stopped' | 'idle'): AiEvent => ({
      chatId: 'c',
      type: 'run',
      run: { runId, state }
    })
    // A delta in flight when Stop was pressed lands after the view was dropped and makes a new one;
    // a stopped run sends no done, so its run event is what clears it.
    const tail = foldTurn(undefined, { chatId: 'c', type: 'delta', text: 'and the ca' }, 1)
    expect(foldTurn(tail, run('r1', 'stopped'), 2)).toBeUndefined()
    // Sent again at once: the old run's end must not take the new turn with it.
    const sent = { ...emptyTurn(3), runId: null }
    expect(foldTurn(sent, run('r1', 'stopped'), 4)).toBe(sent)
    const named = foldTurn(sent, run('r2', 'running'), 5)!
    expect(named).toMatchObject({ runId: 'r2', thinkingAt: 3 })
    expect(foldTurn(named, run('r1', 'stopped'), 6)).toBe(named)
    expect(foldTurn(named, run('r2', 'idle'), 7)).toBeUndefined()
  })

  it('closes each of two parallel calls of one tool in its own row when they end in reverse order', () => {
    // The second call is refused at once and ends first; by name it used to land in the first row.
    const v = fold([
      [tool('search_background', 'start', { callId: '2.0', args: '{"query":"widget"}' }), 1_000],
      [tool('search_background', 'start', { callId: '2.1', args: '{}' }), 1_000],
      [tool('search_background', 'done', { callId: '2.1', soft: 'Pass query.', ms: 0 }), 1_001],
      [tool('search_background', 'done', { callId: '2.0', preview: '8 hits', ms: 466 }), 1_466]
    ])!
    expect(v.live.map((t) => [t.args, t.status, t.detail ?? t.preview])).toEqual([
      ['{"query":"widget"}', 'ok', '8 hits'],
      ['{}', 'rejected', 'Pass query.']
    ])
    expect(v.ids).toEqual(['2.0', '2.1'])
  })

  it('falls back to the newest open row of the tool for an event without a call key', () => {
    const v = fold([
      [tool('research_web', 'start', { callId: '0.0' }), 1],
      [tool('research_web', 'start', { callId: '0.1' }), 1],
      [tool('research_web', 'progress', { detail: 'leg 2 of 3' }), 2]
    ])!
    expect(v.live.map((t) => t.detail)).toEqual([undefined, 'leg 2 of 3'])
    // A key nobody started under closes nothing — never a row of another call.
    expect(
      foldTurn(v, tool('research_web', 'done', { callId: '9.9' }), 3)!.live.every((t) => !t.status)
    ).toBe(true)
  })

  it('shows what holds for the cache now, and keeps a recovered failure visible until the run ends', () => {
    const warn = (pattern: 'dropped' | 'stuck' | 'recovered'): AiEvent => ({
      chatId: 'c',
      type: 'cache-warning',
      pattern
    })
    const v = fold([
      [warn('stuck'), 1],
      [{ chatId: 'c', type: 'delta', text: 'Linking.' }, 2],
      [warn('recovered'), 3]
    ])!
    expect(v.cacheWarning).toBe('stuck-recovered')
    expect(foldTurn(v, warn('dropped'), 4)!.cacheWarning).toBe('dropped')
    expect(foldTurn(v, warn('recovered'), 4)!.cacheWarning).toBe('stuck-recovered')
    // A recovery with nothing raised before it says nothing.
    expect(fold([[warn('recovered'), 1]])?.cacheWarning).toBeUndefined()
    expect(foldTurn(v, { chatId: 'c', type: 'done', text: 'Linking.' }, 4)).toBeUndefined()
  })

  it('leaves the view alone for events that are not the turn', () => {
    const v = fold([[tool('search', 'start'), 1]])!
    expect(foldTurn(v, { chatId: 'c', type: 'steer', queued: ['kg'] }, 2)).toBe(v)
    expect(foldTurn(undefined, { chatId: 'c', type: 'refresh' }, 2)).toBeUndefined()
  })
})

describe('a request the provider refused, sent again', () => {
  const wait: AiEvent = {
    chatId: 'c',
    type: 'retry',
    phase: 'wait',
    cause: 'busy',
    detail: 'overloaded (529)',
    attempt: 2,
    until: 12_000
  }

  it('shows the wait, then the attempt under way with a fresh thinking clock', () => {
    const waiting = fold([[wait, 5_000]], { ...emptyTurn(1_000), reasoning: 900 })!
    expect(waiting.retry).toEqual({
      phase: 'wait',
      cause: 'busy',
      detail: 'overloaded (529)',
      attempt: 2,
      until: 12_000
    })
    // The wait keeps the old clock: nothing new has started yet.
    expect(waiting.thinkingAt).toBe(1_000)
    const sending = foldTurn(waiting, { chatId: 'c', type: 'retry', phase: 'send', attempt: 2 }, 12_000)!
    expect(sending).toMatchObject({ retry: { phase: 'send', attempt: 2 }, thinkingAt: 12_000, reasoning: 0 })
  })

  it('clears the note as soon as the round produces anything', () => {
    for (const ev of [
      { chatId: 'c', type: 'delta', text: 'Hi' },
      { chatId: 'c', type: 'reasoning', chars: 400 },
      tool('search', 'start'),
      { chatId: 'c', type: 'round-restart', reason: 'empty' }
    ] as AiEvent[])
      expect(
        fold([
          [wait, 1],
          [ev, 2]
        ])!.retry
      ).toBeUndefined()
  })
})

describe('the store', () => {
  // Main sends an `error` after `done` when the answer could not be saved, and relies on the renderer
  // holding no partial text by then: a turn kept past `done` would put the answer in twice.
  it('hands a done its turn as it stood, and an error after it nothing', () => {
    const seen: Array<[string, string | undefined]> = []
    const off = onChatEvent((ev, before) => seen.push([ev.type, before?.streaming]))
    try {
      handleTurnEvent({ chatId: 's', type: 'delta', text: 'The bottle' }, 1)
      handleTurnEvent({ chatId: 's', type: 'done', text: '' }, 2)
      handleTurnEvent({ chatId: 's', type: 'error', message: 'could not be saved' }, 3)
    } finally {
      off()
    }
    expect(seen).toEqual([
      ['delta', undefined],
      ['done', 'The bottle'],
      ['error', undefined]
    ])
    expect(turnOf('s')).toBeUndefined()
  })
})
