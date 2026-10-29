import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { makePrism } from '../test/prism'
import { useSearchIndexStatus } from './useSearchIndexStatus'

/**
 * The poll runs for the lifetime of the app, and whatever it hands back reaches the Workbench — and
 * through it the chat, whose transcript re-parses every message's Markdown on each render (11.09.2026).
 * So what is asserted here is not the polling but the SILENCE: an unchanged status must keep its
 * identity, or an idle window does the work of a whole conversation six times a minute.
 */
const IDLE = { state: 'idle' as const, database: null, detail: '', count: 0, total: 0 }

/** The fixture only becomes the app's bridge once it is installed on the window. */
function install(routes: Parameters<typeof makePrism>[0]): void {
  ;(window as unknown as { prism: unknown }).prism = makePrism(routes).prism
}

describe('the search-index poll', () => {
  it('keeps the same object while nothing changes', async () => {
    vi.useFakeTimers()
    try {
      install({ 'GET /api/v1/search/status': () => ({ ...IDLE }) })
      const { result } = renderHook(() => useSearchIndexStatus())
      await vi.waitFor(() => expect(result.current).not.toBeNull())
      const first = result.current
      // Three more polls, each answering with a FRESH object carrying the same values — which is
      // exactly what IPC does.
      for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(10_000)
      expect(result.current).toBe(first)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still passes progress through while a build runs', async () => {
    vi.useFakeTimers()
    try {
      let count = 0
      install({
        'GET /api/v1/search/status': () => ({
          state: 'running',
          database: 'ecoinvent',
          detail: 'indexing',
          count: (count += 100),
          total: 1000
        })
      })
      const { result } = renderHook(() => useSearchIndexStatus())
      await vi.waitFor(() => expect(result.current?.count).toBe(100))
      // A running build polls every 1.5 s; the bar must follow, so a changed count MUST come through.
      await vi.advanceTimersByTimeAsync(1_500)
      await vi.waitFor(() => expect(result.current?.count).toBe(200))
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes a newly queued database through while the count stands still', async () => {
    vi.useFakeTimers()
    try {
      const running = { state: 'running', database: 'ecoinvent', detail: 'indexing', count: 100, total: 1000 }
      let queued: string[] = []
      install({ 'GET /api/v1/search/status': () => ({ ...running, queued: [...queued] }) })
      const { result } = renderHook(() => useSearchIndexStatus())
      await vi.waitFor(() => expect(result.current?.queued).toEqual([]))
      // An import finished meanwhile: only the queue changed, and the panel must still hear of it.
      queued = ['bafu-2026-v1']
      await vi.advanceTimersByTimeAsync(1_500)
      await vi.waitFor(() => expect(result.current?.queued).toEqual(['bafu-2026-v1']))
    } finally {
      vi.useRealTimers()
    }
  })
})
