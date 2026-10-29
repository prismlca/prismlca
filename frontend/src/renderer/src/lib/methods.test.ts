import { describe, expect, it } from 'vitest'
import { familyToOpen, groupMethodsByFamily, indicatorLabel, indicatorLabels } from './methods'

const m = (...method: string[]): { method: string[] } => ({ method })

describe('groupMethodsByFamily', () => {
  it('groups by method[0], preserving backend order for families and members', () => {
    const map = groupMethodsByFamily([
      m('EF v3.1', 'climate change'),
      m('ReCiPe 2016', 'GWP100'),
      m('EF v3.1', 'ozone depletion')
    ])
    expect([...map.keys()]).toEqual(['EF v3.1', 'ReCiPe 2016'])
    expect(map.get('EF v3.1')!.map((x) => x.method[1])).toEqual(['climate change', 'ozone depletion'])
  })

  it('returns an empty map for no methods', () => {
    expect(groupMethodsByFamily([]).size).toBe(0)
  })
})

/** The catalogue as ecoinvent ships it, in the two shapes that matter (V203). */
const CATALOGUE = [
  m('EF v3.1', 'climate change', 'global warming potential (GWP100)'),
  m('EF v3.1', 'water use', 'user deprivation potential (deprivation-weighted water consumption)'),
  m('ReCiPe 2016 v1.03, endpoint (H)', 'ecosystem quality', 'climate change: freshwater ecosystems'),
  m('ReCiPe 2016 v1.03, endpoint (H)', 'ecosystem quality', 'climate change: terrestrial ecosystems'),
  m('ReCiPe 2016 v1.03, endpoint (H)', 'human health', 'climate change: human health'),
  m('ReCiPe 2016 v1.03, endpoint (H)', 'human health', 'water use: human health'),
  m('IPCC 2013', 'climate change GWP 100a')
]

describe('indicatorLabels', () => {
  it('keeps the category where the family gives it to one indicator', () => {
    const labels = indicatorLabels(CATALOGUE)
    expect(indicatorLabel(['EF v3.1', 'climate change', 'global warming potential (GWP100)'], labels)).toBe(
      'climate change'
    )
  })

  it('spells out what the category alone cannot tell apart', () => {
    const labels = indicatorLabels(CATALOGUE)
    const named = CATALOGUE.filter((x) => x.method[0].startsWith('ReCiPe')).map((x) =>
      indicatorLabel(x.method, labels)
    )
    expect(named).toEqual([
      'ecosystem quality / climate change: freshwater ecosystems',
      'ecosystem quality / climate change: terrestrial ecosystems',
      'human health / climate change: human health',
      'human health / water use: human health'
    ])
    expect(new Set(named).size).toBe(named.length)
  })

  it('judges a family against itself, so one indicator of its own stays short', () => {
    const labels = indicatorLabels([
      m('Own family', 'ecosystem quality', 'climate change: freshwater ecosystems'),
      ...CATALOGUE.filter((x) => x.method[0] === 'EF v3.1')
    ])
    expect(
      indicatorLabel(['Own family', 'ecosystem quality', 'climate change: freshwater ecosystems'], labels)
    ).toBe('ecosystem quality')
  })

  it('answers about the family it is given, which is why callers pass the catalogue', () => {
    // Handed one row instead of the catalogue, the same indicator looks unambiguous — the mistake the
    // callers must not make, and the reason `methods` is never the filtered or the ticked subset.
    const one = CATALOGUE[2]
    expect(indicatorLabel(one.method, indicatorLabels([one]))).toBe('ecosystem quality')
    expect(indicatorLabel(one.method, indicatorLabels(CATALOGUE))).toBe(
      'ecosystem quality / climate change: freshwater ecosystems'
    )
  })

  it('leaves a two-part method its own last segment, with no trailing separator', () => {
    const labels = indicatorLabels(CATALOGUE)
    const short = indicatorLabel(['IPCC 2013', 'climate change GWP 100a'], labels)
    expect(short).toBe('climate change GWP 100a')
    expect(short.endsWith('/')).toBe(false)
    expect(short.trim()).not.toBe('')
  })

  it('names a method the catalogue does not have from the method itself', () => {
    expect(indicatorLabel(['Gone', 'acidification', 'AP'], indicatorLabels(CATALOGUE))).toBe('acidification')
    expect(indicatorLabel(['Only a family'], new Map())).toBe('Only a family')
  })

  it('counts a duplicated entry once', () => {
    const twice = indicatorLabels([CATALOGUE[0], CATALOGUE[0]])
    expect([...twice.values()]).toEqual(['climate change'])
  })
})

describe('familyToOpen', () => {
  const names = ['CML v4.8', 'EF v3.1', 'ReCiPe 2016']

  it('opens on the family of the first picked indicator when the shown one holds none', () => {
    expect(familyToOpen('CML v4.8', ['EF v3.1', 'ReCiPe 2016'], names)).toBe('EF v3.1')
  })

  it('keeps the shown family when it holds a picked indicator, or when nothing is picked', () => {
    expect(familyToOpen('ReCiPe 2016', ['EF v3.1', 'ReCiPe 2016'], names)).toBe('ReCiPe 2016')
    expect(familyToOpen('CML v4.8', [], names)).toBe('CML v4.8')
  })

  it('ignores a picked family this workspace does not have', () => {
    expect(familyToOpen('CML v4.8', ['Gone 1.0'], names)).toBe('CML v4.8')
    expect(familyToOpen('CML v4.8', ['Gone 1.0', 'EF v3.1'], names)).toBe('EF v3.1')
  })
})
