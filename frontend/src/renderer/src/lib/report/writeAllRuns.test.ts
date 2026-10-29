import { describe, expect, it } from 'vitest'
import { isWritingAll, reportBase, trackWriteAll } from './writeAllRuns'

describe('the Write-all runs in flight', () => {
  it('counts a run until it settles — finished or failed — and keeps reports apart', async () => {
    const a = reportBase('My model/1', 'rep-1')
    const b = reportBase('My model/1', 'rep-2')
    expect(a).toBe('/api/v1/report/one/My%20model%2F1/rep-1')

    let finish: () => void = () => {}
    let fail: (e: Error) => void = () => {}
    const one = trackWriteAll(a, new Promise<void>((r) => (finish = r)))
    const two = trackWriteAll(a, new Promise<void>((_r, j) => (fail = j)))
    expect(isWritingAll(a)).toBe(true)
    expect(isWritingAll(b)).toBe(false)

    finish()
    await one
    expect(isWritingAll(a)).toBe(true) // the second run is still writing

    fail(new Error('cancelled'))
    await expect(two).rejects.toThrow('cancelled')
    expect(isWritingAll(a)).toBe(false)
  })
})
