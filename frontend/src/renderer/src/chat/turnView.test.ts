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

  it('leaves the view alone for events that are not the turn', () => {
    const v = fold([[tool('search', 'start'), 1]])!
    expect(foldTurn(v, { chatId: 'c', type: 'steer', queued: ['kg'] }, 2)).toBe(v)
    expect(foldTurn(undefined, { chatId: 'c', type: 'refresh' }, 2)).toBeUndefined()
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
