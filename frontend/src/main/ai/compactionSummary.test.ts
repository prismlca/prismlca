import { describe, expect, it } from 'vitest'
import type { DroppedResult } from './contextBudget'
import { SUMMARY_MAX_INPUT, summaryInput, summaryTask, TASK_CHARS } from './compactionSummary'

const result = (tool: string, text: string, args = '{}'): DroppedResult => ({ tool, args, text })

describe('what the summariser reads of the dropped results', () => {
  it('heads every result with the call that produced it', () => {
    const input = summaryInput([result('search_background', '{"hits":[]}', '{"query":"steel"}')])
    expect(input).toBe('### search_background {"query":"steel"}\n{"hits":[]}')
  })

  it('reads the newest results when not all of them fit, and says how many it left out', () => {
    const dropped = Array.from({ length: 60 }, (_, i) =>
      result('get_process_details', `r${i} `.repeat(1_000))
    )
    const input = summaryInput(dropped)
    expect(input.length).toBeLessThanOrEqual(SUMMARY_MAX_INPUT)
    // The oldest are counted, not shown; the newest are always there.
    expect(input).toMatch(/^\(\d+ older results not included\)/)
    expect(input).toContain('r59 ')
    expect(input).not.toContain('r0 ')
  })

  it('stays inside its cap with headings, separators and markers counted', () => {
    const dropped = Array.from({ length: 33 }, (_, i) =>
      result('search_background', 'x'.repeat(5_000), `{"query":"${'q'.repeat(300)}${i}"}`)
    )
    expect(summaryInput(dropped).length).toBeLessThanOrEqual(SUMMARY_MAX_INPUT)
  })

  it('lets one giant result have what the short ones leave, but not the whole room', () => {
    const giant = result('research_web', `${'A'.repeat(100_000)}CONCLUSION`)
    const short = Array.from({ length: 5 }, (_, i) => result('list_methods', `short ${i}`))
    const input = summaryInput([giant, ...short])
    // Every short result is whole, and the giant fills nearly the rest, cut in the middle: its end
    // (where research puts its conclusion) survives.
    for (let i = 0; i < 5; i++) expect(input).toContain(`short ${i}`)
    expect(input).toContain('… [cut] …')
    expect(input).toContain('CONCLUSION')
    expect(input.length).toBeGreaterThan(SUMMARY_MAX_INPUT - 1_000)
  })

  it('shares the room equally between results of the same size, oldest first in the output', () => {
    const input = summaryInput([result('a', 'a'.repeat(50_000)), result('b', 'b'.repeat(50_000))])
    const a = input.split('### b')[0]
    expect(input.indexOf('### a')).toBeLessThan(input.indexOf('### b'))
    expect(Math.abs(a.length - (input.length - a.length))).toBeLessThan(100)
  })

  it('names a protected result the forced sweep gave up, like any other', () => {
    const input = summaryInput([result('get_skill', 'Skill: EF 3.1 rules … use the cut-off approach')])
    expect(input).toContain('### get_skill')
    expect(input).toContain('use the cut-off approach')
  })
})

describe("the user's request beside them", () => {
  it('is the run’s own message, then what the user sent while it worked', () => {
    expect(summaryTask(['Build a bike model.', 'use kilograms'])).toBe(
      'Build a bike model.\nThen, while it worked: use kilograms'
    )
  })

  it('serves the newest message first and keeps its last words, without crowding out the request', () => {
    const request = `Build the bike model. ${'Context. '.repeat(120)}Use EF 3.1.`
    const newest = `Change of plan: ${'detail '.repeat(150)}and report in kilograms.`
    const task = summaryTask([request, 'an older note', newest])
    expect(task.length).toBeLessThanOrEqual(TASK_CHARS)
    // The newest message fits whole, its final constraint included.
    expect(task).toContain(newest)
    // The request keeps its start and its end.
    expect(task.startsWith('Build the bike model.')).toBe(true)
    expect(task).toContain('Use EF 3.1.')
  })

  it('stays inside its cap with every label and line break counted', () => {
    for (const notes of [
      ['request', ...Array.from({ length: 100 }, () => 'yes')],
      ['R'.repeat(5_000), 'S'.repeat(5_000)],
      ['', 'only steering '.repeat(300)],
      ['R'.repeat(5_000)]
    ])
      expect(summaryTask(notes).length).toBeLessThanOrEqual(TASK_CHARS)
  })

  it('is empty when there is nothing to say', () => {
    expect(summaryTask(['  '])).toBe('')
  })
})
