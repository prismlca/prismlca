import { fmtSig } from '../../lib/settings'
import { fmtPct } from './chartUtils'
import type {
  CompareResponse,
  DifferenceBlock,
  DifferenceChange,
  DifferenceSplit,
  MatrixRow,
  WhyData
} from './types'

/**
 * What makes the difference, as the Results page shows it: the answers of a run gathered, the pairs one
 * indicator's chart lists, and the words for a change, its share and the reference.
 */

type Answer = NonNullable<CompareResponse['difference']>

/** A run's answers as the page keeps them. Every answer carries the whole plan, so the last one is taken; a split
 *  comes in the request that brought its second side, so they are gathered from all. The indicators are keyed by
 *  the method keys the run asked for, in its order — the answer names them as installed, which a key the page
 *  built from its own picks need not match. */
export function gatherWhy(answers: Answer[], methods: string[][]): WhyData {
  const splits: WhyData['splits'] = {}
  for (const answer of answers) {
    for (const { indicators, ...rest } of answer.splits) {
      const blocks: Record<string, DifferenceBlock> = {}
      indicators?.forEach((block, k) => {
        if (methods[k]) blocks[methods[k].join(' · ')] = block
      })
      splits[rest.subject] = { ...rest, blocks }
    }
  }
  return { plan: answers[answers.length - 1].plan, splits }
}

export interface WhyPair {
  sub: number
  ref: number
  split: WhyData['splits'][number]
  /** This indicator's split; absent when the pair could not be split (`split.error`). */
  block?: DifferenceBlock
}

/** The pairs under one indicator's chart, in the order of the subjects. */
export function pairsFor(why: WhyData, key: string): WhyPair[] {
  return Object.values(why.splits)
    .sort((a, b) => a.subject - b.subject)
    .map((split) => ({ sub: split.subject, ref: split.reference, split, block: split.blocks[key] }))
    .filter((p) => p.split.error || p.block)
}

/** The reference as the list names it: "baseline" for the same process without a scenario, else its label. */
export function vsLabel(rows: MatrixRow[], sub: number, ref: number): string {
  const s = rows[sub]
  const r = rows[ref]
  if (!s || !r) return ''
  return s.database === r.database && s.code === r.code && !r.scenario ? 'baseline' : r.label
}

/** What a change is called in a chip: the input or flow that changed, else the process (a functional unit). */
export function changeName(c: DifferenceChange): string {
  return c.exchange ?? c.process ?? c.kind
}

/** A share of the difference: "68 %", "9 %", "−4.2 %". */
export function fmtShare(pct: number): string {
  const a = Math.abs(pct)
  const s = a >= 10 ? a.toFixed(0) : String(Number(a.toFixed(1)))
  return `${pct < 0 ? '−' : ''}${s} %`
}

/** A signed amount in the indicator's unit: "+0.36", "−1.2e-5". */
export function fmtSigned(x: number, digits: number): string {
  return `${x > 0 ? '+' : x < 0 ? '−' : ''}${fmtSig(Math.abs(x), digits)}`
}

/** A change's part of the difference: its share, or — when the two scores are the same and a share means
 *  nothing — its contribution in the indicator's unit. */
export function changePart(c: DifferenceChange, digits: number): string {
  return c.share_pct != null ? fmtShare(c.share_pct) : fmtSigned(c.contribution, digits)
}

/** The difference of a pair in one indicator, in % where the reference is not zero. */
export function deltaLabel(block: DifferenceBlock, digits: number): string {
  if (block.delta === 0) return '±0'
  return block.delta_pct != null ? fmtPct(block.delta_pct) : `${fmtSigned(block.delta, digits)} ${block.unit}`
}

/** One line for a change's tooltip: what it is, where, and how it moved. */
export function changeTitle(c: DifferenceChange, digits: number): string {
  const where = c.process && c.exchange ? ` in ${c.process}` : ''
  const unit = c.unit ? ` ${c.unit}` : ''
  const formula = c.formula ? ` (= ${c.formula})` : ''
  return `${c.kind}${where}: ${fmtSig(c.before, digits)} → ${fmtSig(c.after, digits)}${unit}${formula}`
}

/** How a copy was laid onto its original: "3 processes paired with the original (1 by name). Only in this
 *  model: paint." */
export function pairingText(pairing: NonNullable<DifferenceSplit['pairing']>): string {
  const n = pairing.paired
  const byName = pairing.paired_by_name ? ` (${pairing.paired_by_name} by name)` : ''
  const only = (where: string, names?: string[]): string =>
    names?.length ? ` Only in ${where}: ${names.join(', ')}.` : ''
  return (
    `${n} ${n === 1 ? 'process' : 'processes'} paired with the original${byName}.` +
    only('this model', pairing.only_in_subject) +
    only('the original', pairing.only_in_reference)
  )
}

/** What stands under the charts when a scenario's baseline is not ticked: a scenario is split only against it. */
export const ASK_BASELINE = 'Tick the baseline to see what makes each scenario differ from it.'

/** Whether a scenario of the run was not split because its baseline was not among the subjects. */
export function needsBaseline(why: WhyData): boolean {
  return why.plan.some((e) => 'reason' in e && e.reason === 'no_baseline')
}

/**
 * One sentence for the processes and datasets nothing is split against and that are no one's reference, or null
 * when there are none — or when the page compares one subject, where there is nothing to differ from. A scenario
 * without its baseline is not among them: it is a variant, and the charts ask for its baseline (`ASK_BASELINE`).
 */
export function whyNote(why: WhyData, rows: MatrixRow[]): string | null {
  const isAlone = (e: WhyData['plan'][number]): boolean =>
    'reason' in e && (e.reason === 'independent' || e.reason === 'dataset')
  const alone = why.plan.flatMap((e, i) => (isAlone(e) && rows[i] ? [rows[i].label] : []))
  if (!alone.length || rows.length < 2) return null
  if (why.plan.every(isAlone))
    return (
      'What makes the difference is split only between a model and its scenarios, or a copy and its ' +
      'original — these subjects are independent of each other.'
    )
  return `Not split: ${alone.join(', ')} — neither a scenario nor a copy of another subject here.`
}
