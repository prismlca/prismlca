import { describe, expect, it } from 'vitest'
import { expandBatch, explainNotFound, ignoredNote, topLevelOnly } from './exchangeBatch'

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
    // Not under `hint`: the batch answer it is merged into says there which items to send again.
    expect(ignoredNote(['comment'])).not.toHaveProperty('hint')
  })

  it('tells an item that lacks a value where the one given at the top went', () => {
    const { ignored } = expandBatch({ ...call, amount: 1 })
    expect(topLevelOnly(ignored, 'amount', 'formula')).toContain('"amount" at the top level')
    expect(topLevelOnly(ignored, 'amount', 'formula')).not.toContain('formula')
    // Nothing given at the top, or a different field: the item's error stands alone.
    expect(topLevelOnly(expandBatch(call).ignored, 'amount', 'formula')).toBe('')
    expect(topLevelOnly(ignored, 'formula')).toBe('')
    // A top-level 0 is padding, not a statement, exactly as in the note at the end of the answer.
    expect(topLevelOnly(expandBatch({ ...call, amount: 0 }).ignored, 'amount')).toBe('')
    // Without a list the top level IS the item, so there is nothing to explain.
    expect(
      topLevelOnly(expandBatch({ action: 'set_amount', uid: 'u', formula: 'x' }).ignored, 'formula')
    ).toBe('')
    expect(
      topLevelOnly(expandBatch({ ...call, amount: 1, formula: 'n' }).ignored, 'amount', 'formula')
    ).toContain('"amount" and "formula" at the top level of the batch are not applied')
    // A comment above the list: said there, so the item without one is told; "" is no statement.
    expect(topLevelOnly(expandBatch({ ...call, comment: 'why' }).ignored, 'comment')).toContain(
      '"comment" at the top level of the batch is not applied'
    )
    expect(topLevelOnly(expandBatch({ ...call, comment: '' }).ignored, 'comment')).toBe('')
  })

  it('treats a call without a list as one item', () => {
    const single = { action: 'add', input_code: 'x' }
    expect(expandBatch(single).items).toEqual([single])
  })
})
