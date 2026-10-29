import { describe, expect, it } from 'vitest'
import { expandBatch, explainNotFound, ignoredNote } from './exchangeBatch'

describe('an edit_exchange batch', () => {
  const call = {
    action: 'add',
    activity_code: 'dist',
    input_database: 'M1',
    exchanges: [
      { input_code: 'assembly', amount: 1 },
      { input_code: 'fa28', amount: 0.04 },
      { input_code: 'sea', input_database: 'ecoinvent', amount: 6.8 }
    ]
  }

  it('hands the top-level defaults to every item and lets the item win', () => {
    const { items, inheritedDb } = expandBatch(call)
    expect(items.map((i) => i.input_database)).toEqual(['M1', 'M1', 'ecoinvent'])
    expect(items.every((i) => i.activity_code === 'dist' && i.action === 'add')).toBe(true)
    expect(items.map((i) => inheritedDb.has(i))).toEqual([true, true, false])
  })

  it('says where the database came from when an inherited one does not hold the input', () => {
    const { items, inheritedDb } = expandBatch(call)
    const notFound = new Error("Activity 'fa28' not found in 'M1'. — Check the activity code and database.")
    expect(explainNotFound(items[1], inheritedDb, notFound).message).toContain(
      'took input_database "M1" from the top level'
    )
    // Its own database, or another failure: the error stays as it was.
    const own = new Error("Activity 'sea' not found in 'ecoinvent'.")
    expect(explainNotFound(items[2], inheritedDb, own)).toBe(own)
    const other = new Error('Amount must be a number.')
    expect(explainNotFound(items[1], inheritedDb, other)).toBe(other)
  })

  it('reports a per-exchange field given at the top level, and nothing when there is none', () => {
    expect(ignoredNote([])).toBeNull()
    expect(expandBatch({ ...call, comment: 'why' }).ignored).toEqual(['comment'])
    expect(ignoredNote(['comment'])?.not_applied).toEqual(['comment'])
  })

  it('treats a call without a list as one item', () => {
    const single = { action: 'add', input_code: 'x' }
    expect(expandBatch(single).items).toEqual([single])
  })
})
