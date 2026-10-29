import { useSyncExternalStore } from 'react'
import { DEFAULT_DISPLAY, sanitiseDisplay, type DisplaySettings } from '../../../shared/displayDefaults'
import { getAS, setAS, subscribeAppSettings } from './appSettings'

/**
 * App-wide UI settings — rounding per surface and the unit rule — as the views read them.
 *
 * The shape is the one the views always had; the storage is not. This store used to write
 * `localStorage` (`prism.settings.v1`), the last setting to do so after everything else had moved to
 * `userData/settings.json` (V353). It is now a view over the app settings' `display` group: the same
 * synchronous snapshot for render and plain functions, written through `setAS` like every other setting.
 * The old browser key is read once, as the seed for main — see `lib/appSettings.ts`.
 */
export interface PrismSettings {
  /** Significant digits used when displaying numbers, per surface. */
  round: {
    edges: number // numbers on the canvas arrows
    properties: number // flow-property amounts
    io: number // input/output (exchange) amounts
    parameters: number // parameter values (a formula's result, and a typed value while its field is idle)
    results: number // result figures: Detailed results, and a dataset's scores in Process details
  }
  modelling: {
    /** false (default) = STRICT: units must come from the existing unit vocabulary;
     * true = HYBRID: the vocabulary only autocompletes, any free-text unit is accepted. */
    freeUnits: boolean
    /** Canvas arrows: show the amount with its unit, and the product the arrow carries (both on by default). */
    edgeAmounts: boolean
    edgeProducts: boolean
  }
}

export const DEFAULT_SETTINGS: PrismSettings = {
  round: { ...DEFAULT_DISPLAY.round },
  modelling: {
    freeUnits: DEFAULT_DISPLAY.freeUnits,
    edgeAmounts: DEFAULT_DISPLAY.edgeAmounts,
    edgeProducts: DEFAULT_DISPLAY.edgeProducts
  }
}

function fromDisplay(d: unknown): PrismSettings {
  const x: DisplaySettings = sanitiseDisplay(d)
  return {
    round: { ...x.round },
    modelling: { freeUnits: x.freeUnits, edgeAmounts: x.edgeAmounts, edgeProducts: x.edgeProducts }
  }
}

function toDisplay(s: PrismSettings): DisplaySettings {
  const { freeUnits, edgeAmounts, edgeProducts } = s.modelling
  return { round: { ...s.round }, freeUnits, edgeAmounts, edgeProducts }
}

let current: PrismSettings = fromDisplay(getAS().display)
const listeners = new Set<() => void>()

// Main's answer (and every write from elsewhere) reaches the views through this: a fresh snapshot only
// when the values changed, so consumers keyed on the object identity do not re-run for nothing.
subscribeAppSettings(() => {
  const next = fromDisplay(getAS().display)
  if (JSON.stringify(next) === JSON.stringify(current)) return
  current = next
  listeners.forEach((l) => l())
})

export function getSettings(): PrismSettings {
  return current
}

export function setSettings(next: PrismSettings): void {
  current = next
  listeners.forEach((l) => l())
  setAS({ display: toDisplay(next) })
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useSettings(): PrismSettings {
  return useSyncExternalStore(subscribe, getSettings, getSettings)
}

/** Format a number to `digits` significant figures; extreme magnitudes fall back to exponential. */
export function fmtSig(x: number | null | undefined, digits: number): string {
  if (x == null || Number.isNaN(x)) return ''
  if (x === 0) return '0'
  const d = Math.max(1, Math.min(12, Math.round(digits)))
  // The notation is chosen on the ROUNDED value: 999 999 at four digits is shown as 1 000 000, and
  // judged on the raw value it printed as "1000000" while 1 000 000 itself printed as "1.000e+6".
  const r = Number(x.toPrecision(d))
  const ar = Math.abs(r)
  // Trailing zeros go in both notations, so 0.0005 does not sit next to 5.00000e-5 in one column. The
  // mantissa comes from `x`: rounding 1.79e308 up overflows to Infinity, the value itself does not.
  if (ar >= 10 ** Math.max(6, d) || ar < 1e-4) return x.toExponential(d - 1).replace(/\.?0+e/, 'e')
  return String(r)
}
