import { act, renderHook } from '@testing-library/react'
import type { UIEvent } from 'react'
import { describe, expect, it } from 'vitest'
import { useStickToBottom } from './useStickToBottom'

/** A transcript of `height` px showing `view` px, its scroll position kept by hand (jsdom lays nothing out). */
function transcript(height: number, view = 100) {
  const el = document.createElement('div')
  const box = { height, top: 0 }
  Object.defineProperty(el, 'scrollHeight', { get: () => box.height })
  Object.defineProperty(el, 'clientHeight', { get: () => view })
  Object.defineProperty(el, 'scrollTop', {
    get: () => box.top,
    set: (v: number) => (box.top = Math.max(0, Math.min(v, box.height - view)))
  })
  el.scrollTo = ((o: ScrollToOptions) => (el.scrollTop = o.top ?? 0)) as typeof el.scrollTo
  return { el, box }
}

function setup(height = 1000) {
  const t = transcript(height)
  const ref = { current: t.el }
  const hook = renderHook(() => useStickToBottom(ref))
  /** The reader (or the follow scroll) moved the view: the browser's scroll event. */
  const scrolled = (top: number): void => {
    t.el.scrollTop = top
    act(() => hook.result.current.onScroll({ currentTarget: t.el } as unknown as UIEvent<HTMLDivElement>))
  }
  /** Output arrived: the transcript grew, and the panel rendered. */
  const grew = (by: number): void => {
    t.box.height += by
    hook.rerender()
  }
  return { ...t, hook, scrolled, grew }
}

describe('the transcript follows the output', () => {
  it('keeps the end in view while the reader is there', () => {
    const t = setup()
    t.grew(200)
    expect(t.el.scrollTop).toBe(1100) // 1200 tall, 100 shown
    expect(t.hook.result.current.atBottom).toBe(true)
  })

  it('lets go when the reader scrolls up, however fast the output comes', () => {
    const t = setup()
    t.grew(0)
    t.scrolled(600)
    t.grew(50)
    t.grew(50)
    expect(t.el.scrollTop).toBe(600)
    expect(t.hook.result.current.atBottom).toBe(false)
  })

  it('follows again once the reader is back at the end', () => {
    const t = setup()
    t.grew(0)
    t.scrolled(500)
    t.scrolled(890) // within the slack of the end (900)
    t.grew(100)
    expect(t.el.scrollTop).toBe(1000)
  })

  it('keeps following when its own scroll lands short of a big jump in the output', () => {
    const t = setup()
    t.grew(0)
    t.scrolled(900)
    // Output grew by more than the slack before the browser reported the follow scroll: the view is
    // off the end, but it moved down, not up — that is not the reader leaving.
    t.box.height += 400
    t.scrolled(950)
    t.grew(0)
    expect(t.el.scrollTop).toBe(1300)
  })

  it('follows again after a send, and the jump button goes to the end at once', () => {
    const t = setup()
    t.grew(0)
    t.scrolled(200)
    act(() => t.hook.result.current.follow())
    t.grew(100)
    expect(t.el.scrollTop).toBe(1000)
    t.scrolled(300)
    act(() => t.hook.result.current.toBottom())
    expect(t.el.scrollTop).toBe(1000)
    expect(t.hook.result.current.atBottom).toBe(true)
  })
})
