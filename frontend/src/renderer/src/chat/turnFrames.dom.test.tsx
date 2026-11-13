import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dropTurn, handleTurnEvent, startTurn, turnOf, useTurnView } from './turnView'

/**
 * Streamed text is folded into the store at once but announced to the panel once per frame: every
 * announcement re-renders the panel and parses the answer's Markdown again.
 */
describe('streamed text, announced once per frame', () => {
  afterEach(() => {
    act(() => dropTurn('f'))
    vi.unstubAllGlobals()
  })

  it('folds every piece at once, announces the text with the next frame, and anything else at once', () => {
    const frames: Array<FrameRequestCallback | null> = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => (frames[id - 1] = null))
    const { result } = renderHook(() => useTurnView('f'))
    act(() => startTurn('f', 0))

    act(() => {
      handleTurnEvent({ chatId: 'f', type: 'delta', text: 'The ' }, 1)
      handleTurnEvent({ chatId: 'f', type: 'delta', text: 'bottle' }, 2)
    })
    expect(turnOf('f')?.streaming).toBe('The bottle')
    expect(result.current.streaming).toBe('')
    expect(frames).toHaveLength(1)
    act(() => frames[0]?.(0))
    expect(result.current.streaming).toBe('The bottle')

    // A tool call is announced at once, and takes the text still waiting for its frame along.
    act(() => {
      handleTurnEvent({ chatId: 'f', type: 'delta', text: ' is modelled' }, 3)
      handleTurnEvent({ chatId: 'f', type: 'tool', name: 'calculate', phase: 'start' }, 4)
    })
    expect(result.current.streaming).toBe('The bottle is modelled')
    expect(result.current.live.map((t) => t.name)).toEqual(['calculate'])
    expect(frames[1]).toBeNull()
  })
})
