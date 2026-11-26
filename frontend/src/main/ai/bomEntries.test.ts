import { describe, expect, it } from 'vitest'
import type { BomItem, BomLeg } from './bomAnswer'
import { weighBom } from './bomBalance'
import { alternativesNote, sameNameEntries, severalEntries } from './bomEntries'

/**
 * What one leg's entries stand for. The case is a recorded answer of the paid series on the soap refill (Mistral):
 * asked for the pouch, the researcher returned an aluminium-free variant, a barrier variant and a measured comparison
 * pouch as three entries; asked for the label, a label and a direct print — either one or the other. Every entry went
 * into the sum. Then the same answer as a leg gives it when it has a place for the other figures.
 */

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

const POUCH = 'Nachfüllbeutel (Folie, Material und Masse)'
const SPOUT = 'Verschluss/Ausgießer (Material und Masse)'
const LABEL = 'Etikett (Material und Masse)'

describe('a part returned as several figures', () => {
  it('names the entries of one request side by side when the leg gave them as entries of their own', () => {
    const r = weighBom([
      {
        request: POUCH,
        leg: leg({
          items: [
            item('Nachfüllbeutel (Folie, Standbodenbeutel 500 ml, alufreie Variante)', 0.0102),
            item('Nachfüllbeutel (Folie, Standbodenbeutel 500 ml, Alu-Barriere-Variante)', 0.0103)
          ]
        })
      },
      {
        request: SPOUT,
        leg: leg({ items: [item('Einschweiß-Ausgießer (Weldspout) am Nachfüllbeutel', 0.002)] })
      },
      {
        request: LABEL,
        leg: leg({
          items: [
            item(
              'Etikett (selbstklebendes Etikett auf dem Refill-Beutel, falls nicht direkt bedruckt)',
              0.0006
            ),
            item('Direktbedruckung / abziehbare bedruckte Banderole', 0.00015)
          ]
        })
      }
    ])
    // Nothing is removed on a suspicion: the sum stays what the entries say, and the reader is shown why to doubt it.
    expect(r.sum_kg).toBeCloseTo(0.02325, 6)
    expect(r.note).toMatch(
      new RegExp(
        `"${POUCH.replace(/[()]/g, '\\$&')}" came back as 2 entries, all counted: "Nachfüllbeutel \\(Folie, ` +
          'Standbodenbeutel 500 ml, alufreie Variante\\)" 0.0102 kg, .*Alu-Barriere-Variante\\)" 0.0103 kg — if one ' +
          'is another figure for the same part'
      )
    )
    expect(r.note).toMatch(/"Etikett \(Material und Masse\)" came back as 2 entries/)
    expect(r.note).not.toMatch(/Verschluss\/Ausgießer \(Material und Masse\)" came back/)
  })

  it('counts a part once when the leg gave its other figures as alternatives, and names them', () => {
    const r = weighBom(
      [
        {
          request: POUCH,
          leg: leg({
            items: [
              item('Nachfüllbeutel (Standbodenbeutel 500 ml)', 0.0102, {
                material: 'PET/PE',
                alternatives: [
                  { mass_kg: 0.0103, material: 'PET/ALU/PE', source_url: 'https://e.org/alu' },
                  { mass_kg: 0.01206, source_url: 'https://e.org/recoup' }
                ]
              })
            ]
          })
        },
        { request: SPOUT, leg: leg({ items: [item('Weldspout', 0.002)] }) },
        {
          request: LABEL,
          leg: leg({
            items: [
              item('Etikett', 0.0006, { alternatives: [{ mass_kg: 0.00015, material: 'Direktdruck' }] })
            ]
          })
        }
      ],
      { totalMassKg: 0.0128 }
    )
    expect(r.sum_kg).toBeCloseTo(0.0128, 6)
    expect(r.balance_ok).toBe(true)
    expect(r.note).toMatch(
      /Other figures the research found for the same part, not counted: "Nachfüllbeutel \(Standbodenbeutel 500 ml\)" 0\.0103 kg \(PET\/ALU\/PE\), 0\.01206 kg \(counted: 0\.0102 kg\); "Etikett" 0\.00015 kg \(Direktdruck\) \(counted: 0\.0006 kg\)/
    )
    expect(r.note).not.toMatch(/came back as \d+ entries/)
  })

  // The counter-case: a tyre, its tube and its valve are all in the wheel. They stay three parts, all summed, and the
  // side-by-side note does not lock a verdict the parts satisfy.
  it('keeps the parts of one requested component as parts, and the verdict with them', () => {
    const r = weighBom(
      [
        {
          request: 'Luftrad: Gummimantel + Schlauch + Autoventil',
          leg: leg({
            items: [item('Gummimantel', 1.8), item('Schlauch', 0.282), item('Autoventil', 0.018)]
          })
        },
        { request: 'Felge', leg: leg({ items: [item('Stahlfelge', 1.4)] }) }
      ],
      { totalMassKg: 3.5 }
    )
    expect(r.sum_kg).toBeCloseTo(3.5, 6)
    expect(r.balance_ok).toBe(true)
    expect(r.note).toMatch(
      /"Luftrad: Gummimantel \+ Schlauch \+ Autoventil" came back as 3 entries, all counted/
    )
  })
})

describe('severalEntries', () => {
  // Using the field once says nothing about the entry beside it: here the comparison pouch still came back on its own.
  it('names the entries also when the leg wrote alternatives for one of them', () => {
    expect(
      severalEntries(
        'pouch',
        leg({
          items: [
            item('pouch, alu-free', 0.0102, { alternatives: [{ mass_kg: 0.0103, material: 'PET/ALU/PE' }] }),
            item('pouch, measured comparison', 0.012)
          ]
        })
      )
    ).toMatch(
      /"pouch" came back as 2 entries, all counted: "pouch, alu-free" 0\.0102 kg, "pouch, measured comparison" 0\.012 kg/
    )
  })

  it('says nothing about a request answered with one entry', () => {
    expect(severalEntries('frame', leg({ items: [item('frame', 7)] }))).toBeUndefined()
  })

  it('is not asked for the leg that enumerates the components itself', () => {
    const r = weighBom([{ request: null, leg: leg({ items: [item('frame', 7), item('shelf', 6.5)] }) }])
    expect(r.note ?? '').not.toMatch(/came back as/)
  })
})

// One name, several materials: a door's packaging came back as cardboard, film and tape, all named "Verpackung" — three
// parts, as the leg is told to list a part of several materials. The name alone held back a verdict the parts met.
describe('one name, several materials', () => {
  const PACKAGING = [
    item('Verpackung', 1.15, { material: 'Karton', packaging: 'sales' }),
    item('Verpackung', 0.03, { material: 'PE-Folie', packaging: 'sales' }),
    item('Verpackung', 0.01, { material: 'Klebeband', packaging: 'sales' })
  ]
  const door = (packaging: BomItem[]) =>
    weighBom(
      [
        { request: 'Türblatt', leg: leg({ items: [item('Türblatt', 61.6, { material: 'Spanplatte' })] }) },
        { request: 'Verpackung', leg: leg({ items: packaging }) }
      ],
      { totalMassKg: 61.6 }
    )

  it('counts entries of one name and different materials as parts, and names them side by side', () => {
    const r = door(PACKAGING)
    expect(r.unresolved).toEqual([])
    expect(r.packaging_kg).toBeCloseTo(1.19, 6)
    expect(r.balance_ok).toBe(true)
    expect(r.note).toMatch(
      /"Verpackung" came back as 3 entries, all counted: "Verpackung" \(Karton\) 1\.15 kg, "Verpackung" \(PE-Folie\) 0\.03 kg, "Verpackung" \(Klebeband\) 0\.01 kg — if one is another figure for the same part/
    )
  })

  it('still reads one material with two masses as a contradiction, beside the other parts', () => {
    const r = door([...PACKAGING, item('Verpackung', 0.9, { material: 'karton', packaging: 'sales' })])
    expect(r.unresolved).toMatchObject([
      { component: 'Verpackung', material: 'Karton', reason: 'unclear_mass' }
    ])
    expect(r.packaging_kg).toBeCloseTo(0.04, 6)
    expect(r.balance_ok).toBeNull()
  })

  it('still reads one name with two masses as a contradiction when an entry names no material', () => {
    const r = door([PACKAGING[0], item('Verpackung', 0.03, { packaging: 'sales' })])
    expect(r.unresolved).toMatchObject([{ component: 'Verpackung', reason: 'unclear_mass' }])
    expect(r.balance_ok).toBeNull()
  })

  it('drops a repeat of one material as before, and counts the other material', () => {
    const r = door([
      PACKAGING[0],
      PACKAGING[1],
      item('Verpackung', 1.15, { material: 'Karton ', packaging: 'sales' })
    ])
    expect(r.unresolved).toEqual([])
    expect(r.packaging_kg).toBeCloseTo(1.18, 6)
    expect(r.note).toMatch(/"Verpackung" came back twice for the same request/)
  })

  // The other door: the adhesive came back twice at 0.5 kg, its material worded once one way and once another. One
  // mass twice is one figure reported twice, whatever the material says.
  it('reads one mass under two wordings of its material as a repeat', () => {
    const r = door([
      ...PACKAGING,
      item('Verpackung', 1.15, { material: 'Papier/Pappe (vorgeformter Karton)', packaging: 'sales' })
    ])
    expect(r.unresolved).toEqual([])
    expect(r.packaging_kg).toBeCloseTo(1.19, 6)
    expect(r.note).toMatch(/"Verpackung" came back twice for the same request/)
  })

  it('reads an entry that matches one part by material and another by mass as contradicting both', () => {
    const r = door([
      PACKAGING[0],
      PACKAGING[1],
      item('Verpackung', 0.03, { material: 'Karton', packaging: 'sales' })
    ])
    expect(r.unresolved).toMatchObject([
      { component: 'Verpackung', material: 'Karton', reason: 'unclear_mass' }
    ])
    expect(r.unresolved[0].note).toMatch(/3 times with different masses: 1\.15 kg, 0\.03 kg, 0\.03 kg/)
  })

  // The wheelbarrow: all entries named after the request, the fasteners listing their own screws. "Schrauben" is in
  // every sibling's name, so it points at none of them.
  it('reads no overlap between entries of one name, whose shared words say nothing about which', () => {
    const request = 'Achse, Lager, Schrauben, Standfüße'
    const r = weighBom(
      [
        {
          request,
          leg: leg({
            items: [
              item(request, 0.18, { material: 'Stahl verzinkt (Massivachse)' }),
              item(request, 0.12, {
                material: 'Stahl verzinkt (Verbindungselemente)',
                includes: ['Schrauben', 'Muttern']
              })
            ]
          })
        },
        { request: 'Mulde', leg: leg({ items: [item('Mulde', 11, { includes: ['Schrauben'] })] }) }
      ],
      { totalMassKg: 11.3 }
    )
    expect(r.overlaps).toMatchObject([{ entry: 'Mulde', includes: [request] }])
    const alone = weighBom(
      [{ request, leg: leg({ items: r.items.filter((i) => i.component === request) }) }],
      { totalMassKg: 0.3 }
    )
    expect(alone.overlaps).toBeUndefined()
    expect(alone.balance_ok).toBe(true)
    expect(alone.note).toMatch(/came back as 2 entries, all counted/)
  })

  it('keeps a material still without a mass beside the materials that have one', () => {
    const housing = (extra: Partial<BomItem>) =>
      weighBom(
        [
          {
            request: 'housing',
            leg: leg({
              items: [
                item('housing', 0.8, { material: 'PP' }),
                item('housing', 0.1, { material: 'aluminium' })
              ],
              unresolved: [{ component: 'housing', reason: 'no_mass', ...extra }]
            })
          }
        ],
        { totalMassKg: 0.95 }
      )
    expect(housing({ material: 'steel' }).unresolved).toMatchObject([
      { component: 'housing', material: 'steel' }
    ])
    expect(housing({ material: 'steel' }).balance_ok).toBeNull()
    expect(housing({}).balance_ok).toBeNull()
    expect(housing({ material: 'pp' }).unresolved).toEqual([])
  })

  it('keeps a material still without a mass when another material of its name contradicts itself', () => {
    const r = weighBom([
      {
        request: 'housing',
        leg: leg({
          items: [
            item('housing', 0.8, { material: 'PP' }),
            item('housing', 0.4, { material: 'PP' }),
            item('housing', 0.1, { material: 'aluminium' })
          ],
          unresolved: [{ component: 'housing', material: 'steel', reason: 'no_mass' }]
        })
      }
    ])
    expect(r.unresolved.map((u) => [u.material, u.reason])).toEqual([
      ['steel', 'no_mass'],
      ['PP', 'unclear_mass']
    ])
  })

  it('drops the null entry of a part the measured entry names without a material', () => {
    const r = weighBom([
      {
        request: 'Spout',
        leg: leg({
          items: [item('Spout', 0.002)],
          unresolved: [{ component: 'spout', material: 'PP', reason: 'no_mass' }]
        })
      }
    ])
    expect(r.unresolved).toEqual([])
  })

  it('reads one part as one figure only when all its figures agree, in any order', () => {
    const bracket = [
      item('bracket', 1, { material: 'aluminium' }),
      item('bracket', 0.981, { material: 'steel' }),
      item('bracket', 1.019, { material: 'steel' }),
      item('bracket', 0.1, { material: 'rubber' })
    ]
    for (const items of [bracket, [bracket[1], bracket[0], bracket[2], bracket[3]]]) {
      const r = weighBom([{ request: 'bracket', leg: leg({ items }) }], { totalMassKg: 1.1 })
      expect(r.unresolved).toMatchObject([{ component: 'bracket', reason: 'unclear_mass' }])
      expect(r.balance_ok).toBeNull()
    }
  })

  // Entries of one name in different requests are no siblings: each leg answered its own question.
  it('still reads an overlap with an entry of the same name from another request', () => {
    const r = weighBom(
      [
        {
          request: 'wheel assembly',
          leg: leg({ items: [item('wheel with axle', 2, { includes: ['axle'] })] })
        },
        { request: 'running gear', leg: leg({ items: [item('wheel with axle', 0.1)] }) },
        { request: 'frame', leg: leg({ items: [item('frame', 8)] }) }
      ],
      { totalMassKg: 10 }
    )
    expect(r.overlaps).toEqual([{ entry: 'wheel with axle', includes: ['wheel with axle'] }])
    expect(r.balance_ok).toBeNull()
  })

  it('names them in the leg that enumerates the components itself, and nothing for distinct names', () => {
    const list = leg({
      items: [
        item('Beschlag', 0.4, { material: 'Stahl' }),
        item('Beschlag', 0.1, { material: 'Messing' }),
        item('Türblatt', 61, { material: 'Spanplatte' })
      ]
    })
    expect(sameNameEntries(list)).toEqual([
      '"Beschlag" came back as 2 entries of different materials, all counted: "Beschlag" (Stahl) 0.4 kg, ' +
        '"Beschlag" (Messing) 0.1 kg — if one is another figure for the same part (a variant, another source) ' +
        'rather than a further part of it, that part is counted twice.'
    ])
    const r = weighBom([{ request: null, leg: list }], { totalMassKg: 61.5 })
    expect(r.balance_ok).toBe(true)
    expect(r.note).toMatch(/"Beschlag" came back as 2 entries of different materials/)
    expect(sameNameEntries(leg({ items: [item('frame', 7), item('shelf', 6.5)] }))).toEqual([])
  })
})

describe('alternativesNote', () => {
  it('names nothing when no entry carries alternatives', () => {
    expect(alternativesNote([item('frame', 7)])).toBeUndefined()
  })
})
