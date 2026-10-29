import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

/**
 * useState backed by localStorage — the value survives component unmount (tab/view switches)
 * and app restarts. Same signature as useState; pass a stable `key`.
 */
/** Read a persisted value without subscribing to it — for settings that are read fresh per action.
 *  Was defined three times across the views; it belongs next to usePersisted. */
export function readLs<T>(key: string, def: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? def : (JSON.parse(raw) as T)
  } catch {
    return def
  }
}

/**
 * localStorage key for state that belongs to ONE model.
 *
 * State that is really per model but stored under a global key looks harmless until it leaks: the
 * results view carried the selected processes and indicators of an unrelated study into a brand-new
 * model — and from there into that model's report configuration, which then compared apple juice with
 * `dodecanol production`.
 */
export const modelKey = (base: string, database: string | null | undefined): string =>
  `${base}.${database ?? '(none)'}`

/**
 * Move a model's own browser state to its new name, after the backend renamed the model.
 *
 * The server moves the nine model-scoped stores it owns; these keys it cannot reach. Matched by
 * SUFFIX rather than from a list of bases, because `modelKey` builds every one of them as
 * `${base}.${database}` and a hand-kept list goes stale the first time somebody adds a key — moving
 * one key too many costs nothing, leaving one behind loses the state silently (which is how the canvas
 * arrangement stranded under a dead name before it became a store).
 */
export function renameModelKeys(from: string, to: string): void {
  if (!from || !to || from === to) return
  try {
    const suffix = `.${from}`
    for (const key of Object.keys(localStorage).filter((k) => k.endsWith(suffix))) {
      const value = localStorage.getItem(key)
      if (value == null) continue
      localStorage.setItem(`${key.slice(0, -suffix.length)}.${to}`, value)
      localStorage.removeItem(key)
    }
  } catch {
    /* quota / unavailable — non-fatal, as everywhere else in this file */
  }
}

export function usePersisted<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw != null ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  // A changing key means a different subject (another model), so the value has to be re-read rather
  // than carried over — plain `usePersisted` only reads its key once, at mount.
  const lastKey = useRef(key)
  useEffect(() => {
    if (lastKey.current === key) return
    lastKey.current = key
    setValue(readLs(key, initial))
    // `initial` is intentionally not a dependency: it is a fresh literal on most call sites, which
    // would re-run this on every render and clobber the state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  // Debounce writes a touch so rapid changes (typing, dragging) don't thrash localStorage.
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (t.current) clearTimeout(t.current)
    t.current = setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* quota / unavailable — non-fatal */
      }
    }, 150)
    return () => {
      if (t.current) clearTimeout(t.current)
    }
  }, [key, value])
  return [value, setValue]
}
