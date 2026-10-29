import { describe, expect, it } from 'vitest'
import { methodFamilyInfo } from './methodInfo'

const nameOf = (family: string): string | undefined => methodFamilyInfo(family)?.name

describe('methodFamilyInfo', () => {
  // The default set Brightway itself installs (bw2io `create_default_lcia_methods`), so the blurbs
  // work in a workspace that never imported an ecoinvent LCIA file.
  it.each([
    ['CML v4.8 2016 no LT', 'CML-IA (Leiden)'],
    ['Crustal Scarcity Indicator 2020', 'Crustal Scarcity Indicator'],
    ['Cumulative Energy Demand (CED)', 'Cumulative Energy Demand (CED)'],
    ['Cumulative Exergy Demand (CExD)', 'Cumulative Exergy Demand (CExD)'],
    ['EDIP 2003 no LT', 'EDIP 2003'],
    ['EF v3.1', 'Environmental Footprint (EF)'],
    ['EF v3.1 EN15804', 'EN 15804 +A2'],
    ['EN15804', 'EN 15804 +A2'],
    ['EPS 2020d', 'Environmental Priority Strategies (EPS)'],
    ['Ecological Footprint', 'Ecological Footprint'],
    ['Ecological Scarcity 2021', 'Ecological Scarcity (UBP)'],
    ['Ecosystem Damage Potential', 'Ecosystem Damage Potential'],
    ['IMPACT 2002+ (Midpoint)', 'IMPACT 2002+'],
    ['IPCC 2021 no LT', 'IPCC (climate change)'],
    ['ReCiPe 2016 v1.03, midpoint (H)', 'ReCiPe 2016'],
    ['TRACI v2.1', 'TRACI (US EPA)'],
    ['USEtox no LT', 'USEtox'],
    ['selected LCI results, additional', 'Inventory results & indicators']
  ])('Brightway default set: %s', (family, name) => {
    expect(nameOf(family)).toBe(name)
  })

  // Other spellings of the same methods, as other importers and newer releases write them.
  it.each([
    ['EN15804+A2 - Core impact categories and indicators', 'EN 15804 +A2'],
    ['EF 3.1', 'Environmental Footprint (EF)'],
    ['Environmental Footprint 3.1', 'Environmental Footprint (EF)'],
    ['IMPACT World+ v2.1, footprint version', 'IMPACT World+'],
    ['IPCC 2021 (incl. biogenic CO2)', 'IPCC (climate change)'],
    ['USEtox v2.13, midpoint', 'USEtox'],
    ['Inventory results and indicators', 'Inventory results & indicators']
  ])('other spellings: %s', (family, name) => {
    expect(nameOf(family)).toBe(name)
  })

  // Substring matching found acronyms inside ordinary words: "CED" in "reduced", "EPS " in "steps ".
  it.each(['reduced set', 'my steps 2024', 'chief v2', 'family 2', 'hjhj'])(
    'no entry for an unrelated name: %s',
    (family) => {
      expect(methodFamilyInfo(family)).toBeNull()
    }
  )

  it('returns the info without the matching pattern', () => {
    expect(methodFamilyInfo('TRACI v2.1')).not.toHaveProperty('pattern')
  })
})
