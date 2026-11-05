/**
 * A chat turn and a report write name the workspace they started in on every backend request, so a
 * request that arrives after the user switched workspace is refused by the backend's project guard.
 * The handlers are registered against a fake ipcMain and called by channel; a fake backend plays the
 * guard (409 when the named workspace is not the active one).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'prism-pin-ipc-'))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getPath: () => dir, getAppPath: () => dir, isPackaged: false },
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn), on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] }
}))

type ApiRaw = (
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
) => Promise<{ status: number; body: unknown }>

/** What the mocked agent and writer do in the middle of their run: the switch, then a request. */
const during = vi.hoisted(() => ({ step: async (_api: unknown): Promise<unknown> => undefined }))

vi.mock('../ai/agent', () => ({
  runAgent: async (_req: unknown, deps: { apiRaw: ApiRaw }) => {
    await during.step(deps.apiRaw)
    return { text: 'done', aborted: false, outcome: 'answered', turnId: 'turn-1', trace: [] }
  }
}))
vi.mock('../ai/client', () => ({ transcribeAudio: async () => '' }))
vi.mock('./distance', () => ({ distanceKeys: () => ({}) }))
vi.mock('../distance/service', () => ({
  computeDistances: async () => ({}),
  distancesAvailable: () => false
}))
vi.mock('../ai/reportWriter', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../ai/reportWriter')>()
  const write = async (o: { api: (m: string, p: string) => Promise<unknown> }): Promise<unknown> => {
    await during.step(o.api)
    return { text: 'chapter', model: 'm', lookups: [], findings: [], attempts: 1, figure: null }
  }
  return { ...orig, writeSection: write, writeAll: write }
})

const { registerChatIpc } = await import('./chat')
const { registerReportIpc } = await import('./report')
const { UiBridge } = await import('./uiBridge')

/** The backend: one active workspace, the guard on `X-Prism-Project`, every request recorded. */
let active = 'Main'
const seen: Array<{ method: string; path: string; project?: string; status: number }> = []
const apiRequest: ApiRaw = async (method, path, _body, headers) => {
  const named = headers?.['X-Prism-Project']
  const project = named === undefined ? undefined : decodeURIComponent(named)
  const status = project !== undefined && project !== active ? 409 : 200
  seen.push({ method, path, project, status })
  if (status === 409) return { status, body: { error: { code: 'project_changed', message: 'switched' } } }
  if (path === '/api/v1/system/info') return { status, body: { current_project: { name: active } } }
  return { status, body: {} }
}

beforeEach(() => {
  handlers.clear()
  seen.length = 0
  active = 'Main Ü'
  const controllers = new Map<string, AbortController>()
  registerChatIpc(
    { apiRequest, getWindow: () => null },
    controllers,
    new UiBridge({ getWindow: () => null, emit: () => {} })
  )
  registerReportIpc({ apiRequest, getWindow: () => null }, controllers)
})

describe('a run is bound to the workspace it started in', () => {
  it('names it on every request of a chat turn, and the request after a switch is refused', async () => {
    let answer: { status: number } | undefined
    during.step = async (api) => {
      active = 'Restored copy'
      answer = await (api as ApiRaw)('POST', '/api/v1/model/process', {}, { 'X-Prism-Turn': 'turn-1' })
    }
    await handlers.get('ai:send')!(null, {
      chatId: 'c1',
      model: '',
      activeDb: 'Twin',
      history: [],
      userText: 'go'
    })
    expect(answer?.status).toBe(409)
    const run = seen.filter((r) => r.path !== '/api/v1/system/info')
    expect(run.length).toBeGreaterThan(2)
    for (const r of run) expect(r.project, r.path).toBe('Main Ü')
    // The answer is not saved into the other workspace's chat either.
    expect(seen.find((r) => r.path.endsWith('/messages'))?.status).toBe(409)
  })

  it('names it on every request of a report write', async () => {
    const answers: number[] = []
    during.step = async (api) => {
      await (api as (m: string, p: string) => Promise<unknown>)('GET', '/api/v1/report/brief')
      active = 'Restored copy'
      await (api as (m: string, p: string) => Promise<unknown>)('POST', '/api/v1/report/store').catch(
        (e: { status?: number }) => answers.push(e.status ?? 0)
      )
    }
    await handlers.get('ai:writeSection')!({ sender: { send: () => {} } }, { brief: {}, database: 'Twin' })
    expect(answers).toEqual([409])
    active = 'Main Ü'
    await handlers.get('ai:writeAll')!(
      { sender: { send: () => {} } },
      { base: '/x', waves: [], database: 'Twin' }
    )
    const run = seen.filter((r) => r.path !== '/api/v1/system/info')
    expect(run.map((r) => r.project)).toEqual(['Main Ü', 'Main Ü', 'Main Ü', 'Main Ü'])
  })
})
