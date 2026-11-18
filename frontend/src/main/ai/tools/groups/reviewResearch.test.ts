import { describe, expect, it } from 'vitest'
import type { ToolCtx } from '../context'
import type { BomItem, BomLeg } from '../../bomAnswer'
import { weighBom } from '../../bomBalance'
import { bomLogEntry } from './bomLogEntry'
import { researchSection, sourceId } from './reviewResearch'
import { reviewTools } from './review'

const leg = (l: Partial<BomLeg>): BomLeg => ({
  items: [],
  unresolved: [],
  product_masses: [],
  versions_seen: [],
  ...l
})
const item = (component: string, mass_kg: number, more: Partial<BomItem> = {}): BomItem => ({
  component,
  material: '',
  mass_kg,
  ...more
})

const EAN459 = 'EAN 5400431601459'
const EAN480 = 'EAN 5400431601480'

/** The shelf rack (T4): the answer as research_bom returns it, logged as research.ts logs it. */
function t4Entry(asked = '2026-11-15T20:00:00Z', context = 'Avasco Atlas 176 x 90 x 40 cm, 5 boards') {
  const result = weighBom([
    { request: 'steel', leg: leg({ unresolved: [{ component: 'steel', reason: 'no_mass' }] }) },
    {
      request: 'boards',
      leg: leg({
        items: [
          item('5 Holzböden (HDF, 5 mm)', 7.65, {
            count: 5,
            mass_each_kg: 1.53,
            version: EAN459,
            source_url: 'https://www.praxis.nl/a/stellingkast-atlas/10119671',
            source_class: 'industry',
            confidence: 'medium',
            note: '0.9 × 0.4 × 0.005 m × 850 kg/m³ = 1.53 kg per board'
          })
        ]
      })
    },
    {
      request: 'total',
      leg: leg({
        product_masses: [
          {
            mass_kg: 13,
            basis: 'net',
            version: EAN480,
            source_url: 'https://www.praxis.nl/a/stellingkast-atlas/10322182'
          },
          {
            mass_kg: 24,
            basis: 'unknown',
            version: 'Atlas 175 HDF4',
            source_url: 'https://www.buchmann.ch/atlas-175'
          }
        ]
      })
    }
  ])
  return { ...bomLogEntry({ product: 'Schwerlastregal Atlas', context }, result)!, asked }
}

const web = (question: string, findings: Array<Record<string, unknown>>, asked = '2026-11-15T21:00:00Z') => ({
  question,
  findings,
  asked
})
const finding = (text: string, source_class?: string, confidence?: string, url = 'https://e.org/p') => ({
  text,
  sources: [url],
  ...(source_class ? { source_class } : {}),
  ...(confidence ? { confidence } : {})
})

describe('the dossier’s research on record', () => {
  it('shows the bill-of-materials check with every total, the versions and the part with its derivation', () => {
    const text = researchSection([t4Entry()])
    expect(text).toMatch(/^RESEARCH ON RECORD FOR THIS MODEL/)
    expect(text).toContain('BILL OF MATERIALS: Schwerlastregal Atlas')
    expect(text).toContain('Check of 2026-11-15:')
    expect(text).toContain('Given to the research: Avasco Atlas 176 x 90 x 40 cm, 5 boards')
    expect(text).toContain('Left open: steel (no_mass)')
    expect(text).toContain(
      `Whole-product masses found (they differ): 13 kg net, ${EAN480} — praxis.nl/10322182; ` +
        '24 kg scope not stated, Atlas 175 HDF4 — buchmann.ch/atlas-175'
    )
    // One line per version, so a part is never read as belonging to the version named next to it.
    expect(text).toContain(
      'Versions: the figures rest on DIFFERENT versions of the product:\n' +
        `    - ${EAN459}: 5 Holzböden (HDF, 5 mm)\n` +
        `    - ${EAN480}: whole product (13 kg)\n`
    )
    // Two articles of one retailer are two sources.
    expect(text).toContain(
      '- 5 Holzböden (HDF, 5 mm) (5 pieces): 7.65 kg (version: EAN 5400431601459) [industry/medium] Note: 0.9 × 0.4 × 0.005 m × 850 kg/m³ = ' +
        '1.53 kg per board — praxis.nl/10119671'
    )
  })

  it('names a recipe that does not close as not settled, with its gap and what it lacks', () => {
    const entry = (recipe: Record<string, unknown>) => ({
      question: 'Bill of materials: liquid soap refill',
      findings: [],
      asked: '2026-11-15T21:00:00Z',
      bom_check: { summary: 'checked', recipe }
    })
    const open = researchSection([
      entry({
        of: 'liquid soap',
        formulation: 'MP-01',
        kind: 'frame',
        closes: false,
        gap_pct: 8.88,
        gap_kg: 0.045288,
        mass_kg: 0.51,
        mass_source: 'given',
        missing_ingredients: ['Glyceryl Oleate', 'Betaine'],
        inci_order: [
          'Cocamidopropyl Betaine (no. 4) is listed before Glycerin (no. 5), but the recipe gives 1.05 % against 2 %'
        ]
      })
    ])
    expect(open).toContain(
      'Recipe of liquid soap ("MP-01", a frame formulation): does NOT close (8.88 %, 0.045288 kg unaccounted) — not ' +
        'settled; lacks ingredients known from the product: Glyceryl Oleate, Betaine; contradicts the order of the ' +
        "product's INCI list: Cocamidopropyl Betaine (no. 4) is listed before Glycerin (no. 5), but the recipe gives " +
        '1.05 % against 2 %; scaled to 0.51 kg (given)'
    )
    const unchecked = researchSection([
      entry({ of: 'concrete', closes: null, note: 'parts by weight have no total of their own' })
    ])
    expect(unchecked).toContain(
      'Recipe of concrete: closure not checked (parts by weight have no total of their own) — not settled; shares only, no kg'
    )
  })

  it('keeps every check as history: the latest whole, earlier ones a line with what they were given', () => {
    const text = researchSection([
      t4Entry('2026-11-14T10:00:00Z', 'Atlas, 4 mm boards'),
      { ...t4Entry('2026-11-15T10:00:00Z'), findings: [] }
    ])
    expect(text).toContain('Check of 2026-11-15:')
    expect(text).toMatch(/Earlier check of 2026-11-14: .* Given: Atlas, 4 mm boards/)
    expect(text).toContain('Part masses found (asked 2026-11-14):')
    expect(text.match(/Whole-product masses found/g)).toHaveLength(1)
  })

  it('keeps the totals an earlier check found when a later check of one part found none', () => {
    const partOnly = {
      ...bomLogEntry(
        { product: 'Schwerlastregal Atlas', context: 'frame only' },
        weighBom([
          {
            request: 'steel',
            leg: leg({ items: [item('steel frame', 5.8, { source_url: 'https://e.org/frame' })] })
          }
        ])
      )!,
      asked: '2026-11-16T19:00:00Z'
    }
    const text = researchSection([t4Entry(), partOnly])
    expect(text).toContain('Check of 2026-11-16:')
    expect(text).toMatch(
      /Earlier check of 2026-11-15: .* Whole-product masses it found: 13 kg net, EAN 5400431601480 — praxis\.nl\/10322182; 24 kg scope not stated/
    )
  })

  it('keeps one question asked for two products apart, each finding with its own context', () => {
    const text = researchSection([
      { ...web('Dose per wash?', [finding('2.3 g', 'official', 'high')]), context: 'liquid soap' },
      { ...web('Dose per wash?', [finding('0.6 g', 'media', 'low')]), context: 'foam soap' }
    ])
    const blocks = text.split('Q (').slice(1)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatch(/Given: liquid soap\n- 2\.3 g/)
    expect(blocks[1]).toMatch(/Given: foam soap\n- 0\.6 g/)
  })

  it('names the version a part mass belongs to', () => {
    const text = researchSection([t4Entry()])
    expect(text).toContain('- 5 Holzböden (HDF, 5 mm) (5 pieces): 7.65 kg (version: EAN 5400431601459)')
  })

  it('marks a source the search did not return, and puts the look-ups on one line each', () => {
    const text = researchSection([
      web('Soap per hand wash?', [
        { ...finding('2.3 g per wash', 'official', 'high'), cited_by_search: false }
      ]),
      {
        question: 'Eurostat end-of-life statistics: env_wasmun DE 2024',
        findings: [finding('18 values … 6 of 18 values are NOT final — flagged "i". Source: Eurostat')]
      },
      {
        question: 'Road distance Ieper → Karlsruhe',
        findings: [
          {
            text: '512.4 km (shortest route). Method road v2026. Routing © openrouteservice.org',
            sources: [],
            confidence_note: 'route not checked for ferry or shuttle-train crossings'
          }
        ]
      }
    ])
    expect(text).toContain(
      '- 2.3 g per wash [official/high] — e.org/p (source not returned by the search engine)'
    )
    expect(text).toContain('- Eurostat env_wasmun DE 2024 — NOT all values final')
    expect(text).toContain(
      '- Road distance Ieper → Karlsruhe: 512.4 km (shortest route) (route not checked for ferry or shuttle-train crossings)'
    )
    // Look-ups after the research, the bill of materials before it.
    expect(text.indexOf('WEB RESEARCH:')).toBeLessThan(text.indexOf('LOOK-UPS'))
  })

  it('shows the strongest sources first and counts what it leaves out, by class', () => {
    const long = (i: number, klass: string, conf: string) =>
      finding(`${klass} finding ${i}: ${'a fairly long sentence about a figure. '.repeat(6)}`, klass, conf)
    const questions = Array.from({ length: 6 }, (_, q) =>
      web(`question ${q}?`, [
        ...Array.from({ length: 6 }, (_, i) => long(i, 'community', 'low')),
        ...Array.from({ length: 6 }, (_, i) => long(i, 'media', 'medium')),
        long(0, 'official', 'high')
      ])
    )
    const text = researchSection(questions)
    expect(text.length).toBeLessThanOrEqual(14_500)
    for (let q = 0; q < 6; q++) expect(text).toContain(`question ${q}?`)
    // The official finding, logged last by an upgrade pass, is the one shown first.
    const first = text.split('Q (2026-11-15): question 0?\n')[1].split('\n')[0]
    expect(first).toMatch(/^- official finding 0/)
    expect(text).toMatch(/\(\+\d+ more: (\d+ media, )?\d+ community\)/)
    // Texts of single findings are never cut.
    expect(text).toContain(long(0, 'official', 'high').text)
  })

  it('folds the oldest questions into one line when even the questions do not fit', () => {
    const many = Array.from({ length: 80 }, (_, q) =>
      web(
        `question ${q}: ${'what is the typical figure for this material in this market '.repeat(3)}?`,
        [finding('x', 'media', 'low')],
        `2026-11-${String(16 + (q % 5)).padStart(2, '0')}T19:00:00Z`
      )
    )
    const text = researchSection([t4Entry(), ...many])
    expect(text.length).toBeLessThanOrEqual(14_500)
    expect(text).toMatch(/- \d+ earlier questions not shown \(asked 2026-11-16 – 2026-11-(1[6-9]|20)\)/)
    expect(text).toContain('question 79:')
    // The bill-of-materials check is never the part that goes.
    expect(text).toContain('Whole-product masses found')
  })

  it('is empty when nothing was researched', () => {
    expect(researchSection([])).toBe('')
    expect(researchSection(null)).toBe('')
    expect(researchSection({ error: 'x' })).toBe('')
  })

  it('tells two pages of one host apart', () => {
    expect(sourceId('https://www.praxis.nl/meubels/stellingkast/10119671')).toBe('praxis.nl/10119671')
    expect(sourceId('https://example.org/')).toBe('example.org')
    expect(sourceId('not a url')).toBe('not a url')
  })
})

describe('the dossier review_model hands over', () => {
  const reviewOnce = async (research: () => unknown) => {
    let dossier = ''
    await reviewTools[0].run({ database: `m-${Math.random()}` }, {
      api: async (method: string, path: string) => {
        if (method === 'GET' && path.startsWith('/api/v1/provenance/research')) return research()
        throw new Error('not in this test')
      },
      ui: async () => ({}),
      review: async (o: { dossier: string }) => {
        dossier = o.dossier
        return { text: 'nothing', outcome: 'ok' as const, reasoning_chars: 0, attempts: 1, ms: 1 }
      }
    } as unknown as ToolCtx)
    return dossier
  }

  it('carries the research on record', async () => {
    const dossier = await reviewOnce(() => [t4Entry()])
    expect(dossier).toContain('RESEARCH ON RECORD FOR THIS MODEL')
    expect(dossier).toContain('24 kg scope not stated')
  })

  it('names a log it could not read as a gap', async () => {
    const dossier = await reviewOnce(() => {
      throw new Error('backend gone')
    })
    expect(dossier).not.toContain('RESEARCH ON RECORD')
    expect(dossier).toMatch(
      /GAPS IN THIS DOSSIER: .*research on record: could not be collected \(backend gone\)/
    )
  })
})
