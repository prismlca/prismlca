import { describe, expect, it } from 'vitest'
import { familiesInUse, resolveSplit } from './splitBy'
import type { TagGroup } from '../../lib/server/routes'

const g = (name: string, databases: string[]): TagGroup => ({ name, color: '#000', values: [], databases })
const GROUPS = [g('Supplier', ['Other']), g('Phase', ['Bottle', 'Other']), g('Component', ['Bottle'])]

describe('familiesInUse', () => {
  it('keeps the families some of the databases carry, in project order', () => {
    expect(familiesInUse(GROUPS, new Set(['Bottle'])).map((x) => x.name)).toEqual(['Phase', 'Component'])
    expect(familiesInUse(GROUPS, new Set(['Nothing']))).toEqual([])
  })
})

describe('resolveSplit', () => {
  it('preselects a tag family the model carries', () => {
    expect(resolveSplit('', GROUPS, 'Bottle')).toBe('tag:Phase')
  })

  it('falls back to ISIC when the model carries no tags, even if another model does', () => {
    expect(resolveSplit('', GROUPS, 'Untagged')).toBe('isic')
    expect(resolveSplit(undefined, GROUPS, null)).toBe('isic')
  })

  it('keeps a choice once made, ISIC included', () => {
    expect(resolveSplit('isic', GROUPS, 'Bottle')).toBe('isic')
    expect(resolveSplit('tag:Component', GROUPS, 'Bottle')).toBe('tag:Component')
  })
})
