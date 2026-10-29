import { describe, expect, it } from 'vitest'

import { runDone, runSize, type PlanItem } from './ReportSections'

/** A plan row: only the id and the action decide what a run of it costs. */
const item = (id: string, action: PlanItem['action']): PlanItem =>
  ({ section: { id, kind: 'prose' }, action, why: '' }) as unknown as PlanItem

describe('the write-all button names every call the run will make', () => {
  // The run that found this: nine chapters, a glossary and a German study in an English report. The
  // button offered "Run 10" and the study translation — a paid model call of its own — made it
  // eleven. The author agreed to a different number than they got (V169).
  const items = [item('a', 'write'), item('b', 'update'), item('c', 'keep'), item('g', 'glossary')]

  it('counts the ticked chapters and the glossary', () => {
    expect(runSize(items, ['a', 'b', 'g'], false)).toEqual({
      chapters: 2,
      glossary: 1,
      translation: 0,
      total: 3
    })
  })

  it('counts the study translation when the report is in another language', () => {
    expect(runSize(items, ['a', 'b', 'g'], true).total).toBe(4)
  })

  it('ignores the chapters that were left unticked', () => {
    expect(runSize(items, ['a'], false).total).toBe(1)
  })

  it('does not translate for a glossary alone: no chapter is going to read the texts', () => {
    // `runPlan` skips the translator in this case too, so counting it would over-state the bill.
    expect(runSize(items, ['g'], true)).toEqual({
      chapters: 0,
      glossary: 1,
      translation: 0,
      total: 1
    })
  })

  it('counts nothing when nothing is ticked, so the button can say so', () => {
    expect(runSize(items, [], true).total).toBe(0)
  })

  it('counts a second glossary row once — the run only rebuilds one', () => {
    const two = [...items, item('g2', 'glossary')]
    expect(runSize(two, ['g', 'g2'], false).total).toBe(1)
  })
})

describe('the progress figure reaches the total it promised', () => {
  // The main process counts chapters only; the renderer adds the translation step it ran itself. It
  // used to overwrite instead of add, so the run went from "9 of 11" straight to finished and
  // "10 of 11" never existed. Nine chapters, a glossary, a German study, an English report.
  const { translation, total } = runSize(
    [...Array(9).keys()].map((i) => item(`s${i}`, 'write')).concat([item('g', 'glossary')]),
    [...Array(9).keys()].map((i) => `s${i}`).concat(['g']),
    true
  )

  it('has the translation in the total', () => {
    expect(total).toBe(11)
    expect(translation).toBe(1)
  })

  it('keeps the finished translation while the chapters are counted', () => {
    expect(runDone(0, translation, total)).toBe(1)
    expect(runDone(9, translation, total)).toBe(10) // the step that was skipped
  })

  it('never runs past the total, whatever the main process reports', () => {
    expect(runDone(99, translation, total)).toBe(total)
  })
})
