import { describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { useTurnFeed } from '../chat/turnView'
import { renderWithPrism } from '../test/render'
import { useAiEditRefresh } from './useAiEditRefresh'

/** The Workbench holds the turn feed and this hook for its whole lifetime; this stands in for it. */
function Holder({ activeDb, refresh }: { activeDb: string | null; refresh: () => void }): null {
  useTurnFeed()
  useAiEditRefresh(activeDb, refresh)
  return null
}

const settle = async (): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
}

describe('assistant edits and the reload that follows them', () => {
  it('coalesce a burst into one reload, with the canvas only for the model on screen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const refresh = vi.fn()
      const { prism } = renderWithPrism(<Holder activeDb="b" refresh={refresh} />)
      act(() => {
        for (let i = 0; i < 5; i++) prism.emit({ chatId: 'chat-b', type: 'refresh', database: 'b' })
      })
      expect(refresh).not.toHaveBeenCalled() // not before the burst has settled
      await settle()
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(refresh).toHaveBeenLastCalledWith({ canvas: true, fit: false })

      act(() => prism.emit({ chatId: 'chat-a', type: 'refresh', database: 'a' }))
      await settle()
      expect(refresh).toHaveBeenLastCalledWith({ canvas: false, fit: false })
      // An edit that did not touch the graph (study, scenarios) reloads the rest only.
      act(() => prism.emit({ chatId: 'chat-b', type: 'refresh', database: 'b', graph: false }))
      await settle()
      expect(refresh).toHaveBeenLastCalledWith({ canvas: false, fit: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('follow the model on screen as it changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const refresh = vi.fn()
      const { prism, rerender } = renderWithPrism(<Holder activeDb="a" refresh={refresh} />)
      rerender(<Holder activeDb="b" refresh={refresh} />)
      act(() => prism.emit({ chatId: 'chat-b', type: 'refresh', database: 'b' }))
      await settle()
      expect(refresh).toHaveBeenLastCalledWith({ canvas: true, fit: false })
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * After a turn that added or removed boxes, the canvas is fitted to the view — once, when the turn
   * ends, merged into its last reload (the new processes used to sit outside the frame).
   * Not during the run, not after a turn that only changed numbers, and not for another model.
   */
  it('fit the canvas when a turn that changed its structure ends, and only then', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const refresh = vi.fn()
      const { prism } = renderWithPrism(<Holder activeDb="b" refresh={refresh} />)

      // Mid-run: the structure changed, the canvas reloads, the view stays where the user put it.
      act(() =>
        prism.emit({ chatId: 'chat-b', type: 'refresh', database: 'b', graph: true, structure: true })
      )
      await settle()
      expect(refresh).toHaveBeenLastCalledWith({ canvas: true, fit: false })
      // The turn's own final reconcile and its end arrive together: one reload, with the fit.
      act(() => prism.emit({ chatId: 'chat-b', type: 'refresh', database: 'b' }))
      act(() => prism.emit({ chatId: 'chat-b', type: 'done', text: 'Built.' }))
      await settle()
      expect(refresh).toHaveBeenLastCalledWith({ canvas: true, fit: true })

      // A turn that only set a parameter: the arrows' amounts reload, the framing is left alone.
      refresh.mockClear()
      act(() => prism.emit({ chatId: 'chat-b', type: 'refresh', database: 'b', graph: true }))
      act(() => prism.emit({ chatId: 'chat-b', type: 'done', text: 'Set.' }))
      await settle()
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(refresh).toHaveBeenLastCalledWith({ canvas: true, fit: false })

      // A run that failed half-way has still put its boxes on the canvas.
      refresh.mockClear()
      act(() =>
        prism.emit({ chatId: 'chat-b', type: 'refresh', database: 'b', graph: true, structure: true })
      )
      act(() => prism.emit({ chatId: 'chat-b', type: 'error', message: 'Provider down' }))
      await settle()
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(refresh).toHaveBeenLastCalledWith({ canvas: true, fit: true })

      // Boxes added to ANOTHER model: nothing to fit on this canvas.
      refresh.mockClear()
      act(() =>
        prism.emit({ chatId: 'chat-a', type: 'refresh', database: 'a', graph: true, structure: true })
      )
      act(() => prism.emit({ chatId: 'chat-a', type: 'done', text: 'A done' }))
      await settle()
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(refresh).toHaveBeenLastCalledWith({ canvas: false, fit: false })
    } finally {
      vi.useRealTimers()
    }
  })
})
