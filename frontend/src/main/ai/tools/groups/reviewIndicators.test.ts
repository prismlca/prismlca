import { describe, expect, it } from 'vitest'

import { indicatorsSection, pickedMethods } from './reviewIndicators'

const GWP = ['IPCC 2021', 'climate change', 'GWP100']
const ACID = ['EF v3.1', 'acidification', 'AE']
const scored = (...ms: string[][]): Map<string, string> =>
  new Map(ms.map((m) => [JSON.stringify(m), m.join(' | ')]))

describe('the indicators section of the review dossier', () => {
  it('names every scored indicator and marks the one the hotspots cover', () => {
    const s = indicatorsSection(scored(GWP), [ACID, GWP], GWP)
    expect(s).toContain('INDICATORS SCORED FOR THIS MODEL')
    expect(s).toContain('- IPCC 2021 | climate change | GWP100  ← the hotspot analysis above')
    expect(s).toMatch(/^- EF v3\.1 \| acidification \| AE$/m)
    expect(s.match(/IPCC 2021/g)).toHaveLength(1) // picked and scored are one indicator
  })

  it('says so when the hotspot method is the only indicator anybody scored', () => {
    expect(indicatorsSection(new Map(), [], GWP)).toBe(
      'INDICATORS: IPCC 2021 | climate change | GWP100 is the only indicator scored for this model in this ' +
        'chat or picked on its Results page.'
    )
  })

  it('without a hotspot analysis says none is broken down, and is empty when nothing is known', () => {
    expect(indicatorsSection(scored(GWP, ACID), [], null)).toContain('This review has no hotspot analysis')
    expect(indicatorsSection(new Map(), [], null)).toBe('')
  })

  it('cuts a long hand-picked list', () => {
    const many = Array.from({ length: 45 }, (_, i) => ['M', `indicator ${i}`])
    const s = indicatorsSection(new Map(), many, null)
    expect(s).toContain('indicator 39')
    expect(s).not.toContain('indicator 40')
    expect(s).toContain('… and 5 more')
  })

  it('reads the picked methods from a stored view, whatever else is in it', () => {
    const view = {
      view: { results: { picked: [{ key: 'k', method: ACID, label: 'a' }, { key: 'x' }, null] } }
    }
    expect(pickedMethods(view)).toEqual([ACID])
    expect(pickedMethods({ view: {} })).toEqual([])
    expect(pickedMethods(null)).toEqual([])
  })
})
