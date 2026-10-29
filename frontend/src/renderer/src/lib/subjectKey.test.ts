/**
 * The compare subject's identity is database + code + scenario, stored relative to the model whose
 * view holds it — and keys stored before that move over without anyone noticing.
 */
import { describe, expect, it } from 'vitest'
import { migrateSubjectKeys, renameDatabaseInView, subjectKey, type OwnModel } from './subjectKey'

const own = (codes: string[], scenarios: string[] = [], databases: string[] | null = null): OwnModel => ({
  codes,
  scenarios,
  databases: databases ? new Set(databases) : null
})

describe('subjectKey', () => {
  it('keeps the own model bare and names every other database', () => {
    expect(subjectKey({ database: 'A', code: 'root' }, 'A')).toBe('root')
    expect(subjectKey({ database: 'A', code: 'root', scenario: 's1' }, 'A')).toBe('root#s1')
    expect(subjectKey({ database: 'B', code: 'root' }, 'A')).toBe('B/root')
    expect(subjectKey({ database: 'A', code: 'root' }, null)).toBe('A/root')
  })

  it('is injective for free-text codes and model names (review P2)', () => {
    // Own code "B/root" vs B's "root"; own code "root#s1" vs root under scenario s1; absolute
    // B:"C/root" vs "B/C":root — each pair used to produce one key.
    expect(subjectKey({ database: 'A', code: 'B/root' }, 'A')).not.toBe(
      subjectKey({ database: 'B', code: 'root' }, 'A')
    )
    expect(subjectKey({ database: 'A', code: 'root#s1' }, 'A')).not.toBe(
      subjectKey({ database: 'A', code: 'root', scenario: 's1' }, 'A')
    )
    expect(subjectKey({ database: 'B', code: 'C/root' }, null)).not.toBe(
      subjectKey({ database: 'B/C', code: 'root' }, null)
    )
    expect(subjectKey({ database: 'A', code: '100%' }, 'A')).not.toBe(
      subjectKey({ database: 'A', code: '100%25' }, 'A')
    )
  })
})

describe('migrateSubjectKeys', () => {
  const fg = [{ database: 'B', code: 'root', name: 'PET bottle' }]
  const bg = [{ database: 'ecoinvent-3.12', code: 'hex', name: 'PET granulate', amount: 1 }]

  it('moves colours and the reference of foreign subjects to database/code, and marks the section', () => {
    const out = migrateSubjectKeys(
      {
        subjSel: { own: true },
        fgSubjects: fg,
        bgSubjects: bg,
        colors: { own: '#111111', root: '#222222', hex: '#333333', s1: '#444444' },
        refCode: 'hex'
      },
      'A',
      own(['own'], ['s1'])
    )
    expect(out!.colors).toEqual({
      own: '#111111',
      s1: '#444444',
      'B/root': '#222222',
      'ecoinvent-3.12/hex': '#333333'
    })
    expect(out!.refCode).toBe('ecoinvent-3.12/hex')
    expect(out!.subjSel).toEqual({ own: true })
    expect(out!.keys).toBe(2)
  })

  it('leaves a bare key the own model also answers to — both keep the colour they shared', () => {
    const out = migrateSubjectKeys(
      { subjSel: { root: true }, fgSubjects: fg, colors: { root: '#222222' }, refCode: 'root' },
      'A',
      own(['root'])
    )
    expect(out!.colors).toEqual({ root: '#222222', 'B/root': '#222222' })
    // The old lookup found the own row first, so the reference stays with it.
    expect(out!.refCode).toBe('root')
  })

  it('runs once: a marked section is never read as old keys again (review P2, idempotence)', () => {
    const first = migrateSubjectKeys({ bgSubjects: bg, colors: { hex: '#333333' } }, 'A', own([]))
    expect(first).not.toBeNull()
    expect(migrateSubjectKeys(first!, 'A', own([]))).toBeNull()
  })

  it('reads only the old snapshot: a key one move writes is not taken as old by the next (review P2)', () => {
    // B:x and C:"B/x"; the old colour "x" belonged to B:x. Reading the object it was writing, the
    // migration made "B/x", then took it for C's bare code and deleted it.
    const subjects = [
      { database: 'B', code: 'x', name: 'x' },
      { database: 'C', code: 'B/x', name: 'y' }
    ]
    const out = migrateSubjectKeys(
      { subjSel: {}, fgSubjects: subjects, colors: { x: '#112233' }, refCode: 'x' },
      'A',
      own([])
    )
    expect(out!.colors).toEqual({ 'B/x': '#112233' })
    expect(out!.refCode).toBe('B/x')
    expect(migrateSubjectKeys(out!, 'A', own([]))).toBeNull()
  })

  it('resolves the old reference against what the page actually compared (review P2)', () => {
    // A has root and other, only other is ticked; B:root is compared. The old "root" meant B:root.
    const out = migrateSubjectKeys(
      { subjSel: { other: true }, fgSubjects: fg, refCode: 'root' },
      'A',
      own(['root', 'other'], [], ['A', 'B'])
    )
    expect(out!.refCode).toBe('B/root')
    // A disabled entry before an enabled one of the same code does not take it.
    const two = migrateSubjectKeys(
      {
        subjSel: {},
        fgSubjects: [
          { database: 'B', code: 'root', name: 'x', enabled: false },
          { database: 'C', code: 'root', name: 'y' }
        ],
        refCode: 'root'
      },
      'A',
      own([], [], ['A', 'B', 'C'])
    )
    expect(two!.refCode).toBe('C/root')
  })

  it('keeps a scenario reference, takes over a 2c9884c5 key, and clears a reference to nothing', () => {
    const scen = migrateSubjectKeys(
      { subjSel: { own: true }, scenSel: { s1: true }, refCode: 'own#s1' },
      'A',
      own(['own'], ['s1'])
    )
    expect(scen!.refCode).toBe('own#s1')
    const interim = migrateSubjectKeys(
      {
        subjSel: {},
        bgSubjects: bg,
        colors: { 'ecoinvent-3.12/hex': '#999999' },
        refCode: 'ecoinvent-3.12/hex'
      },
      'A',
      own([])
    )
    expect(interim!.colors).toEqual({ 'ecoinvent-3.12/hex': '#999999' })
    expect(interim!.refCode).toBe('ecoinvent-3.12/hex')
    const gone = migrateSubjectKeys({ subjSel: {}, refCode: 'vanished' }, 'A', own([]))
    expect(gone!.refCode).toBe('')
  })

  it('escapes what an older build stored raw: own code "B/root", foreign model "P/G"', () => {
    const out = migrateSubjectKeys(
      {
        subjSel: { 'B/root': true },
        fgSubjects: [{ database: 'P/G', code: 'root', name: 'x' }],
        colors: { 'B/root': '#010101', 'P/G/root': '#020202' },
        refCode: 'P/G/root'
      },
      'A',
      own(['B/root'], [], ['A', 'P/G'])
    )
    expect(out!.colors).toEqual({ 'B%2Froot': '#010101', 'P%2FG/root': '#020202' })
    expect(out!.refCode).toBe('P%2FG/root')
  })
})

describe('renameDatabaseInView', () => {
  it('follows a renamed model in subjects, colour keys, reference and the detailed subject', () => {
    const out = renameDatabaseInView(
      {
        results: {
          fgSubjects: [{ database: 'B', code: 'root', name: 'x' }],
          bgSubjects: [{ database: 'ecoinvent', code: 'hex', name: 'y' }],
          colors: { 'B/root': '#111111', own: '#222222', 'BB/root': '#333333' },
          refCode: 'B/root',
          keys: 2
        },
        detailed: { subject: { database: 'B', code: 'root' } }
      },
      'B',
      'B2'
    )
    expect(out!.results).toMatchObject({
      fgSubjects: [{ database: 'B2', code: 'root', name: 'x' }],
      bgSubjects: [{ database: 'ecoinvent', code: 'hex', name: 'y' }],
      colors: { 'B2/root': '#111111', own: '#222222', 'BB/root': '#333333' },
      refCode: 'B2/root'
    })
    expect(out!.detailed).toEqual({ subject: { database: 'B2', code: 'root' } })
    expect(renameDatabaseInView({ results: { colors: { own: '#1' } } }, 'B', 'B2')).toBeNull()
  })

  it('leaves the keys of an unmigrated view alone — "B/x" may be its own code', () => {
    const out = renameDatabaseInView(
      {
        results: {
          subjSel: { 'B/x': true },
          fgSubjects: [{ database: 'B', code: 'y', name: 'y' }],
          colors: { 'B/x': '#111111' },
          refCode: 'B/x'
        }
      },
      'B',
      'C'
    )
    expect(out!.results).toMatchObject({
      subjSel: { 'B/x': true },
      fgSubjects: [{ database: 'C', code: 'y', name: 'y' }],
      colors: { 'B/x': '#111111' },
      refCode: 'B/x'
    })
  })
})
