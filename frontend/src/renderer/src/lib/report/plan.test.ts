import { describe, expect, it } from 'vitest'
import { followSummaries, planForChapter, runErrors, runSummary, type PlanItem } from './plan'
import type { ReportSection } from './model'

const chapter = (id: string, kind: string, text = 'Written.'): ReportSection =>
  ({ id, kind, title: '', text }) as ReportSection
const keep = (s: ReportSection): PlanItem =>
  planForChapter(s, { remedy: 'none', findings: [] } as never, null, true)

describe('the run plan', () => {
  it('takes the summarising chapters along when a chapter they sum up changes in the run', () => {
    const lcia = { ...keep(chapter('a', 'lcia')), action: 'update' as const }
    const items = followSummaries([lcia, keep(chapter('c', 'conclusions')), keep(chapter('s', 'summary'))])
    expect(items.map((i) => i.action)).toEqual(['update', 'update', 'update'])
    expect(items[2].why).toContain('change in this run')
  })

  it('leaves them alone when nothing they sum up changes, and never writes an empty one this way', () => {
    const quiet = [keep(chapter('a', 'lcia')), keep(chapter('s', 'summary'))]
    expect(followSummaries(quiet).map((i) => i.action)).toEqual(['keep', 'keep'])
    const empty = followSummaries([
      { ...keep(chapter('a', 'lcia')), action: 'update' },
      planForChapter(chapter('s', 'summary', ''), undefined, null, false)
    ])
    expect(empty[1].action).toBe('write')
  })
})

describe('what a run says about the chapters it could not store', () => {
  const sections = [
    { id: 'a', kind: 'prose' },
    { id: 'b', kind: 'lcia', title: 'Results' }
  ]

  it('names the chapter in words for the user, not the gate finding written for the model', () => {
    const errors = runErrors(
      [
        { id: 'a', stored: false },
        { id: 'b', stored: true }
      ],
      sections
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/^Interpretation kept failing the report's checks/)
    expect(errors[0]).not.toMatch(/placeholder|derivation/i)
    expect(
      runSummary({ written: 1, updated: 0, unchanged: 0, unfinished: 1, firstError: errors[0], errors: 1 })
    ).toBe(`1 written · 1 could not be finished — ${errors[0]}`)
  })

  it('passes a run error on as it is', () => {
    expect(runErrors([{ id: 'b', stored: false, error: 'Canceled.' }], sections)).toEqual(['Canceled.'])
  })
})
