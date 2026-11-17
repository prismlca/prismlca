import { describe, expect, it } from 'vitest'
import { familiesOffered, resolveSplit } from './splitBy'
import type { TagFamily } from '../../lib/server/routes'

const f = (name: string, databases: string[]): TagFamily => ({ name, databases })
const FAMILIES = [f('Supplier', ['Other']), f('Phase', ['Bottle', 'Other']), f('Component', ['Bottle'])]

describe('familiesOffered', () => {
  it('keeps the families some of the databases carry, in the order they arrive', () => {
    expect(familiesOffered(FAMILIES, new Set(['Bottle']), '')).toEqual(['Phase', 'Component'])
    expect(familiesOffered(FAMILIES, new Set(['Nothing']), '')).toEqual([])
  })

  it('keeps the family already chosen on offer, even when no selected model carries it', () => {
    expect(familiesOffered(FAMILIES, new Set(['Bottle']), 'Supplier')).toEqual([
      'Phase',
      'Component',
      'Supplier'
    ])
    expect(familiesOffered([], new Set(['Bottle']), 'Gone')).toEqual(['Gone'])
    expect(familiesOffered(FAMILIES, new Set(['Bottle']), 'Phase')).toEqual(['Phase', 'Component'])
  })

  it('takes several chosen families, with or without the tag: prefix, each once', () => {
    expect(familiesOffered(FAMILIES, new Set(['Bottle']), ['tag:Supplier', 'tag:Phase', 'Supplier'])).toEqual(
      ['Phase', 'Component', 'Supplier']
    )
    expect(familiesOffered(FAMILIES, new Set(['Bottle']), [])).toEqual(['Phase', 'Component'])
  })
})

describe('resolveSplit', () => {
  it('preselects a tag family the model carries', () => {
    expect(resolveSplit('', FAMILIES, 'Bottle')).toBe('tag:Phase')
  })

  it('falls back to ISIC when the model carries no tags, even if another model does', () => {
    expect(resolveSplit('', FAMILIES, 'Untagged')).toBe('isic')
    expect(resolveSplit(undefined, FAMILIES, null)).toBe('isic')
  })

  it('keeps a choice once made, ISIC included', () => {
    expect(resolveSplit('isic', FAMILIES, 'Bottle')).toBe('isic')
    expect(resolveSplit('tag:Component', FAMILIES, 'Bottle')).toBe('tag:Component')
  })
})
