import { useState, type Dispatch, type SetStateAction } from 'react'

/**
 * What a field holds while it is being edited, apart from the saved value it shows.
 *
 * The draft starts as the saved value and goes back to it whenever the saved value changes from outside
 * (a reload, an undo, another edit). That reset happens in the render that brings the new value, not in an
 * effect after it. An effect also runs once after the field mounts, and React runs effects when it gets
 * round to it: on a busy machine the first keystroke can come first, and the effect then put the saved
 * value back over it — leaving the field saved nothing, because nothing seemed to have changed.
 *
 * `onReset` runs at the same moment, for state that belongs to the draft (an error shown for it). It may
 * set state of the calling component only.
 */
export function useDraft<T>(saved: T, onReset?: () => void): [T, Dispatch<SetStateAction<T>>] {
  const [draft, setDraft] = useState(saved)
  const [seen, setSeen] = useState(saved)
  if (!Object.is(seen, saved)) {
    setSeen(saved)
    setDraft(saved)
    onReset?.()
  }
  return [draft, setDraft]
}
