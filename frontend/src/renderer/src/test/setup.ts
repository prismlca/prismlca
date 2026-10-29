/**
 * Setup for the `dom` project only. The `node` project loads none of this and stays as fast as it was.
 */
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// MUST be explicit. Testing Library only registers its own auto-cleanup when it finds a GLOBAL
// `afterEach`, and this project deliberately runs with `globals: false` (every existing test imports
// its own `describe/it/expect`). Without this line the DOM leaks between cases and tests start
// finding elements from the previous one — which looks like a flaky test, not a missing hook.
afterEach(() => {
  cleanup()
  window.localStorage.clear()
  delete (window as unknown as { prism?: unknown }).prism
})

// jsdom implements none of these, and the app uses all of them: React Flow and ECharts both observe
// resizes, the theme reads a media query, and ECharts wants a canvas context.
class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return []
  }
}
globalThis.ResizeObserver ??= NoopObserver as unknown as typeof ResizeObserver
globalThis.IntersectionObserver ??= NoopObserver as unknown as typeof IntersectionObserver

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false
})) as unknown as typeof window.matchMedia

// jsdom has no scrolling, so `Element.scrollTo` is not merely a no-op there — it is absent, and the
// chat transcript calls it the frame after it opens. Without this, a test that expands the chat fails
// with an uncaught exception from inside a requestAnimationFrame, far from the line that caused it.
Element.prototype.scrollTo ??= (() => {}) as unknown as Element['scrollTo']

// Same story for pointer capture: jsdom does not implement it, and a drag that is not allowed to
// capture the pointer would lose the cursor the moment it left the element it started on. The group
// box's grab strip calls it on pointer-down.
Element.prototype.setPointerCapture ??= (() => {}) as unknown as Element['setPointerCapture']
Element.prototype.releasePointerCapture ??= (() => {}) as unknown as Element['releasePointerCapture']

if (!HTMLCanvasElement.prototype.getContext) {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext']
}
