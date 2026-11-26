import { describe, expect, it } from 'vitest'
import type { BomItem, BomLeg } from './bomAnswer'
import { massBalance, weighBom, type LegOutcome } from './bomBalance'
import type { TotalUsed } from './bomTotals'
import { gtinsIn, sameReference, versionsContradict } from './bomVersions'

/**
 * The verdict a parent model builds on. The cases are the recorded answers of real runs (T1, T4, T5, T9 of the
 * mid-November test series): first as the legs actually answered, in the old array form, then as a leg answers
 * when it can say what its figure is — the whole product, five shelves, another version. The second kind is a
 * re-enactment written from the legs' own notes, not a recording.
 */

const given = (mass_kg: number): TotalUsed => ({ mass_kg, basis: 'net', source: 'given' })
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

describe('massBalance', () => {
  const items: BomItem[] = [item('body', 0.019), item('cap', 0.0025), item('label', 0.0005)]
  const check = (total?: TotalUsed, open: string[] = [], locks: string[] = []) =>
    massBalance({ items, total, open, locks })

  it('passes when the parts add up to the stated total', () => {
    const r = check(given(0.022))
    expect(r.sum_kg).toBeCloseTo(0.022, 6)
    expect(r.balance_ok).toBe(true)
    expect(r.note).toBeUndefined()
  })

  it('fails loudly when they do not, and says how far off', () => {
    const r = check(given(0.05))
    expect(r.balance_ok).toBe(false)
    expect(r.note).toMatch(/off/)
    expect(r.note).toContain('0.05')
  })

  it('cannot judge without a total, and still names what is open', () => {
    const r = check(undefined, ['frame (no mass found)'])
    expect(r.balance_ok).toBeNull()
    expect(r.note).toMatch(/No total mass is known/)
    // Before, the "no total" answer came first and the open component went unmentioned.
    expect(r.note).toMatch(/no usable mass for frame \(no mass found\)/)
    expect(r.sum_kg).toBeCloseTo(0.022, 6)
  })

  // The measured case (live run, PVC window): four of six legs came back, summing to
  // 25.7 of 30 kg. 14.3 % fell inside the 15 % tolerance, so the result said `balance_ok: true` in the
  // same breath as "2 of 6 research legs failed" — and the model made the missing 4.3 kg the mass of
  // the PVC profile.
  it('cannot judge a balance while a component is open, and says what the residual is not', () => {
    const r = massBalance({
      items: [item('glass', 20.9), item('steel', 3.9), item('seals', 0.4), item('hardware', 0.5)],
      total: given(30),
      open: ['PVC profile (research failed)', 'spacer (research failed)'],
      locks: []
    })
    expect(r.balance_ok).toBeNull() // NOT true — this is the whole point
    expect(r.sum_kg).toBeCloseTo(25.7, 6)
    expect(r.residual_kg).toBeCloseTo(4.3, 6)
    expect(r.note).toMatch(/NOT checked: no usable mass for PVC profile \(research failed\)/)
    expect(r.note).toMatch(/do NOT hand the remainder/i)
  })

  // R9 of the PL-28 series: a rim listed twice (with and without its hub) put the parts 2.9 kg over 20.7 kg,
  // and the overshoot sat behind four other reasons the verdict was locked.
  it('says first when the parts already exceed the total, whatever else is open', () => {
    const r = massBalance({
      items: [item('a', 12), item('b', 11.6)],
      total: given(20.7),
      open: ['c (no mass found)'],
      locks: []
    })
    expect(r.balance_ok).toBeNull()
    expect(r.note).toMatch(/^The parts already EXCEED the total you passed \(20\.7 kg\) by 2\.9 kg \(14 %\)/)
  })

  it('says the residual is not missing mass while entries overlap', () => {
    const r = massBalance({
      items,
      total: given(0.03),
      open: [],
      locks: ['entries overlap: …'],
      overlapping: true
    })
    expect(r.balance_ok).toBeNull()
    expect(r.note).toMatch(/is not missing mass as it stands/)
    expect(r.note).not.toMatch(/do NOT hand/)
  })

  it('reports the residual even when the balance passes', () => {
    // 8 % under, inside tolerance — the verdict stands, but 0.0018 kg belongs to nothing named.
    const r = check(given(0.0238))
    expect(r.balance_ok).toBe(true)
    expect(r.residual_kg).toBeCloseTo(0.0018, 6)
    expect(r.note).toMatch(/not covered by any listed component/)
  })

  it('stays quiet when the residual is negligible', () => {
    const r = check(given(0.0222))
    expect(r.balance_ok).toBe(true)
    expect(r.note).toBeUndefined()
  })

  it('keeps the residual signed, so over and under are distinguishable', () => {
    expect(check(given(0.05)).residual_kg).toBeGreaterThan(0) // parts miss the total
    expect(check(given(0.01)).residual_kg).toBeLessThan(0) // parts exceed it
  })

  it('reports what the parts can span when ranges came back — and stays silent when none did', () => {
    const ranged = [
      item('frame', 9, { mass_range_kg: [8, 10] }),
      item('roof', 2.2, { mass_range_kg: [1.8, 2.6] }),
      item('bag', 0.7) // point value, counts as [0.7, 0.7]
    ]
    expect(massBalance({ items: ranged, open: [], locks: [] }).sum_range_kg).toEqual([10.5, 13.3])
    expect(check().sum_range_kg).toBeUndefined()
  })

  it('says on a failed balance whether the ranges could still reach the total', () => {
    const ranged = [
      item('frame', 8, { mass_range_kg: [8, 12] }),
      item('roof', 1.8, { mass_range_kg: [1.8, 2.6] })
    ]
    // Point sum 9.8 vs total 14 = 30 % off, but the spans [9.8, 14.6] contain 14: reachable.
    const reachable = massBalance({ items: ranged, total: given(14), open: [], locks: [] })
    expect(reachable.balance_ok).toBe(false)
    expect(reachable.note).toMatch(/ranges DO reach/)
    // Total 20 lies beyond even the maxima: not a placement problem, something is missing.
    const beyond = massBalance({ items: ranged, total: given(20), open: [], locks: [] })
    expect(beyond.balance_ok).toBe(false)
    expect(beyond.note).toMatch(/component is missing or the total is wrong/)
  })

  // T9: the parts landed 6.7 % under the total, inside the tolerance — and even the top of their ranges
  // fell short of it. That used to go unsaid inside the tolerance.
  it('says inside the tolerance when even the ranges do not reach the total', () => {
    const r = massBalance({
      items: [item('water', 0.377, { mass_range_kg: [0.3723, 0.3774] }), item('rest', 0.11259)],
      total: given(0.525),
      open: [],
      locks: []
    })
    expect(r.balance_ok).toBe(true)
    expect(r.note).toMatch(/Even the researched ranges do not reach it exactly/)
  })

  describe('packaging and the scope of the total', () => {
    const withBox = [item('frame', 7), item('shelves', 6), item('box', 0.6, { packaging: 'sales' })]

    it('keeps packaging out of the parts and compares a net total with the parts alone', () => {
      const r = massBalance({ items: withBox, total: given(13), open: [], locks: [] })
      expect(r).toMatchObject({ sum_kg: 13, packaging_kg: 0.6, balance_ok: true, residual_kg: 0 })
    })

    it('compares a gross total with parts and packaging together', () => {
      const r = massBalance({
        items: withBox,
        total: { mass_kg: 13.6, basis: 'gross', source: 'researched' },
        open: [],
        locks: []
      })
      expect(r).toMatchObject({ balance_ok: true, residual_kg: 0 })
    })

    // 10 kg of unknown scope against 9 kg of parts and 1 kg of packaging: both readings fall inside 15 %,
    // and they check different things. Neither verdict goes out; both differences do.
    it('gives no verdict on a total of unknown scope, and both residuals', () => {
      const r = massBalance({
        items: [item('parts', 9), item('box', 1, { packaging: 'sales' })],
        total: { mass_kg: 10, basis: 'unknown', source: 'researched' },
        open: [],
        locks: []
      })
      expect(r.balance_ok).toBeNull()
      expect(r.residual_kg).toBe(1)
      expect(r.residual_if_total_includes_packaging_kg).toBe(0)
      expect(r.note).toMatch(
        /does not say whether the total includes packaging \(if it does, the residual is 0 kg\)/
      )
    })
  })
})

describe('sameReference', () => {
  it('matches references by a shared EAN, or by the words of one being in the other', () => {
    expect(sameReference('EAN 5400431601459 / Hornbach 12008577', 'Atlas 175, EAN 5400431601459')).toBe(true)
    expect(sameReference('EAN 5400431601459', 'EAN 5400431601480')).toBe(false)
    expect(sameReference('AVASCO Atlas 175 HDF4', 'AVASCO Steckregal Atlas 175 HDF4')).toBe(true)
    // A number on one side only says nothing either way — and is not grouped.
    expect(sameReference('Atlas 175 HDF4', 'EAN 5400431601480')).toBe(false)
    expect(sameReference('', undefined)).toBe(true)
    expect(sameReference('Atlas 175', '')).toBe(false)
  })
})

describe('versionsContradict', () => {
  it('reads EAN numbers first, then the numbers in the words, never the wording', () => {
    expect(versionsContradict('EAN 5400431601459', 'EAN 5400431601480')).toBe(true)
    expect(versionsContradict('Atlas HDF4', 'Atlas HDF5')).toBe(true)
    expect(versionsContradict('shelves 4 mm', 'shelves 5 mm')).toBe(true)
    // R8 of the PL-28 series: one refill pouch described two ways by two legs.
    expect(
      versionsContradict(
        '500-ml-Nachfüllbeutel, DE, Bezugsjahr 2025',
        '500 ml Nachfüllpack Eukalyptus & Lotus, Deutschland 2025'
      )
    ).toBe(false)
    expect(versionsContradict('Atlas 175 verzinkt', 'Atlas 175 HDF4, EAN 5400431601480')).toBe(false)
    expect(versionsContradict('Atlas HDF4', 'Atlas HDF 4 mm')).toBe(false)
    // Two years are two versions; one year against none says nothing.
    expect(versionsContradict('Modelljahr 2024', 'Modelljahr 2025')).toBe(true)
    // F04: a reference year against an article number, one product.
    expect(
      versionsContradict(
        '500 ml Nachfüllpack, Deutschland, Bezugsjahr 2025',
        'Balea Flüssigseife Eukalyptus & Lotus Nachfüllpack 500 ml (GTIN 4070765029765, dm-Art.-Nr. 3038087)'
      )
    ).toBe(false)
  })
})

describe('gtinsIn', () => {
  it('finds EAN/GTIN numbers and ignores article numbers', () => {
    expect(gtinsIn('Hornbach 12008577, EAN 5400431601459')).toEqual(['5400431601459'])
    expect(gtinsIn('EAN 5400431601435/...480')).toEqual(['5400431601435'])
    expect(gtinsIn('4 mm boards')).toEqual([])
  })
})

/** T4 (Hy4), the shelf rack: the five requests in the order the model sent them. */
const T4 = {
  steel: 'Verzinkte Stahlständer/Profile und Traversen',
  shelves: '5 Holzböden (Spanplatte/MDF) mit Masse je Boden',
  feet: 'Kunststofffüße und Kleinteile',
  box: 'Verkaufsverpackung Karton/Folie',
  total: 'Gesamtgewicht laut Hersteller oder Händler'
}
const EAN459 = 'EAN 5400431601459'
const EAN480 = 'EAN 5400431601480'
const PRAXIS = 'https://www.praxis.nl/avasco-stellingkast-atlas-176x90x40cm/10322182'

describe('weighBom — T4 as recorded', () => {
  const outcomes: LegOutcome[] = [
    { request: T4.steel, leg: leg({ unresolved: [{ component: T4.steel, reason: 'no_mass' }] }) },
    { request: T4.shelves, leg: leg({ items: [item('5 Holzböden (HDF, 5 mm), Masse je Boden', 1.53)] }) },
    { request: T4.feet, leg: leg({ items: [item('Kunststofffüße und Kleinteile', 0.048)] }) },
    { request: T4.box, leg: leg({ items: [item('Verkaufsverpackung Karton/Folie', 0.6)] }) },
    { request: T4.total, leg: leg({ items: [item(T4.total, 13)] }) }
  ]

  // What the code alone does better, with nothing new from the legs: the steel is no longer "covered".
  it('counts the steel without a mass as open, and names it without a total', () => {
    const r = weighBom(outcomes)
    expect(r.coverage).toEqual({ requested: 5, with_mass: 4 })
    expect(r.requests?.find((q) => q.component === T4.steel)?.status).toBe('no_mass')
    expect(r.balance_ok).toBeNull()
    expect(r.summary).toMatch(/4 of 5 requested components came back with a mass of their own/)
    expect(r.summary).toMatch(/open: Verzinkte Stahlständer\/Profile und Traversen \(no mass found\)/)
  })
})

describe('weighBom — T4 when the legs can say what their figures are', () => {
  const outcomes: LegOutcome[] = [
    {
      request: T4.steel,
      leg: leg({ unresolved: [{ component: T4.steel, reason: 'no_mass' }] })
    },
    {
      request: T4.shelves,
      leg: leg({
        items: [
          item('5 Holzböden (HDF, 5 mm)', 7.65, {
            count: 5,
            mass_each_kg: 1.53,
            version: `Hornbach 12008577, ${EAN459}`
          })
        ],
        product_masses: [{ mass_kg: 14.1, basis: 'unknown', version: EAN459 }],
        versions_seen: [
          { version: EAN480, differs_by: '4 mm HDF shelves', mass_kg: 13, sold_by: 'Praxis NL' }
        ]
      })
    },
    { request: T4.feet, leg: leg({ items: [item('Kunststofffüße', 0.048)] }) },
    { request: T4.box, leg: leg({ items: [item('Verkaufsverpackung', 0.6, { packaging: 'sales' })] }) },
    {
      request: T4.total,
      leg: leg({
        product_masses: [
          { mass_kg: 13, basis: 'net', version: EAN480, source_url: PRAXIS },
          { mass_kg: 24, basis: 'unknown', version: 'Atlas 175 HDF4' }
        ]
      })
    }
  ]
  const r = weighBom(outcomes)

  it('sums the parts without the total, the five shelves as five, and the box apart', () => {
    expect(r.sum_kg).toBeCloseTo(7.698, 6)
    expect(r.packaging_kg).toBe(0.6)
    expect(r.items.map((i) => i.component)).not.toContain(T4.total)
  })

  it('reports the whole-product masses it found without picking one', () => {
    expect(r.totals_found?.map((t) => t.mass_kg)).toEqual([14.1, 13, 24])
    expect(r.total_used).toBeUndefined()
    expect(r.note).toMatch(
      /belong to different versions of the product: 14\.1 kg \(packaging not stated, EAN 5400431601459\), 13 kg \(without packaging, praxis\.nl, EAN 5400431601480\)/
    )
  })

  it('flags that the figures rest on two versions of the product', () => {
    expect(r.versions?.conflict).toBe(true)
    expect(r.versions?.used?.map((u) => u.entries)).toEqual([
      ['5 Holzböden (HDF, 5 mm)', 'whole product (14.1 kg)'],
      ['whole product (13 kg)'],
      ['whole product (24 kg)']
    ])
    expect(r.summary).toMatch(
      /Still open: .*; the figures rest on different versions of the product — see note\.$/
    )
  })

  it('names the steel as open and the total request as answered with the whole product', () => {
    expect(r.coverage).toEqual({ requested: 5, with_mass: 3 })
    expect(r.requests?.find((q) => q.component === T4.total)?.status).toBe('product_mass_only')
    expect(r.summary).toMatch(/open: Verzinkte Stahlständer\/Profile und Traversen \(no mass found\)/)
    expect(r.balance_ok).toBeNull()
  })

  // Once the user has said which rack it is, the model passes the total — and the steel's gap shows as a
  // number that must not become the steel's mass. The shelves still rest on the other version.
  it('with the total passed, gives the residual the open steel leaves — and still refuses a verdict', () => {
    const settled = weighBom(outcomes, { totalMassKg: 13 })
    expect(settled.total_used).toEqual({ mass_kg: 13, basis: 'net', source: 'given' })
    expect(settled.residual_kg).toBeCloseTo(5.302, 6)
    expect(settled.balance_ok).toBeNull()
    expect(settled.note).toMatch(/do NOT hand the remainder to one part/)
    expect(settled.note).toMatch(
      /The research found 24 kg \(packaging not stated, Atlas 175 HDF4\) for the whole product/
    )
  })
})

/** T5 (Mistral Large 4), the same rack: four requests. */
const T5 = {
  frame: 'Verzinkter Stahlrahmen (4 Pfosten, Längs- und Querträger, Steckverbinder), Masse und Stahlsorte',
  shelves: '5 Fachböden aus Holzwerkstoff (Spanplatte/MDF), Masse je Boden und Plattendicke',
  feet: 'Kunststoff- oder Gummifüße, Endkappen und sonstiges Kleinmaterial',
  zinc: 'Oberflächenschutz/Verzinkung (Zinkschichtgewicht) des Rahmens'
}

describe('weighBom — T5 as recorded', () => {
  const outcomes: LegOutcome[] = [
    { request: T5.frame, leg: leg({ items: [item('Verzinkter Stahlrahmen (… EAN 5400431601480)', 13)] }) },
    { request: T5.shelves, leg: leg({ items: [item('5 Fachböden', 6, { mass_range_kg: [5.8, 6.6] })] }) },
    { request: T5.feet, error: 'The research ran past its 6-minute budget and was stopped.' },
    // The zinc came back in the follow-up pass, spelt differently; the pass now books it to its request.
    { request: T5.zinc, leg: leg({ items: [item('Oberflächenschutz/Verzinkung des Stahlrahmens', 0.14)] }) }
  ]
  const r = weighBom(outcomes)

  it('names the failed request instead of only counting it', () => {
    expect(r.coverage).toEqual({ requested: 4, with_mass: 3 })
    expect(r.unresolved).toEqual([
      {
        component: T5.feet,
        reason: 'failed',
        note: 'The research ran past its 6-minute budget and was stopped.'
      }
    ])
    expect(r.summary).toMatch(
      /open: Kunststoff- oder Gummifüße, Endkappen und sonstiges Kleinmaterial \(research failed\)/
    )
  })
})

describe('weighBom — T5 when the legs can say what their figures are', () => {
  const outcomes: LegOutcome[] = [
    {
      request: T5.frame,
      leg: leg({
        unresolved: [{ component: 'Verzinkter Stahlrahmen', reason: 'no_mass' }],
        product_masses: [{ mass_kg: 13, basis: 'unknown', version: EAN480, source_url: PRAXIS }],
        versions_seen: [
          { version: EAN459, differs_by: '5 mm shelves', mass_kg: 14.1, sold_by: 'Hornbach DE' }
        ]
      })
    },
    {
      request: T5.shelves,
      leg: leg({
        items: [item('5 Fachböden (HDF 4 mm)', 6, { count: 5, mass_each_kg: 1.2, version: EAN480 })],
        product_masses: [{ mass_kg: 13, basis: 'unknown', version: EAN480, source_url: PRAXIS }]
      })
    },
    { request: T5.feet, error: 'The research ran past its 6-minute budget and was stopped.' },
    {
      request: T5.zinc,
      leg: leg({ items: [item('Verzinkung des Rahmens', 0.14, { mass_range_kg: [0.11, 0.17] })] })
    }
  ]
  const r = weighBom(outcomes)

  it('balances against the researched total and names the open steel and feet', () => {
    expect(r.totals_found).toHaveLength(1)
    expect(r.total_used).toMatchObject({ mass_kg: 13, source: 'researched', basis: 'unknown' })
    expect(r.sum_kg).toBeCloseTo(6.14, 6)
    expect(r.residual_kg).toBeCloseTo(6.86, 6)
    expect(r.balance_ok).toBeNull()
    expect(r.note).toMatch(
      /6\.86 kg of the researched whole-product mass 13 kg \(packaging not stated, praxis\.nl, EAN 5400431601480\) is not covered/
    )
    expect(r.note).toMatch(/do NOT hand the remainder to one part/)
    expect(r.summary).toMatch(/open: Verzinkter Stahlrahmen \(no mass found\), Kunststoff- oder Gummifüße/)
    expect(r.coverage).toEqual({ requested: 4, with_mass: 2 })
  })

  it('shows the other version the sources named, without calling it a conflict', () => {
    expect(r.versions).toEqual({
      conflict: false,
      seen: [{ version: EAN459, differs_by: '5 mm shelves', mass_kg: 14.1, sold_by: 'Hornbach DE' }]
    })
    expect(r.note).toMatch(
      /other versions of this product: EAN 5400431601459, 5 mm shelves, 14\.1 kg, Hornbach DE/
    )
  })

  // The recorded shape of the frame leg: the rack's weight as the frame's. Suspected and named, not removed.
  // The recorded shape of the frame leg: the rack's 13 kg as the frame, while another leg reported 13 kg as the
  // whole rack. That entry is the whole product's figure in the wrong place, and the frame is open.
  it('reads the rack weight returned as the frame as the whole product, and names the frame open', () => {
    const asFrame = weighBom([
      { request: T5.frame, leg: leg({ items: [item('Stahlrahmen', 13)] }) },
      outcomes[1],
      outcomes[3]
    ])
    expect(asFrame.sum_kg).toBeCloseTo(6.14, 6)
    expect(asFrame.requests?.[0]).toEqual({ component: T5.frame, status: 'product_mass_only' })
    expect(asFrame.balance_ok).toBeNull()
    expect(asFrame.note).toMatch(/"Stahlrahmen" \(13 kg\) came back as a part but with exactly the mass/)
  })
})

describe('weighBom — T1 as recorded', () => {
  it('no longer reports six of six covered when four parts have no mass', () => {
    const names = ['Mulde', 'Rahmen', 'Rad', 'Stahlfelge', 'Griffe', 'Achse']
    const r = weighBom(
      names.map((n) => ({
        request: n,
        leg:
          n === 'Mulde' || n === 'Rad'
            ? leg({ items: [item(n, n === 'Mulde' ? 11 : 1.65)] })
            : leg({ unresolved: [{ component: n, reason: 'no_mass' }] })
      }))
    )
    expect(r.coverage).toEqual({ requested: 6, with_mass: 2 })
  })
})

describe('weighBom — T9, a pouch weighed with its spout', () => {
  const T9 = [
    'Nachfüllbeutel (Verbundfolie)',
    'Ausgießer/Spout und Verschluss',
    'Wasser (Rezeptur)',
    'Tenside (Rezeptur)'
  ]
  const outcomes = (includes?: string[]): LegOutcome[] => [
    { request: T9[0], leg: leg({ items: [item('Nachfüllbeutel mit Spout', 0.01206, { includes })] }) },
    { request: T9[1], leg: leg({ items: [item('Spout und Kappe', 0.00244)] }) },
    { request: T9[2], leg: leg({ items: [item('Wasser', 0.377)] }) },
    { request: T9[3], leg: leg({ items: [item('Tenside', 0.0595)] }) }
  ]

  it('locks the verdict on a reported overlap and keeps both masses', () => {
    const r = weighBom(outcomes(['Ausgießer/Spout und Verschluss']), { totalMassKg: 0.46 })
    expect(r.overlaps).toEqual([
      { entry: 'Nachfüllbeutel mit Spout', includes: ['Ausgießer/Spout und Verschluss'] }
    ])
    expect(r.sum_kg).toBeCloseTo(0.451, 6)
    expect(r.balance_ok).toBeNull()
    expect(r.note).toMatch(/"Nachfüllbeutel mit Spout" contains "Ausgießer\/Spout und Verschluss"/)
    // Only the container is marked: the spout stays a mass to book, once.
    expect(r.items.filter((i) => i.contains_listed).map((i) => [i.component, i.contains_listed])).toEqual([
      ['Nachfüllbeutel mit Spout', ['Ausgießer/Spout und Verschluss']]
    ])
  })

  it('also locks on an overlap between two entries of the same request', () => {
    const r = weighBom(
      [
        {
          request: 'Rad',
          leg: leg({ items: [item('Reifen', 1.2, { includes: ['Schlauch'] }), item('Schlauch', 0.3)] })
        },
        { request: 'Rahmen', leg: leg({ items: [item('Rahmen', 6)] }) }
      ],
      { totalMassKg: 7.5 }
    )
    expect(r.overlaps).toEqual([{ entry: 'Reifen', includes: ['Schlauch'] }])
    expect(r.balance_ok).toBeNull()
  })

  it('ignores an includes that names nothing listed, or the entry itself', () => {
    for (const bogus of [['Henkel'], ['Nachfüllbeutel']]) {
      const r = weighBom(outcomes(bogus), { totalMassKg: 0.46 })
      expect(r.overlaps).toBeUndefined()
      expect(r.balance_ok).toBe(true)
    }
  })
})

// R2 of the PL-28 runs (Mistral, the shelf rack): one shop's 24 kg came back from several legs under several
// wordings of the product, and every wording became its own line.
describe('weighBom — the same figure reported by several legs', () => {
  const buch = 'https://www.buchmann.ch/de/avasco-atlas-175-steckregal-176x90x40cm-hdf'
  const legsWith = (versions: Array<string | undefined>, url = buch, mass = 24): LegOutcome[] =>
    versions.map((version, i) => ({
      request: `part ${i}`,
      leg: leg({
        unresolved: [{ component: `part ${i}`, reason: 'no_mass' }],
        product_masses: [{ mass_kg: mass, basis: 'unknown', version, source_url: url }]
      })
    }))

  it('keeps one figure for one version written several ways, or written once and left out once', () => {
    const r = weighBom(legsWith(['Atlas 175 HDF4', 'Avasco Steckregal Atlas 175 HDF4', undefined]))
    expect(r.totals_found?.map((t) => t.version)).toEqual(['Atlas 175 HDF4'])
    expect(r.versions).toBeUndefined()
  })

  // Two pages of one shop, the same weight for two different EAN numbers: two versions, not one figure.
  it('never merges two different references because the host is the same', () => {
    const praxis = 'https://www.praxis.nl/atlas/10322182'
    const r = weighBom(legsWith([EAN480, 'EAN 5400431601435 (black)'], praxis, 13))
    expect(r.totals_found).toHaveLength(2)
    expect(r.total_used).toBeUndefined()
    expect(r.versions?.conflict).toBe(true)
  })
})

// F03 of the PL-28 series (GLM, the wheelbarrow): three legs read 20.7 kg for the same EAN, once "net", twice
// unstated, once without the EAN — one figure, and the parts can be checked against it.
describe('weighBom — one researched total stated several ways', () => {
  const total = (basis: 'net' | 'unknown', version: string) =>
    leg({
      items: [item('x', 1)],
      product_masses: [{ mass_kg: 20.7, basis, version, source_url: 'https://shop.example/p' }]
    })
  it('uses the figure, with the scope one source states', () => {
    const r = weighBom([
      {
        request: 'tub',
        leg: { ...total('net', 'PRAKTICA 150, EAN 4027972127043'), items: [item('tub', 11)] }
      },
      {
        request: 'frame',
        leg: { ...total('unknown', 'PRAKTICA 150 (EAN 4027972127043)'), items: [item('frame', 6.9)] }
      },
      { request: 'wheel', leg: { ...total('unknown', 'PRAKTICA 150'), items: [item('wheel', 2.8)] } }
    ])
    expect(r.total_used).toMatchObject({ mass_kg: 20.7, basis: 'net', source: 'researched' })
    expect(r.balance_ok).toBe(true)
  })

  // A net weight from a page that names no product lends no scope to the EAN another page names.
  it('takes the scope only from figures naming the same product', () => {
    const r = weighBom([
      {
        request: 'a',
        leg: leg({
          items: [item('a', 10.7)],
          product_masses: [{ mass_kg: 20.7, basis: 'unknown', version: 'EAN 4027972127043' }]
        })
      },
      {
        request: 'b',
        leg: leg({ items: [item('b', 10)], product_masses: [{ mass_kg: 20.7, basis: 'net' }] })
      }
    ])
    expect(r.total_used).toMatchObject({ mass_kg: 20.7, basis: 'unknown', version: 'EAN 4027972127043' })
    expect(r.balance_ok).toBeNull()
  })

  it('still refuses when one source says net and another gross', () => {
    const r = weighBom([
      {
        request: 'tub',
        leg: leg({ items: [item('tub', 11)], product_masses: [{ mass_kg: 20.7, basis: 'net' }] })
      },
      {
        request: 'frame',
        leg: leg({ items: [item('frame', 9.7)], product_masses: [{ mass_kg: 20.7, basis: 'gross' }] })
      }
    ])
    expect(r.total_used).toBeUndefined()
  })
})

describe('weighBom — references without an EAN', () => {
  it('locks the verdict when the figures name different versions in words', () => {
    const r = weighBom(
      [
        { request: 'shelves', leg: leg({ items: [item('shelves', 6, { version: 'Atlas HDF4' })] }) },
        { request: 'frame', leg: leg({ items: [item('frame', 7, { version: 'Atlas HDF5' })] }) }
      ],
      { totalMassKg: 13 }
    )
    expect(r.versions?.conflict).toBe(true)
    expect(r.balance_ok).toBeNull()
    expect(r.note).toMatch(/name different versions: Atlas HDF4 \(shelves\); Atlas HDF5 \(frame\)/)
  })
})

// R3 of the PL-28 series (GLM, the shelf rack): asked for "the total weight" as a component, the leg answered
// with an entry of 24 kg — the figure other legs reported as the whole product's — and the parts summed to 38.1 kg.
describe('weighBom — the whole product returned as a part', () => {
  const outcomes: LegOutcome[] = [
    {
      request: 'frame',
      leg: leg({
        items: [item('frame', 8)],
        product_masses: [{ mass_kg: 24, basis: 'unknown', source_url: 'https://www.buchmann.ch/x' }]
      })
    },
    { request: 'shelves', leg: leg({ items: [item('shelves', 6.1, { count: 5, mass_each_kg: 1.22 })] }) },
    { request: 'Gesamtgewicht', leg: leg({ items: [item('Gesamtgewicht laut Hersteller', 24)] }) }
  ]
  const r = weighBom(outcomes)

  it('reads it as the whole-product weight, keeps it out of the parts and says so', () => {
    expect(r.sum_kg).toBeCloseTo(14.1, 6)
    expect(r.items.map((i) => i.component)).toEqual(['frame', 'shelves'])
    expect(r.totals_found?.map((t) => t.mass_kg)).toEqual([24])
    expect(r.requests?.find((q) => q.component === 'Gesamtgewicht')?.status).toBe('product_mass_only')
    expect(r.note).toMatch(
      /"Gesamtgewicht laut Hersteller" \(24 kg\) came back as a part but with exactly the mass/
    )
  })

  // Glass of 9.96 kg and a 0.04 kg seal against a 10 kg product: a complete list, not a misplaced total.
  it('leaves a part alone when the others weigh no more than the rounding margin', () => {
    const r = weighBom([
      {
        request: 'glass',
        leg: leg({ items: [item('glass', 9.96)], product_masses: [{ mass_kg: 10, basis: 'net' }] })
      },
      { request: 'seal', leg: leg({ items: [item('seal', 0.04)] }) }
    ])
    expect(r.items.map((i) => i.component)).toEqual(['glass', 'seal'])
    expect(r.balance_ok).toBe(true)
  })

  it('leaves a part alone that is merely close to a whole-product weight', () => {
    const near = weighBom([
      {
        request: 'glass',
        leg: leg({ items: [item('glass', 9.85)], product_masses: [{ mass_kg: 10, basis: 'net' }] })
      },
      { request: 'seal', leg: leg({ items: [item('seal', 0.15)] }) }
    ])
    expect(near.items.map((i) => i.component)).toEqual(['glass', 'seal'])
  })
})

// R8 of the PL-28 series (GLM, the soap refill): the follow-up answered "Glycerin" again beside the first answer,
// and both went into the sum.
describe('weighBom — the same part twice in one request', () => {
  it('drops a repeat with the same mass and a null entry of that name, and says so', () => {
    const r = weighBom([
      {
        request: 'Spout',
        leg: leg({
          items: [item('Ausgießer/Spout', 0.002), item('Ausgießer/Spout', 0.00201)],
          unresolved: [{ component: 'ausgießer/spout', reason: 'no_mass' }]
        })
      },
      { request: 'Wasser', leg: leg({ items: [item('Wasser', 0.38)] }) }
    ])
    expect(r.sum_kg).toBeCloseTo(0.382, 6)
    expect(r.unresolved).toEqual([])
    expect(r.note).toMatch(/"Ausgießer\/Spout" came back twice for the same request/)
  })

  // R8 of the PL-28 series: "Glycerin" came back at 12.8 g and at 10.2 g. Choosing either would pick a number.
  it('chooses no figure when the same part came back with different masses', () => {
    const r = weighBom(
      [
        {
          request: 'Glycerin',
          leg: leg({ items: [item('Glycerin (Rezeptur)', 0.0128), item('Glycerin (Rezeptur)', 0.0102)] })
        },
        { request: 'Wasser', leg: leg({ items: [item('Wasser', 0.38)] }) }
      ],
      { totalMassKg: 0.39 }
    )
    expect(r.sum_kg).toBeCloseTo(0.38, 6)
    expect(r.unresolved[0]).toMatchObject({ component: 'Glycerin (Rezeptur)', reason: 'unclear_mass' })
    expect(r.unresolved[0].note).toMatch(/0\.0128 kg, 0\.0102 kg — no figure is preferred/)
    expect(r.balance_ok).toBeNull()
  })

  it('keeps an unclear entry beside a figure of the same name, so its contradiction stays open', () => {
    const r = weighBom(
      [
        {
          request: 'Rahmen',
          leg: leg({
            items: [item('Rahmen', 6)],
            unresolved: [
              { component: 'Rahmen', reason: 'unclear_mass', note: '7 kg for the set, but 2 × 4 kg = 8 kg.' }
            ]
          })
        },
        { request: 'rest', leg: leg({ items: [item('rest', 4)] }) }
      ],
      { totalMassKg: 10 }
    )
    expect(r.unresolved.map((u) => u.reason)).toEqual(['unclear_mass'])
    expect(r.balance_ok).toBeNull()
  })
})

describe('weighBom — a dominant part', () => {
  // The counter-case agreed before building: 9.85 of 10 kg is a real main part, and the list adds up.
  it('names the suspicion but keeps the verdict when the parts fit the total', () => {
    const r = weighBom(
      [
        { request: 'glass', leg: leg({ items: [item('glass', 9.85)] }) },
        { request: 'seal', leg: leg({ items: [item('seal', 0.15)] }) }
      ],
      { totalMassKg: 10 }
    )
    expect(r.balance_ok).toBe(true)
    expect(r.note).toMatch(/"glass" \(9\.85 kg\) weighs as much as the whole product \(10 kg\)/)
  })

  // T5's shape: the rack's 13 kg as the frame, plus the coating — 13.14 against 13 sits inside the tolerance.
  it('locks the verdict when that part and the others overshoot the total', () => {
    const r = weighBom(
      [
        { request: 'frame', leg: leg({ items: [item('frame', 13)] }) },
        { request: 'zinc', leg: leg({ items: [item('zinc', 0.14)] }) }
      ],
      { totalMassKg: 13 }
    )
    expect(r.balance_ok).toBeNull()
    expect(r.note).toMatch(/the parts overshoot the total/)
  })
})

describe('weighBom — limits and the enumerating leg', () => {
  it('locks the verdict when requested components were never researched', () => {
    const r = weighBom([{ request: 'body', leg: leg({ items: [item('body', 0.022)] }) }], {
      totalMassKg: 0.022,
      notResearched: ['label']
    })
    expect(r.balance_ok).toBeNull()
    expect(r.coverage).toEqual({ requested: 2, with_mass: 1 })
    expect(r.note).toMatch(/1 requested component was not researched \(over the limit per call\): label/)
  })

  it('locks the verdict when entries were cut from the list', () => {
    const r = weighBom([{ request: null, leg: leg({ items: [item('a', 1), item('b', 1), item('c', 1)] }) }], {
      totalMassKg: 2,
      itemCap: 2
    })
    expect(r.items).toHaveLength(2)
    expect(r.balance_ok).toBeNull()
    expect(r.note).toMatch(/1 further entries were cut/)
  })

  it('describes an enumerated list by what it lists, never as the product being complete', () => {
    const r = weighBom([
      {
        request: null,
        leg: leg({ items: [item('body', 0.019)], unresolved: [{ component: 'label', reason: 'no_mass' }] })
      }
    ])
    expect(r.coverage).toEqual({ listed: 2, with_mass: 1 })
    expect(r.requests).toBeUndefined()
    expect(r.summary).toMatch(/1 of 2 listed components have a mass/)
  })

  it('gives a verdict on a complete list against a total the caller passed', () => {
    const r = weighBom(
      ['body', 'cap'].map((n) => ({
        request: n,
        leg: leg({ items: [item(n, n === 'body' ? 0.019 : 0.003)] })
      })),
      { totalMassKg: 0.022 }
    )
    expect(r.balance_ok).toBe(true)
    expect(r.summary).toMatch(/Checked against the total you passed \(0\.022 kg\) — the parts add up/)
    // The share goes with the kilograms, so a small residual does not read as a gap to close first.
    expect(r.summary).toMatch(/residual 0 kg, 0 % of the total, within the 15 % tolerance/)
  })
})

// O-W4 of PL-137 (GLM, the Forza door with its EPD): the parts add up to the EPD's 61.6 kg, but "Furnierklebstoff"
// (veneer adhesive) read as containing the veneer, and the EPD's number, edition and dates written four ways read as
// four versions, kept the verdict back.
describe('weighBom — names that are parts of words, references that are ways of writing one', () => {
  const EPD = 'https://www.forza-doors.com/x/forza-fd30-epd.pdf'
  const door = (version: string, part: BomItem): LegOutcome => ({
    request: part.component,
    leg: leg({
      items: [{ ...part, version }],
      product_masses: [{ mass_kg: 61.6, basis: 'net', version, source_url: EPD }]
    })
  })
  const outcomes: LegOutcome[] = [
    door('FD30 Flush Solid Core Timber Door 2040x926x44 mm (EPD S-P-11102)', item('Türblatt-Kern', 56.2)),
    door('Forza FD30 Flush Solid Core Timber Door 2040x926x44mm (EPD S-P-11102)', item('Furnier', 1.7)),
    door('EPD v2 (2025-06-23), S-P-11102', item('Umleimer (Eiche)', 2.6)),
    door('EPD S-P-11102, 2023-12-15', item('Brandschutzstreifen', 0.6)),
    {
      request: 'Klebstoff und Versiegelung',
      leg: leg({
        items: [
          item('Klebstoff und Versiegelung', 0.5, { includes: ['Umleimer-Klebstoff', 'Furnierklebstoff'] })
        ]
      })
    }
  ]

  it('gives the door its verdict', () => {
    const r = weighBom(outcomes)
    expect(r.overlaps).toBeUndefined()
    expect(r.versions).toBeUndefined()
    expect(r.total_used).toMatchObject({ mass_kg: 61.6, basis: 'net' })
    expect(r.balance_ok).toBe(true)
  })

  it('still reads a whole word, and the head of a compound, as the part it names', () => {
    const tube = weighBom(
      [
        { request: 'tyre', leg: leg({ items: [item('tyre', 1.2, { includes: ['tube'] })] }) },
        { request: 'inner tube', leg: leg({ items: [item('inner tube', 0.3)] }) }
      ],
      { totalMassKg: 1.5 }
    )
    expect(tube.overlaps).toEqual([{ entry: 'tyre', includes: ['inner tube'] }])
    // O-W2: the complete wheel "with axle" beside the axle delivered in the accessory bag.
    const axle = weighBom(
      [
        { request: 'Luftrad', leg: leg({ items: [item('Luftrad komplett', 3.6, { includes: ['Achse'] })] }) },
        { request: 'Achse', leg: leg({ items: [item('Massivachse 17×101 mm', 0.18)] }) }
      ],
      { totalMassKg: 3.8 }
    )
    expect(axle.overlaps).toEqual([{ entry: 'Luftrad komplett', includes: ['Massivachse 17×101 mm'] }])
    expect(axle.balance_ok).toBeNull()
    // One screw or several: a containment claim does not get lost to a plural.
    const screws = weighBom(
      [
        { request: 'housing', leg: leg({ items: [item('housing', 8, { includes: ['screw'] })] }) },
        { request: 'motor', leg: leg({ items: [item('motor', 2)] }) },
        { request: 'screws', leg: leg({ items: [item('screws', 0.1)] }) }
      ],
      { totalMassKg: 10 }
    )
    expect(screws.overlaps).toEqual([{ entry: 'housing', includes: ['screws'] }])
    expect(screws.balance_ok).toBeNull()
  })
})

// B-W1c of PL-137 (Haiku, total passed): two shops' article numbers for one wheelbarrow kept the verdict back even
// with the total the caller passed. A spare grip's EAN beside the wheelbarrow's still locks — the leg was asked for the
// whole product's version — but the lock says it may be the grip's own article number.
describe('weighBom — shop numbers and a part’s own EAN', () => {
  const legs = (gripVersion?: string): LegOutcome[] => [
    {
      request: 'Mulde',
      leg: leg({
        items: [item('Mulde', 11, { version: 'Luftrad mit Rillenprofil und Stahlfelge, Art. 5691696' })]
      })
    },
    {
      request: 'Rahmen',
      leg: leg({
        items: [
          item('Rahmen', 7, {
            version: 'PRAKTICA 150 l, Luftrad mit Stahlfelge, Buchenholzgriffe (Hornbach)'
          })
        ]
      })
    },
    {
      request: 'Griffe',
      leg: leg({
        items: [item('Griffe', 0.46, gripVersion ? { version: gripVersion } : {})],
        product_masses: [{ mass_kg: 20.7, basis: 'unknown', version: 'PRAKTICA 150 (EAN 4027972127043)' }]
      })
    },
    { request: 'Rad', leg: leg({ items: [item('Rad', 2.6)] }) }
  ]

  it('checks against the total passed', () => {
    const r = weighBom(legs(), { totalMassKg: 20.7 })
    expect(r.versions).toBeUndefined()
    expect(r.balance_ok).toBe(true)
  })

  it('locks on a part’s EAN, naming it as perhaps the part’s own', () => {
    const r = weighBom(legs('Capito Holzgriff 410801 (EAN 4027972108011)'), { totalMassKg: 20.7 })
    expect(r.versions?.conflict).toBe(true)
    expect(r.balance_ok).toBeNull()
    expect(r.versions?.only_part_eans).toBe(true)
    expect(r.summary).toMatch(
      /residual -0\.36 kg\. The figures rest on different versions of the product — see note\.$/
    )
    expect(r.note).toMatch(
      /an EAN is named only on a part entry, never on a whole-product figure, and differs from the product's: "Capito Holzgriff 410801 \(EAN 4027972108011\)" \(on Griffe\) — open that entry's source: if it is the part's own article number/
    )
  })
})
