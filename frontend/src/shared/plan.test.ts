import { describe, expect, it } from 'vitest'

import { formatPlanForModel, planProgress, validatePlanUpdate, type ChatPlan } from './plan'

const plan = (steps: ChatPlan['steps'], revision = 1): ChatPlan => ({
  title: 'PET bottle model',
  steps,
  revision,
  updated: '2026-10-01T10:00:00Z'
})

describe('validatePlanUpdate', () => {
  it('accepts a first plan with a title and exactly one step in progress', () => {
    const v = validatePlanUpdate(null, {
      title: 'PET bottle model',
      steps: [
        { step: 'Record goal and scope', status: 'in_progress' },
        { step: 'Find PET granulate dataset', status: 'pending' }
      ]
    })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.input.steps).toHaveLength(2)
  })

  it('refuses the shapes a weak model sends: a string, one step, a missing title', () => {
    expect(validatePlanUpdate(null, 'do the thing')).toMatchObject({ ok: false })
    expect(validatePlanUpdate(null, { steps: 'Record goal' })).toMatchObject({ ok: false })
    const noTitle = validatePlanUpdate(null, { steps: [{ step: 'Record goal', status: 'in_progress' }] })
    expect(noTitle).toMatchObject({ ok: false })
    if (!noTitle.ok) expect(noTitle.error).toContain('title')
  })

  it('refuses two in_progress steps and names them', () => {
    const v = validatePlanUpdate(null, {
      title: 'T',
      steps: [
        { step: 'A', status: 'in_progress' },
        { step: 'B', status: 'in_progress' }
      ]
    })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toMatch(/"A".*"B"/)
  })

  it('refuses a list with work left and nothing in progress, but accepts an all-terminal list', () => {
    const idle = validatePlanUpdate(plan([{ step: 'A', status: 'in_progress' }]), {
      steps: [
        { step: 'A', status: 'completed' },
        { step: 'B', status: 'pending' }
      ]
    })
    expect(idle.ok).toBe(false)
    if (!idle.ok) expect(idle.error).toContain('in_progress')
    const done = validatePlanUpdate(plan([{ step: 'A', status: 'in_progress' }]), {
      steps: [
        { step: 'A', status: 'completed' },
        { step: 'B', status: 'skipped', note: 'not needed' }
      ]
    })
    expect(done.ok).toBe(true)
  })

  it('demands a note on blocked and skipped steps', () => {
    const v = validatePlanUpdate(null, {
      title: 'T',
      steps: [
        { step: 'A', status: 'blocked' },
        { step: 'B', status: 'in_progress' }
      ]
    })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toContain('note')
  })

  it('lets an unfinished step disappear only with an explanation', () => {
    const prev = plan([
      { step: 'Link PET granulate', status: 'in_progress' },
      { step: 'Calculate GWP', status: 'pending' }
    ])
    const silent = validatePlanUpdate(prev, { steps: [{ step: 'Calculate GWP', status: 'in_progress' }] })
    expect(silent.ok).toBe(false)
    if (!silent.ok) expect(silent.error).toContain('explanation')
    const said = validatePlanUpdate(prev, {
      explanation: 'granulate is linked via the preform dataset instead',
      steps: [{ step: 'Calculate GWP', status: 'in_progress' }]
    })
    expect(said.ok).toBe(true)
    // A completed step may vanish without a word — nothing unfinished is lost.
    const doneGone = validatePlanUpdate(
      plan([
        { step: 'A', status: 'completed' },
        { step: 'B', status: 'in_progress' }
      ]),
      { steps: [{ step: 'B', status: 'in_progress' }] }
    )
    expect(doneGone.ok).toBe(true)
  })

  it('clears the plan on an empty list, with an explanation only', () => {
    const prev = plan([{ step: 'A', status: 'in_progress' }])
    expect(validatePlanUpdate(prev, { steps: [] })).toMatchObject({ ok: false })
    expect(validatePlanUpdate(prev, { steps: [], explanation: 'user withdrew the task' })).toMatchObject({
      ok: true,
      cleared: true
    })
    expect(validatePlanUpdate(null, { steps: [] })).toMatchObject({ ok: false })
  })

  it('bounds the list and the texts', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      step: `S${i}`,
      status: i ? 'pending' : 'in_progress'
    }))
    expect(validatePlanUpdate(null, { title: 'T', steps: many })).toMatchObject({ ok: false })
    const long = validatePlanUpdate(null, {
      title: 'T',
      steps: [{ step: 'x'.repeat(121), status: 'in_progress' }]
    })
    expect(long.ok).toBe(false)
  })
})

describe('validatePlanUpdate — status written as a key (V364)', () => {
  const prev = plan([
    { step: 'Record goal', status: 'completed' },
    { step: 'Link datasets', status: 'in_progress' }
  ])

  it('names the key the status landed in and the line to write instead', () => {
    const v = validatePlanUpdate(prev, {
      steps: [
        { step: 'Record goal', status: 'completed' },
        { in_progress: true, step: 'Link datasets' }
      ]
    })
    expect(v.ok).toBe(false)
    if (!v.ok)
      expect(v.error).toBe(
        'steps[1] has no "status" — you wrote "in_progress" as a key; write "status": "in_progress".'
      )
    const asValue = validatePlanUpdate(prev, {
      steps: [
        { step: 'Record goal', status: 'completed' },
        { in_progress: 'pending', step: 'Link datasets' }
      ]
    })
    if (!asValue.ok) expect(asValue.error).toContain('you wrote "in_progress" as a key')
  })

  it('leaves a step with a proper status alone, whatever else it carries', () => {
    // The counter-probe: a foreign key beside a correct status is not the V364 shape.
    const v = validatePlanUpdate(prev, {
      steps: [
        { step: 'Record goal', status: 'completed', completed: true },
        { step: 'Link datasets', status: 'in_progress', owner: 'me' }
      ]
    })
    expect(v.ok).toBe(true)
    // A status that is simply missing, with no status-named key, keeps the plain refusal.
    const missing = validatePlanUpdate(prev, {
      steps: [
        { step: 'Record goal', status: 'completed' },
        { step: 'Link datasets', state: 'in_progress' }
      ]
    })
    if (!missing.ok) expect(missing.error).toContain('steps[1].status "undefined" is not one of')
  })
})

describe('planProgress / formatPlanForModel', () => {
  it('counts completed and skipped as done and renders one line per step', () => {
    const p = plan([
      { step: 'A', status: 'completed' },
      { step: 'B', status: 'skipped', note: 'n/a' },
      { step: 'C', status: 'in_progress' },
      { step: 'D', status: 'pending' }
    ])
    expect(planProgress(p)).toEqual({ completed: 2, total: 4 })
    const text = formatPlanForModel(p)
    expect(text).toContain('2/4 done')
    expect(text.split('\n')).toHaveLength(5)
    expect(text).toContain('[>] 3. C')
    expect(text).toContain('[-] 2. B — n/a')
  })
})
