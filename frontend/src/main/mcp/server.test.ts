/**
 * The MCP host under plain Node: a real HTTP listener on 127.0.0.1, the SDK's own client against
 * it, a fake backend behind it. No Electron, no window — UI tools answer with the bridge's error.
 */
import { request as httpRequest } from 'node:http'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { setProgressEvery, McpHost } from './server'
import { endpointPath, readEndpoint } from './endpoint'
import type { ApiRaw } from '../ai/execute'
import type { McpEvent } from '../../shared/ipc'

const apiCalls: Array<{ method: string; path: string; headers?: Record<string, string> }> = []
/** The app's state as the fake backend reports it: an import in flight blocks writes. */
let importing = false
/** The project the fake backend has open; a request naming another is refused like the real one. */
let currentProject = 'proj-A'
/** The fake backend cannot name a project at all (503 on the list). */
let projectsDown = false
/** Settings as the user may change them while a session is open. */
let disabled: string[] = []
let eurostatOn = true
/** The window, as the test wants it: absent by default (the bridge's own error), or answering. */
let uiImpl: (name: string, args: Record<string, unknown>) => Promise<unknown> = async () => {
  throw new Error('No window available for the UI action.')
}
const apiRaw: ApiRaw = async (method, path, _body, headers) => {
  apiCalls.push({ method, path, headers })
  const named = headers?.['X-Prism-Project'] ? decodeURIComponent(headers['X-Prism-Project']) : undefined
  if (named && named !== currentProject)
    return {
      status: 409,
      body: {
        error: {
          code: 'project_changed',
          message: `The active workspace changed: this session was opened on "${named}", the app now has "${currentProject}". Reconnect to continue in the current workspace.`
        }
      }
    }
  if (path === '/api/v1/projects')
    return projectsDown
      ? { status: 503, body: 'down' }
      : { status: 200, body: [{ name: currentProject, is_active: true }] }
  if (path === '/api/v1/databases')
    return {
      status: 200,
      body: [
        { name: 'Shampoo', kind: 'foreground' },
        { name: 'ecoinvent-3.12-cutoff', kind: 'background' },
        { name: 'My processes', kind: 'library' }
      ]
    }
  if (path.startsWith('/api/v1/study?')) return { status: 200, body: { goal: 'Footprint of 1 l shampoo' } }
  if (path.startsWith('/api/v1/ai/skills')) return { status: 200, body: { skills: [] } }
  if (path === '/api/v1/setup/status') return { status: 200, body: { state: importing ? 'running' : 'idle' } }
  if (method === 'POST' && path.startsWith('/api/v1/model/')) return { status: 200, body: { ok: true } }
  // The irreversible example of the approval tests (a method family is gone for good).
  if (method === 'POST' && path === '/api/v1/lcia/family/delete')
    return { status: 200, body: { deleted: 'Scratch' } }
  return { status: 404, body: { detail: 'not found' } }
}

let userData: string
let host: McpHost
let url: string
const events: McpEvent[] = []

beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'prism-mcp-'))
  host = new McpHost({
    version: '0.0.0-test',
    userData: () => userData,
    apiRaw,
    emit: (ev) => events.push(ev),
    currentModel: async () => 'Shampoo',
    session: {
      ui: (_sid, _client, _db, name, args) => uiImpl(name, args),
      settings: () => ({ disabledTools: disabled, preferredBackground: '', eurostatEnabled: eurostatOn }),
      eurostat: async () => ({ rows: [] })
    }
  })
  url = await host.start()
})

afterAll(async () => {
  await host.stop()
  rmSync(userData, { recursive: true, force: true })
})

function client(): { c: Client; t: StreamableHTTPClientTransport } {
  const token = readEndpoint(userData)!.token
  const t = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const c = new Client({ name: 'test-client', version: '9.9' })
  return { c, t }
}

/** A raw request with full control over the headers (fetch forbids setting Host). */
function raw(opts: { headers: Record<string, string>; body?: string; method?: string }): Promise<number> {
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: opts.method ?? 'POST',
        headers: opts.headers
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

describe('McpHost', () => {
  it('publishes its endpoint while running', () => {
    const info = readEndpoint(userData)!
    expect(info.url).toBe(url)
    expect(info.token.length).toBeGreaterThan(30)
    expect(info.pid).toBe(process.pid)
    expect(events.some((e) => e.type === 'status' && e.running)).toBe(true)
  })

  it('refuses without the token, and refuses a foreign Host header', async () => {
    const init = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } }
    })
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    expect(await raw({ headers, body: init })).toBe(401)
    const token = readEndpoint(userData)!.token
    expect(await raw({ headers: { ...headers, authorization: 'Bearer wrong' }, body: init })).toBe(401)
    expect(
      await raw({
        headers: { ...headers, authorization: `Bearer ${token}`, host: 'evil.example' },
        body: init
      })
    ).toBe(403)
    // The health probe is authenticated too.
    expect(await raw({ method: 'GET', headers: {} })).toBe(401)
  })

  it('serves the catalogue, pins the session to the open model, and answers orientation', async () => {
    const { c, t } = client()
    await c.connect(t)
    expect(c.getInstructions()).toMatch(/FIRST call `orientation`/)
    const { tools } = await c.listTools()
    expect(tools[0].name).toBe('orientation')
    expect(tools.map((x) => x.name)).toContain('get_current_model')
    expect(tools.map((x) => x.name)).not.toContain('research_web')

    const current = await c.callTool({ name: 'get_current_model', arguments: {} })
    const text = (current.content as Array<{ type: string; text: string }>)[0].text
    expect(JSON.parse(text).active_model).toBe('Shampoo')

    const orient = await c.callTool({ name: 'orientation', arguments: {} })
    const o = (orient.content as Array<{ type: string; text: string }>)[0].text
    expect(o).toContain('`Shampoo`')
    expect(o).toContain('Footprint of 1 l shampoo')
    expect(o).toContain('`ecoinvent-3.12-cutoff`')
    expect(o).toContain('(test-client)')

    // The session is visible to the app, named after the client.
    const s = host.sessions()
    expect(s).toHaveLength(1)
    expect(s[0].clientName).toBe('test-client')
    expect(s[0].activeDb).toBe('Shampoo')
    expect(s[0].recent.map((r) => r.tool)).toEqual(['get_current_model', 'orientation'])
    await t.terminateSession()
    await c.close()
  })

  it('stamps every backend call with a per-call turn and the client label', async () => {
    const { c, t } = client()
    await c.connect(t)
    // undo is irreversible: without a window to show the card, the default mode refuses it.
    expect(host.setApproval(host.sessions()[0].id, 'never')).toBe(true)
    apiCalls.length = 0
    await c.callTool({ name: 'history', arguments: { action: 'undo' } })
    const call = apiCalls.find((x) => x.method === 'POST' && x.path.startsWith('/api/v1/model/'))!
    expect(call.headers?.['X-Prism-Client']).toBe('test-client 9.9')
    expect(call.headers?.['X-Prism-Turn']).toMatch(/^mcp-[0-9a-f]{8}-\d+$/)
    // A mutation asks the app to reload the model on screen.
    expect(events.some((e) => e.type === 'refresh' && e.database === 'Shampoo')).toBe(true)
    await t.terminateSession()
    await c.close()
  })

  it('answers a UI tool without a window with a readable error, not a hang', async () => {
    const { c, t } = client()
    await c.connect(t)
    const r = await c.callTool({ name: 'get_canvas', arguments: {} })
    expect(r.isError).toBe(true)
    expect((r.content as Array<{ text: string }>)[0].text).toMatch(/No window/)
    await t.terminateSession()
    await c.close()
  })

  it('asks the user before an irreversible call and refuses when unanswered or declined', async () => {
    const { c, t } = client()
    await c.connect(t)
    const text = (r: Awaited<ReturnType<Client['callTool']>>): string =>
      (r.content as Array<{ text: string }>)[0].text
    // Deleting a method family is irreversible (undo is not since V390: the agent may take back its
    // own change without a card). Default mode, no window: the card cannot be shown, the call is refused
    // with the way out.
    let r = await c.callTool({
      name: 'manage_method_family',
      arguments: { action: 'delete', family: 'Scratch' }
    })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/approval in the PrismLCA window/)
    expect(text(r)).toMatch(/canvas_view/)
    // The user declines on the card.
    const seen: Array<{ name: string; args: Record<string, unknown> }> = []
    uiImpl = async (name, args) => {
      seen.push({ name, args })
      return { approved: false }
    }
    r = await c.callTool({ name: 'manage_method_family', arguments: { action: 'delete', family: 'Scratch' } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/Declined by the user/)
    expect(seen[0]).toMatchObject({
      name: 'approve_tool',
      args: { tool: 'manage_method_family', effect: 'irreversible' }
    })
    // The user approves: the call runs, stamped like any other.
    uiImpl = async () => ({ approved: true })
    apiCalls.length = 0
    r = await c.callTool({ name: 'manage_method_family', arguments: { action: 'delete', family: 'Scratch' } })
    expect(r.isError).toBe(false)
    expect(apiCalls.some((x) => x.method === 'POST' && x.path === '/api/v1/lcia/family/delete')).toBe(true)
    // A plain write never shows a card in the default mode; a read never does in any mode.
    uiImpl = async (name) => ({ ok: true, asked: name })
    host.setApproval(host.sessions()[0].id, 'every-write')
    seen.length = 0
    uiImpl = async (name, args) => {
      seen.push({ name, args })
      return name === 'approve_tool' ? { approved: true } : { ok: true }
    }
    await c.callTool({ name: 'canvas_view', arguments: { action: 'layout' } })
    expect(seen.map((s) => s.name)).toEqual(['approve_tool', 'auto_layout'])
    seen.length = 0
    await c.callTool({ name: 'get_current_model', arguments: {} })
    expect(seen.map((s) => s.name)).toEqual(['get_state'])
    uiImpl = async () => {
      throw new Error('No window available for the UI action.')
    }
    await t.terminateSession()
    await c.close()
  })

  it('tells the client every interval that a card is waiting on the user (V3: progress)', async () => {
    setProgressEvery(15)
    const { c, t } = client()
    await c.connect(t)
    uiImpl = (name) =>
      name === 'approve_tool'
        ? new Promise((resolve) => setTimeout(() => resolve({ approved: false }), 120))
        : Promise.resolve({ ok: true })
    const messages: string[] = []
    const r = await c.callTool(
      { name: 'manage_method_family', arguments: { action: 'delete', family: 'Scratch' } },
      undefined,
      { onprogress: (p) => messages.push(p.message ?? '') }
    )
    expect(r.isError).toBe(true)
    expect(messages.length).toBeGreaterThan(0)
    expect(messages[0]).toMatch(/Waiting for the user's approval in PrismLCA \(1 min of up to 15\)/)
    setProgressEvery(30_000)
    uiImpl = async () => {
      throw new Error('No window available for the UI action.')
    }
    await t.terminateSession()
    await c.close()
  })

  it('reports the window state with the model, and follows open_model deliberately', async () => {
    uiImpl = async (name, args) =>
      name === 'get_state' ? { view: 'model', selected: ['p1'] } : { ok: true, opened: args.database }
    const { c, t } = client()
    await c.connect(t)
    const text = (r: Awaited<ReturnType<Client['callTool']>>): string =>
      (r.content as Array<{ text: string }>)[0].text
    let r = await c.callTool({ name: 'get_current_model', arguments: {} })
    expect(JSON.parse(text(r))).toMatchObject({
      active_model: 'Shampoo',
      app: { view: 'model', selected: ['p1'] }
    })
    r = await c.callTool({ name: 'canvas_view', arguments: { action: 'open_model', database: 'Soap' } })
    expect(r.isError).toBe(false)
    r = await c.callTool({ name: 'get_current_model', arguments: {} })
    expect(JSON.parse(text(r)).active_model).toBe('Soap')
    expect(host.sessions()[0].activeDb).toBe('Soap')
    uiImpl = async () => {
      throw new Error('No window available for the UI action.')
    }
    await t.terminateSession()
    await c.close()
  })

  it('holds writes while a background import runs, and lets reads through', async () => {
    const { c, t } = client()
    await c.connect(t)
    const text = (r: Awaited<ReturnType<Client['callTool']>>): string =>
      (r.content as Array<{ text: string }>)[0].text
    importing = true
    let r = await c.callTool({ name: 'edit_tags', arguments: { action: 'create_group', group: 'phase' } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/importing a background database/)
    r = await c.callTool({ name: 'get_current_model', arguments: {} })
    expect(r.isError).toBe(false)
    importing = false
    await t.terminateSession()
    await c.close()
  })

  it('refuses a tool the user switched off after the session started', async () => {
    const { c, t } = client()
    await c.connect(t)
    const text = (r: Awaited<ReturnType<Client['callTool']>>): string =>
      (r.content as Array<{ text: string }>)[0].text
    expect((await c.listTools()).tools.map((x) => x.name)).toContain('eurostat_eol')
    disabled = ['edit_tags']
    eurostatOn = false
    let r = await c.callTool({ name: 'edit_tags', arguments: { action: 'create_group', group: 'phase' } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/switched off/)
    r = await c.callTool({ name: 'eurostat_eol', arguments: { dataset: 'env_wasoper', queries: [] } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/switched off/)
    // The catalogue as advertised does not move under the client.
    expect((await c.listTools()).tools.map((x) => x.name)).toContain('edit_tags')
    disabled = []
    eurostatOn = true
    await t.terminateSession()
    await c.close()
  })

  it('binds the session to the project it was opened on, and ends it when the app switches', async () => {
    const { c, t } = client()
    await c.connect(t)
    const text = (r: Awaited<ReturnType<Client['callTool']>>): string =>
      (r.content as Array<{ text: string }>)[0].text
    expect(host.sessions()[0].project).toBe('proj-A')
    apiCalls.length = 0
    let r = await c.callTool({ name: 'list_models', arguments: {} })
    expect(r.isError).toBe(false)
    expect(apiCalls.find((x) => x.path === '/api/v1/databases')?.headers?.['X-Prism-Project']).toBe('proj-A')
    currentProject = 'proj-B'
    r = await c.callTool({ name: 'list_models', arguments: {} })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/active workspace changed/)
    r = await c.callTool({ name: 'get_current_model', arguments: {} })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/session has ended/)
    currentProject = 'proj-A'
    await t.terminateSession().catch(() => undefined)
    await c.close().catch(() => undefined)
  })

  it('refuses to open a session while the backend names no project, and encodes Unicode names', async () => {
    projectsDown = true
    const { c, t } = client()
    await expect(c.connect(t)).rejects.toThrow()
    projectsDown = false
    expect(host.sessions()).toEqual([])
    currentProject = 'Müller 研究'
    const { c: c2, t: t2 } = client()
    await c2.connect(t2)
    apiCalls.length = 0
    const r = await c2.callTool({ name: 'list_models', arguments: {} })
    expect(r.isError).toBe(false)
    const sent = apiCalls.find((x) => x.path === '/api/v1/databases')?.headers?.['X-Prism-Project']
    expect(sent).toBe(encodeURIComponent('Müller 研究'))
    expect(/^[\x21-\x7e]+$/.test(sent!)).toBe(true) // printable ASCII on the wire
    currentProject = 'proj-A'
    await t2.terminateSession().catch(() => undefined)
    await c2.close().catch(() => undefined)
  })

  it('a disconnect during an approval wait cancels the write', async () => {
    const { c, t } = client()
    await c.connect(t)
    let release: ((v: unknown) => void) | null = null
    uiImpl = (name) =>
      name === 'approve_tool'
        ? new Promise((resolve) => {
            release = resolve
          })
        : Promise.resolve({ ok: true })
    apiCalls.length = 0
    const pending = c
      .callTool({ name: 'manage_method_family', arguments: { action: 'delete', family: 'Scratch' } })
      .catch((e: unknown) => ({
        isError: true,
        content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }]
      }))
    for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 20))
    expect(release).not.toBeNull()
    // The user disconnects the session while its card is still open — then the card is answered.
    expect(await host.disconnect(host.sessions()[0].id)).toBe(true)
    release!({ approved: true })
    // The closed transport may never deliver the refusal to this client (the real client sees a
    // dropped connection); what matters is what the backend did NOT receive.
    await Promise.race([pending, new Promise((r) => setTimeout(r, 1500))])
    expect(apiCalls.some((x) => x.method === 'POST' && x.path === '/api/v1/lcia/family/delete')).toBe(false)
    uiImpl = async () => {
      throw new Error('No window available for the UI action.')
    }
    await c.close().catch(() => undefined)
  })

  it('in "Ask only before deleting", a delete switched off while its question is open does not run', async () => {
    // The tool's own question waits like the approval card does, and must recheck like it after.
    // Before the fix the answer "Delete" still reached the backend.
    const { c, t } = client()
    await c.connect(t)
    expect(host.setApproval(host.sessions()[0].id, 'never')).toBe(true)
    let asked = 0
    uiImpl = async (name) => {
      if (name !== 'ask_user') return { ok: true }
      asked++
      disabled = ['manage_method_family'] // switched off in Settings while the card waits
      return { answers: ['Delete'] }
    }
    apiCalls.length = 0
    const r = await c.callTool({
      name: 'manage_method_family',
      arguments: { action: 'delete', family: 'Scratch' }
    })
    expect(asked).toBe(1)
    expect(r.isError).toBe(true)
    expect((r.content as Array<{ text: string }>)[0].text).toMatch(/switched off/)
    expect(apiCalls.some((x) => x.method === 'POST' && x.path === '/api/v1/lcia/family/delete')).toBe(false)
    disabled = []
    uiImpl = async () => {
      throw new Error('No window available for the UI action.')
    }
    await t.terminateSession()
    await c.close()
  })

  it('removes the endpoint file when stopped, and ends the sessions', async () => {
    const { c, t } = client()
    await c.connect(t)
    expect(host.sessions().length).toBeGreaterThan(0)
    await host.stop()
    expect(existsSync(endpointPath(userData))).toBe(false)
    expect(host.sessions()).toEqual([])
    await c.close().catch(() => undefined)
    url = await host.start() // for afterAll's stop, and to prove a restart works
    expect(readEndpoint(userData)!.url).toBe(url)
  })
})
