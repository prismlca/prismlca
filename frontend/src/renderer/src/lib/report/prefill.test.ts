import { describe, expect, it } from 'vitest'
import { defaultReportName, initialReportLang, reportPrefill, type PrefillInput } from './prefill'

const EF = (cat: string): string[] => ['EF v3.1', cat, 'global warming potential']
const FALLBACK = [EF('climate change')]

const input = (patch: Partial<PrefillInput> = {}): PrefillInput => ({
  database: 'hose-cart',
  subject: { code: 'ref', name: 'Hose cart' },
  results: null,
  stacked: false,
  stackBy: 'isic',
  scenarios: [
    { id: 's1', name: 'Recycled steel' },
    { id: 's2', name: 'Aluminium frame' }
  ],
  known: [],
  fallbackMethods: FALLBACK,
  lang: 'en',
  ...patch
})

describe('defaultReportName (V414)', () => {
  it('names the report in its own language', () => {
    expect(defaultReportName('Hose cart', 'en')).toBe('Hose cart report')
    expect(defaultReportName('Schlauchwagen', 'de')).toBe('Schlauchwagen Bericht')
    expect(defaultReportName('X', 'fr')).toBe('X rapport')
    expect(defaultReportName('X', 'es')).toBe('X informe')
    expect(defaultReportName('X', 'pt')).toBe('X relatório')
  })

  it('falls back to English and to "LCA" without a subject', () => {
    expect(defaultReportName(undefined, 'xx')).toBe('LCA report')
  })
})

describe('initialReportLang', () => {
  it('takes the declared language before the detected one', () => {
    expect(initialReportLang({ language: 'de', detected_language: 'fr' })).toBe('de')
    expect(initialReportLang({ language: '', detected_language: 'de' })).toBe('de')
  })

  it('falls back to English for no study or a language reports cannot be written in', () => {
    expect(initialReportLang(null)).toBe('en')
    expect(initialReportLang({ language: 'it' })).toBe('en')
  })
})

describe('reportPrefill (V407)', () => {
  it("keeps today's defaults when the Results page has nothing", () => {
    const r = reportPrefill(input())
    expect(r.methods).toEqual(FALLBACK)
    expect(r.subjects).toEqual([{ database: 'hose-cart', code: 'ref' }])
    expect(r.aggregate_by).toBeUndefined()
    expect(r.name).toBe('Hose cart report')
    expect(r.note).toBeNull()
  })

  it('takes indicators, scenarios and a tag breakdown from the Results page — the practice-run case', () => {
    const picked = Array.from({ length: 16 }, (_, i) => ({ method: EF(`cat ${i}`) }))
    const r = reportPrefill(
      input({
        results: { picked, scenSel: { s1: true, s2: true } },
        stacked: true,
        stackBy: 'tag:Life-cycle phase',
        lang: 'de'
      })
    )
    expect(r.methods).toHaveLength(16)
    expect(r.subjects).toEqual([
      { database: 'hose-cart', code: 'ref', label: 'Baseline' },
      {
        database: 'hose-cart',
        code: 'ref',
        scenario: 's1',
        scenario_name: 'Recycled steel',
        label: 'Recycled steel'
      },
      {
        database: 'hose-cart',
        code: 'ref',
        scenario: 's2',
        scenario_name: 'Aluminium frame',
        label: 'Aluminium frame'
      }
    ])
    expect(r.aggregate_by).toBe('tag:Life-cycle phase')
    expect(r.lang).toBe('de')
    expect(r.name).toBe('Hose cart Bericht')
    expect(r.note).toBe(
      'Taken from the Results page: 16 indicators, 3 variants, breakdown by Life-cycle phase. ' +
        'Written in Deutsch, the study’s language.'
    )
  })

  it('drops unticked and vanished scenarios, duplicate and unknown indicators', () => {
    const r = reportPrefill(
      input({
        results: {
          picked: [{ method: EF('a') }, { method: EF('a') }, { method: EF('gone') }, { method: [] }],
          scenSel: { s1: false, s2: true, deleted: true }
        },
        known: [EF('a'), EF('b')]
      })
    )
    expect(r.methods).toEqual([EF('a')])
    expect(r.subjects.map((s) => s.scenario ?? null)).toEqual([null, 's2'])
  })

  it('carries no breakdown for ISIC/CPC or an unstacked chart', () => {
    expect(reportPrefill(input({ stacked: true, stackBy: 'isic' })).aggregate_by).toBeUndefined()
    expect(reportPrefill(input({ stacked: false, stackBy: 'tag:Phase' })).aggregate_by).toBeUndefined()
    expect(reportPrefill(input({ stacked: true, stackBy: 'tag:' })).aggregate_by).toBeUndefined()
  })

  it('creates no subject without a reference process', () => {
    const r = reportPrefill(input({ subject: undefined, results: { scenSel: { s1: true } } }))
    expect(r.subjects).toEqual([])
    expect(r.name).toBe('LCA report')
  })
})
