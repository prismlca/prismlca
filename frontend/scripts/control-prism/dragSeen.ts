/**
 * What the page saw of a drag that `drag` drove: whether an HTML5 drag started or the page cancelled it, the
 * kinds of data on it, whether a drop was taken, and whether the drag ended — and how the answer says so.
 * It only looks: listeners on the window that replace no handler of the page and prevent or stop nothing.
 * A hint for the one driving, never the proof; the effect of the drop is.
 */
import type { Page } from '@playwright/test'
import { withDeadline } from './waits'

export interface Seen {
  started: boolean
  /** A dragstart came, and the page cancelled it: this element does not drag from where it was pressed. */
  refused: boolean
  types: string[]
  /** A drop event fires only where a dragover was accepted, so this is "the drop was taken". */
  dropped: boolean
  ended: boolean
}

type Page_ = Pick<Page, 'evaluate'>

const WATCH = '__controlPrismDrag'

/** Starts listening for the drag events of the coming drag. A watcher left from a drag that broke off is
 *  taken down first, so listeners never pile up. */
export async function watch(page: Page_): Promise<void> {
  await page.evaluate((key) => {
    const slot = window as unknown as Record<string, { off: () => void } | undefined>
    slot[key]?.off()
    const seen = { started: false, refused: false, types: [] as string[], dropped: false, ended: false }
    // Capturing, so a handler that stops the event cannot hide it. Whether the page let the drag start is
    // known only after its handlers ran; the data's kinds are read where they are readable, during the drag.
    const types = (e: DragEvent): void => {
      seen.types = [...(e.dataTransfer?.types ?? [])]
    }
    const listeners: [string, (e: DragEvent) => void][] = [
      [
        'dragstart',
        (e) =>
          void setTimeout(() => {
            seen.started = !e.defaultPrevented
            seen.refused = e.defaultPrevented
          }, 0)
      ],
      ['dragover', types],
      ['drop', (e) => (types(e), (seen.dropped = true))],
      ['dragend', () => (seen.ended = true)]
    ]
    for (const [type, fn] of listeners) window.addEventListener(type, fn as EventListener, true)
    const off = (): void => {
      for (const [type, fn] of listeners) window.removeEventListener(type, fn as EventListener, true)
    }
    slot[key] = { seen, off } as { off: () => void }
  }, WATCH)
}

/** What the watcher saw, and the watcher gone; null when the window could not say within 3 s. */
export async function seenAndStop(page: Page_): Promise<Seen | null> {
  const read = page.evaluate((key) => {
    const slot = window as unknown as Record<string, { seen: Seen; off: () => void } | undefined>
    const w = slot[key]
    if (!w) return null
    w.off()
    delete slot[key]
    return w.seen
  }, WATCH)
  return withDeadline(read, 3000).catch(() => null)
}

/** The answer's second half: what kind of drag it was, and for an HTML5 drag whether the drop was taken. */
export function describeSeen(seen: Seen | null): string {
  if (!seen) return ''
  if (seen.refused)
    return ' — the page cancelled the HTML5 drag as it started: the element does not drag from where it was pressed'
  if (!seen.started)
    return ' — no HTML5 drag started: a drag the page follows with its own pointer handlers, or none'
  const data = seen.types.length ? `carrying ${seen.types.join(', ')}` : 'with no data the page could read'
  const end = seen.ended ? '' : ' (and no dragend reached the page)'
  return seen.dropped
    ? ` — an HTML5 drag ${data}; the drop was taken${end}`
    : ` — an HTML5 drag ${data}; the drop was NOT taken: nothing under the pointer accepted it${end}`
}
