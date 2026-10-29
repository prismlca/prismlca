import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type React from 'react'
import { useAttachments } from './useAttachments'
import { makePrism, type PrismOverrides } from '../test/prism'
import type { AttachmentMeta } from '../lib/ai'

/**
 * The composer's attachment chips as a hook. The component-level behaviour (chips, dialog, drop,
 * send) is pinned in CanvasChat.composer.dom.test.tsx; this file pins what a hook adds: which
 * callbacks keep their identity, and that the panel's setters are driven as before.
 */
const install = (overrides: PrismOverrides): void => {
  ;(window as unknown as { prism: unknown }).prism = makePrism({}, overrides).prism
}
const meta = (id: string, name: string, error?: string): AttachmentMeta => ({
  id,
  name,
  kind: 'text',
  bytes: 1,
  ...(error ? { error } : {})
})

const rig = () => {
  const setError = vi.fn()
  const setOpen = vi.fn()
  const hook = renderHook(() => useAttachments({ setError, setOpen }))
  return { ...hook, setError, setOpen }
}

describe('useAttachments', () => {
  it('keeps onFileDrop, clearAttachments and the other callbacks stable across renders', async () => {
    install({ bridge: { pickFiles: async () => ['/a'] }, ai: { attach: async () => [meta('h1', 'a')] } })
    const { result, rerender } = rig()
    const first = result.current
    await act(() => result.current.onAttachClick())
    rerender()
    expect(result.current.attachments).toHaveLength(1)
    expect(result.current.onFileDrop).toBe(first.onFileDrop)
    expect(result.current.clearAttachments).toBe(first.clearAttachments)
    expect(result.current.onAttachClick).toBe(first.onAttachClick)
    expect(result.current.removeAttachment).toBe(first.removeAttachment)
  })

  it('opens the panel and clears the error on an attach, and reports a failed one', async () => {
    let fail = false
    install({
      bridge: { pickFiles: async () => ['/a'] },
      ai: {
        attach: async () => {
          if (fail) throw new Error('disk gone')
          return [meta('h1', 'a')]
        }
      }
    })
    const { result, setError, setOpen } = rig()
    await act(() => result.current.onAttachClick())
    expect(setOpen).toHaveBeenCalledWith(true)
    expect(setError).toHaveBeenLastCalledWith(null)
    expect(result.current.attaching).toBe(false)

    fail = true
    await act(() => result.current.onAttachClick())
    expect(setError).toHaveBeenLastCalledWith(expect.stringContaining('disk gone'))
    expect(result.current.attachments).toHaveLength(1)
  })

  it('ignores a drop without files, and clears / removes on request', async () => {
    install({
      bridge: { droppedFilePaths: async () => ({ paths: ['/a', '/b'], overflow: 0 }) },
      ai: { attach: async () => [meta('h1', 'a'), meta('', 'b', 'refused')] }
    })
    const { result } = rig()
    const preventDefault = vi.fn()
    const empty = { dataTransfer: { files: [] }, preventDefault } as unknown as React.DragEvent
    expect(result.current.onFileDrop(empty)).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()

    const withFile = {
      dataTransfer: { files: [new File(['x'], 'a')] },
      preventDefault
    } as unknown as React.DragEvent
    act(() => {
      expect(result.current.onFileDrop(withFile)).toBe(true)
    })
    expect(preventDefault).toHaveBeenCalled()
    await waitFor(() => expect(result.current.attachments).toHaveLength(2))

    act(() => result.current.removeAttachment(0))
    expect(result.current.attachments.map((a) => a.name)).toEqual(['b'])
    act(() => result.current.clearAttachments())
    expect(result.current.attachments).toEqual([])
  })
})
