import { describe, expect, it } from 'vitest'
import type { BomItem, BomLeg } from './bomAnswer'
import type { LegOutcome } from './bomBalance'
import {
  admissiblePage,
  crossCheckNote,
  crossChecks,
  crossFigures,
  leadWords,
  leadsFor,
  type CrossFigure
} from './bomCrossCheck'
import { CitationBook } from './citationBook'

const SHEET = 'https://maker.example/sheet.pdf'
const SHOP = 'https://shop.example/rim'

const leg = (over: Partial<BomLeg> = {}): BomLeg => ({
  items: [],
  unresolved: [],
  product_masses: [],
  versions_seen: [],
  ...over
})
const item = (component: string, mass_kg: number, over: Partial<BomItem> = {}): BomItem => ({
  component,
  material: 'steel',
  mass_kg,
  source_url: SHOP,
  ...over
})
const bookOf = (...urls: string[]): CitationBook => {
  const book = new CitationBook()
  book.add(urls.map((url) => ({ url })))
  return book
}
const figure = (over: Partial<CrossFigure>): CrossFigure => ({
  component: 'rim',
  request: 'rim',
  mass_kg: 1.2,
  source_url: SHEET,
  read_for: 'frame',
  ...over
})

describe('crossFigures', () => {
  const book = bookOf(SHEET)
  const admissible = admissiblePage(book, 'Wheelbarrow, model P150')

  it('settles a figure to the request it belongs to, a part of a group included', () => {
    const outcomes: LegOutcome[] = [
      {
        request: 'frame',
        leg: leg({
          for_others: [
            { component: 'Achse', mass_kg: 0.18, source_url: SHEET },
            { component: 'Stahlfelge', mass_kg: 1.2, source_url: SHEET }
          ]
        })
      },
      { request: 'Achse, Lager, Schrauben', leg: leg() },
      { request: 'Stahlfelge', leg: leg() }
    ]
    expect(crossFigures(outcomes, admissible)).toEqual([
      {
        component: 'Achse',
        mass_kg: 0.18,
        source_url: SHEET,
        request: 'Achse, Lager, Schrauben',
        read_for: 'frame'
      },
      { component: 'Stahlfelge', mass_kg: 1.2, source_url: SHEET, request: 'Stahlfelge', read_for: 'frame' }
    ])
  })

  it("leaves out the leg's own part, a part nobody asked for and the same figure from the same page twice", () => {
    const outcomes: LegOutcome[] = [
      {
        request: 'frame',
        leg: leg({
          for_others: [
            { component: 'frame', mass_kg: 7, source_url: SHEET },
            { component: 'paint', mass_kg: 0.2, source_url: SHEET },
            { component: 'rim', mass_kg: 1.2, source_url: SHEET }
          ]
        })
      },
      { request: 'rim', leg: leg({ for_others: [] }) },
      { request: 'tyre', leg: leg({ for_others: [{ component: 'rim', mass_kg: 1.2, source_url: SHEET }] }) }
    ]
    expect(crossFigures(outcomes, admissible).map((f) => [f.component, f.read_for])).toEqual([
      ['rim', 'frame']
    ])
  })

  it('passes on only a page the search delivered or the caller named, in their spelling, never one a leg wrote down', () => {
    const named = admissiblePage(book, 'datasheet: https://maker.example/manual.pdf')
    const outcomes: LegOutcome[] = [
      {
        request: 'frame',
        leg: leg({
          for_others: [
            { component: 'rim', mass_kg: 1.2, source_url: 'https://elsewhere.example/x' },
            { component: 'rim', mass_kg: 1.3, source_url: 'http://www.maker.example/MANUAL.pdf' },
            { component: 'rim', mass_kg: 1.1, source_url: 'https://maker.example/Sheet.pdf#page=2' }
          ]
        })
      },
      { request: 'rim', leg: leg() }
    ]
    expect(crossFigures(outcomes, named).map((f) => f.source_url)).toEqual([
      'https://maker.example/manual.pdf',
      SHEET
    ])
  })
})

describe('leadsFor', () => {
  it("hands an open part the pages for its own name or its group's, each page once and at most two", () => {
    const figures = [
      figure({ component: 'Lager', request: 'Achse, Lager', source_url: 'https://a.example/1' }),
      figure({ component: 'Achse, Lager', request: 'Achse, Lager', source_url: 'https://a.example/2' }),
      figure({ component: 'Lager', request: 'Achse, Lager', source_url: 'https://a.example/1', mass_kg: 2 }),
      figure({ component: 'Achse', request: 'Achse, Lager', source_url: 'https://a.example/3' }),
      figure({ component: 'Lager', request: 'Achse, Lager', source_url: 'https://a.example/4' })
    ]
    expect(leadsFor(figures, 'Achse, Lager', 'Lager').map((l) => l.source_url)).toEqual([
      'https://a.example/1',
      'https://a.example/2'
    ])
    expect(leadsFor(figures, 'rim', 'Lager')).toEqual([])
  })

  it('tells the follow-up to open the page first, and to search on when it does not give the part alone', () => {
    expect(leadWords([figure({ component: 'Lager' })])).toBe(
      `\nAnother researcher read a page that states a mass for "Lager": ${SHEET}. Open it first and take your ` +
        'figure from there when it is given for this part alone; when it is not, say so in the note and search on.'
    )
    expect(leadWords([figure({}), figure({ source_url: SHOP })])).toMatch(
      /pages that state a mass for this part: \S+ \("rim"\), \S+ \("rim"\)\. Open them first/
    )
    expect(leadWords([])).toBe('')
  })
})

describe('crossChecks', () => {
  const outcome = (request: string, l: BomLeg): LegOutcome => ({ request, leg: l })

  it('confirms a figure within a tenth, and contradicts one beyond it', () => {
    const outcomes = [outcome('rim', leg({ items: [item('rim', 1.15)] }))]
    expect(crossChecks([figure({ mass_kg: 1.2 })], outcomes)).toEqual([
      {
        component: 'rim',
        page_kg: 1.2,
        source_url: SHEET,
        read_for: 'frame',
        own_kg: 1.15,
        verdict: 'agrees'
      }
    ])
    expect(crossChecks([figure({ mass_kg: 2.4 })], outcomes)[0]).toMatchObject({
      verdict: 'differs',
      own_kg: 1.15
    })
  })

  it('reads a figure inside the part’s researched range as agreeing', () => {
    const outcomes = [outcome('rim', leg({ items: [item('rim', 1.2, { mass_range_kg: [1.0, 1.8] })] }))]
    expect(crossChecks([figure({ mass_kg: 1.7 })], outcomes)[0].verdict).toBe('agrees')
  })

  it('leaves out agreement with a figure from the same page, and names a different reading of it', () => {
    const outcomes = [outcome('rim', leg({ items: [item('rim', 1.2, { source_url: `${SHEET}#p2` })] }))]
    expect(crossChecks([figure({ mass_kg: 1.2 })], outcomes)).toEqual([])
    expect(crossChecks([figure({ mass_kg: 3 })], outcomes)[0]).toMatchObject({
      verdict: 'differs',
      same_page: true
    })
  })

  it('says when the page figure is already among the part’s alternatives', () => {
    const outcomes = [
      outcome(
        'rim',
        leg({ items: [item('rim', 1.2, { alternatives: [{ mass_kg: 2.5, source_url: SHOP }] })] })
      )
    ]
    expect(crossChecks([figure({ mass_kg: 2.4 })], outcomes)[0]).toMatchObject({
      verdict: 'differs',
      among_alternatives: true
    })
  })

  it('holds a figure for one part of a group against that entry, not against the group', () => {
    const outcomes = [
      outcome(
        'Achse, Lager, Schrauben',
        leg({
          items: [item('Massivachse', 0.18), item('Schrauben', 0.1)],
          unresolved: [{ component: 'Lager', reason: 'no_mass' }]
        })
      )
    ]
    const checks = crossChecks(
      [
        figure({ component: 'Achse', request: 'Achse, Lager, Schrauben', mass_kg: 0.19 }),
        figure({ component: 'Lager', request: 'Achse, Lager, Schrauben', mass_kg: 0.06 }),
        figure({ component: 'Achse, Lager, Schrauben', request: 'Achse, Lager, Schrauben', mass_kg: 0.4 })
      ],
      outcomes
    )
    expect(checks.map((c) => [c.component, c.verdict, c.own_kg, c.in_request])).toEqual([
      ['Massivachse', 'agrees', 0.18, 'Achse, Lager, Schrauben'],
      ['Lager', 'no_own_figure', undefined, 'Achse, Lager, Schrauben'],
      // The group as a whole has an open part: its entries are not its mass, so nothing is compared.
      ['Achse, Lager, Schrauben', 'no_own_figure', undefined, undefined]
    ])
  })

  it('compares nothing with an entry that covers more than the figure, or a part that is partly open', () => {
    const outcomes = [
      outcome(
        'axle, bearings, screws',
        leg({
          items: [item('axle and bearings', 0.5), item('screws', 0.1, { material: 'steel' })],
          unresolved: [{ component: 'screws', material: 'zinc coating', reason: 'no_mass' }]
        })
      )
    ]
    const checks = crossChecks(
      [
        figure({ component: 'axle', request: 'axle, bearings, screws', mass_kg: 0.18 }),
        figure({ component: 'screws', request: 'axle, bearings, screws', mass_kg: 0.3 })
      ],
      outcomes
    )
    expect(checks.map((c) => [c.component, c.verdict])).toEqual([['screws', 'no_own_figure']])
  })

  it('holds a figure against the entries the balance keeps: a repeat once, a contradiction as open', () => {
    const repeat = [outcome('rim', leg({ items: [item('rim', 1.2), item('rim', 1.2)] }))]
    expect(crossChecks([figure({ mass_kg: 1.2 })], repeat)[0]).toMatchObject({
      own_kg: 1.2,
      verdict: 'agrees'
    })
    const contradiction = [outcome('rim', leg({ items: [item('rim', 0.6), item('rim', 0.6 * 2.5)] }))]
    expect(crossChecks([figure({ mass_kg: 2.1 })], contradiction)[0]).toMatchObject({
      verdict: 'no_own_figure'
    })
  })

  it("asks whether two addresses are the same page of the page each stands for, a provider's link included", () => {
    const link = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc'
    const outcomes = [outcome('rim', leg({ items: [item('rim', 1.2, { source_url: link })] }))]
    const canonical = (u: string): string => (u === link ? SHEET : u)
    expect(crossChecks([figure({ mass_kg: 1.2 })], outcomes, canonical)).toEqual([])
    expect(crossChecks([figure({ mass_kg: 1.2 })], outcomes)[0].verdict).toBe('agrees')
  })

  it('holds a figure for the whole request against all its entries once none is open', () => {
    const outcomes = [outcome('wheel', leg({ items: [item('tyre', 1.4), item('rim', 1.0)] }))]
    expect(
      crossChecks([figure({ component: 'wheel', request: 'wheel', mass_kg: 2.5 })], outcomes)[0]
    ).toMatchObject({ component: 'wheel', own_kg: 2.4, verdict: 'agrees' })
  })
})

describe('crossCheckNote', () => {
  it('names contradictions first, then pages for parts without a mass, then confirmations', () => {
    const note = crossCheckNote([
      { component: 'frame', page_kg: 7, source_url: SHEET, read_for: 'rim', own_kg: 7.1, verdict: 'agrees' },
      { component: 'Lager', page_kg: 0.06, source_url: SHEET, read_for: 'frame', verdict: 'no_own_figure' },
      {
        component: 'rim',
        page_kg: 2.4,
        source_url: SHEET,
        read_for: 'frame',
        own_kg: 1.2,
        verdict: 'differs'
      }
    ])
    expect(note).toBe(
      `Pages read for other parts disagree: "rim" counts 1.2 kg, but a page read for "frame" gives 2.4 kg (${SHEET}) ` +
        '— another version or scope, or one figure is wrong; check which fits before booking. A page read for ' +
        `another part states a mass for a part without one of its own: "Lager" (0.06 kg on ${SHEET}, read for ` +
        '"frame") — not checked and not counted; open it before booking that figure. Pages read for other parts ' +
        'confirm the figures of "frame".'
    )
    expect(crossCheckNote([])).toBeUndefined()
  })
})
