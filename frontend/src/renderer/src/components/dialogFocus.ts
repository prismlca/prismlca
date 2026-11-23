/**
 * The keyboard side of a modal dialog (DialogBox) that has to know about the other dialogs too: Tab stays
 * inside the topmost one, and a closing dialog finds where the focus goes back to.
 *
 * Tab: a dialog that says it is modal (`aria-modal`) has to be modal for the keyboard as well. Without this,
 * Tab past the last control walked on into the page behind the backdrop, and Enter there opened a page or
 * deleted a process nobody could see. One window listener serves every dialog, like EscapeCloser: Tab past
 * the last control goes to the first, Shift+Tab past the first to the last, and a focus that is outside the
 * topmost dialog altogether (dropped to <body> when the focused control vanished) is brought back in. A field
 * that gives Tab its own meaning (accepting a completion) calls `preventDefault()`, and its Tab stays its own.
 *
 * Return: a dialog remembers what had the focus before it opened. That control can be gone by the time it
 * closes: Distances hands over to Settings, Background data to the import sheet, and the button that was
 * pressed went down with the first dialog. Its element still knows the dialog it was in, though, and that
 * dialog's own opener is where the user came from.
 */

const open: HTMLElement[] = []
const openers = new WeakMap<Element, Element | null>()

/** What Tab can land on inside `root`, in document order. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  const candidates = root.querySelectorAll<HTMLElement>(
    'a[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable]:not([contenteditable="false"])'
  )
  return Array.from(candidates).filter(
    (el) =>
      el.tabIndex >= 0 &&
      !el.matches(':disabled') &&
      !(el instanceof HTMLInputElement && el.type === 'hidden') &&
      !el.closest('[inert]') &&
      // jsdom has no layout and no checkVisibility: there everything counts as shown.
      (typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true })) &&
      radioStop(el, root)
  )
}

/** A group of radio buttons is one Tab stop: the checked one, or the first while none is checked. */
function radioStop(el: HTMLElement, root: HTMLElement): boolean {
  if (!(el instanceof HTMLInputElement) || el.type !== 'radio' || !el.name) return true
  if (el.checked) return true
  const group = root.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`)
  return !Array.from(group).some((r) => r.checked) && group[0] === el
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Tab' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
  const box = open[open.length - 1]
  if (!box) return
  const stops = tabbables(box)
  const active = document.activeElement
  if (!stops.length) {
    e.preventDefault()
    box.focus({ preventScroll: true })
    return
  }
  const first = stops[0]
  const last = stops[stops.length - 1]
  const inside = active instanceof Node && box.contains(active)
  const wraps = !inside || (e.shiftKey ? active === first || active === box : active === last)
  if (!wraps) return
  e.preventDefault()
  ;(e.shiftKey ? last : first).focus()
}

/** Register a dialog's box while it is mounted: it becomes the one Tab stays in. Returns the release. */
export function holdTab(box: HTMLElement, opener: Element | null): () => void {
  openers.set(box, opener)
  if (!open.length) window.addEventListener('keydown', onKey)
  open.push(box)
  return () => {
    const i = open.indexOf(box)
    if (i >= 0) open.splice(i, 1)
    if (!open.length) window.removeEventListener('keydown', onKey)
  }
}

/** Where the focus goes back to when a dialog opened from `opener` closes: the opener while it is still in
 *  the page, otherwise the opener of the dialog it was in, and so on outwards. */
export function returnTarget(opener: Element | null): HTMLElement | null {
  let el = opener
  for (let hops = 0; el && !el.isConnected && hops < 8; hops++) {
    const box = el.closest('[aria-modal="true"]')
    el = box ? (openers.get(box) ?? null) : null
  }
  return el instanceof HTMLElement && el.isConnected ? el : null
}
