import { describe, expect, it } from 'vitest'
import { offeredSkills, providersOf, renderSkill } from './skillRender'

const SKILL = [
  '# Waste',
  'Check the sign.',
  '<!-- if ecoinvent -->',
  'ecoinvent: treatment is negative.',
  '<!-- endif -->',
  '<!-- if bafu -->',
  'BAFU: disposal is positive.',
  '<!-- endif -->',
  '<!-- if ecoinvent bafu -->',
  'Either way, write the reason down.',
  '<!-- endif -->',
  'Done.'
].join('\n')

describe('skill rendering per released background database', () => {
  it('maps database names to providers', () => {
    expect([...providersOf(['ecoinvent-3.12-cutoff', 'bafu-2026-v1', 'My processes'])]).toEqual([
      'ecoinvent',
      'bafu'
    ])
    expect(providersOf(undefined).size).toBe(0)
  })

  it('keeps only the blocks of the released providers', () => {
    const eco = renderSkill(SKILL, new Set(['ecoinvent']))
    expect(eco).toContain('treatment is negative')
    expect(eco).not.toContain('disposal is positive')
    expect(eco).toContain('Either way')
    expect(eco).not.toContain('<!--')
    const bafu = renderSkill(SKILL, new Set(['bafu']))
    expect(bafu).toContain('disposal is positive')
    expect(bafu).not.toContain('treatment is negative')
    expect(bafu).toContain('Either way')
  })

  it('keeps everything when nothing is released or the caller does not say', () => {
    const all = renderSkill(SKILL, new Set())
    expect(all).toContain('treatment is negative')
    expect(all).toContain('disposal is positive')
    expect(all).not.toContain('<!--')
    expect(all.split('\n')[0]).toBe('# Waste')
  })

  it('keeps both blocks when both providers are released', () => {
    const both = renderSkill(SKILL, new Set(['ecoinvent', 'bafu']))
    expect(both).toContain('treatment is negative')
    expect(both).toContain('disposal is positive')
  })
})

describe('skill rendering per external-data switch', () => {
  const GAPS = [
    'Ask the user first.',
    '<!-- if eurostat -->',
    'Call eurostat_eol.',
    '<!-- endif -->',
    '<!-- if web -->',
    'Search the web.',
    '<!-- endif -->',
    'Otherwise estimate.'
  ].join('\n')

  it('drops a switch block only when its switch is off, each on its own', () => {
    const noWeb = renderSkill(GAPS, new Set(['ecoinvent']), { web: false, eurostat: true })
    expect(noWeb).toContain('Call eurostat_eol.')
    expect(noWeb).not.toContain('Search the web.')
    const noEurostat = renderSkill(GAPS, new Set(['ecoinvent']), { web: true, eurostat: false })
    expect(noEurostat).not.toContain('Call eurostat_eol.')
    expect(noEurostat).toContain('Search the web.')
    expect(noEurostat).toContain('Otherwise estimate.')
  })

  it('drops a distances block only when the distance tool is off', () => {
    const SEA = ['Corridor table.', '<!-- if distances -->', 'Call distances.', '<!-- endif -->'].join('\n')
    expect(renderSkill(SEA, new Set(), { distances: false })).not.toContain('Call distances.')
    expect(renderSkill(SEA, new Set(), { distances: true })).toContain('Call distances.')
    expect(renderSkill(SEA, new Set(), {})).toContain('Call distances.')
  })

  it('keeps switch blocks when the caller does not say, even with providers released', () => {
    const unknown = renderSkill(GAPS, new Set(['bafu']))
    expect(unknown).toContain('Call eurostat_eol.')
    expect(unknown).toContain('Search the web.')
    expect(unknown).not.toContain('<!--')
  })
})

describe('skills offered per switch', () => {
  const SKILLS = [
    { id: 'builtin-model-building', name: 'LCA model building' },
    { id: 'builtin-bom', name: 'Bill of materials from a product description' },
    { name: 'A skill without an id' }
  ]

  it('drops the bill-of-materials skill only when the web is said to be off', () => {
    expect(offeredSkills(SKILLS, { web: false }).map((s) => s.name)).toEqual([
      'LCA model building',
      'A skill without an id'
    ])
    expect(offeredSkills(SKILLS, { web: true })).toHaveLength(3)
    expect(offeredSkills(SKILLS, {})).toHaveLength(3)
  })
})
