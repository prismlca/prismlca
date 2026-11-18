import { describe, expect, it } from 'vitest'
import type { BomItem, BomLeg } from './bomAnswer'
import { weighBom } from './bomBalance'
import { alternativesNote, severalEntries } from './bomEntries'

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

describe('alternativesNote', () => {
  it('names nothing when no entry carries alternatives', () => {
    expect(alternativesNote([item('frame', 7)])).toBeUndefined()
  })
})
