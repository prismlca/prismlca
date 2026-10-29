import { describe, expect, it } from 'vitest'
import { bestSearchDb, groupKey, searchableDbs, variantFor, type SearchHit } from './search'
import type { DatabaseInfo } from './api'

const db = (name: string, over: Partial<DatabaseInfo> = {}): DatabaseInfo =>
  ({ name, kind: 'foreground', read_only: false, node_count: 0, ...over }) as DatabaseInfo

describe('searchableDbs', () => {
  it('excludes the biosphere (elementary flows, not processes)', () => {
    const dbs = [
      db('model'),
      db('biosphere3', { kind: 'biosphere' }),
      db('ecoinvent', { kind: 'background' })
    ]
    expect(searchableDbs(dbs).map((d) => d.name)).toEqual(['model', 'ecoinvent'])
  })
})

describe('bestSearchDb', () => {
  it('prefers the largest read-only background inventory', () => {
    const dbs = [
      db('model'),
      db('small-bg', { kind: 'background', read_only: true, node_count: 100 }),
      db('ecoinvent', { kind: 'background', read_only: true, node_count: 26000 }),
      db('biosphere3', { kind: 'biosphere', read_only: true, node_count: 99999 })
    ]
    expect(bestSearchDb(dbs)).toBe('ecoinvent')
  })

  it('falls back to the first searchable DB when nothing is read-only', () => {
    expect(bestSearchDb([db('model-a'), db('model-b')])).toBe('model-a')
  })

  it('returns empty for no databases', () => {
    expect(bestSearchDb([])).toBe('')
  })
})

describe('variantFor', () => {
  const hit = (variants?: SearchHit['variants']): SearchHit => ({
    code: 'c0',
    name: 'electricity',
    database: 'ecoinvent',
    geography: 'DE',
    activity_type: 'M',
    variants
  })

  it('resolves a result without variants to the hit itself', () => {
    expect(variantFor(hit(), {})).toEqual({ code: 'c0', geography: 'DE', database: 'ecoinvent' })
  })

  it('resolves a single-variant result directly', () => {
    const v = { code: 'c1', geography: 'FR', database: 'ecoinvent' }
    expect(variantFor(hit([v]), {})).toEqual(v)
  })

  it('is undefined for a multi-region result until the user picks a region', () => {
    const vs = [
      { code: 'c1', geography: 'DE', database: 'ecoinvent' },
      { code: 'c2', geography: 'FR', database: 'ecoinvent' }
    ]
    const h = hit(vs)
    expect(variantFor(h, {})).toBeUndefined()
    expect(variantFor(h, { [groupKey(h)]: 'c2' })).toEqual(vs[1])
  })
})

describe('clipName', () => {
  it('leaves ordinary names alone and cuts a very long one after 100 characters with an ellipsis', async () => {
    const { clipName, NAME_CLIP } = await import('./search')
    expect(clipName('market for electricity, low voltage')).toBe('market for electricity, low voltage')
    const long = 'x'.repeat(99) + ' ' + 'y'.repeat(80)
    const cut = clipName(long)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut.length).toBeLessThanOrEqual(NAME_CLIP + 1)
    expect(cut.startsWith('x'.repeat(99))).toBe(true)
    // Exactly 100 is not cut — the cut starts beyond it.
    expect(clipName('z'.repeat(100))).toBe('z'.repeat(100))
  })
})
