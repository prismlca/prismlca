import { describe, expect, it } from 'vitest'
import { followSummaries, planForChapter, type PlanItem } from './plan'
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
