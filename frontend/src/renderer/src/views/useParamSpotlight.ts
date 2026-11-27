import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * The parameter a "Used by" link pointed at on the Parameters page: lit until the next click or focus
 * outside its row, scrolled to and focused when it lights up.
 *
 * Making the row reachable — unfolding its group, clearing a search that hides it — is the page's part,
 * because the fold state and the search live there; this keeps which row is lit and lets it go again.
 * The light belongs to one model: `scope` is the open model, and a name lit in one model never lights a
 * namesake in the next.
 */
export function useParamSpotlight(scope: string | null): {
  /** The lit parameter's name, or null. */
  spot: string | null
  /** For the lit row: what is scrolled to and focused, and what a click may land in without ending it. */
  spotRef: RefObject<HTMLDivElement>
  /** Light this parameter. Lighting the one already lit scrolls to it again. */
  show: (name: string) => void
} {
  // A fresh object on every `show`, so a second click on the same link runs the effect below again
  // and brings a row scrolled away since back into view.
  const [lit, setLit] = useState<{ name: string; scope: string | null } | null>(null)
  const spotRef = useRef<HTMLDivElement>(null)
  const spot = lit && lit.scope === scope ? lit.name : null

  useEffect(() => {
    if (!lit) return
    const row = spotRef.current
    // Centred, not "nearest": at the top edge the sticky toolbar of the page would cover the row.
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    row?.scrollIntoView?.({ block: 'center', behavior: smooth ? 'smooth' : 'auto' })
    // Focus follows, so a keyboard carries on from the row it was sent to.
    row?.focus({ preventScroll: true })
    const away = (e: Event): void => {
      if (spotRef.current?.contains(e.target as Node)) return
      setLit(null)
    }
    // Capture phase: a handler further down that stops the event still counts as a click elsewhere.
    document.addEventListener('mousedown', away, true)
    document.addEventListener('focusin', away, true)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('focusin', away, true)
    }
  }, [lit])

  return { spot, spotRef, show: (name) => setLit({ name, scope }) }
}
