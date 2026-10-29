/**
 * A drop past the preload's cap still accounts for every file:
 * the dialog route gets one outcome per file from main, so the drop route must not quietly lose the
 * 51st. `attachDropped` turns the preload's `overflow` count into a refused chip beside main's answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AttachmentMeta } from '../../../shared/ipc'

// Like main: ten stored, the rest refused with the per-message limit.
const likeMain = (paths: string[]): AttachmentMeta[] => {
  return paths.map((p, i) =>
    i < 10
      ? { id: `id-${i}`, name: p, kind: 'text', bytes: 1 }
      : { id: '', name: p, kind: 'text', bytes: 0, error: 'More than 10 files in one message.' }
  )
}
const attach = vi.fn(async (paths: string[]) => likeMain(paths))
vi.stubGlobal('window', { prism: { ai: { attach } } })

const { attachDropped } = await import('./ai')

// Braces, not an arrow value: a function returned from beforeEach is run as its teardown, and
// mockClear returns the mock.
beforeEach(() => {
  attach.mockClear()
})

describe('attachDropped', () => {
  it('a 51-file drop comes back with an outcome for all 51', async () => {
    const paths = Array.from({ length: 50 }, (_, i) => `/home/u/f${i}.txt`)
    const out = await attachDropped({ paths, overflow: 1 })
    expect(attach).toHaveBeenCalledWith(paths)
    expect(out.filter((a) => a.id)).toHaveLength(10)
    expect(out.filter((a) => a.error === 'More than 10 files in one message.')).toHaveLength(40)
    const last = out[out.length - 1]
    expect(last).toEqual(
      expect.objectContaining({
        id: '',
        name: '1 more file',
        error: '1 more file was not attached: one drop reads at most 50 files. Drop them in smaller groups.'
      })
    )
    expect(out).toHaveLength(51)
  })

  it('adds nothing when nothing overflowed, and does not call main for an empty drop', async () => {
    expect(await attachDropped({ paths: [], overflow: 0 })).toEqual([])
    expect(attach).not.toHaveBeenCalled()
    const only = await attachDropped({ paths: [], overflow: 3 })
    expect(only).toEqual([expect.objectContaining({ name: '3 more files', id: '' })])
  })
})
