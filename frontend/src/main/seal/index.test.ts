/**
 * The switch: PRISM_SEALED seals an app run from source — every part in place, the trap in the children's
 * environment, a line saying so — and an installed app drops the variable and stays as it is.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  app: null as unknown as EventEmitter & { isPackaged: boolean },
  shell: {} as Record<string, unknown>,
  dialog: {} as Record<string, unknown>,
  session: { defaultSession: { webRequest: { onBeforeRequest: () => undefined } } }
}))
vi.mock('electron', () => electron)
const guardSockets = vi.hoisted(() => vi.fn())
const trapFails = vi.hoisted(() => ({ with: null as Error | null }))
vi.mock('./network', async (original) => {
  const real = await original<typeof import('./network')>()
  return {
    ...real,
    guardSockets,
    startProxyTrap: (log: Parameters<typeof real.startProxyTrap>[0]) =>
      trapFails.with ? Promise.reject(trapFails.with) : real.startProxyTrap(log)
  }
})

const { sealFromEnv } = await import('./index')

const PROXY_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy'
]
let saved: Record<string, string | undefined>
let switches: [string, string][]

beforeEach(() => {
  saved = Object.fromEntries(['PRISM_SEALED', ...PROXY_VARS].map((k) => [k, process.env[k]]))
  switches = []
  electron.app = Object.assign(new EventEmitter(), {
    isPackaged: false,
    whenReady: () => Promise.resolve(),
    commandLine: { appendSwitch: (name: string, value: string) => switches.push([name, value]) }
  })
  electron.shell = {}
  electron.dialog = {}
  guardSockets.mockClear()
  trapFails.with = null
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.restoreAllMocks()
})

describe('sealFromEnv', () => {
  it('does nothing without the variable', () => {
    delete process.env.PRISM_SEALED
    expect(sealFromEnv()).toBeNull()
    expect(electron.shell).toEqual({})
    expect(guardSockets).not.toHaveBeenCalled()
    expect(switches).toEqual([])
  })

  it('is ignored by an installed app, which drops the variable before a child could inherit it', () => {
    process.env.PRISM_SEALED = '/tmp/sealed.jsonl'
    electron.app.isPackaged = true
    expect(sealFromEnv()).toBeNull()
    expect(process.env.PRISM_SEALED).toBeUndefined()
    expect(electron.shell).toEqual({})
    expect(guardSockets).not.toHaveBeenCalled()
  })

  it('seals every part from source, hands the children the trap, and says so in the log', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'prism-seal-')), 'sealed.jsonl')
    process.env.PRISM_SEALED = path
    const seal = sealFromEnv()
    expect(seal?.log).toBe(path)
    expect(Object.keys(electron.shell).sort()).toEqual(['openExternal', 'openPath', 'showItemInFolder'])
    expect(electron.dialog).toHaveProperty('showOpenDialog')
    expect(electron.app.listenerCount('web-contents-created')).toBe(1)
    expect(electron.app.listenerCount('session-created')).toBe(1)
    expect(guardSockets).toHaveBeenCalledTimes(1)
    expect(switches.map(([name]) => name)).toEqual(['host-resolver-rules'])

    await seal!.ready
    expect(process.env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(process.env.NO_PROXY).toBe('localhost,127.0.0.1,::1')
    const lines = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines).toEqual([
      expect.objectContaining({ kind: 'sealed', proc: 'main', pid: process.pid, outcome: 'in place' })
    ])
  })

  it('starts no program when the trap cannot listen, and says so in the log', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'prism-seal-')), 'sealed.jsonl')
    process.env.PRISM_SEALED = path
    delete process.env.HTTPS_PROXY
    trapFails.with = new Error('listen EADDRINUSE')
    const seal = sealFromEnv()
    await expect(seal!.ready).rejects.toThrow(/proxy trap did not start \(listen EADDRINUSE\)/)
    expect(process.env.HTTPS_PROXY).toBeUndefined()
    expect(readFileSync(path, 'utf8')).toMatch(/"outcome":"failed"/)
  })
})
