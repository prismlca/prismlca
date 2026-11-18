import { describe, expect, it } from 'vitest'
import { parseBomAnswer, parseBomItems } from './bomAnswer'

/**
 * What a bill-of-materials leg's JSON is read as. Models rename fields, wrap the list, write 0 for "unknown"
 * and give one shelf's mass where five are meant; the reading must neither delete what it cannot use nor pick
 * a reading of figures that contradict each other.
 */
describe('parseBomItems', () => {
  it('accepts a bare array, an {items} wrapper and the full answer object', () => {
    const one = parseBomItems([{ component: 'cap', material: 'HDPE', mass_kg: 0.002 }])
    const two = parseBomItems({ items: [{ component: 'cap', material: 'HDPE', mass_kg: 0.002 }] })
    const three = parseBomItems({
      items: [{ component: 'cap', material: 'HDPE', mass_kg: 0.002 }],
      product_mass: [{ mass_kg: 0.022, basis: 'net' }]
    })
    expect(one).toEqual(two)
    expect(three).toEqual(one)
    expect(one[0]).toMatchObject({ component: 'cap', material: 'HDPE', mass_kg: 0.002 })
  })

  it('tolerates the field-name variants models produce', () => {
    const items = parseBomItems([
      { part: 'body', materials: 'PET', mass: 0.019, source: 'https://example.org/a' },
      { name: 'label', material: 'PP', mass_in_kg: '0.0005' }
    ])
    expect(items.map((i) => i.component)).toEqual(['body', 'label'])
    expect(items[0].source_url).toBe('https://example.org/a')
    expect(items[1].mass_kg).toBeCloseTo(0.0005, 6)
  })

  it('keeps the judgement fields only over the closed vocabularies', () => {
    const items = parseBomItems([
      { component: 'frame', mass_kg: 9, source_class: 'Industry', confidence: 'MEDIUM' },
      { component: 'roof', mass_kg: 2.2, source_class: 'very good', confidence: '4' }
    ])
    expect(items[0]).toMatchObject({ source_class: 'industry', confidence: 'medium' })
    // A numeric confidence is exactly what was refused — words or nothing.
    expect(items[1].source_class).toBeUndefined()
    expect(items[1].confidence).toBeUndefined()
  })

  it('drops entries without a usable component or mass', () => {
    const items = parseBomItems([
      { component: 'ok', mass_kg: 1 },
      { component: '', mass_kg: 2 },
      { component: 'no mass' },
      { component: 'bad mass', mass_kg: 'a lot' },
      'nonsense'
    ])
    expect(items.map((i) => i.component)).toEqual(['ok'])
  })

  it('returns an empty list for non-list input instead of throwing', () => {
    expect(parseBomItems(null)).toEqual([])
    expect(parseBomItems({ nope: true })).toEqual([])
  })

  it('keeps a mass range only when it really brackets the point value', () => {
    const items = parseBomItems([
      { component: 'roof', mass_kg: 2.2, mass_range_kg: [1.8, 2.6] },
      { component: 'alias', mass_kg: 2.2, mass_range: [1.8, 2.6] },
      { component: 'outside', mass_kg: 3.5, mass_range_kg: [1.8, 2.6] },
      { component: 'inverted', mass_kg: 2.2, mass_range_kg: [2.6, 1.8] },
      { component: 'degenerate', mass_kg: 2.2, mass_range_kg: [2.2, 2.2] },
      { component: 'short', mass_kg: 2.2, mass_range_kg: [1.8] },
      { component: 'words', mass_kg: 2.2, mass_range_kg: ['about 2', 'maybe 3'] }
    ])
    expect(items[0].mass_range_kg).toEqual([1.8, 2.6])
    expect(items[1].mass_range_kg).toEqual([1.8, 2.6]) // the field-name variant still counts
    // A range that contradicts the point value is dropped, never "repaired" — the point value is
    // what everything downstream keys on.
    for (const i of items.slice(2)) expect(i.mass_range_kg).toBeUndefined()
    // The entries themselves survive; only the range is refused.
    expect(items).toHaveLength(7)
  })
})

describe('parseBomAnswer — packaging', () => {
  // A live run: offered only "sales" | "transport", a weak model marked a wheelbarrow's tray as sales packaging.
  it('reads "no" as a part of the product, and keeps sales and transport packaging apart', () => {
    const items = parseBomAnswer({
      items: [
        { component: 'tray', mass_kg: 11, packaging: 'no' },
        { component: 'box', mass_kg: 1, packaging: 'sales' },
        { component: 'pallet share', mass_kg: 0.2, packaging: 'transport' },
        { component: 'film', mass_kg: 0.1, packaging: true },
        { component: 'frame', mass_kg: 6, packaging: false }
      ]
    }).items
    expect(items.map((i) => i.packaging)).toEqual([undefined, 'sales', 'transport', 'sales', undefined])
  })
})

describe('parseBomAnswer — parts without a mass', () => {
  // PCFBench (arXiv 2608.27716): 47–86 % of generated BOMs carry zero-mass "ghost" parts and a quarter
  // to a third of the parts go missing. A 0 used to pass as a researched figure and a
  // missing mass deleted the part — both invisible to the balance. Now both are named.
  it('keeps components without a mass as unresolved instead of deleting them or booking a ghost', () => {
    const { items, unresolved } = parseBomAnswer([
      { component: 'body', material: 'PET', mass_kg: 0.019 },
      { component: 'label', material: 'PP', mass_kg: null, note: 'no figure anywhere' },
      { component: 'adhesive', mass_kg: 0 },
      { component: 'ink', mass_kg: 'unknown' },
      { component: '', mass_kg: 1 }
    ])
    expect(items.map((i) => i.component)).toEqual(['body'])
    expect(unresolved).toEqual([
      { component: 'label', material: 'PP', reason: 'no_mass', note: 'no figure anywhere' },
      { component: 'adhesive', reason: 'zero_mass' },
      { component: 'ink', reason: 'no_mass' }
    ])
  })

  // The note of a part without a mass is where the leg says what it did find and where the figure
  // would be. It used to stop after 300 characters in the middle of a word, unmarked, and the model
  // read the stump as the whole answer — "the datasheet could not be retrieved".
  it('hands on a long note of an unresolved part marked as cut, with its address whole', () => {
    const url = 'https://www.maker.example/downloads/datasheets/barrow-150.pdf'
    const lead = 'No frame mass is published for this product. '
    const note = `${lead}${'The datasheet gives tube sizes only. '.repeat(25)}Datasheet: ${url}`
    expect(note.length).toBeGreaterThanOrEqual(1000)
    const { unresolved } = parseBomAnswer([
      { component: 'frame', material: 'steel tube', mass_kg: null, note }
    ])
    expect(unresolved).toHaveLength(1)
    expect(unresolved[0].see_also).toEqual([url])
    expect(unresolved[0].note!.length).toBeGreaterThan(700)
    expect(unresolved[0].note).toMatch(
      /tube sizes only\. … \[note cut here: \d+ more characters not shown; the links it names are in see_also\]$/
    )
  })

  it('keeps the page the leg named for a part it found no mass for', () => {
    const { unresolved } = parseBomAnswer([
      { component: 'frame', mass_kg: null, source_url: 'https://maker.example/manual.pdf' }
    ])
    expect(unresolved[0].source_url).toBe('https://maker.example/manual.pdf')
  })
})

describe('parseBomAnswer — pieces and sets', () => {
  // T4: "5 Holzböden … Masse je Boden" came back as 1.53 kg and went into the sum once.
  it('multiplies a piece mass by its count, and keeps both on the entry', () => {
    const [shelves] = parseBomItems([
      { component: '5 shelves', material: 'HDF', count: 5, mass_each_kg: 1.22, mass_range_kg: [1.15, 1.31] }
    ])
    expect(shelves).toMatchObject({ mass_kg: 6.1, count: 5, mass_each_kg: 1.22 })
    // The range had the basis of the figure it brackets — one shelf — and is scaled with it.
    expect(shelves.mass_range_kg).toEqual([5.75, 6.55])
  })

  it('reads mass_kg as the whole set and keeps the count beside it', () => {
    const [legs] = parseBomItems([{ component: 'legs', mass_kg: 2, count: 4 }])
    expect(legs).toMatchObject({ mass_kg: 2, count: 4 })
    expect(legs.mass_each_kg).toBeUndefined()
  })

  it('accepts a set mass that agrees with count × piece mass', () => {
    const [shelves] = parseBomItems([{ component: 'shelves', mass_kg: 6.1, count: 5, mass_each_kg: 1.22 }])
    expect(shelves.mass_kg).toBe(6.1)
  })

  // No reading is preferred: the count may be the wrong number, not the mass.
  it('names contradicting figures instead of choosing one', () => {
    const { items, unresolved } = parseBomAnswer([
      { component: 'shelves', mass_kg: 1.53, count: 5, mass_each_kg: 1.53, note: 'per board' }
    ])
    expect(items).toEqual([])
    expect(unresolved[0]).toMatchObject({ component: 'shelves', reason: 'unclear_mass' })
    expect(unresolved[0].note).toMatch(/1\.53 kg for the set, but 5 × 1\.53 kg = 7\.65 kg\. per board$/)
  })

  it('never lets a missing count become 1', () => {
    const { items, unresolved } = parseBomAnswer([{ component: 'shelf', mass_each_kg: 1.53 }])
    expect(items).toEqual([])
    expect(unresolved[0]).toMatchObject({ reason: 'unclear_mass' })
    expect(unresolved[0].note).toMatch(/without a count/)
  })

  it('refuses a count that is not a whole number of pieces', () => {
    expect(parseBomAnswer([{ component: 'x', mass_each_kg: 1, count: 2.5 }]).unresolved[0].reason).toBe(
      'unclear_mass'
    )
  })
})

describe('parseBomAnswer — what the leg says about its figure', () => {
  it('keeps packaging, includes and version only in their own shapes', () => {
    const [box, pouch, odd] = parseBomItems([
      { component: 'box', mass_kg: 0.6, packaging: true, version: 'EAN 5400431601480' },
      { component: 'pouch', mass_kg: 0.012, includes: ['spout', '', 7] },
      { component: 'odd', mass_kg: 1, packaging: 'yes', includes: 'spout' }
    ])
    expect(box).toMatchObject({ packaging: 'sales', version: 'EAN 5400431601480' })
    expect(
      parseBomAnswer({ items: [{ component: 'carton', mass_kg: 0.4, packaging: 'transport' }] }).items[0]
        .packaging
    ).toBe('transport')
    expect(pouch.includes).toEqual(['spout', '7'])
    expect(odd.packaging).toBeUndefined()
    expect(odd.includes).toBeUndefined()
  })

  it('lifts whole-product masses out, with an unknown scope when the source does not say', () => {
    const leg = parseBomAnswer({
      items: [{ component: 'frame', mass_kg: null }],
      product_mass: [
        { mass_kg: 13, basis: 'net', version: 'EAN 5400431601480', source_url: 'https://praxis.example/a' },
        { mass_kg: 24, basis: 'brutto?' },
        { mass_kg: 0 },
        { mass_kg: 'heavy' }
      ]
    })
    expect(leg.product_masses).toEqual([
      { mass_kg: 13, basis: 'net', version: 'EAN 5400431601480', source_url: 'https://praxis.example/a' },
      { mass_kg: 24, basis: 'unknown' }
    ])
    expect(leg.unresolved).toHaveLength(1)
  })

  it('accepts a single whole-product mass as an object', () => {
    expect(
      parseBomAnswer({ items: [], product_mass: { mass_kg: 13, basis: 'gross' } }).product_masses
    ).toEqual([{ mass_kg: 13, basis: 'gross' }])
  })

  it('reads the versions the sources showed, dropping unnamed ones', () => {
    const leg = parseBomAnswer({
      items: [],
      versions_seen: [
        { version: 'EAN 5400431601459', differs_by: '5 mm shelves', mass_kg: 14.1, sold_by: 'Hornbach DE' },
        { differs_by: 'black' }
      ]
    })
    expect(leg.versions_seen).toEqual([
      { version: 'EAN 5400431601459', differs_by: '5 mm shelves', mass_kg: 14.1, sold_by: 'Hornbach DE' }
    ])
  })
})

// A part researcher returned one refill pouch three times — an aluminium-free variant, a barrier variant and a
// measured comparison pouch — as three entries, and the sum counted the pouch three times. The other figures have a
// place of their own now, inside the one entry.
describe('parseBomAnswer — other figures for the same part', () => {
  it('keeps alternatives inside their entry, never as entries of their own', () => {
    const leg = parseBomAnswer({
      items: [
        {
          component: 'Nachfüllbeutel',
          material: 'PET/PE',
          mass_kg: 0.0102,
          source_url: 'https://e.org/alufrei',
          alternatives: [
            {
              mass_kg: 0.0103,
              material: 'PET/ALU/PE',
              source_url: 'https://e.org/alu',
              note: 'barrier variant'
            },
            { mass: '0.01206', source: 'https://e.org/recoup' }
          ]
        }
      ]
    })
    expect(leg.items).toHaveLength(1)
    expect(leg.items[0].mass_kg).toBe(0.0102)
    expect(leg.items[0].alternatives).toEqual([
      { mass_kg: 0.0103, material: 'PET/ALU/PE', source_url: 'https://e.org/alu', note: 'barrier variant' },
      { mass_kg: 0.01206, source_url: 'https://e.org/recoup' }
    ])
  })

  it("puts an alternative's piece mass on the entry's basis and drops one without a figure", () => {
    const [shelves] = parseBomItems([
      {
        component: 'shelf',
        mass_each_kg: 1.3,
        count: 5,
        alternatives: [{ mass_each_kg: 1.4 }, { mass_kg: 7.2 }, { material: 'MDF' }, { mass_kg: 0 }]
      }
    ])
    expect(shelves.mass_kg).toBeCloseTo(6.5, 6)
    expect(shelves.alternatives?.map((a) => a.mass_kg)).toEqual([7, 7.2])
  })

  it('keeps at most four alternatives', () => {
    const [part] = parseBomItems([
      { component: 'cap', mass_kg: 0.002, alternatives: [1, 2, 3, 4, 5].map((n) => ({ mass_kg: n / 1000 })) }
    ])
    expect(part.alternatives).toHaveLength(4)
  })

  it('chooses none when an entry gives figures only as alternatives', () => {
    const leg = parseBomAnswer({
      items: [
        {
          component: 'Etikett',
          mass_kg: null,
          alternatives: [
            { mass_kg: 0.0013, material: 'PP', source_url: 'https://e.org/pp' },
            { mass_kg: 0.0008, material: 'Papier', source_url: 'https://e.org/paper' }
          ]
        }
      ]
    })
    expect(leg.items).toEqual([])
    expect(leg.unresolved[0]).toMatchObject({ component: 'Etikett', reason: 'unclear_mass' })
    expect(leg.unresolved[0].note).toMatch(
      /only alternatives: 0\.0013 kg \(PP\), 0\.0008 kg \(Papier\) — none chosen/
    )
    // Kept with their pages, so a follow-up that lands a figure can carry them onto it.
    expect(leg.unresolved[0].alternatives).toEqual([
      { mass_kg: 0.0013, material: 'PP', source_url: 'https://e.org/pp' },
      { mass_kg: 0.0008, material: 'Papier', source_url: 'https://e.org/paper' }
    ])
  })

  // The entry's own rules hold for its alternatives: a piece mass needs a count, and a set mass beside it must agree.
  it('reads no alternative one way when its figures allow two, and says what it left out', () => {
    const [shelves, cap] = parseBomItems([
      {
        component: 'shelves',
        mass_kg: 6.5,
        count: 5,
        note: 'five HDF boards',
        alternatives: [
          { mass_each_kg: 1.4, mass_kg: 1.4 },
          { mass_each_kg: 1.5, mass_kg: 7.5 }
        ]
      },
      { component: 'cap', mass_kg: 0.002, alternatives: [{ mass_each_kg: 0.0025 }] }
    ])
    expect(shelves.alternatives).toEqual([{ mass_kg: 7.5 }])
    expect(shelves.note).toBe(
      "five HDF boards Other figures not readable on this entry's basis, left out: 1.4 kg for the set against " +
        '5 × 1.4 kg = 7 kg.'
    )
    expect(cap.alternatives).toBeUndefined()
    expect(cap.note).toMatch(/left out: 0\.0025 kg per piece \(no count of pieces\)/)
  })
})
