import { describe, expect, it } from 'vitest'
import type { BomItem, ProductMass } from './bomAnswer'
import { heavierThanWhole, researchedTotal } from './bomTotals'

const total = (mass_kg: number, version?: string, basis: ProductMass['basis'] = 'unknown'): ProductMass => ({
  mass_kg,
  basis,
  ...(version ? { version } : {})
})

describe('researchedTotal — why no total is used', () => {
  // PL-137: the wheelbarrow at 19, 20.7 and 22.5 kg on three shop pages, each leg naming its shop's article number.
  // Those numbers used to make it "different references"; it is one product with figures that disagree.
  it('names figures that disagree for one product as that, not as versions', () => {
    const r = researchedTotal([
      total(20.7, 'PRAKTICA 150 l (Hornbach-Artikel 5691696)'),
      total(22.5, 'PRAKTICA 150 L (Siepmann listing, variant 1 of 2)'),
      total(19, 'PRAKTICA 150 (Artikeldatenblatt 2025)')
    ])
    expect(r).toMatch(
      /^the sources give different whole-product masses, and no version tells them apart: 20\.7 kg/
    )
    expect(r).not.toMatch(/versions/)
  })

  it('names figures of two versions as versions', () => {
    const r = researchedTotal([total(14.1, 'EAN 5400431601459'), total(13, 'EAN 5400431601480')])
    expect(r).toMatch(
      /^the whole-product masses the research found belong to different versions of the product/
    )
  })

  it('names a net against a gross figure as a matter of scope — unless the gross one is the lighter', () => {
    expect(researchedTotal([total(20, 'X', 'net'), total(10, 'X', 'gross')])).toMatch(
      /^the sources give different whole-product masses/
    )
    const r = researchedTotal([total(1.1, 'TWK3A011', 'net'), total(1.4, 'TWK3A011', 'gross')])
    expect(r).toMatch(
      /without packaging and with it: 1\.1 kg .* pass the mass without packaging as total_mass_kg/
    )
  })

  // O-W4 of PL-137: one EPD read by four legs, its number, its edition and its dates written four ways.
  it('uses one figure written several ways', () => {
    const r = researchedTotal([
      total(61.6, 'FD30 Flush Solid Core Timber Door 2040x926x44 mm (EPD S-P-11102)', 'net'),
      total(61.6, 'EPD v2 (2025-06-23), S-P-11102', 'net'),
      total(61.6, 'EPD S-P-11102, 2023-12-15', 'net')
    ])
    expect(r).toMatchObject({ mass_kg: 61.6, basis: 'net', source: 'researched' })
  })
})

describe('heavierThanWhole', () => {
  const part = (component: string, mass_kg: number, version?: string): BomItem => ({
    component,
    material: 'steel',
    mass_kg,
    ...(version ? { version } : {})
  })
  const EAN459 = 'verzinkt, EAN 5400431601459 (Atlas 175)'
  // O-W3 of PL-137: 17 kg booked for the frame of a rack whose EAN weighs 14.1 kg whole.
  const totals = [total(14.1, EAN459), total(24, 'Atlas 175 HDF4'), total(13, 'EAN 5400431601480')]

  it('names a part heavier than a whole-product figure of its own version, that figure first', () => {
    expect(heavierThanWhole([part('Stahlrahmen', 17, EAN459)], totals)).toMatch(
      /^A part weighs more than a whole-product figure the research found that names no other version: "Stahlrahmen" \(17 kg\) against 14\.1 kg \(packaging not stated, verzinkt, EAN 5400431601459/
    )
  })

  it('holds no figure of another version against the part, nor the total the balance checks', () => {
    expect(
      heavierThanWhole([part('Stahlrahmen', 13.5, EAN459)], [total(13, 'EAN 5400431601480')])
    ).toBeUndefined()
    expect(
      heavierThanWhole([part('Stahlrahmen', 17, EAN459)], [total(14.1, EAN459)], {
        mass_kg: 14.1,
        basis: 'unknown',
        source: 'researched'
      })
    ).toBeUndefined()
    expect(heavierThanWhole([part('Stahlrahmen', 7, EAN459)], totals)).toBeUndefined()
  })
})
