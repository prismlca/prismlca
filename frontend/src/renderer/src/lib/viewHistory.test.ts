import { describe, expect, it } from 'vitest'
import {
  firstRedo,
  firstUndo,
  pushStep,
  redoStep,
  undoStep,
  VIEW_HISTORY_LIMIT,
  type ViewSnapshot,
  type ViewStep
} from './viewHistory'

const snap = (x: number): ViewSnapshot => ({ pos: { 'm/a': { x, y: 0 } }, colors: {}, groups: [] })
const step = (label: string, at: number, x = at): ViewStep => ({ label, at, snap: snap(x) })

describe('which history Undo and Redo take first', () => {
  it('Undo takes the newer step; the canvas alone when the model has none', () => {
    expect(firstUndo(step('Move', 20), 10)).toBe(true)
    expect(firstUndo(step('Move', 5), 10)).toBe(false)
    expect(firstUndo(step('Move', 5), null)).toBe(true)
    expect(firstUndo(undefined, null)).toBe(false)
  })

  it('a canvas step does not jump ahead of a newer model step, even one another model holds', () => {
    // The model's own step at 10 is held (its Undo is blocked): its time still counts.
    expect(firstUndo(step('Paint', 5), 10)).toBe(false)
  })

  it('Redo brings back the older of the two — the one Undo took back last', () => {
    expect(firstRedo(step('Move', 5), 10)).toBe(true)
    expect(firstRedo(step('Move', 20), 10)).toBe(false)
    expect(firstRedo(step('Move', 20), null)).toBe(true)
  })
})

describe('the steps', () => {
  it('a new step drops Redo, and the oldest fall off past the limit', () => {
    let s = { undo: [] as ViewStep[], redo: [step('Old', 1)] }
    s = pushStep(s, step('New', 2))
    expect(s.redo).toEqual([])
    for (let i = 0; i < VIEW_HISTORY_LIMIT + 5; i++) s = pushStep(s, step(`s${i}`, 3 + i))
    expect(s.undo).toHaveLength(VIEW_HISTORY_LIMIT)
    expect(s.undo[0].label).toBe('s5')
  })

  it('undo puts back the arrangement from before and keeps the current one for redo, under the same label and time', () => {
    const s = pushStep({ undo: [], redo: [] }, step('Auto-layout', 7, 100))
    const u = undoStep(s, snap(300))!
    expect(u.restore).toEqual(snap(100))
    expect(u.stacks.undo).toEqual([])
    expect(u.stacks.redo).toEqual([{ label: 'Auto-layout', at: 7, snap: snap(300) }])
    const r = redoStep(u.stacks, snap(100))!
    expect(r.restore).toEqual(snap(300))
    expect(r.stacks.undo).toEqual([{ label: 'Auto-layout', at: 7, snap: snap(100) }])
    expect(undoStep({ undo: [], redo: [] }, snap(0))).toBeNull()
  })
})
