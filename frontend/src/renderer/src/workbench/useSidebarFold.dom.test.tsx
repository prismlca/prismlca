import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { NARROW_WINDOW, useSidebarFold } from './useSidebarFold'

/**
 * The rail follows the window's width at start and every time the window crosses the threshold, and
 * follows the user in between. The media query is the only thing that knows the width, so the test
 * stands in for it: one list whose `matches` it sets and whose listeners it calls.
 */
let narrow = false
let listeners: Array<() => void> = []
/** Called with the running count each time the hook asks for the media query. */
let onAsk: (count: number) => void = () => {}
const cross = (next: boolean): void => {
  narrow = next
  act(() => listeners.forEach((l) => l()))
}

beforeEach(() => {
  narrow = false
  listeners = []
  onAsk = () => {}
  let asked = 0
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
    onAsk(++asked)
    return {
      get matches() {
        return query === NARROW_WINDOW && narrow
      },
      media: query,
      addEventListener: (_: string, l: () => void) => listeners.push(l),
      removeEventListener: (_: string, l: () => void) => {
        listeners = listeners.filter((x) => x !== l)
      }
    } as unknown as MediaQueryList
  })
})
afterEach(() => vi.restoreAllMocks())

describe('useSidebarFold', () => {
  it('starts with the full rail in a wide window and with the strip in a narrow one', () => {
    expect(renderHook(() => useSidebarFold()).result.current.collapsed).toBe(false)
    narrow = true
    const folded = renderHook(() => useSidebarFold()).result.current
    expect(folded.collapsed).toBe(true)
    // The first layout is the window's doing, so nothing slides when the window is maximised under it.
    expect(folded.byWindow).toBe(true)
  })

  it('catches a crossing that happened between the first render and the subscription', () => {
    // The page is laid out narrow, the window is maximised, and only then do the effects run: the
    // change event is gone by the time anyone listens for it.
    narrow = true
    onAsk = (count) => {
      if (count === 2) narrow = false
    }
    const { result } = renderHook(() => useSidebarFold())
    expect(result.current).toMatchObject({ collapsed: false, byWindow: true })
  })

  it('follows the window across the threshold, in both directions', () => {
    const { result } = renderHook(() => useSidebarFold())
    cross(true)
    expect(result.current).toMatchObject({ collapsed: true, byWindow: true })
    cross(false)
    expect(result.current).toMatchObject({ collapsed: false, byWindow: true })
  })

  it('a click holds until the window crosses the threshold again', () => {
    narrow = true
    const { result } = renderHook(() => useSidebarFold())
    act(() => result.current.toggle(false))
    // Unfolded by hand in a narrow window: it stays, and this change is the animated kind.
    expect(result.current).toMatchObject({ collapsed: false, byWindow: false })
    cross(false)
    expect(result.current.collapsed).toBe(false)
    act(() => result.current.toggle(true))
    expect(result.current).toMatchObject({ collapsed: true, byWindow: false })
    cross(true)
    cross(false)
    expect(result.current).toMatchObject({ collapsed: false, byWindow: true })
  })

  it('stops listening when it unmounts', () => {
    const { unmount } = renderHook(() => useSidebarFold())
    expect(listeners).toHaveLength(1)
    unmount()
    expect(listeners).toHaveLength(0)
  })
})
