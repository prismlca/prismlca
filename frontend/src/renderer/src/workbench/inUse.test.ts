import { describe, expect, it } from 'vitest'
import { blockedConsumers, inUseMessage } from './inUse'

const c = (database: string, code: string, name: string) => ({ database, code, name })

describe('blockedConsumers', () => {
  it('reads the consumers of a delete_blocked refusal and drops what is not one', () => {
    const details = { consumers: [c('m', 'b', 'Bottle'), { database: 'm', code: 'x' }, null] }
    expect(blockedConsumers(details)).toEqual([c('m', 'b', 'Bottle')])
    expect(blockedConsumers(undefined)).toEqual([])
    expect(blockedConsumers({ consumers: 'nope' })).toEqual([])
  })
})

describe('inUseMessage', () => {
  it('names one consumer in the singular', () => {
    expect(inUseMessage('Steel sheet', 'm', [c('m', 'b', 'Bottle')])).toBe(
      '“Steel sheet” is still an input of “Bottle”. Deleting it removes that input too. Delete anyway? Undo brings it back.'
    )
  })

  it('names a consumer in another model with that model, after the own ones', () => {
    expect(inUseMessage('S', 'm', [c('glass', 'g', 'Jar'), c('m', 'b', 'Bottle')])).toContain(
      'input of “Bottle” and “Jar” in the model “glass”. Deleting it removes those inputs too.'
    )
  })

  it('lists up to three names, then counts the rest', () => {
    const three = ['A', 'B', 'C'].map((n) => c('m', n, n))
    const five = ['A', 'B', 'C', 'D', 'E'].map((n) => c('m', n, n))
    expect(inUseMessage('S', 'm', three)).toContain('input of “A”, “B” and “C”.')
    expect(inUseMessage('S', 'm', five)).toContain('input of “A”, “B” and 3 more.')
  })

  it('still asks when the refusal lists nobody, without a code in the text', () => {
    expect(inUseMessage('S', 'm', [])).toBe(
      '“S” is still an input of other processes. Deleting it removes those inputs too. Delete anyway? Undo brings them back.'
    )
  })
})
