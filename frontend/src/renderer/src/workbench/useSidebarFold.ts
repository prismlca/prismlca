/**
 * Whether the navigation rail is folded to its icon strip, and who decided it.
 *
 * The window's width sets the starting point: below 1400 px the rail's 224 px are a quarter of what the
 * canvas has left between the search panel and the inspector, so a narrow window opens with the strip
 * and a wide one with the full rail. Every time the window crosses that width the rail follows it; in
 * between, the fold button and the strip decide, and their choice holds until the next crossing.
 * Nothing is stored — the next start reads the width again.
 */
import { useCallback, useEffect, useState } from 'react'

/** Below this window width the rail starts folded. */
export const NARROW_WINDOW = '(width < 1400px)'

export interface SidebarFold {
  collapsed: boolean
  /** The window's width folded or unfolded the rail, not a click. Such a change is not animated: the
   *  whole layout is jumping with the window already, and at start the window is maximised under a
   *  page that was laid out at its unmaximised size — a rail sliding open would be the first thing seen. */
  byWindow: boolean
  toggle: (next: boolean) => void
}

export function useSidebarFold(): SidebarFold {
  const [fold, setFold] = useState(() => ({
    collapsed: window.matchMedia(NARROW_WINDOW).matches,
    byWindow: true
  }))
  useEffect(() => {
    const narrow = window.matchMedia(NARROW_WINDOW)
    const follow = (): void => setFold({ collapsed: narrow.matches, byWindow: true })
    // The window may have crossed the width between the first render and this subscription — it is
    // maximised right after the page loads — and that crossing fires no event here. No click can
    // have come in between, so there is no choice of the user's to overwrite.
    setFold((seen) =>
      seen.collapsed === narrow.matches ? seen : { collapsed: narrow.matches, byWindow: true }
    )
    narrow.addEventListener('change', follow)
    return () => narrow.removeEventListener('change', follow)
  }, [])
  const toggle = useCallback((next: boolean) => setFold({ collapsed: next, byWindow: false }), [])
  return { ...fold, toggle }
}
