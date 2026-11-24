import { describe, expect, it, vi } from 'vitest'
import { mutationRunner, writeFromDialog } from './mutation'

/** A dialog's write: refused before the thing exists → back to the dialog; after → the page's line. */
describe('writeFromDialog', () => {
  const setup = () => {
    const setError = vi.fn()
    const close = vi.fn()
    return { setError, close, run: mutationRunner({ setError }) }
  }

  it('hands a refusal before done() back to the dialog at once, without refresh or page error', async () => {
    const setError = vi.fn()
    const close = vi.fn()
    const after = vi.fn(async () => {})
    const run = mutationRunner({ setError, after })
    const refusal = new Error("A method 'My methods · GWP' already exists.")
    await expect(
      writeFromDialog(run, close, async () => {
        throw refusal
      })
    ).rejects.toBe(refusal)
    expect(close).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled() // nothing was written, so nothing to reload before the dialog hears
    expect(setError.mock.calls).toEqual([[null]]) // only the runner's clearing at the start
  })

  it('refreshes after a write that went through', async () => {
    const after = vi.fn(async () => {})
    const close = vi.fn()
    await writeFromDialog(mutationRunner({ setError: () => {}, after }), close, async () => {})
    expect(close).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('closes on done() and sends a later failure to the page, not the dialog', async () => {
    const { setError, close, run } = setup()
    await expect(
      writeFromDialog(run, close, async (done) => {
        done()
        throw new Error('study metadata failed')
      })
    ).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(1)
    expect(setError).toHaveBeenLastCalledWith('study metadata failed')
  })

  it('closes once when the write returns without calling done()', async () => {
    const { close, run } = setup()
    await writeFromDialog(run, close, async (done) => {
      done()
      done()
    })
    await writeFromDialog(run, close, async () => {})
    expect(close).toHaveBeenCalledTimes(2)
  })
})
