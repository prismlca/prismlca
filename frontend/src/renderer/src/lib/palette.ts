/** Chart/canvas colour palettes, all derived from the house scheme (design/prism-theme.css).
 * They live as runtime constants (not CSS vars) because ECharts and React Flow need concrete hex
 * values — this module is the single place they may be spelled out. */

/** Core brand-derived series palette: green, navy, purple, info-blue, amber, teal, alert, olive.
 * Used to colour method families in the overview charts. */
export const FAMILY_PALETTE = [
  '#93c120',
  '#2f4e66',
  '#9f5987',
  '#1779ba',
  '#e08e0b',
  '#3a9d7e',
  '#cc4b37',
  '#5b7a2b'
]

/** Node colour-coding swatches on the canvas — the first six brand colours. */
export const NODE_COLORS = FAMILY_PALETTE.slice(0, 6)

/** Comparison subjects lead with blue so the first two subjects contrast strongly. */
export const SUBJECT_PALETTE = [
  '#1779ba',
  '#93c120',
  '#9f5987',
  '#e08e0b',
  '#2f4e66',
  '#3a9d7e',
  '#cc4b37',
  '#5b7a2b'
]

/** Stacked classification segments need more distinct hues than the core eight. */
export const STACK_PALETTE = [
  '#93c120',
  '#2f4e66',
  '#9f5987',
  '#1779ba',
  '#e08e0b',
  '#3a9d7e',
  '#cc4b37',
  '#5b7a2b',
  '#7a5cff',
  '#0f9b8e',
  '#b5651d',
  '#d14e8a',
  '#4a8fd6',
  '#8a9b2e'
]

/** Tag-aggregation bar segments (detailed results). */
export const AGG_PALETTE = [
  '#93c120',
  '#2f4e66',
  '#9f5987',
  '#1779ba',
  '#d18a00',
  '#3a9d5d',
  '#cc4b37',
  '#7a5cff'
]

/** Grey for placeholder groups like '(untagged)' / '(no ISIC)'. */
export const NEUTRAL_GREY = '#9aa2a8'
