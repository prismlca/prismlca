import { describe, expect, it } from 'vitest'
import { closestName, insertName, lintFormula, replaceName, suggest, wordAt } from './formula'

const P = [{ name: 'mass' }, { name: 'mass_glass' }, { name: 'distance_km' }, { name: 'recycled_share' }]

describe('lintFormula', () => {
  it('accepts what the server evaluates', () => {
    for (const f of [
      'mass * 2',
      'mass * (1 - recycled_share)',
      'max(mass, 0.5) / distance_km',
      '-mass ** 2 + 1e-3',
      '2 ** -1',
      'sqrt(mass_glass) * pi',
      'round(mass * 1000) / 1000',
      'mass // 2 + 7 // 2',
      'clip(mass, 0, 1)',
      'recycled_share if recycled_share < 1 else 1',
      '0.9 if distance_km > 500 else 0.6',
      'mass if mass > 1 and not (mass_glass == 0) or True else 0',
      '1 if mass >= 2 else 2 if mass != 0 else 3',
      '  mass  ',
      ''
    ]) {
      expect(lintFormula(f, P), f).toBeNull()
    }
  })

  it('names an unknown parameter and the one it probably meant', () => {
    const p = lintFormula('Mass * 2', P)
    expect(p?.kind).toBe('unknown')
    expect(p?.name).toBe('Mass')
    expect(p?.suggestion).toBe('mass')
    expect(p?.message).toContain('did you mean "mass"')
    expect(lintFormula('mas_glass + 1', P)?.suggestion).toBe('mass_glass')
    expect(lintFormula('xyzzy + 1', P)?.suggestion).toBeUndefined()
  })

  it('checks nothing about names while the list is unknown', () => {
    expect(lintFormula('whatever * 2', null)).toBeNull()
    expect(lintFormula('whatever * ', null)?.kind).toBe('syntax')
  })

  it('refuses the two things Python gets silently wrong', () => {
    expect(lintFormula('2^3', P)?.kind).toBe('power')
    expect(lintFormula('mass * 0,5', P)?.kind).toBe('decimal')
    expect(lintFormula('0,5', P)?.kind).toBe('decimal')
    // A comma between call arguments is what a comma is for.
    expect(lintFormula('max(mass, 0.5)', P)).toBeNull()
  })

  it('reports brackets and operators in reading order', () => {
    expect(lintFormula('mass * (1 - recycled_share', P)?.message).toBe('A "(" is not closed.')
    expect(lintFormula('mass) * 2', P)?.kind).toBe('parens')
    expect(lintFormula('mass * ', P)?.message).toBe('The formula ends with "*".')
    expect(lintFormula('mass * / 2', P)?.message).toBe('Unexpected "/".')
    expect(lintFormula('mass 2', P)?.message).toBe('Missing operator before "2".')
    expect(lintFormula('mass = 2', P)?.kind).toBe('syntax')
    expect(lintFormula('mass; 2', P)?.kind).toBe('char')
  })

  it('reads the conditional the handbook documents, and refuses half of one', () => {
    expect(lintFormula('mass if mass > 1', P)?.message).toBe(
      'An "if" needs an "else": value if condition else other.'
    )
    expect(lintFormula('mass < ', P)?.message).toBe('The formula ends with "<".')
    expect(lintFormula('mass if', P)?.message).toBe('The formula ends with "if".')
    expect(lintFormula('mass else 2', P)?.message).toBe('Unexpected "else".')
    expect(lintFormula('mass ! 2', P)?.kind).toBe('char')
  })

  it('tells a function from a parameter', () => {
    expect(lintFormula('mass(2)', P)?.message).toContain('is a parameter, not a function')
    expect(lintFormula('sqrt * 2', P)?.message).toContain('needs brackets')
    expect(lintFormula('foo(2)', P)?.message).toBe('Unknown function "foo".')
  })

  it('refuses a parameter that names itself', () => {
    expect(lintFormula('mass * 2', P, { self: 'mass' })?.kind).toBe('self')
    expect(lintFormula('mass_glass * 2', P, { self: 'mass' })).toBeNull()
  })
})

describe('closestName', () => {
  it('prefers case, then prefix, then a short edit', () => {
    expect(closestName('MASS', ['mass', 'mass_glass'])).toBe('mass')
    expect(closestName('mass_g', ['mass', 'mass_glass'])).toBe('mass_glass')
    expect(closestName('dstance_km', ['mass', 'distance_km'])).toBe('distance_km')
    expect(closestName('q', ['mass'])).toBeUndefined()
  })
})

describe('completion helpers', () => {
  it('finds the word under the caret and the part typed so far', () => {
    expect(wordAt('mass * rec', 10)).toEqual({ start: 7, end: 10, word: 'rec', prefix: 'rec' })
    expect(wordAt('mass * rec', 8)).toEqual({ start: 7, end: 10, word: 'rec', prefix: 'r' })
    expect(wordAt('mass * 2', 8).word).toBe('') // a number is not a name
    expect(wordAt('mass * ', 7).word).toBe('')
  })

  it('offers prefix matches before substring matches and never the exact word', () => {
    expect(suggest('ma', P).map((p) => p.name)).toEqual(['mass', 'mass_glass'])
    expect(suggest('glass', P).map((p) => p.name)).toEqual(['mass_glass'])
    // The name typed in full stays, first; one letter past it and nothing matches.
    expect(suggest('mass', P).map((p) => p.name)).toEqual(['mass', 'mass_glass'])
    expect(suggest('massx', P)).toEqual([])
    expect(suggest('', P)).toEqual([])
  })

  it('inserts and replaces names in place', () => {
    expect(insertName('mass * rec', 7, 10, 'recycled_share')).toEqual({
      text: 'mass * recycled_share',
      caret: 21
    })
    expect(replaceName('Mass * 2 + Mass', 'Mass', 'mass')).toBe('mass * 2 + mass')
    expect(replaceName('mass_glass + mass', 'mass', 'm')).toBe('mass_glass + m')
  })
})
