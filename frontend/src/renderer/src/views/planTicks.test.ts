import { describe, expect, it } from 'vitest'

import { mergeTicks, type PlanItem } from './ReportSections'

/** A plan row: only the id and the action decide what `mergeTicks` does. */
const item = (id: string, action: PlanItem['action']): PlanItem =>
  ({ section: { id, kind: 'prose' }, action, why: '' }) as unknown as PlanItem

describe('the write-all plan keeps the ticks the author made while it was checking', () => {
  // The dialog draws at once and re-sorts itself when the staleness check lands, tens of seconds
  // later on an ecoinvent model. Run is disabled until then, so almost every tick is made in that
  // window — and they used to be discarded. Ticking all ten chapters and watching the run start
  // with three is how this was found.
  const provisional = [item('a', 'write'), item('b', 'keep'), item('c', 'keep')]

  it('keeps a chapter the author ticked that the defaults would leave alone', () => {
    expect(mergeTicks(provisional, ['a', 'b', 'c'], provisional)).toEqual(['a', 'b', 'c'])
  })

  it('keeps a chapter the author unticked that the defaults want', () => {
    expect(mergeTicks(provisional, [], provisional)).toEqual([])
  })

  it('takes the default for a chapter the fresh plan brought in', () => {
    // 'd' was never on screen, so nothing was decided about it: it follows the default (write).
    const fresh = [...provisional, item('d', 'write'), item('e', 'keep')]
    expect(mergeTicks(provisional, ['b'], fresh)).toEqual(['b', 'd'])
  })

  it('drops a chapter that is gone, without disturbing the rest', () => {
    const fresh = [item('a', 'write'), item('c', 'keep')]
    expect(mergeTicks(provisional, ['a', 'b', 'c'], fresh)).toEqual(['a', 'c'])
  })

  it('follows the action a chapter has now, not the one it had', () => {
    // The check found 'b' out of date. It was on screen and left unticked, so it stays unticked —
    // the author's decision outranks a default, which is the whole point of asking first.
    const fresh = [item('a', 'write'), item('b', 'update'), item('c', 'keep')]
    expect(mergeTicks(provisional, ['a'], fresh)).toEqual(['a'])
  })

  it('returns the ids in the fresh plan’s order', () => {
    const fresh = [item('c', 'write'), item('a', 'write')]
    expect(mergeTicks(provisional, ['a', 'c'], fresh)).toEqual(['c', 'a'])
  })
})
