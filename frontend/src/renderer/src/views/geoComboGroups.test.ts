import { describe, expect, it } from 'vitest'
import { groupGeoItems } from './geoComboGroups'

const items = (...geos: string[]): { value: string; geo: string }[] =>
  geos.map((geo) => ({ value: geo, geo }))
const names = { RER: 'Europe', GLO: 'Global', RoW: 'Rest of the world', 'US-NPCC': 'NPCC, US only' }

describe('groupGeoItems', () => {
  it('lists regions above countries, each alphabetical by label', () => {
    const { aggs, countries } = groupGeoItems(items('DE', 'RoW', 'CH', 'RER', 'GLO', 'US-NPCC'), names)
    expect(aggs.map((it) => it.geo)).toEqual(['RER', 'GLO', 'US-NPCC', 'RoW'])
    expect(countries.map((it) => it.geo)).toEqual(['DE', 'CH'])
  })

  it('puts the pinned codes first, in the order given, and leaves the rest as it was', () => {
    const { aggs, countries } = groupGeoItems(items('DE', 'RoW', 'CH', 'RER', 'GLO', 'US-NPCC'), names, [
      'GLO',
      'RoW'
    ])
    expect(aggs.map((it) => it.geo)).toEqual(['GLO', 'RoW', 'RER', 'US-NPCC'])
    expect(countries.map((it) => it.geo)).toEqual(['DE', 'CH'])
  })

  it('pins only what is there', () => {
    const { aggs } = groupGeoItems(items('RER', 'RoW', 'US-NPCC'), names, ['GLO', 'RoW'])
    expect(aggs.map((it) => it.geo)).toEqual(['RoW', 'RER', 'US-NPCC'])
  })
})
