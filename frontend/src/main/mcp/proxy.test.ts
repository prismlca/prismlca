/**
 * The bridge against an in-process McpHost: a client on an in-memory transport talks to the proxy
 * server, which discovers the host through a real endpoint file in a temp userData and forwards.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { McpHost } from './server'
import { readEndpoint, writeEndpoint, type EndpointInfo } from './endpoint'
import { ProxyCore, createProxyServer, createShutdown, type ProxyDeps } from './proxy'
import { mcpToolDefs } from './catalog'
import type { ApiRaw } from '../ai/execute'

const apiRaw: ApiRaw = async (_m, path) => {
  if (path === '/api/v1/databases') return { status: 200, body: [{ name: 'Shampoo', kind: 'foreground' }] }
  if (path === '/api/v1/projects') return { status: 200, body: [{ name: 'proj', is_active: true }] }
  if (path.startsWith('/api/v1/study?')) return { status: 200, body: { goal: 'g' } }
  if (path.startsWith('/api/v1/ai/skills')) return { status: 200, body: { skills: [] } }
  return { status: 404, body: {} }
}

let userData: string
let host: McpHost
let launched = 0
let enabled = true
const logs: string[] = []

function makeHost(dir: string): McpHost {
  return new McpHost({
    version: '1.2.3',
    userData: () => dir,
    apiRaw,
    emit: () => {},
    currentModel: async () => 'Shampoo',
    session: {
      ui: async () => {
        throw new Error('No window available for the UI action.')
      },
      settings: () => ({ disabledTools: [], preferredBackground: '', eurostatEnabled: false })
    }
  })
}

async function health(info: EndpointInfo): Promise<boolean> {
  const r = await fetch(info.url.replace(/\/mcp$/, '/health'), {
    headers: { Authorization: `Bearer ${info.token}` }
  })
  return r.ok
}

function deps(over: Partial<ProxyDeps> = {}): ProxyDeps {
  return {
    version: '1.2.3',
    endpoint: () => readEndpoint(userData),
    isPidAlive: (pid) => pid === process.pid,
    health,
    mcpEnabled: () => enabled,
    launchApp: () => {
      launched++
    },
    catalogFallback: () => mcpToolDefs({}),
    clientInfo: { name: 'test-bridge', version: '0' },
    log: (m) => logs.push(m),
    pollMs: 30,
    ...over
  }
}

/** A client wired to a fresh proxy over in-memory transports. */
async function bridge(d: ProxyDeps): Promise<{ c: Client; core: ProxyCore }> {
  const core = new ProxyCore(d)
  const server = createProxyServer(d, core)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const c = new Client({ name: 'outer-client', version: '0' })
  await c.connect(b)
  return { c, core }
}

const text = (r: Awaited<ReturnType<Client['callTool']>>): string =>
  (r.content as Array<{ text: string }>)[0].text

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'prism-bridge-'))
  launched = 0
  enabled = true
  logs.length = 0
})

afterEach(async () => {
  await host?.stop().catch(() => undefined)
  rmSync(userData, { recursive: true, force: true })
})

describe('the stdio bridge', () => {
  it('answers initialize and tools/list at once, and forwards calls to the running app', async () => {
    host = makeHost(userData)
    await host.start()
    const { c, core } = await bridge(deps())
    expect(c.getInstructions()).toMatch(/orientation/)
    const { tools } = await c.listTools()
    expect(tools[0].name).toBe('orientation')
    const r = await c.callTool({ name: 'get_current_model', arguments: {} })
    expect(JSON.parse(text(r)).active_model).toBe('Shampoo')
    expect(host.sessions()).toHaveLength(1)
    // The app sees the agent, carried by the bridge — not the bridge alone.
    expect(host.sessions()[0].clientName).toBe('outer-client via test-bridge')
    expect(launched).toBe(0)
    await core.close()
    expect(host.sessions()).toHaveLength(0)
  })

  it('shows the built-in catalogue while the app is not up, and refuses when the server is off', async () => {
    enabled = false
    const { c } = await bridge(deps())
    const { tools } = await c.listTools()
    expect(tools.map((t) => t.name)).toContain('get_current_model')
    const r = await c.callTool({ name: 'get_current_model', arguments: {} })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/switched off in PrismLCA/)
    expect(launched).toBe(0)
  })

  it('starts the app when it is not running, waits for its endpoint, then forwards', async () => {
    const d = deps({
      launchApp: () => {
        launched++
        // The "app" comes up a moment later and publishes its endpoint.
        setTimeout(() => {
          host = makeHost(userData)
          void host.start()
        }, 120)
      }
    })
    const { c } = await bridge(d)
    const r = await c.callTool({ name: 'get_current_model', arguments: {} })
    expect(r.isError).toBe(false)
    expect(launched).toBe(1)
    expect(logs.some((l) => /starting it/.test(l))).toBe(true)
  })

  it('ignores a stale endpoint file (dead process) and launches instead', async () => {
    writeEndpoint(userData, {
      url: 'http://127.0.0.1:1/mcp',
      token: 't',
      pid: 999_999,
      version: '1.2.3',
      startedAt: 'x'
    })
    const d = deps({
      launchApp: () => {
        launched++
        setTimeout(() => {
          host = makeHost(userData)
          void host.start()
        }, 100)
      }
    })
    const { c } = await bridge(d)
    const r = await c.callTool({ name: 'get_current_model', arguments: {} })
    expect(r.isError).toBe(false)
    expect(launched).toBe(1)
  })

  it('never drives an app of another version, and does not try to start one', async () => {
    host = makeHost(userData)
    await host.start()
    const { c } = await bridge(deps({ version: '9.9.9' }))
    const r = await c.callTool({ name: 'get_current_model', arguments: {} })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/1\.2\.3 is running, but this bridge belongs to version 9\.9\.9/)
    expect(launched).toBe(0)
  })

  it('reports a failed launch at once, and again on the next call — never a silent wait', async () => {
    const { c, core } = await bridge(
      deps({
        launchApp: () => {
          launched++
          throw new (class extends Error {})('no display for the app')
        }
      })
    )
    const t0 = Date.now()
    let r = await c.callTool({ name: 'get_current_model', arguments: {} })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/could not be started: no display/)
    r = await c.callTool({ name: 'get_current_model', arguments: {} })
    expect(text(r)).toMatch(/could not be started/)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(launched).toBe(1)
    expect(core.connected).toBe(false)
  })

  it('gives up with a readable error when the app does not come up', async () => {
    const { c, core } = await bridge(deps())
    // Short patience for the test: the core's timeout is per call; drive ensureClient directly.
    await expect(core.ensureClient({ launch: true, timeoutMs: 150 })).rejects.toThrow(/did not come up/)
    expect(launched).toBe(1)
    await c.close()
  })

  it('shuts down once, ends the app session, and exits even when closing hangs', async () => {
    host = makeHost(userData)
    await host.start()
    const { c, core } = await bridge(deps())
    await c.callTool({ name: 'get_current_model', arguments: {} })
    expect(host.sessions()).toHaveLength(1)
    const exits: number[] = []
    const shutdown = createShutdown(core, (code) => exits.push(code))
    shutdown()
    shutdown() // stdin end + SIGTERM both fire: one shutdown
    for (let i = 0; i < 50 && !exits.length; i++) await new Promise((r) => setTimeout(r, 20))
    expect(exits).toEqual([0])
    expect(host.sessions()).toHaveLength(0)
    // A close that never resolves is cut off by the bound.
    const stuck = { close: () => new Promise<void>(() => {}) } as unknown as ProxyCore
    const late: number[] = []
    createShutdown(stuck, (code) => late.push(code), 30)()
    await new Promise((r) => setTimeout(r, 80))
    expect(late).toEqual([0])
  })

  it('starts the app AGAIN after the one it started has quit — once per attempt, not once per bridge', async () => {
    // The app a bridge launched quits when nobody uses it (idleQuit.ts); the next call must be able
    // to bring it back. A flag that stayed true for ever left every later call polling.
    const d = deps({
      launchApp: () => {
        launched++
        setTimeout(() => {
          host = makeHost(userData)
          void host.start()
        }, 80)
      }
    })
    const { c, core } = await bridge(d)
    expect((await c.callTool({ name: 'get_current_model', arguments: {} })).isError).toBe(false)
    expect(launched).toBe(1)
    // The app quits: endpoint gone, session gone.
    await host.stop()
    const lost = await c.callTool({ name: 'get_current_model', arguments: {} })
    expect(lost.isError).toBe(true)
    // Next call: launch number two, then forward as if nothing had happened.
    const again = await c.callTool({ name: 'get_current_model', arguments: {} })
    expect(again.isError).toBe(false)
    expect(launched).toBe(2)
    expect(core.launches).toBe(2)
  })

  it('tools/list never starts the app — discovery is not use', async () => {
    const { c } = await bridge(deps())
    const { tools } = await c.listTools()
    expect(tools.length).toBeGreaterThan(10) // the built-in catalogue
    expect(launched).toBe(0)
    expect(logs.some((l) => /starting it/.test(l))).toBe(false)
  })

  it('reconnects with a new session after the app closed the old one', async () => {
    host = makeHost(userData)
    await host.start()
    const { c } = await bridge(deps())
    await c.callTool({ name: 'get_current_model', arguments: {} })
    const first = host.sessions()[0].id
    await host.disconnect(first)
    // No standing connection tells the bridge: the first call after the loss reports it...
    const lost = await c.callTool({ name: 'get_current_model', arguments: {} })
    expect(lost.isError).toBe(true)
    expect(text(lost)).toMatch(/connection to PrismLCA failed during this call/)
    // ...and the next one runs in a fresh session.
    const r = await c.callTool({ name: 'get_current_model', arguments: {} })
    expect(r.isError).toBe(false)
    expect(host.sessions()).toHaveLength(1)
    expect(host.sessions()[0].id).not.toBe(first)
  })
})
