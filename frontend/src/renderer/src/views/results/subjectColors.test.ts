import { describe, expect, it } from 'vitest'
import { SUBJECT_PALETTE as P } from '../../lib/palette'
import { subjectKey, type SubjectRef } from '../../lib/subjectKey'
import { buildColorMap } from './subjectColors'
import type { Matrix } from './types'

/**
 * The slot rules of the Results colours, pinned on the pure function: the page reads the same function
 * for the rail, the bars and the radar, so a rule broken here is a colour that differs between them.
 */
const DB = 'Model A'
const own = (code: string): SubjectRef => ({ database: DB, code })
const bg = (code: string): SubjectRef => ({ database: 'ecoinvent', code })
const fg = (code: string): SubjectRef => ({ database: 'Model B', code })
const rows = (...subjects: SubjectRef[]): Matrix => ({
  methods: [],
  subjects: subjects.map((s) => ({ ...s, label: s.code, scores: {} }))
})

function colours(over: Partial<Parameters<typeof buildColorMap>[0]> = {}) {
  const activeDb = over.activeDb === undefined ? DB : over.activeDb
  return buildColorMap({
    activeDb,
    acts: [{ code: 'root' }, { code: 'cap' }],
    bgSubjects: [bg('b1'), bg('b2')],
    shownFg: [fg('g1')],
    scenarios: [{ id: 's1' }, { id: 's2' }],
    matrix: null,
    subjectColors: {},
    keyOf: (s) => subjectKey(s, activeDb),
    ...over
  })
}

describe('buildColorMap', () => {
  it('slots by position: own processes, then database activities, then other models', () => {
    const c = colours()
    expect([own('root'), own('cap'), bg('b1'), bg('b2'), fg('g1')].map(c.subject)).toEqual(P.slice(0, 5))
  })

  it("scenarios come after every listed subject, and a scenario row takes its scenario's colour", () => {
    const c = colours()
    expect([c.scenario('s1'), c.scenario('s2')]).toEqual([P[5], P[6]])
    expect(c.subject({ ...own('cap'), scenario: 's2' })).toBe(P[6])
  })

  it("a user's colour wins, for a subject and for a scenario", () => {
    const c = colours({ subjectColors: { cap: '#111111', 'ecoinvent/b2': '#222222', s1: '#333333' } })
    expect(c.subject(own('cap'))).toBe('#111111')
    expect(c.subject(bg('b2'))).toBe('#222222')
    expect(c.scenario('s1')).toBe('#333333')
    expect(c.subject({ ...own('root'), scenario: 's1' })).toBe('#333333')
  })

  it('rows whose subject or scenario is gone get slots past the scenarios, distinct from every live one', () => {
    // b1 removed from the rail, s1 deleted — both still on screen until the next Calculate.
    const c = colours({
      bgSubjects: [bg('b2')],
      scenarios: [{ id: 's2' }],
      matrix: rows(own('root'), bg('b1'), bg('b2'), { ...own('root'), scenario: 's1' })
    })
    const live = [own('root'), own('cap'), bg('b2'), fg('g1')].map(c.subject).concat(c.scenario('s2'))
    const goneScenario = c.scenario('s1')
    const goneSubject = c.subject(bg('b1'))
    expect(goneScenario).toBe(P[5]) // 4 listed subjects + 1 live scenario
    expect(goneSubject).toBe(P[6]) // … + 1 gone scenario
    expect(new Set([...live, goneScenario, goneSubject]).size).toBe(live.length + 2)
  })

  it('a deleted scenario and a removed activity with no scenarios left do not share a colour', () => {
    const c = colours({
      acts: [{ code: 'root' }],
      bgSubjects: [],
      shownFg: [],
      scenarios: [],
      matrix: rows({ ...own('root'), scenario: 's1' }, bg('b1'))
    })
    expect(c.scenario('s1')).not.toBe(c.subject(bg('b1')))
  })

  it('an unknown subject that is not on screen falls back to the first slot, as before', () => {
    expect(colours().subject(bg('never-seen'))).toBe(P[0])
  })

  it("the own model's processes are keyed against the active model, so a model switch re-keys them", () => {
    const stored = { root: '#abcdef' }
    expect(colours({ subjectColors: stored }).subject(own('root'))).toBe('#abcdef')
    // Viewed from Model B, Model A's `root` is a foreign subject: the bare-code colour is not its colour.
    const fromB = colours({ activeDb: 'Model B', subjectColors: stored, shownFg: [own('root')] })
    expect(fromB.subject(own('root'))).not.toBe('#abcdef')
  })

  it('with no active model the own processes still take the first slots', () => {
    const c = colours({ activeDb: null })
    expect(c.subject({ database: '', code: 'root' })).toBe(P[0])
    expect(c.subject({ database: '', code: 'cap' })).toBe(P[1])
  })

  it('wraps around the palette', () => {
    const acts = Array.from({ length: P.length + 1 }, (_, i) => ({ code: `p${i}` }))
    const c = colours({ acts, bgSubjects: [], shownFg: [], scenarios: [] })
    expect(c.subject(own(`p${P.length}`))).toBe(P[0])
  })
})
