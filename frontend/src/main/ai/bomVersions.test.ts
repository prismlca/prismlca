import { describe, expect, it } from 'vitest'
import type { BomItem, ProductMass } from './bomAnswer'
import { gtinsDiffer, versionFeatures, versionsContradict, versionsOf } from './bomVersions'

const features = (v: string): Record<string, string[]> =>
  Object.fromEntries([...versionFeatures(v)].map(([k, s]) => [k, [...s]]))

describe('versionFeatures', () => {
  it('reads each number under the property it states: what its unit measures, the code it is written to, or both', () => {
    expect(features('Atlas 175 HDF4')).toEqual({ 'code atlas': ['175'], 'code hdf': ['4'] })
    expect(features('Atlas-180')).toEqual({ 'code atlas': ['180'] })
    expect(features('Atlas HDF 4 mm')).toEqual({ length: ['4 mm'], 'code hdf': ['4~4 mm'] })
    expect(features('PRAKTICA 150 Liter Jumbomulde')).toEqual({
      volume: ['150000 ml'],
      'code praktica': ['150~150000 ml']
    })
    expect(features('Ersatzachse für 400 x 100 mm')).toEqual({ 'length×2': ['100x400 mm'] })
    expect(features('shelf 176×90x40 cm')).toEqual({
      'length×3': ['400x900x1760 mm'],
      'code shelf': ['176~1760 mm', '90~900 mm', '40~400 mm']
    })
    expect(features('panel 10/20/30 mm')).toEqual({
      'length×3': ['10x20x30 mm'],
      'code panel': ['10~10 mm', '20~20 mm', '30~30 mm']
    })
    expect(features('Bereifung 400/100')).toEqual({ 'code bereifung': ['400', '100'] })
    expect(features('Modelljahr 2024')).toEqual({ year: ['2024'] })
    // A month and year is a year — a recipe reformulated in May 2024 is not the one of May 2025.
    expect(features('reformulation May 2024')).toEqual({ year: ['2024'] })
  })

  // PL-137: shop, spare-part and register numbers, dates of a document or listing, a place in a list and masses
  // locked the balance of one wheelbarrow eleven times.
  it('leaves out what is no version: long article numbers, EANs, full dates, "N of M", masses', () => {
    expect(features('Hornbach-Artikel 5691696, Hersteller-Nr. 10121, EAN 4027972127043')).toEqual({})
    expect(features('EPD S-P-11102, 2023-12-15')).toEqual({})
    expect(features('Datenblatt vom 23.06.2025')).toEqual({})
    expect(features('Siepmann listing, variant 1 of 2')).toEqual({})
    expect(features('one variant listed at 22.50 kg, another at 23.50 kg')).toEqual({})
  })
})

describe('versionsContradict', () => {
  it('still tells versions apart by EAN, by code and by measure, however written', () => {
    expect(versionsContradict('Atlas HDF4', 'Atlas HDF 5 mm')).toBe(true)
    expect(versionsContradict('Atlas 175', 'Atlas-180')).toBe(true)
    expect(versionsContradict('shelf 176×90x40 cm', 'shelf 175x90x40 cm')).toBe(true)
    expect(versionsContradict('shelf 176 cm x 90 cm x 40 cm', 'shelf 176x90x50 cm')).toBe(true)
    expect(versionsContradict('reformulation May 2024', 'reformulation May 2025')).toBe(true)
    expect(versionsContradict('panel 10/20/30 mm', 'panel 11/20/30 mm')).toBe(true)
    expect(versionsContradict('thickness: 4 mm', 'thickness: 5 cm')).toBe(true)
    expect(versionsContradict('EAN 5400431601459', 'EAN 5400431601480')).toBe(true)
    expect(versionsContradict('Atlas HDF4', 'Atlas HDF5')).toBe(true)
    expect(versionsContradict('shelves 4 mm', 'shelves 5 mm')).toBe(true)
    expect(versionsContradict('Atlas 175', 'Atlas 180')).toBe(true)
    expect(versionsContradict('PRAKTICA 150 l', 'PRAKTICA 120 Liter')).toBe(true)
    expect(versionsContradict('Modelljahr 2024', 'Modelljahr 2025')).toBe(true)
  })

  it('reads a property only one side states, a measure in another unit, or a dropped number, as no contradiction', () => {
    expect(versionsContradict('HDF 4 mm', 'HDF 0.4 cm')).toBe(false)
    expect(versionsContradict('shelf 176 cm x 90 cm x 40 cm', 'shelf 176x90x40 cm')).toBe(false)
    expect(versionsContradict('shelf 1.76 m x 90 cm x 40 cm', 'shelf 176 × 90 × 40 cm')).toBe(false)
    expect(versionsContradict('board 3 m x 1 inch', 'board 3000 x 25.4 mm')).toBe(false)
    expect(versionsContradict('board 3 m x 1 inch', 'board 3000 x 25 mm')).toBe(true)
    expect(versionFeatures('HDF 4 mm / 5 mm').get('length')).toEqual(new Set(['4 mm', '5 mm']))
    expect(versionsContradict('Atlas HDF 4 mm', 'Atlas 176x90x40 cm')).toBe(false)
    expect(versionsContradict('PRAKTICA 150', 'PRAKTICA 150 l')).toBe(false)
    expect(versionsContradict('Hornbach AKN 36V3', 'Hornbach-Artikel 5691696 (Luftrad, 150 l)')).toBe(false)
    expect(versionsContradict('Mulde 150 l (Hersteller-Nr. 10121)', 'Ersatzachse 400 x 100 mm')).toBe(false)
    expect(versionsContradict('EPD v2 (2025-06-23), S-P-11102', 'EPD S-P-11102, 2023-12-15')).toBe(false)
    expect(
      versionsContradict('Atlas 175 (Galaxus listing)', 'Atlas 175 (Galaxus-Artikelnummer 64601145)')
    ).toBe(false)
  })
})

/**
 * Every pair of references versionsContradict() flagged in the PL-137 series (code before this change), as research
 * legs wrote them, with which side carried a whole-product mass. Two are different versions — the rack's two EANs
 * (14.1 against 13 kg) and the wheelbarrow with ball against plastic bearings (both 20.7 kg). Two more set a spare
 * grip's EAN, written on the grips' entry, against the wheelbarrow's: they still lock, since the leg was asked for the
 * whole product's version there, but the part's EAN is named as perhaps its own. Every other pair was set off by
 * shop, spare-part or register numbers, dates or "variant 1 of 2". [run, side A, side B, different versions]
 */
const PAIRS: Array<[string, [string, boolean], [string, boolean], boolean]> = [
  [
    'A-W1a',
    ['PRAKTICA 150 l, Luftrad with steel rim (Hornbach article 5691696)', true],
    ['PRAKTICA 150 L (Siepmann listing, variant 1 of 2)', true],
    false
  ],
  [
    'A-W1a',
    ['PRAKTICA 150 L (Siepmann listing, variant 1 of 2)', true],
    ['PRAKTICA 150 l, Luftrad with Stahlfelge (Hornbach article 5691696)', true],
    false
  ],
  [
    'A-W1a',
    ['PRAKTICA 150 L (Siepmann listing, variant 1 of 2)', true],
    ['PRAKTICA 150 l Luftrad mit Stahlfelge (Hornbach Artikel 5691696)', true],
    false
  ],
  [
    'A-W1b',
    ['Mulde 150 l, verzinkt (Ersatzmulde Capito Practica 150 L, Hersteller-Nr. 10121)', false],
    [
      'Ersatzachse für CAPITO-Schubkarren 400 x 100 mm; das Produkt selbst wird nicht als Achse gewogen',
      false
    ],
    false
  ],
  [
    'A-W1b',
    ['Mulde 150 l, verzinkt (Ersatzmulde Capito Practica 150 L, Hersteller-Nr. 10121)', false],
    ['CAPITO PRAKTICA 150 l Jumbomulde, Hornbach Art. 5691696', true],
    false
  ],
  [
    'A-W1b',
    ['Mulde 150 l, verzinkt (Ersatzmulde Capito Practica 150 L, Hersteller-Nr. 10121)', false],
    ['PRAKTICA 150 l, Luftrad mit Stahlfelge (Hornbach-Artikel 5691696)', true],
    false
  ],
  [
    'A-W1b',
    ['Mulde 150 l, verzinkt (Ersatzmulde Capito Practica 150 L, Hersteller-Nr. 10121)', false],
    ['Praktica 150 l, Hornbach article 5691696', true],
    false
  ],
  [
    'A-W1b',
    ['Mulde 150 l, verzinkt (Ersatzmulde Capito Practica 150 L, Hersteller-Nr. 10121)', false],
    ['PRAKTICA 150 L Jumbomulde (Variante mit Luftrad 400/100 auf Stahlfelge mit Kugellager)', true],
    false
  ],
  [
    'A-W1b',
    [
      'Ersatzachse für CAPITO-Schubkarren 400 x 100 mm; das Produkt selbst wird nicht als Achse gewogen',
      false
    ],
    ['CAPITO PRAKTICA 150 l Jumbomulde, Hornbach Art. 5691696', true],
    false
  ],
  [
    'A-W1b',
    [
      'Ersatzachse für CAPITO-Schubkarren 400 x 100 mm; das Produkt selbst wird nicht als Achse gewogen',
      false
    ],
    ['CAPITO Profi-Schubkarre PRAKTICA 150 L (Siepmann listing, first offer)', true],
    false
  ],
  [
    'A-W1b',
    [
      'Ersatzachse für CAPITO-Schubkarren 400 x 100 mm; das Produkt selbst wird nicht als Achse gewogen',
      false
    ],
    ['PRAKTICA 150 l, Luftrad mit Stahlfelge (Hornbach-Artikel 5691696)', true],
    false
  ],
  [
    'A-W1b',
    [
      'Ersatzachse für CAPITO-Schubkarren 400 x 100 mm; das Produkt selbst wird nicht als Achse gewogen',
      false
    ],
    ['PRAKTICA 150 L (older listing, possibly different blade thickness)', true],
    false
  ],
  [
    'A-W1b',
    [
      'Ersatzachse für CAPITO-Schubkarren 400 x 100 mm; das Produkt selbst wird nicht als Achse gewogen',
      false
    ],
    ['Praktica 150 l, Hornbach article 5691696', true],
    false
  ],
  [
    'A-W1b',
    [
      'Ersatzachse für CAPITO-Schubkarren 400 x 100 mm; das Produkt selbst wird nicht als Achse gewogen',
      false
    ],
    ['PRAKTICA 150 l, Luftrad mit Rillenprofil und Stahlfelge', true],
    false
  ],
  [
    'A-W1b',
    ['CAPITO PRAKTICA 150 l Jumbomulde, Hornbach Art. 5691696', true],
    ['PRAKTICA 150 L Jumbomulde (Variante mit Luftrad 400/100 auf Stahlfelge mit Kugellager)', true],
    false
  ],
  [
    'A-W1b',
    ['PRAKTICA 150 l, Luftrad mit Stahlfelge (Hornbach-Artikel 5691696)', true],
    ['PRAKTICA 150 L Jumbomulde (Variante mit Luftrad 400/100 auf Stahlfelge mit Kugellager)', true],
    false
  ],
  [
    'A-W1b',
    ['Praktica 150 l, Hornbach article 5691696', true],
    ['PRAKTICA 150 L Jumbomulde (Variante mit Luftrad 400/100 auf Stahlfelge mit Kugellager)', true],
    false
  ],
  [
    'A-W6',
    ['Bereifung 400/100 (3.50-8-Klasse), Standardausführung Luftrad', false],
    ['CAPITO PRAKTICA 150 L Jumbomulde, Hornbach Art. 5691696', true],
    false
  ],
  [
    'A-W6',
    ['Bereifung 400/100 (3.50-8-Klasse), Standardausführung Luftrad', false],
    ['CAPITO Profi Schubkarre PRAKTICA 150 Liter (EAN 4027972127043, Herst.-Nr. 12704)', true],
    false
  ],
  [
    'A-W6',
    ['Bereifung 400/100 (3.50-8-Klasse), Standardausführung Luftrad', false],
    ['Hornbach listing, Artikel 5691696', true],
    false
  ],
  [
    'A-W6',
    ['Bereifung 400/100 (3.50-8-Klasse), Standardausführung Luftrad', false],
    ['PRAKTICA 150 l, Hornbach-Artikel 5691696 (Luftrad)', true],
    false
  ],
  [
    'A-W6',
    ['Bereifung 400/100 (3.50-8-Klasse), Standardausführung Luftrad', false],
    ['PRAKTICA 150 l Luftrad mit Stahlfelge', true],
    false
  ],
  [
    'A-W6',
    ['CAPITO PRAKTICA 150 L Jumbomulde, Hornbach Art. 5691696', true],
    ['CAPITO Profi Schubkarre PRAKTICA 150 Liter (EAN 4027972127043, Herst.-Nr. 12704)', true],
    false
  ],
  [
    'A-W6',
    ['CAPITO Profi Schubkarre PRAKTICA 150 Liter (EAN 4027972127043, Herst.-Nr. 12704)', true],
    ['Hornbach listing, Artikel 5691696', true],
    false
  ],
  [
    'A-W6',
    ['CAPITO Profi Schubkarre PRAKTICA 150 Liter (EAN 4027972127043, Herst.-Nr. 12704)', true],
    ['PRAKTICA 150 l, Hornbach-Artikel 5691696 (Luftrad)', true],
    false
  ],
  [
    'A-W6',
    ['Hornbach listing, Artikel 5691696', true],
    ['PRAKTICA 150 l Luftrad mit Stahlfelge', true],
    false
  ],
  [
    'B-W1c',
    ['PRAKTICA 150 l, Luftrad mit Stahlfelge, Buchenholzgriffe (Hornbach listing)', true],
    ['Luftrad mit Rillenprofil und Stahlfelge, Art. 5691696', true],
    false
  ],
  [
    'B-W5',
    ['Jumbomulde 150, Hersteller-Nr. 10121', false],
    ['PRAKTICA 150 Luftrad, Stahlfelge (Hornbach-Artikel 5691696)', true],
    false
  ],
  [
    'B-W5',
    ['Jumbomulde 150, Hersteller-Nr. 10121', false],
    ['Luftrad-Version (Praktica 150 l, 400 mm Luftrad)', true],
    false
  ],
  [
    'B-W5',
    ['PRAKTICA 150 Luftrad, Stahlfelge (Hornbach-Artikel 5691696)', true],
    ['Luftrad-Version (Praktica 150 l, 400 mm Luftrad)', true],
    false
  ],
  ['F-W1a', ['Hornbach-Artikel 5691696 (Luftrad, 150 l)', true], ['Hornbach AKN 36V3', true], false],
  [
    'L-W1a',
    ['Capito Holzgriff Buchenholz 410801 (EAN 4027972108011), fitted to Praktica', false],
    ['PRAKTICA 150 Liter Jumbomulde, Luftrad (EAN 4027972127043)', true],
    false
  ],
  [
    'L-W1a',
    ['Capito Holzgriff Buchenholz 410801 (EAN 4027972108011), fitted to Praktica', false],
    ['Praktica 150 l, Luftrad mit Rillenprofil (Hornbach-Artikel 5691696)', true],
    false
  ],
  [
    'L-W1a',
    ['Capito Holzgriff Buchenholz 410801 (EAN 4027972108011), fitted to Praktica', false],
    ['Art. 5691696 (Hornbach, PRAKTICA 150 l)', true],
    false
  ],
  [
    'L-W1a',
    ['Capito Holzgriff Buchenholz 410801 (EAN 4027972108011), fitted to Praktica', false],
    ['PRAKTICA 150 l Luftrad mit Rillenprofil und Stahlfelge (Hornbach AKN 36V3)', true],
    false
  ],
  [
    'L-W1a',
    ['Capito Holzgriff Buchenholz 410801 (EAN 4027972108011), fitted to Praktica', false],
    ['CAPITO Profi-Schubkarre PRAKTICA 150 L (Variante, Stahl verzinkt)', true],
    false
  ],
  [
    'L-W1a',
    ['Praktica 150 l, Luftrad mit Rillenprofil (Hornbach-Artikel 5691696)', true],
    ['PRAKTICA 150 l Luftrad mit Rillenprofil und Stahlfelge (Hornbach AKN 36V3)', true],
    false
  ],
  [
    'L-W1a',
    ['Art. 5691696 (Hornbach, PRAKTICA 150 l)', true],
    ['PRAKTICA 150 l Luftrad mit Rillenprofil und Stahlfelge (Hornbach AKN 36V3)', true],
    false
  ],
  [
    'L-W5',
    ['Mulde 150 l (Ersatzteil-Nr. 10121), Modell PRAKTICA 150', false],
    [
      'Rad: Luftrad mit Kunststofflager oder Kugellager (gleiche Bereifung 4.00/4.80-8, 400x100 mm laut Datenblatt)',
      false
    ],
    false
  ],
  [
    'L-W5',
    ['Mulde 150 l (Ersatzteil-Nr. 10121), Modell PRAKTICA 150', false],
    ['PRAKTICA 150 Jumbomulde, Artikel 5691696', true],
    false
  ],
  [
    'L-W5',
    ['Mulde 150 l (Ersatzteil-Nr. 10121), Modell PRAKTICA 150', false],
    ['PRAKTICA 150 Liter Jumbomulde, Luftrad mit Stahlfelge (Hornbach Art. 5691696)', true],
    false
  ],
  [
    'L-W5',
    ['Mulde 150 l (Ersatzteil-Nr. 10121), Modell PRAKTICA 150', false],
    ['CAPITO Profi-Schubkarre PRAKTICA 150 L (one variant listed at 22.50 kg, another at 23.50 kg)', true],
    false
  ],
  [
    'L-W5',
    ['Mulde 150 l (Ersatzteil-Nr. 10121), Modell PRAKTICA 150', false],
    ['Hornbach Artikel 5691696, Jumbomulde 150 l, Luftrad', true],
    false
  ],
  [
    'L-W5',
    ['Mulde 150 l (Ersatzteil-Nr. 10121), Modell PRAKTICA 150', false],
    ['PRAKTICA 150 L, Luftrad mit Rillenprofil und Stahlfelge (Hornbach Artikel 5691696)', true],
    false
  ],
  [
    'L-W5',
    [
      'Rad: Luftrad mit Kunststofflager oder Kugellager (gleiche Bereifung 4.00/4.80-8, 400x100 mm laut Datenblatt)',
      false
    ],
    ['PRAKTICA 150 (Jumbomulde, Luftrad Kunststofflager/Kugellager)', true],
    false
  ],
  [
    'L-W5',
    [
      'Rad: Luftrad mit Kunststofflager oder Kugellager (gleiche Bereifung 4.00/4.80-8, 400x100 mm laut Datenblatt)',
      false
    ],
    ['PRAKTICA 150 Jumbomulde, Artikel 5691696', true],
    false
  ],
  [
    'L-W5',
    [
      'Rad: Luftrad mit Kunststofflager oder Kugellager (gleiche Bereifung 4.00/4.80-8, 400x100 mm laut Datenblatt)',
      false
    ],
    ['PRAKTICA 150 Liter Jumbomulde, Luftrad mit Stahlfelge (Hornbach Art. 5691696)', true],
    false
  ],
  [
    'L-W5',
    [
      'Rad: Luftrad mit Kunststofflager oder Kugellager (gleiche Bereifung 4.00/4.80-8, 400x100 mm laut Datenblatt)',
      false
    ],
    ['CAPITO Profi-Schubkarre PRAKTICA 150 L (one variant listed at 22.50 kg, another at 23.50 kg)', true],
    false
  ],
  [
    'L-W5',
    [
      'Rad: Luftrad mit Kunststofflager oder Kugellager (gleiche Bereifung 4.00/4.80-8, 400x100 mm laut Datenblatt)',
      false
    ],
    ['PRAKTICA 150, Jumbomulde 150 l (Stand Januar 2023)', true],
    false
  ],
  [
    'L-W5',
    [
      'Rad: Luftrad mit Kunststofflager oder Kugellager (gleiche Bereifung 4.00/4.80-8, 400x100 mm laut Datenblatt)',
      false
    ],
    ['Hornbach Artikel 5691696, Jumbomulde 150 l, Luftrad', true],
    false
  ],
  [
    'L-W5',
    [
      'Rad: Luftrad mit Kunststofflager oder Kugellager (gleiche Bereifung 4.00/4.80-8, 400x100 mm laut Datenblatt)',
      false
    ],
    ['PRAKTICA 150 L, Luftrad mit Rillenprofil und Stahlfelge (Hornbach Artikel 5691696)', true],
    false
  ],
  [
    'L-W5',
    ['PRAKTICA 150 Jumbomulde, Artikel 5691696', true],
    ['CAPITO Profi-Schubkarre PRAKTICA 150 L (one variant listed at 22.50 kg, another at 23.50 kg)', true],
    false
  ],
  [
    'L-W5',
    ['PRAKTICA 150 Liter Jumbomulde, Luftrad mit Stahlfelge (Hornbach Art. 5691696)', true],
    ['CAPITO Profi-Schubkarre PRAKTICA 150 L (one variant listed at 22.50 kg, another at 23.50 kg)', true],
    false
  ],
  [
    'L-W5',
    ['CAPITO Profi-Schubkarre PRAKTICA 150 L (one variant listed at 22.50 kg, another at 23.50 kg)', true],
    ['Hornbach Artikel 5691696, Jumbomulde 150 l, Luftrad', true],
    false
  ],
  [
    'L-W5',
    ['CAPITO Profi-Schubkarre PRAKTICA 150 L (one variant listed at 22.50 kg, another at 23.50 kg)', true],
    ['PRAKTICA 150 L, Luftrad mit Rillenprofil und Stahlfelge (Hornbach Artikel 5691696)', true],
    false
  ],
  [
    'M-W1a',
    ['Hornbach listing (20,7 kg, verzinkt) and retailer data for PRAKTICA 150 L', true],
    ['PRAKTICA 150 L, Hornbach listing (article 5691696)', true],
    false
  ],
  [
    'M-W1a',
    ['Hornbach listing (20,7 kg, verzinkt) and retailer data for PRAKTICA 150 L', true],
    ['150 l, Luftrad mit Rillenprofil auf Stahlfelge (Hornbach-Artikel 5691696)', true],
    false
  ],
  [
    'M-W1a',
    ['Hornbach listing (20,7 kg, verzinkt) and retailer data for PRAKTICA 150 L', true],
    ['150 l Variante 1 (Siepmann listing, Praktica 150 L)', true],
    false
  ],
  [
    'M-W1a',
    ['Hornbach listing (20,7 kg, verzinkt) and retailer data for PRAKTICA 150 L', true],
    ['PRAKTICA 150 l Luftrad, Hornbach article 5691696', true],
    false
  ],
  [
    'M-W1a',
    ['PRAKTICA 150 L, Hornbach listing (article 5691696)', true],
    ['150 l Variante 1 (Siepmann listing, Praktica 150 L)', true],
    false
  ],
  [
    'M-W1a',
    ['150 l, Luftrad mit Rillenprofil auf Stahlfelge (Hornbach-Artikel 5691696)', true],
    ['150 l Variante 1 (Siepmann listing, Praktica 150 L)', true],
    false
  ],
  [
    'M-W1a',
    ['150 l Variante 1 (Siepmann listing, Praktica 150 L)', true],
    ['PRAKTICA 150 l Luftrad, Hornbach article 5691696', true],
    false
  ],
  [
    'O-W1a',
    ['PRAKTICA 150, Jumbomulde (Herst.-Nr. Ersatzmulde 10121)', true],
    ['PRAKTICA 150 (Luftrad mit Kugellager, Art. #10509, EAN 4027972127043)', true],
    false
  ],
  [
    'O-W1a',
    ['PRAKTICA 150, Jumbomulde (Herst.-Nr. Ersatzmulde 10121)', true],
    ['PRAKTICA 150 Jumbomuldenkarre (Art. 12704)', true],
    false
  ],
  [
    'O-W1a',
    ['PRAKTICA 150 (Luftrad mit Kugellager, Art. #10509, EAN 4027972127043)', true],
    ['PRAKTICA 150 Jumbomuldenkarre (Art. 12704)', true],
    false
  ],
  [
    'O-W1b',
    ['PRAKTICA 150 Jumbomulde, Ersatzteil #10121', true],
    ['PRAKTICA 150, Luftrad Kugellager (Art. 10509, EAN 4027972127043)', true],
    false
  ],
  [
    'O-W1b',
    ['PRAKTICA 150 Jumbomulde, Ersatzteil #10121', true],
    ['PRAKTICA 150 (Art.-Nr. 410801, EAN 4027972108011)', false],
    false
  ],
  [
    'O-W1b',
    ['PRAKTICA 150, Luftrad Kugellager (Art. 10509, EAN 4027972127043)', true],
    ['PRAKTICA 150 (Art.-Nr. 410801, EAN 4027972108011)', false],
    false
  ],
  [
    'O-W1c',
    ['PRAKTICA 150 (EAN 4027972127043, Art.-Nr. 12704)', true],
    ['PRAKTICA 150 (Jumbomulde, EAN 4027972127197 montiert)', true],
    true
  ],
  [
    'O-W3',
    ['verzinkt, EAN 5400431601459 (Atlas 175)', true],
    ['verzinkt (5400431601480), gleiches Bodenmaß wie schwarz-matt 175 (5400431601435)', true],
    true
  ],
  [
    'O-W4',
    ['FD30 Flush Solid Core Timber Door 2040x926x44 mm (EPD S-P-11102)', true],
    ['EPD v2 (2025-06-23), S-P-11102', true],
    false
  ],
  [
    'O-W4',
    ['FD30 Flush Solid Core Timber Door 2040x926x44 mm (EPD S-P-11102)', true],
    ['EPD S-P-11102, 2023-12-15', true],
    false
  ],
  [
    'O-W4',
    ['Forza FD30 Flush Solid Core Timber Door 2040x926x44mm (EPD S-P-11102)', true],
    ['EPD v2 (2025-06-23), S-P-11102', true],
    false
  ],
  [
    'O-W4',
    ['Forza FD30 Flush Solid Core Timber Door 2040x926x44mm (EPD S-P-11102)', true],
    ['EPD S-P-11102, 2023-12-15', true],
    false
  ],
  ['O-W4', ['EPD v2 (2025-06-23), S-P-11102', true], ['EPD S-P-11102, 2023-12-15', true], false],
  [
    'O-W5',
    ['PRAKTICA 150 Jumbomulde (Art.-Nr. 10121; EAN 4027972127043 montiert)', true],
    ['PRAKTICA 150, Händlernrn. 12704 (LUKU montiert)', true],
    false
  ],
  [
    'Chat-C1',
    [
      'Spare tub Capito art. 10121 (150 L, galvanised, perforated); the figure is for that spare tub, used here as the proxy for the tub of PRAKTICA 150',
      false
    ],
    ['EAN 4027972127043, article 12704 (PRAKTICA 150 L Jumbomulde with air wheel)', true],
    false
  ],
  [
    'Chat-C1',
    [
      'Spare tub Capito art. 10121 (150 L, galvanised, perforated); the figure is for that spare tub, used here as the proxy for the tub of PRAKTICA 150',
      false
    ],
    ['Capito PRAKTICA 150 L, art. 12704', true],
    false
  ],
  [
    'Chat-C2',
    ['Avasco Steckregal Atlas 175, 176x90x40 cm (Galaxus listing; silver/galvanised, 5 shelves)', true],
    ['Avasco Steckregal Atlas 175 (Galaxus-Artikelnummer 64601145)', true],
    false
  ]
]

describe('versionsOf — the reference pairs of the PL-137 series', () => {
  const item = (version: string): BomItem => ({ component: 'part', material: 'steel', mass_kg: 1, version })
  const whole = (version: string): ProductMass => ({ mass_kg: 20.7, basis: 'unknown', version })
  it.each(PAIRS)('%s: «%s» against «%s»', (_run, a, b, different) => {
    const sides = [a, b]
    const v = versionsOf(
      sides.filter(([, w]) => !w).map(([r]) => item(r)),
      sides.filter(([, w]) => w).map(([r]) => whole(r)),
      []
    )
    const partEan = gtinsDiffer(a[0], b[0]) && (!a[1] || !b[1])
    expect(v?.conflict ?? false).toBe(different || partEan)
    expect(v?.unattested?.map((u) => u.version)).toEqual(
      partEan ? sides.filter(([, w]) => !w).map(([r]) => r) : undefined
    )
  })
})

describe('versionsOf — an EAN only a part names', () => {
  const grips: BomItem = {
    component: 'Buchenholzgriffe (2 Stück)',
    material: 'beech',
    mass_kg: 0.46,
    version: 'Capito Holzgriff Buchenholz 410801 (EAN 4027972108011), fitted to Praktica'
  }
  const total: ProductMass = { mass_kg: 20.7, basis: 'unknown', version: 'PRAKTICA 150 (EAN 4027972127043)' }

  // L-W1a: a spare grip's EAN beside the wheelbarrow's. The leg was asked for the whole product's version, so it is a
  // conflict; the lock names the EAN as one only a part names, perhaps the part's own article number.
  it('locks, and names the EAN only a part names', () => {
    const v = versionsOf([grips], [total], [])
    expect(v?.conflict).toBe(true)
    expect(v?.unattested).toEqual([{ version: grips.version, entries: ['Buchenholzgriffe (2 Stück)'] }])
  })

  it('names nothing apart once a source ties it to the whole product', () => {
    const seen = [{ version: 'EAN 4027972108011', differs_by: 'other grips' }]
    expect(versionsOf([grips], [total], seen)).toMatchObject({ conflict: true })
    expect(versionsOf([grips], [total], seen)?.unattested).toBeUndefined()
    const weighed = { ...total, mass_kg: 20.9, version: 'EAN 4027972108011' }
    expect(versionsOf([grips], [total, weighed], [])?.unattested).toBeUndefined()
  })
})
