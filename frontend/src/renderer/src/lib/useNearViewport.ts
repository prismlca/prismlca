import { useEffect, useState, type RefObject } from 'react'

/** The nearest ancestor that scrolls vertically; null = the window. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if (o === 'auto' || o === 'scroll') return p
  }
  return null
}

/**
 * Whether the element is in view or within `margin` pixels of it, in the box that scrolls it.
 *
 * Observed against the scroll container rather than the window: a margin around the window does not
 * reach past the container's own clipping, so an element just below a scrolled panel's edge would count
 * as far away until it was already showing. Without IntersectionObserver every element counts as near.
 */
export function useNearViewport(ref: RefObject<HTMLElement>, margin = 600): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1]
        if (last) setNear(last.isIntersecting)
      },
      { root: scrollParent(el), rootMargin: `${margin}px 0px` }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, margin])
  return near
}
