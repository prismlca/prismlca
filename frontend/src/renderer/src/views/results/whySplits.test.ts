import { describe, expect, it } from 'vitest'
import {
  changePart,
  deltaLabel,
  fmtShare,
  gatherWhy,
  needsBaseline,
  pairingText,
  pairsFor,
  vsLabel,
  whyNote
} from './whySplits'
import type { DifferenceBlock, MatrixRow } from './types'

const A = ['EF v3.1', 'climate change', 'GWP100']
const B = ['EF v3.1', 'acidification', 'AE']

function block(method: string[], delta: number, ref = 10): DifferenceBlock {
  return {
    method,
    unit: 'u',
    reference_score: ref,
    score: ref + delta,
    delta,
    ...(ref ? { delta_pct: (100 * delta) / ref } : {}),
    changes: [],
    not_explained: 0,
    exact: true
  }
}

const row = (code: string, label: string, scenario?: string, database = 'm'): MatrixRow => ({
  label,
  code,
  database,
  scenario,
  scores: {}
})

describe('what makes the difference, gathered and worded', () => {
  it('keys each split by the method the run asked for, whatever name the answer gives it', () => {
    const installed = ['EF v3.1', 'climate change', 'global warming potential (GWP100)']
    const why = gatherWhy(
      [
        { plan: [{ reason: 'reference' }, { reference: 0 }], splits: [] },
        {
          plan: [{ reason: 'reference' }, { reference: 0 }],
          splits: [{ subject: 1, reference: 0, indicators: [block(installed, 2), block(B, -1)] }]
        }
      ],
      [A, B]
    )
    expect(Object.keys(why.splits[1].blocks)).toEqual([A.join(' · '), B.join(' · ')])
    expect(pairsFor(why, A.join(' · ')).map((p) => [p.sub, p.ref, p.block?.delta])).toEqual([[1, 0, 2]])
  })

  it('keeps a pair that could not be split under every chart, with its reason', () => {
    const why = gatherWhy(
      [
        {
          plan: [{ reason: 'reference' }, { reference: 0 }],
          splits: [{ subject: 1, reference: 0, error: 'moved' }]
        }
      ],
      [A]
    )
    expect(pairsFor(why, A.join(' · '))).toMatchObject([{ sub: 1, ref: 0, split: { error: 'moved' } }])
  })

  it('calls the same process without a scenario the baseline, and anything else by its label', () => {
    const rows = [row('p', 'Pavilion'), row('p', 'Heavy', 's1'), row('q', 'Pavilion — copy', undefined, 'c')]
    expect(vsLabel(rows, 1, 0)).toBe('baseline')
    expect(vsLabel(rows, 2, 0)).toBe('Pavilion')
  })

  it('words a share, a contribution without one, and a difference to a reference of zero', () => {
    expect(fmtShare(68.2)).toBe('68 %')
    expect(fmtShare(9.04)).toBe('9 %')
    expect(fmtShare(-4.25)).toBe('−4.3 %')
    expect(changePart({ kind: 'input', before: 1, after: 2, contribution: -0.5 }, 3)).toBe('−0.5')
    expect(deltaLabel(block(A, 2), 3)).toBe('+20.0%')
    expect(deltaLabel(block(A, 2, 0), 3)).toBe('+2 u')
    expect(deltaLabel(block(A, 0), 3)).toBe('±0')
  })

  it('says how a copy was laid onto its original, one process or many', () => {
    expect(pairingText({ paired: 1 })).toBe('1 process paired with the original.')
    expect(
      pairingText({
        paired: 3,
        paired_by_name: 1,
        only_in_subject: ['paint'],
        only_in_reference: ['recycle']
      })
    ).toBe(
      '3 processes paired with the original (1 by name). Only in this model: paint. Only in the original: recycle.'
    )
  })

  it('says in one sentence why nothing, or what, is not split', () => {
    const rows = [row('p', 'Pavilion'), row('q', 'Tent'), row('x', 'PET granulate', undefined, 'ei')]
    const none = {
      plan: [{ reason: 'independent' as const }, { reason: 'independent' as const }],
      splits: {}
    }
    expect(whyNote(none, rows.slice(0, 2))).toMatch(/^What makes the difference is split only between/)
    const some = {
      plan: [{ reason: 'reference' as const }, { reference: 0 }, { reason: 'dataset' as const }],
      splits: {}
    }
    expect(whyNote(some, rows)).toBe(
      'Not split: PET granulate — neither a scenario nor a copy of another subject here.'
    )
    expect(
      whyNote({ plan: [{ reason: 'reference' }, { reference: 0 }], splits: {} }, rows.slice(0, 2))
    ).toBeNull()
  })

  it('counts a scenario without its baseline as a variant the charts ask the baseline for, not as independent', () => {
    const rows = [row('p', 'Heavy', 's1'), row('p', 'Light', 's2'), row('q', 'Tent')]
    const scenarios = {
      plan: [{ reason: 'no_baseline' as const }, { reason: 'no_baseline' as const }],
      splits: {}
    }
    expect(needsBaseline(scenarios)).toBe(true)
    expect(whyNote(scenarios, rows.slice(0, 2))).toBeNull()
    const withTent = { plan: [...scenarios.plan, { reason: 'independent' as const }], splits: {} }
    expect(whyNote(withTent, rows)).toBe(
      'Not split: Tent — neither a scenario nor a copy of another subject here.'
    )
    expect(needsBaseline({ plan: [{ reason: 'reference' }, { reference: 0 }], splits: {} })).toBe(false)
  })
})
