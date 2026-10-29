/**
 * How numbers are displayed and how units are accepted — the settings of the Display and Modelling panels.
 *
 * They lived in `localStorage` (`prism.settings.v1`) after every other app setting had moved to
 * `userData/settings.json` (V353): a dev server on another port, or cleared site data, reset the rounding
 * while the cost brake and the model choice stayed. One home now; the old key is read once as the seed.
 */
export interface DisplaySettings {
  /** Significant digits, per surface. */
  round: {
    edges: number // numbers on the canvas arrows
    properties: number // flow-property amounts
    io: number // input/output (exchange) amounts
    parameters: number // parameter values (a formula's result, and a typed value while its field is idle)
    results: number // result figures: Detailed results, and a dataset's scores in Process details
  }
  /** false (default) = STRICT: units come from the existing vocabulary; true = free text accepted. */
  freeUnits: boolean
  /** The canvas arrows' two label lines: the exchange amount with its unit, and the product it carries. */
  edgeAmounts: boolean
  edgeProducts: boolean
}

export const DEFAULT_DISPLAY: DisplaySettings = {
  round: { edges: 4, properties: 6, io: 6, parameters: 6, results: 4 },
  freeUnits: false,
  edgeAmounts: true,
  edgeProducts: true
}

const digits = (v: unknown, dflt: number): number => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && v !== null && v !== undefined && v !== '' ? Math.max(1, Math.min(12, n)) : dflt
}

/** Whatever the file (or the seed) holds, made whole and within range. */
export function sanitiseDisplay(raw: unknown): DisplaySettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const round = (r.round && typeof r.round === 'object' ? r.round : {}) as Record<string, unknown>
  return {
    round: {
      edges: digits(round.edges, DEFAULT_DISPLAY.round.edges),
      properties: digits(round.properties, DEFAULT_DISPLAY.round.properties),
      io: digits(round.io, DEFAULT_DISPLAY.round.io),
      // Absent from every file written before this setting existed, so it falls back to the default rather
      // than to `io` — the two were the same number then, and tying them together now would mean a
      // later edit of one silently moved the other.
      parameters: digits(round.parameters, DEFAULT_DISPLAY.round.parameters),
      // Results read the Inputs / Outputs digits before they had their own; the same reasoning as above
      // keeps them apart from the start.
      results: digits(round.results, DEFAULT_DISPLAY.round.results)
    },
    freeUnits: typeof r.freeUnits === 'boolean' ? r.freeUnits : DEFAULT_DISPLAY.freeUnits,
    // Absent from every file written before the switches existed: on, which is what the canvas showed.
    edgeAmounts: typeof r.edgeAmounts === 'boolean' ? r.edgeAmounts : DEFAULT_DISPLAY.edgeAmounts,
    edgeProducts: typeof r.edgeProducts === 'boolean' ? r.edgeProducts : DEFAULT_DISPLAY.edgeProducts
  }
}
