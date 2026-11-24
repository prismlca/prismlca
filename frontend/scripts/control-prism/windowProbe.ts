/**
 * Asks the window itself, past the driver. Playwright reaches the app through a DevTools port, which
 * Chromium also names in the profile (`DevToolsActivePort`: the port, then the browser's own path). A
 * connection of our own there evaluates a plain expression in the main window: when it answers while every
 * command times out, the driver is stuck, not the app — Playwright's own calls cannot tell, since they are
 * what is stuck. It also reads whether any client is attached to the window; Playwright keeps one attached
 * for as long as it holds the window, so none means its hold is gone.
 *
 * The browser's path carries an id of that one start of the app: a port left in a stale file and taken by
 * another program since does not lead to its windows.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withDeadline } from './waits'

/** How long the whole probe may take. */
export const PROBE_MS = 10_000

export type WindowProbe =
  /** The DevTools port could not be reached at all. */
  | { outcome: 'unreachable'; why: string }
  /** The browser process took the connection but did not answer about its windows. */
  | { outcome: 'browser-silent'; why: string }
  /** The browser answered, but has no main window (the renderer from a file:, not the splash). */
  | { outcome: 'no-window'; pages: string[] }
  /** The main window did not answer a plain evaluation in time. */
  | { outcome: 'window-silent'; attached: boolean; why: string }
  | { outcome: 'answers'; attached: boolean; ms: number; readyState: string }

export interface Connection {
  send(method: string, params?: object, sessionId?: string): Promise<Record<string, unknown>>
  close(): void
}
export type Connect = (url: string) => Promise<Connection>

interface TargetInfo {
  targetId: string
  type: string
  url: string
  attached: boolean
}

/** The browser endpoint the app named in its profile, or null when it named none. */
export function devToolsEndpoint(userData: string): string | null {
  try {
    const [port, path] = readFileSync(join(userData, 'DevToolsActivePort'), 'utf8').trim().split('\n')
    if (!/^\d+$/.test(port ?? '') || !path?.startsWith('/devtools/browser/')) return null
    return `ws://127.0.0.1:${port}${path.trim()}`
  } catch {
    return null
  }
}

/** A DevTools connection over Node's own WebSocket (Node 22 and later). */
export const connectWebSocket: Connect = (url) =>
  new Promise((resolve, reject) => {
    const Socket = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
    if (!Socket) {
      reject(new Error('this Node has no WebSocket (Node 22 and later have)'))
      return
    }
    const ws = new Socket(url)
    const waiting = new Map<number, { ok: (r: Record<string, unknown>) => void; fail: (e: Error) => void }>()
    let next = 1
    let open = false
    const failAll = (e: Error): void => {
      for (const w of waiting.values()) w.fail(e)
      waiting.clear()
    }
    ws.onopen = () => {
      open = true
      resolve({
        send: (method, params = {}, sessionId) =>
          new Promise((ok, fail) => {
            const id = next++
            waiting.set(id, { ok, fail })
            ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
          }),
        close: () => {
          failAll(new Error('closed'))
          ws.close()
        }
      })
    }
    ws.onmessage = (m: MessageEvent) => {
      const d = JSON.parse(String(m.data)) as {
        id?: number
        result?: Record<string, unknown>
        error?: { message: string }
      }
      const w = d.id === undefined ? undefined : waiting.get(d.id)
      if (!w) return
      waiting.delete(d.id!)
      if (d.error) w.fail(new Error(d.error.message))
      else w.ok(d.result ?? {})
    }
    ws.onerror = () => {
      if (!open) reject(new Error('the connection failed'))
      else failAll(new Error('the connection broke'))
    }
    ws.onclose = () => failAll(new Error('the connection closed'))
  })

const first = (e: unknown): string => (e as Error).message.split('\n')[0]

/** Asks the main window of the app whose profile is `userData` for its `document.readyState`. */
export async function probeWindow(
  userData: string,
  { connect = connectWebSocket, ms = PROBE_MS }: { connect?: Connect; ms?: number } = {}
): Promise<WindowProbe> {
  const endpoint = devToolsEndpoint(userData)
  if (!endpoint) {
    return { outcome: 'unreachable', why: `the app named no DevTools port in ${userData}/DevToolsActivePort` }
  }
  const until = Date.now() + ms
  const left = (): number => Math.max(until - Date.now(), 1)
  const late = `no answer within ${ms / 1000} s`
  let conn: Connection
  try {
    conn = await withDeadline(connect(endpoint), left(), late)
  } catch (e) {
    return { outcome: 'unreachable', why: `its DevTools port did not take a connection (${first(e)})` }
  }
  try {
    let targets: TargetInfo[]
    try {
      targets = ((await withDeadline(conn.send('Target.getTargets'), left(), late)).targetInfos ??
        []) as TargetInfo[]
    } catch (e) {
      return { outcome: 'browser-silent', why: first(e) }
    }
    // The splash is a data: URL; the main window loads the renderer from a file (e2e/app.ts).
    const pages = targets.filter((t) => t.type === 'page')
    const main = pages.find((t) => t.url.startsWith('file:'))
    if (!main) return { outcome: 'no-window', pages: pages.map((t) => t.url) }
    try {
      const { sessionId } = (await withDeadline(
        conn.send('Target.attachToTarget', { targetId: main.targetId, flatten: true }),
        left(),
        late
      )) as { sessionId: string }
      const started = Date.now()
      const answer = (await withDeadline(
        conn.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId),
        left(),
        late
      )) as { result?: { value?: unknown } }
      const took = Date.now() - started
      // Not awaited: the answer is in, and closing the connection detaches as well.
      conn.send('Target.detachFromTarget', { sessionId }).catch(() => undefined)
      return {
        outcome: 'answers',
        attached: main.attached,
        ms: took,
        readyState: String(answer.result?.value)
      }
    } catch (e) {
      return { outcome: 'window-silent', attached: main.attached, why: first(e) }
    }
  } finally {
    conn.close()
  }
}
