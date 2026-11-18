/**
 * Each operation's share of a table's total, per country — and the note that says how the operations of
 * that table nest.
 *
 * The model used to derive these by hand from the tonnes (V415) and had to decide alone what
 * "incineration" is. The arithmetic belongs here, and so does the nesting: the four tables group their
 * operations differently, and one note written for env_wastrt was handed out for all of them — wrong for
 * env_wasmun, where DSP_I_RCV_E holds DSP_I and RCV_E, and with "GEN" counted as a share of 1. env_waspac
 * has no treatment total at all, so it got no shares, and a model folded the packaging that was not
 * recovered into energy recovery. One table per dataset now says which code holds which, what the shares
 * are a fraction of, and which codes are no share; the note is put together from it.
 *
 * The nesting was checked on real answers (2020 and 2022, every reporting country): in env_wastrt and
 * env_wasoper the top level adds up to TRT exactly; in env_wasmun it does up to rounding, except that
 * some countries count preparing for reuse in RCY but not in TRT (DE: +0.55 %); in env_waspac RCY,
 * RCV_E_PAC and RCV_OTH add up to RCV, and RCV can exceed GEN (CY, EE metal packaging).
 */
import type { EurostatDataset } from './datasets'
import type { ValueRow } from './service'

interface Nesting {
  /** The row every share is a fraction of, and how the note names it. */
  base: 'TRT' | 'GEN'
  baseLabel: string
  /** The operations that together make up the base. */
  top: string[]
  /** Operation → the operations it contains, on any level. */
  contains: Record<string, string[]>
  /** The base minus the top level, under a key no Eurostat code looks like. */
  remainder?: string
  /** What the codes mean for an LCA, said after the nesting. */
  reading: string
}

const THERMAL =
  'An LCA "incineration" share is usually RCV_E (R1, energy recovery) + DSP_I (D10) — both are thermal ' +
  'treatment, and for plastics R1 includes co-incineration in cement kilns.'

const NESTING: Record<EurostatDataset, Nesting> = {
  env_wastrt: {
    base: 'TRT',
    baseLabel: 'total treatment (TRT)',
    top: ['RCV_R_B', 'RCV_E', 'DSP_L_OTH', 'DSP_I'],
    contains: { RCV_R_B: ['RCV_R', 'RCV_B'], DSP_L_OTH: ['DSP_L', 'DSP_OTH'] },
    reading: THERMAL
  },
  env_wasoper: {
    base: 'TRT',
    baseLabel: 'total treatment (TRT)',
    top: ['DSP_L', 'DSP_I', 'DSP_OTH', 'RCV_E', 'RCV_R', 'RCV_B'],
    contains: {},
    reading: THERMAL
  },
  env_wasmun: {
    base: 'TRT',
    baseLabel: 'total treatment (TRT)',
    top: ['DSP_I_RCV_E', 'DSP_L_OTH', 'RCY'],
    contains: { DSP_I_RCV_E: ['DSP_I', 'RCV_E'], RCY: ['RCY_M', 'RCY_C_D', 'PRP_REU'] },
    reading:
      'DSP_I_RCV_E is incineration (D10) and energy recovery (R1) together. GEN is the waste generated, ' +
      'not a treatment, and has no share.'
  },
  env_waspac: {
    base: 'GEN',
    baseLabel: 'packaging waste generated (GEN)',
    top: ['RCY', 'RCV_E_PAC', 'RCV_OTH'],
    contains: { RCV: ['RCV_E_PAC', 'RCV_OTH', 'RCY'], RCY: ['RCY_NAT', 'RCY_EU_FOR', 'RCY_NEU'] },
    remainder: 'not_recovered',
    reading:
      'not_recovered is GEN minus the three: generated but not reported as recovered. RCV_OTH is recovery ' +
      'that is neither recycling nor energy recovery — keep both apart from energy recovery. FMKT* ' +
      '(placed on the market) and RPR (repair) are reported apart from GEN and have no share.'
  }
}

/** Tonnes first; kilograms per capita only where a table has neither tonnes nor thousand tonnes. */
const UNITS: Array<[string, string]> = [
  ['T', 'tonnes'],
  ['THS_T', 'thousand tonnes'],
  ['KG_HAB', 'kg per capita']
]

/** A top level more than this far from 1 is named per country: the shares would lose or add waste. */
const SUM_TOLERANCE = 0.01
/** How many such countries the note names before it counts the rest. */
const SUM_SHOWN = 8

const round4 = (x: number): number => Math.round(x * 10000) / 10000

function list(codes: string[]): string {
  return codes.length > 1 ? `${codes.slice(0, -1).join(', ')} and ${codes.at(-1)}` : codes[0]
}

/**
 * The shares of `dataset` from its value rows, with the note, or nothing when the rows have no total to
 * divide by. The percent rows (env_wasoper, env_waspac) are already shares and are left alone.
 */
export function sharesOf(
  dataset: EurostatDataset,
  rows: ValueRow[]
): { shares?: Record<string, Record<string, number>>; shares_note?: string } {
  const n = NESTING[dataset]
  const found = UNITS.find(([u]) => rows.some((r) => r[2] === u && r[1] === n.base))
  if (!found) return {}
  const [unit, unitWords] = found
  const counted = new Set([...n.top, ...Object.keys(n.contains), ...Object.values(n.contains).flat()])
  const values = new Map<string, Map<string, number>>()
  for (const [geo, op, u, value] of rows) {
    if (u !== unit) continue
    if (!values.has(geo)) values.set(geo, new Map())
    values.get(geo)!.set(op, value)
  }
  const shares: Record<string, Record<string, number>> = {}
  const offSum: string[] = []
  for (const [geo, ops] of values) {
    const total = ops.get(n.base)
    if (!total) continue
    const own: Record<string, number> = {}
    for (const [op, value] of ops) if (counted.has(op)) own[op] = round4(value / total)
    let sum = n.top.reduce((s, op) => s + (ops.get(op) ?? 0), 0) / total
    // A remainder below zero is not a share: more was reported recovered than generated. Nor is one
    // where an operation of the top level is missing (confidential, not reported): it would hold that
    // operation under the wrong name. Either way it stays out, and the sum is named below instead.
    if (n.remainder && sum <= 1 && n.top.every((op) => ops.has(op))) {
      own[n.remainder] = round4(1 - sum)
      sum = 1
    }
    if (!Object.keys(own).length) continue
    shares[geo] = own
    if (Math.abs(sum - 1) > SUM_TOLERANCE) offSum.push(`${geo} ${round4(sum)}`)
  }
  if (!Object.keys(shares).length) return {}
  const nesting = Object.entries(n.contains)
    .map(([parent, children]) => `${parent} contains ${list(children)}`)
    .join('; ')
  const topLevel = n.remainder ? [...n.top, n.remainder] : n.top
  const sentences = [
    `Share of ${n.baseLabel} per operation, from the ${unitWords} rows.`,
    nesting ? `${nesting} — never add a contained code to the one that holds it.` : '',
    `The top-level operations ${list(topLevel)} sum to 1 up to rounding.`,
    n.reading,
    offSum.length
      ? `Here they do not: ${offSum.slice(0, SUM_SHOWN).join(', ')}${
          offSum.length > SUM_SHOWN ? `, and ${offSum.length - SUM_SHOWN} more` : ''
        } — the reported operations do not add up to the total; say so instead of scaling silently.`
      : ''
  ]
  return { shares, shares_note: sentences.filter(Boolean).join(' ') }
}
