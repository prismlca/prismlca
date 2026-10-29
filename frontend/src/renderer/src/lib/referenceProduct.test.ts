import { describe, expect, it } from 'vitest'
import { asReferenceRow } from './referenceProduct'

const act = { database: 'bottle', code: 'p1', product: 'PET flakes' }
const row = (database: string, code: string, name: string | null) => ({
  uid: 'u1',
  amount: 1,
  input: { database, code, name, unit: 'kg' }
})

describe('asReferenceRow', () => {
  it('names the production row after the product, not the process', () => {
    const out = asReferenceRow(row('bottle', 'p1', 'Processing'), act)
    expect(out.input.name).toBe('PET flakes')
    expect(out.input.unit).toBe('kg')
    expect(out.amount).toBe(1)
  })

  it('keeps the process name when the process has no product', () => {
    expect(asReferenceRow(row('bottle', 'p1', 'Processing'), { ...act, product: null }).input.name).toBe(
      'Processing'
    )
    expect(asReferenceRow(row('bottle', 'p1', 'Processing'), { ...act, product: '  ' }).input.name).toBe(
      'Processing'
    )
  })

  it('leaves a production exchange that points at another node alone', () => {
    expect(asReferenceRow(row('bottle', 'other', 'flakes node'), act).input.name).toBe('flakes node')
    expect(asReferenceRow(row('lib', 'p1', 'same code, other db'), act).input.name).toBe(
      'same code, other db'
    )
  })
})
