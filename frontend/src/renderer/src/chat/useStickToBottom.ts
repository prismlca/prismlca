import { useCallback, useEffect, useRef, useState, type RefObject, type UIEvent } from 'react'

/** How far off the bottom still counts as "at the bottom" — a couple of rounded pixels do not. */
export const BOTTOM_SLACK = 24

/**
 * The transcript follows new output while the reader is at its end, and lets go the moment they
 * scroll up.
 *
 * Whether to follow is a ref, decided in the scroll handler and read by the scroll that output
 * triggers — not React state, which output racing in between could read before it changed. Only the
 * reader moves the view up: output only ever adds below, and the follow scroll only moves down. So a
 * scroll that went up and left the end is the reader's, and following stops until they are back at
 * the end (or send, or press the jump button). `atBottom` is the same fact as state, for the jump
 * button.
 */
export function useStickToBottom(bodyRef: RefObject<HTMLDivElement | null>): {
  atBottom: boolean
  /** Follow again and go to the end now: the jump button, a chat opened. */
  toBottom: (smooth?: boolean) => void
  /** Follow again from the next output on: a message just sent, not yet on screen. */
  follow: () => void
  onScroll: (e: UIEvent<HTMLDivElement>) => void
} {
  const [atBottom, setAtBottom] = useState(true)
  const followRef = useRef(true)
  const lastTopRef = useRef(0)

  const follow = useCallback((): void => {
    followRef.current = true
    setAtBottom(true)
  }, [])

  const toBottom = useCallback(
    (smooth = false): void => {
      follow()
      const el = bodyRef.current
      if (!el) return
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
      // A smooth scroll is still on its way; its own scroll events move down and say nothing.
      if (!smooth) lastTopRef.current = el.scrollTop
    },
    [bodyRef, follow]
  )

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK
    if (bottom) followRef.current = true
    else if (el.scrollTop < lastTopRef.current) followRef.current = false
    lastTopRef.current = el.scrollTop
    // Only on a change: this fires on every scrolled pixel, and a setState per pixel re-renders a
    // transcript that can be hundreds of nodes long.
    setAtBottom((was) => (was === bottom ? was : bottom))
  }, [])

  // After every render, while following: whatever the render added — text, a tool row, a card — ends
  // up in view. A render that added nothing leaves the end where it is. The position is noted at once:
  // the browser reports this scroll a frame later, and a reader scrolling up within that frame must
  // still count as going up from here.
  useEffect(() => {
    const el = bodyRef.current
    if (!followRef.current || !el) return
    el.scrollTop = el.scrollHeight
    lastTopRef.current = el.scrollTop
  })

  return { atBottom, toBottom, follow, onScroll }
}
