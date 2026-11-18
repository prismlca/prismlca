/**
 * How long whole study runs took on a catalogue model, measured by us — and the rule that turns those
 * minutes into "slow" at the end of its descriptor (the descriptor rule in models.ts points here,
 * models.test.ts holds every catalogue descriptor to it).
 *
 * Strength and price words follow outside figures that cover every row: the Artificial Analysis index
 * and the live prices. Nothing like that says how long a user waits for a whole study run — dozens of
 * model calls, tool rounds and sub-agents, on whatever host serves the model. Only our own runs say
 * that, so "slow" stands only where a run of ours stands behind it: no measurement, no word.
 *
 * A measurement is the wall time of the same studies, run once on the model and once on the default
 * chat model of one of the providers, at the same effort. The reference need not share the row's
 * provider: the defaults are the strong models a user weighs the others against. Every role — chat,
 * research, review — runs on the model under test, so the minutes are the model's own rather than a
 * blend with the default sub-agents, and the descriptor stands in every role picker. Someone who picks
 * the model only as the chat model keeps the research and review models of their settings, and may wait
 * less than the measured multiple. Wall time includes the time the runs waited for answers to their
 * questions, under a minute each. The word is "slow" when the model's median run takes more than
 * SLOW_FACTOR times the reference's median — a multiple the user cannot miss, not a ranking. Medians,
 * because one run can take twice as long as its siblings on the same model, and a single outlier should
 * not decide the word.
 */
import type { ReasoningEffort } from '../../shared/aiDefaults'

export interface RunTimeMeasurement {
  /** The day the runs were made (YYYY-MM-DD); hosts and models change, so the figure is dated. */
  measured: string
  /** The reasoning effort both sides ran at, every role included. */
  effort: ReasoningEffort
  /** The studies, in the order of the two minute lists. */
  studies: string[]
  /** Wall time per study on this model, in minutes. */
  minutes: number[]
  /** The default chat model it was measured against: some provider's `providerDefaults(p).chat`. */
  reference: string
  /** Wall time per study on the reference model, same order. */
  referenceMinutes: number[]
}

/** More than this many times the reference's median run time makes a model "slow". */
export const SLOW_FACTOR = 3

/** The fewest studies a measurement may rest on. One run is an anecdote. */
export const MIN_STUDIES = 3

const STUDIES = ['wheelbarrow', 'heavy-duty shelf', 'liquid soap']

/** Our measurements, by catalogue id. A model added to the catalogue gets a row here once it has been
 *  run; until then its descriptor says nothing about pace, however fast or slow it feels. */
export const RUN_TIMES: Record<string, RunTimeMeasurement> = {
  // Three to four and a half times Sonnet 5.5's time per study, through its one endpoint (Tencent's own).
  'tencent/hy4': {
    measured: '2026-11-15',
    effort: 'high',
    studies: STUDIES,
    minutes: [27.1, 29.6, 26.3],
    reference: 'claude-sonnet-5-5',
    referenceMinutes: [9.3, 6.5, 6.9]
  },
  // The widest spread of the three: from under three times Sonnet 5.5's time to six and a half.
  'mistralai/mistral-large-4-0': {
    measured: '2026-11-15',
    effort: 'high',
    studies: STUDIES,
    minutes: [60.4, 33.5, 18.1],
    reference: 'claude-sonnet-5-5',
    referenceMinutes: [9.3, 6.5, 6.9]
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** How many times longer the model's median run took than the reference's. */
export function slowdown(m: RunTimeMeasurement): number {
  return median(m.minutes) / median(m.referenceMinutes)
}

/** Whether a measurement earns the descriptor its "slow". */
export function isSlow(m: RunTimeMeasurement | undefined): boolean {
  return m !== undefined && slowdown(m) > SLOW_FACTOR
}
