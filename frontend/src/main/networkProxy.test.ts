/**
 * Chromium's stack never looks for a proxy on its own; the update check borrows the system's settings
 * for exactly as long as it runs.
 */
import { describe, expect, it, vi } from 'vitest'

const appendSwitch = vi.fn()
vi.mock('electron', () => ({ app: { commandLine: { appendSwitch: (s: string) => appendSwitch(s) } } }))

import type { Session } from 'electron'
import { disableProxyDiscovery, withSystemProxy } from './networkProxy'

function fakeSession(): { ses: Session; modes: string[] } {
  const modes: string[] = []
  const ses = {
    setProxy: vi.fn(async (c: { mode: string }) => void modes.push(c.mode))
  } as unknown as Session
  return { ses, modes }
}

describe('proxy settings', () => {
  it('starts every session without a proxy', () => {
    disableProxyDiscovery()
    expect(appendSwitch).toHaveBeenCalledWith('no-proxy-server')
  })

  it('uses the system settings while the work runs, and none again afterwards', async () => {
    const { ses, modes } = fakeSession()
    const seen: string[] = []
    const result = await withSystemProxy(ses, async () => {
      seen.push(modes.at(-1)!)
      return 42
    })
    expect(result).toBe(42)
    expect(seen).toEqual(['system'])
    expect(modes).toEqual(['system', 'direct'])
  })

  it('switches back when the work fails', async () => {
    const { ses, modes } = fakeSession()
    await expect(
      withSystemProxy(ses, async () => {
        throw new Error('offline')
      })
    ).rejects.toThrow('offline')
    expect(modes).toEqual(['system', 'direct'])
  })

  it('keeps the system settings until the last of two overlapping runs is done', async () => {
    const { ses, modes } = fakeSession()
    let finishFirst: (() => void) | undefined
    const first = withSystemProxy(ses, () => new Promise<void>((r) => (finishFirst = r)))
    await vi.waitFor(() => expect(finishFirst).toBeDefined())
    expect(modes).toEqual(['system'])
    const second = withSystemProxy(ses, async () => {
      finishFirst!()
      await first
      expect(modes).toEqual(['system'])
    })
    await second
    expect(modes).toEqual(['system', 'direct'])
  })

  it('still runs the work when the system settings cannot be applied', async () => {
    const { ses, modes } = fakeSession()
    vi.mocked(ses.setProxy).mockRejectedValueOnce(new Error('no proxy service'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(withSystemProxy(ses, async () => 'done')).resolves.toBe('done')
    expect(modes).toEqual(['direct'])
    log.mockRestore()
  })
})
