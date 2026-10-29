import { describe, expect, it } from 'vitest'
import { geoName, isAggregate } from './geographyNames'

describe('geoName', () => {
  it('prefers the workspace release, then our region list, then ICU country names', () => {
    expect(geoName('DE', { DE: 'Germany (release)' })).toBe('Germany (release)')
    expect(geoName('RER')).toBe('Europe')
    expect(geoName('DE')).toBe('Germany')
    expect(geoName('CH')).toBe('Switzerland')
  })

  it('knows no name for a code nobody defines', () => {
    expect(geoName('Europe without Switzerland')).toBeUndefined()
    expect(geoName('XQ')).toBeUndefined()
    expect(geoName('CA-QC')).toBeUndefined()
  })

  it('treats a code as text, never as a property of the map', () => {
    const names = JSON.parse('{"DE": "Germany"}') as Record<string, string>
    for (const code of ['constructor', 'toString', '__proto__', 'hasOwnProperty'])
      expect(geoName(code, names)).toBeUndefined()
  })
})

describe('isAggregate', () => {
  it('reads countries and provinces from the shape of the code', () => {
    for (const code of ['DE', 'CH', 'CA-QC', 'US-CA', 'CN-AH', 'AU-NSW', 'AU-WA'])
      expect(isAggregate(code)).toBe(false)
  })

  it('takes everything else for a region or market area', () => {
    for (const code of [
      'GLO',
      'RoW',
      'RER',
      'US-NPCC',
      'CN-CSG',
      'UCTE without France',
      'Europe without Switzerland'
    ])
      expect(isAggregate(code)).toBe(true)
  })
})
