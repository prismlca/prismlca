import { describe, expect, it } from 'vitest'
import type { ToolCtx } from '../context'
import { CUT_MARK, processesSection } from './reviewProcesses'
import { paramsSection } from './reviewParams'
import { reviewTools } from './review'

const DB = 'Shelf'

/** One process as `GET /model/activities/<db>?with_exchanges=true` lists it. */
const proc = (name: string, more: Record<string, unknown> = {}, exchanges: unknown[] = []) => ({
  database: DB,
  code: `c-${name}`,
  name,
  product: name,
  location: 'DE',
  unit: 'unit',
  read_only: false,
  isic: null,
  cpc: null,
  cpc_name: null,
  comment: '',
  exchanges,
  ...more
})
const ex = (name: string, amount: number, more: Record<string, unknown> = {}) => ({
  uid: '0123456789abcdef0123456789abcdef',
  type: 'technosphere',
  direction: amount < 0 ? 'output' : 'input',
  amount,
  formula: null,
  comment: null,
  input: { database: 'ecoinvent', code: 'x', name, unit: 'kilogram', location: 'GLO', categories: [] },
  ...(amount < 0 ? { sign_note: 'Negative on purpose: …' } : {}),
  ...more
})

describe('the process list of the review dossier', () => {
  it('keeps what a reviewer reads and drops what only the editor needs', () => {
    const { text, gaps } = processesSection(
      [
        proc(
          'Frame',
          { tags: [{ dimension: 'Life-cycle phase', value: 'Production' }], comment: 'Steel, 7 kg.' },
          [
            {
              uid: 'u',
              type: 'production',
              direction: 'output',
              amount: 1,
              input: { database: DB, code: 'c-Frame' }
            },
            ex('market for zinc', 0.02, {
              formula: '0.14 / frame_kg',
              tags: [{ dimension: 'Life-cycle phase', value: 'Raw materials' }]
            }),
            ex('treatment of waste paperboard', -0.1, { comment: 'carton, incinerated share' })
          ]
        )
      ],
      DB
    )
    expect(gaps).toEqual([])
    const list = JSON.parse(text.slice(text.indexOf('\n') + 1))
    expect(list[0]).toEqual({
      name: 'Frame',
      location: 'DE',
      unit: 'unit',
      tags: ['Life-cycle phase: Production'],
      comment: 'Steel, 7 kg.',
      exchanges: [
        { type: 'production', amount: 1 },
        {
          type: 'technosphere',
          amount: 0.02,
          formula: '0.14 / frame_kg',
          input: 'market for zinc [GLO]',
          unit: 'kilogram',
          from: 'ecoinvent',
          tags: ['Life-cycle phase: Raw materials']
        },
        {
          type: 'technosphere',
          amount: -0.1,
          input: 'treatment of waste paperboard [GLO]',
          unit: 'kilogram',
          from: 'ecoinvent',
          comment: 'carton, incinerated share'
        }
      ]
    })
    // Said once, for the whole list.
    expect(text).toMatch(/"tags" on a process are its own/)
    expect(text).toMatch(/"tags" on an exchange belong to that input/)
    expect(text).toMatch(/NEGATIVE technosphere amount — that is the convention/)
    expect(text).not.toMatch(/sign_note|0123456789abcdef|read_only|cpc/)
  })

  it('shortens long comments before anything else, and names each cut', () => {
    const long = 'measured on the retailer page, '.repeat(30) // ~900 characters
    const acts = Array.from({ length: 30 }, (_, i) =>
      proc(`Process ${String(i).padStart(2, '0')}`, {}, [
        ex('steel', 1, { comment: long }),
        ex('electricity', 2, { comment: 'short' })
      ])
    )
    const { text, gaps } = processesSection(acts, DB)
    expect(text.length).toBeLessThanOrEqual(24_000)
    // Every process is still there, the last one included — it used to be the one that fell off.
    for (const a of acts) expect(text).toContain(`"name":"${a.name}"`)
    expect(text).toContain(`… ${CUT_MARK}`)
    expect(text).toContain('"comment":"short"')
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatch(
      /^process list: no process left out, but shortened for length — 30 exchange comments cut to \d+ characters/
    )
    expect(gaps[0]).not.toContain(';')
  })

  it('as a last resort lists a process without its exchanges, and says which', () => {
    const acts = Array.from({ length: 4 }, (_, i) =>
      proc(
        `P${i}`,
        {},
        Array.from({ length: 60 }, (_, j) => ex(`dataset number ${j} with a long name`, j + 1))
      )
    )
    const { text, gaps } = processesSection(acts, DB)
    expect(text.length).toBeLessThanOrEqual(24_000)
    expect(text).toContain('"name":"P3"')
    expect(text).toContain('60 exchanges, not shown for length')
    expect(gaps[0]).toMatch(/processes listed without their exchanges: .*P3/)
    expect(gaps[0]).not.toMatch(/no process left out/)
  })

  it('says nothing when there is nothing to list', () => {
    expect(processesSection([], DB)).toEqual({ text: '', gaps: [] })
    expect(processesSection({ activities: [] }, DB)).toEqual({ text: '', gaps: [] })
  })
})

describe('the parameter section of the review dossier', () => {
  const p = (name: string, amount: number, more: Record<string, unknown> = {}) => ({
    name,
    amount,
    formula: null,
    unit: 'kg',
    description: null,
    ...more
  })

  it('lists entered values first, then computed ones with their formulas', () => {
    const { text, gaps } = paramsSection([
      p('m_rest', 0.0452, { formula: 'm_fill - m_water' }),
      p('m_water', 0.377, { description: 'Retailer page, "Wasser" first on the INCI list.' }),
      p('m_fill', 0.51)
    ])
    expect(gaps).toEqual([])
    const lines = text.split('\n')
    expect(lines[0]).toMatch(/^PARAMETERS \(entered values first/)
    expect(lines.slice(1)).toEqual([
      '- m_fill = 0.51 kg',
      '- m_water = 0.377 kg — Retailer page, "Wasser" first on the INCI list.',
      '- m_rest = m_fill - m_water = 0.0452 kg'
    ])
  })

  it('cuts a long note at 200 characters', () => {
    const { text } = paramsSection([p('m_frame', 13, { description: 'x'.repeat(500) })])
    expect(text).toContain(`— ${'x'.repeat(200)}…`)
    expect(text).not.toContain('x'.repeat(201))
  })

  it('stays within 6,000 characters and counts the rest', () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      p(`m_part_${String(i).padStart(2, '0')}`, i + 1, {
        description: 'From the manufacturer data sheet, page 4.'.repeat(3),
        ...(i % 2 ? { formula: `m_part_00 * ${i}` } : {})
      })
    )
    const { text, gaps } = paramsSection(many)
    expect(text.length).toBeLessThanOrEqual(6_000)
    const shown = text.split('\n').filter((l) => l.startsWith('- ')).length
    expect(text).toMatch(
      new RegExp(`\\(\\+${80 - shown} more not listed for length \\(\\d+ entered, \\d+ computed\\)\\)$`)
    )
    expect(gaps).toEqual([expect.stringMatching(/^parameters: \d+ more not listed for length/)])
    // Entered values were kept over computed ones.
    expect(text).toContain('- m_part_00 = 1 kg')
  })

  it('is left out for a model without parameters', () => {
    expect(paramsSection([])).toEqual({ text: '', gaps: [] })
  })
})

describe('the dossier review_model hands over', () => {
  const reviewOnce = async (answers: Record<string, unknown>) => {
    let dossier = ''
    const out = await reviewTools[0].run({ database: `m-${Math.random()}` }, {
      api: async (method: string, path: string) => {
        for (const [prefix, value] of Object.entries(answers))
          if (method === 'GET' && path.startsWith(prefix)) {
            if (value instanceof Error) throw value
            return value
          }
        throw new Error('not in this test')
      },
      ui: async () => ({}),
      review: async (o: { dossier: string }) => {
        dossier = o.dossier
        return { text: 'nothing', outcome: 'ok' as const, reasoning_chars: 0, attempts: 1, ms: 1 }
      }
    } as unknown as ToolCtx)
    return { dossier, out: JSON.parse(String(out)) }
  }

  it('carries the process tags, the parameters and every cut under GAPS', async () => {
    const long = 'x'.repeat(2_000)
    const { dossier, out } = await reviewOnce({
      '/api/v1/model/activities/': Array.from({ length: 40 }, (_, i) =>
        proc(`Process ${i}`, { tags: [{ dimension: 'Life-cycle phase', value: 'Use' }] }, [
          ex('steel', 1, { comment: long })
        ])
      ),
      '/api/v1/params': [
        { name: 'm_frame', amount: 7, formula: null, unit: 'kg', description: 'Retailer page.' }
      ]
    })
    expect(dossier).toContain('"tags":["Life-cycle phase: Use"]')
    expect(dossier).toContain('PARAMETERS (entered values first')
    expect(dossier).toContain('- m_frame = 7 kg — Retailer page.')
    expect(dossier).toMatch(
      /GAPS IN THIS DOSSIER: .*process list: no process left out, but shortened for length — 40 exchange comments cut/
    )
    expect(out.gaps.some((g: string) => g.startsWith('process list: no process left out'))).toBe(true)
  })

  it('names parameters it could not read as a gap', async () => {
    const { dossier } = await reviewOnce({
      '/api/v1/model/activities/': [proc('Frame')],
      '/api/v1/params': new Error('backend gone')
    })
    expect(dossier).not.toContain('PARAMETERS (')
    expect(dossier).toMatch(/GAPS IN THIS DOSSIER: .*parameters: could not be collected \(backend gone\)/)
  })
})
