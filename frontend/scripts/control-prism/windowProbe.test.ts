import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { devToolsEndpoint, probeWindow, type Connect, type Connection } from './windowProbe'

const MAIN = 'file:///w/frontend/out/renderer/index.html'
const never = (): Promise<Record<string, unknown>> => new Promise(() => undefined)

/** A DevTools connection that answers each method as `answers` says, and records what was sent. */
function fake(
  answers: Record<string, (params: object, sessionId?: string) => Promise<Record<string, unknown>>>
) {
  const sent: string[] = []
  let closed = false
  const connect: Connect = async (url) => {
    sent.push(`connect ${url}`)
    const conn: Connection = {
      send: (method, params = {}, sessionId) => {
        sent.push(sessionId ? `${method} @${sessionId}` : method)
        const answer = answers[method]
        return answer ? answer(params, sessionId) : Promise.reject(new Error(`unexpected ${method}`))
      },
      close: () => {
        closed = true
      }
    }
    return conn
  }
  return { connect, sent, closed: () => closed }
}

const targets =
  (...pages: { url: string; attached?: boolean }[]) =>
  async () => ({
    targetInfos: [
      { targetId: 'svc', type: 'service_worker', url: 'file:///sw.js', attached: false },
      ...pages.map((p, i) => ({ targetId: `t${i}`, type: 'page', url: p.url, attached: p.attached ?? true }))
    ]
  })

describe('probeWindow', () => {
  let userData: string
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'probe-'))
    writeFileSync(join(userData, 'DevToolsActivePort'), '39065\n/devtools/browser/117df028\n')
  })
  afterEach(() => rmSync(userData, { recursive: true, force: true }))

  it("reads the browser's endpoint from the profile, and nothing that is not one", () => {
    expect(devToolsEndpoint(userData)).toBe('ws://127.0.0.1:39065/devtools/browser/117df028')
    writeFileSync(join(userData, 'DevToolsActivePort'), '39065\n/json/list\n')
    expect(devToolsEndpoint(userData)).toBeNull()
    writeFileSync(join(userData, 'DevToolsActivePort'), 'port\n/devtools/browser/x\n')
    expect(devToolsEndpoint(userData)).toBeNull()
    expect(devToolsEndpoint(join(userData, 'missing'))).toBeNull()
  })

  it('asks the main window, not the splash, and says whether the driver still holds it', async () => {
    const f = fake({
      'Target.getTargets': targets({ url: 'data:text/html,splash' }, { url: MAIN, attached: false }),
      'Target.attachToTarget': async (p) => {
        expect(p).toEqual({ targetId: 't1', flatten: true })
        return { sessionId: 'S' }
      },
      'Runtime.evaluate': async () => ({ result: { type: 'string', value: 'complete' } }),
      'Target.detachFromTarget': async () => ({})
    })
    const probe = await probeWindow(userData, { connect: f.connect })
    expect(probe).toMatchObject({ outcome: 'answers', attached: false, readyState: 'complete' })
    expect(f.sent).toEqual([
      'connect ws://127.0.0.1:39065/devtools/browser/117df028',
      'Target.getTargets',
      'Target.attachToTarget',
      'Runtime.evaluate @S',
      'Target.detachFromTarget'
    ])
    expect(f.closed()).toBe(true)
  })

  it('tells a window that does not answer from a browser that does not', async () => {
    const silentWindow = fake({
      'Target.getTargets': targets({ url: MAIN }),
      'Target.attachToTarget': async () => ({ sessionId: 'S' }),
      'Runtime.evaluate': never
    })
    expect(await probeWindow(userData, { connect: silentWindow.connect, ms: 50 })).toEqual({
      outcome: 'window-silent',
      attached: true,
      why: 'no answer within 0.05 s'
    })
    expect(silentWindow.closed()).toBe(true)

    const silentBrowser = fake({ 'Target.getTargets': never })
    expect(await probeWindow(userData, { connect: silentBrowser.connect, ms: 50 })).toEqual({
      outcome: 'browser-silent',
      why: 'no answer within 0.05 s'
    })
  })

  it('says when there is no main window, no port, or no connection', async () => {
    const splashOnly = fake({ 'Target.getTargets': targets({ url: 'data:text/html,splash' }) })
    expect(await probeWindow(userData, { connect: splashOnly.connect })).toEqual({
      outcome: 'no-window',
      pages: ['data:text/html,splash']
    })

    const refused: Connect = () => Promise.reject(new Error('the connection was refused'))
    expect(await probeWindow(userData, { connect: refused })).toEqual({
      outcome: 'unreachable',
      why: 'its DevTools port did not take a connection (the connection was refused)'
    })

    rmSync(join(userData, 'DevToolsActivePort'))
    expect(await probeWindow(userData, { connect: refused })).toMatchObject({
      outcome: 'unreachable',
      why: expect.stringMatching(/named no DevTools port/)
    })
  })
})
