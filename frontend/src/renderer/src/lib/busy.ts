import { useSyncExternalStore } from 'react'

/**
 * Whether a write has been running for longer than a person waits without wondering.
 *
 * Duplicating a model, undoing an import or changing a parameter closed its dialog and then showed
 * nothing for thirteen seconds before the result appeared (V332). Every write goes through
 * `mutationRunner`, which reports here; the workbench shows one line once the oldest open write has
 * run for `BUSY_AFTER_MS`. The delay is what keeps the line off the screen for the writes that take a
 * blink — a spinner that flashes on every click is noise, not information.
 */
export const BUSY_AFTER_MS = 1000

let open = 0
let visible = false
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function publish(next: boolean): void {
  if (visible === next) return
  visible = next
  for (const fn of listeners) fn()
}

/** Called when a write starts; the returned function is called when it ends, success or failure. */
export function beginBusy(): () => void {
  open += 1
  if (open === 1 && !timer) {
    timer = setTimeout(() => {
      timer = null
      if (open > 0) publish(true)
    }, BUSY_AFTER_MS)
  }
  let ended = false
  return () => {
    if (ended) return
    ended = true
    open -= 1
    if (open <= 0) {
      open = 0
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      publish(false)
    }
  }
}

export function isBusy(): boolean {
  return visible
}

export function useBusy(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    isBusy,
    isBusy
  )
}
