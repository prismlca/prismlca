import { describe, expect, it } from 'vitest'
import { nameMap } from './nameMap'

describe('nameMap', () => {
  it('answers only for the names it was given', () => {
    const map = nameMap([['PET bottle', 'f1']])
    expect(map['PET bottle']).toBe('f1')
    expect(map['constructor']).toBeUndefined()
    expect(map['toString']).toBeUndefined()
    expect(map['hasOwnProperty']).toBeUndefined()
  })

  it('keeps "__proto__" as a key like any other', () => {
    const map = nameMap(Object.entries(JSON.parse('{"__proto__": "f1"}') as Record<string, string>))
    expect(map['__proto__']).toBe('f1')
    map['constructor'] = 'f2'
    expect(Object.keys(map)).toEqual(['__proto__', 'constructor'])
  })
})
