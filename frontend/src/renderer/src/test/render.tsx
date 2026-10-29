/**
 * Mount a component against the fake bridge. Three lines of setup per test.
 *
 * Note what this does NOT do: it never `vi.stubGlobal('window', …)`. That call replaces the object
 * carrying `document`, and Testing Library dies on the spot. The node-style tests may stub the whole
 * window (see `installPrism`); a jsdom test assigns onto the real one.
 */
import { render, type RenderOptions, type RenderResult } from '@testing-library/react'
import type { ReactElement } from 'react'
import { makePrism, type PrismFixture, type PrismOverrides, type Routes } from './prism'

export interface RenderWithPrism extends RenderResult {
  prism: PrismFixture
}

export function renderWithPrism(
  ui: ReactElement,
  opts: { routes?: Routes; overrides?: PrismOverrides } & Omit<RenderOptions, 'wrapper'> = {}
): RenderWithPrism {
  const { routes, overrides, ...rest } = opts
  const fixture = makePrism(routes, overrides)
  ;(window as unknown as { prism: unknown }).prism = fixture.prism
  return { ...render(ui, rest), prism: fixture }
}

/**
 * The node-environment installer, for tests of modules with load-time side effects.
 *
 * Reproduces what `lib/modelView.test.ts` has been doing by hand since before this file existed, so
 * that test could adopt this with no behaviour change. Call it BEFORE `await import(...)` of the
 * module under test — several of them read `localStorage` at module scope.
 */
export function installPrism(routes?: Routes, overrides?: PrismOverrides): PrismFixture {
  const fixture = makePrism(routes, overrides)
  const g = globalThis as unknown as Record<string, unknown>
  g.window = {
    prism: fixture.prism,
    localStorage: g.localStorage,
    addEventListener: () => {},
    removeEventListener: () => {}
  }
  return fixture
}
