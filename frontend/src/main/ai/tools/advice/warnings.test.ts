import { describe, expect, it } from 'vitest'
import { OUTSIDE_REGION_LEAD, withSearchWarnings } from './warnings'

// Invented datasets only. The scores mirror the measured cases: a region list of poor neighbours, a region
// list of plausible ones, and a region list that already holds the material.
const hit = (name: string, geography: string, score: number): Record<string, unknown> => ({
  name,
  geography,
  score,
  weak: score < 0.429
})
const outside = (name: string, geography: string, score: number): Record<string, unknown> => ({
  name,
  geography,
  code: name.replace(/\W+/g, '_'),
  database: 'bg',
  product: name,
  unit: 'kilogram',
  score
})
const PROXY =
  "No result's name or reference product contains: 'sulfonate'. Either this database names the material " +
  'differently (…), or it lies outside RER — see outside_region — or it has no dataset for it and you need ' +
  'a documented proxy.'

describe('withSearchWarnings with a region (V462)', () => {
  it('weak regional neighbours, the material clearly better outside: one line naming both scores', () => {
    const out = withSearchWarnings(
      {
        weak_match: true,
        proxy_warning: PROXY,
        hits: [hit('market for leachate, inert', 'RER', 0.4169), hit('market for widget oil', 'RER', 0.4)],
        outside_region: [
          outside('market for gizmo sulfonate, linear', 'GLO', 0.617),
          outside('market for gizmo, linear', 'GLO', 0.549)
        ]
      },
      ['RER']
    )
    expect(out.warnings).toEqual([
      'Nothing in the RER list truly resembles the query — treat every hit as a non-match, not as a weak ' +
        'candidate.',
      'Outside RER: market for gizmo sulfonate, linear [GLO] scores 0.62 (best RER hit 0.42). Use it only if ' +
        'no RER hit is the material itself; then note the region proxy in the exchange comment.'
    ])
    // It takes the proxy warning's place in the list; the field itself stays.
    expect(out.proxy_warning).toBe(PROXY)
  })

  it('plausible regional neighbours a little below: the line fires where no warning did before', () => {
    const out = withSearchWarnings(
      {
        weak_match: false,
        hits: [
          hit('market for widget sulfate', 'RER', 0.5335),
          hit('market for widget sulfite', 'RER', 0.51)
        ],
        outside_region: [
          outside('alkyl widget production', 'GLO', 0.5791),
          outside('market for alkyl widget', 'GLO', 0.5561)
        ]
      },
      ['RER']
    )
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]).toMatch(
      /^Outside RER: alkyl widget production \[GLO\] scores 0\.58 \(best RER hit 0\.53\)/
    )
  })

  it('an outside hit speaks up only when it leads the best region hit by the margin', () => {
    const at = (score: number): string[] | undefined =>
      withSearchWarnings(
        {
          hits: [hit('market for widget ether paste', 'RER', 0.45)],
          outside_region: [outside('o', 'GLO', score)]
        },
        ['RER']
      ).warnings
    expect(OUTSIDE_REGION_LEAD).toBe(0.005)
    expect(at(0.455)).toHaveLength(1) // exactly the lead
    expect(at(0.5)).toHaveLength(1)
    expect(at(0.45)).toBeUndefined() // a tie is a neighbour, not a better dataset
    expect(at(0.4549)).toBeUndefined()
  })

  it('the region hit is the material and clearly ahead: no line, the proxy warning stays', () => {
    const out = withSearchWarnings(
      {
        proxy_warning: PROXY,
        hits: [hit('market for kraft widget', 'RER', 0.7054)],
        outside_region: [
          outside('disposal, kraft widget', 'CH', 0.5658),
          outside('market for printed widget', 'GLO', 0.51)
        ]
      },
      ['RER']
    )
    expect(out.warnings).toEqual([PROXY])
  })

  it('the best of the two outside rows decides, not the first', () => {
    const out = withSearchWarnings(
      {
        hits: [hit('r', 'RER', 0.6)],
        outside_region: [outside('ranked first', 'GLO', 0.5), outside('scores higher', 'CH', 0.65)]
      },
      ['RER']
    )
    expect(out.warnings[0]).toMatch(/^Outside RER: scores higher \[CH\] scores 0\.65/)
  })

  it('a hard filter compares against the whole list and names every region', () => {
    const regions = ['RER', 'GLO', 'Europe without Switzerland']
    const out = withSearchWarnings(
      {
        hits: [hit('treatment of waste gadget, recycling', 'RER', 0.6884), hit('unsanitary', 'GLO', 0.66)],
        outside_region: [outside('treatment of waste gadget, sanitary landfill', 'RoW', 0.696)]
      },
      regions
    )
    expect(out.warnings[0]).toBe(
      'Outside RER/GLO/Europe without Switzerland: treatment of waste gadget, sanitary landfill [RoW] scores ' +
        '0.70 (best RER/GLO/Europe without Switzerland hit 0.69). Use it only if no RER/GLO/Europe without ' +
        'Switzerland hit is the material itself; then note the region proxy in the exchange comment.'
    )
  })

  it('says so when the list has nothing in the region at all', () => {
    const proxies = withSearchWarnings(
      {
        hits: [hit('market for widget', 'RER', 0.45)],
        outside_region: [outside('widget, at plant', 'CH', 0.62)]
      },
      ['DE']
    )
    expect(proxies.warnings[0]).toContain('(best hit shown 0.45, none in DE)')
    const empty = withSearchWarnings({ hits: [], outside_region: [outside('widget', 'CH', 0.62)] }, ['DE'])
    expect(empty.warnings[0]).toContain('(no hit in DE)')
  })

  it('without a region every text stays as it was', () => {
    const answer = {
      weak_match: true,
      proxy_warning: PROXY,
      hits: [hit('x', 'GLO', 0.3)],
      outside_region: [outside('y', 'CH', 0.9)]
    }
    for (const geo of [undefined, [], 'RER']) {
      const out = withSearchWarnings({ ...answer }, geo)
      expect(out.warnings).toEqual([
        'Nothing in this list truly resembles the query — treat every hit as a non-match, not as a weak ' +
          'candidate.',
        PROXY
      ])
    }
  })
})
