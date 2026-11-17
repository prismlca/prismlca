import { describe, expect, it } from 'vitest'
import { regionsInText } from './regionsInText'

// Invented study texts in the shape the test runs wrote them: free prose, often German.
const HELD = ['BE', 'CH', 'DE', 'FR', 'GN', 'PG', 'JE', 'RER', 'GLO', 'RoW', 'Europe without Switzerland']

describe('regionsInText', () => {
  it('reads the countries a German study text names, in the order it names them', () => {
    expect(
      regionsInText('Hergestellt in Diksmuide (Belgien), verkauft, genutzt und entsorgt in Deutschland', HELD)
    ).toEqual(['BE', 'DE'])
    expect(
      regionsInText('Verkauf, Nutzung und Entsorgung in Deutschland. Herstellung in Europa angenommen', HELD)
    ).toEqual(['DE'])
  })

  it('reads English names, codes written as codes and the workspace names of aggregates', () => {
    expect(regionsInText('made in France, sold in Germany', HELD)).toEqual(['FR', 'DE'])
    expect(regionsInText('market for electricity medium voltage DE', HELD)).toEqual(['DE'])
    expect(regionsInText('sold across Europe', HELD, { RER: 'Europe' })).toEqual(['RER'])
  })

  it('finds only the regions the databases hold', () => {
    // ICU names the European Union, but no dataset is located there.
    expect(regionsInText('sold in the European Union', HELD)).toEqual([])
    expect(regionsInText('made in Poland', HELD)).toEqual([])
  })

  it('lets the longer name win where two overlap', () => {
    expect(regionsInText('grown in Papua New Guinea', HELD)).toEqual(['PG'])
    // A longer name the databases do not hold still is that place, not the shorter one inside it.
    expect(regionsInText('grown in Papua New Guinea', ['GN'])).toEqual([])
    expect(regionsInText('made in Equatorial Guinea and Germany', ['GN', 'DE'])).toEqual(['DE'])
    expect(regionsInText('Europe without Switzerland', HELD, { RER: 'Europe' })).toEqual([
      'Europe without Switzerland'
    ])
  })

  it('matches whole words in the case they are written', () => {
    expect(regionsInText('market for de-icer', HELD)).toEqual([])
    expect(regionsInText('jersey fabric, knitted', HELD)).toEqual([])
    expect(regionsInText('Deutschlandticket', HELD)).toEqual([])
    expect(regionsInText('', HELD)).toEqual([])
  })
})
