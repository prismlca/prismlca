/**
 * The stdio bridge (`--mcp-proxy`) started the way an MCP client starts it: the built app's own binary,
 * three pipes, JSON-RPC lines. No app is running and none is started — listing the tools must not launch
 * one — so the test needs no backend and is over in seconds.
 *
 * It is here, in the suite that also runs on Windows, because what it guards is the platform's doing:
 * Electron gives a Windows process an empty standard input, and a bridge reading that one took the
 * client for gone and exited right after "ready". Nothing a unit test fakes shows that.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { FRONTEND, cleanEnv, freshInstall, removeInstall, type Install } from './app'
import { endAll, listed, processTree, type ProcessInfo } from './processes'

/** In Node, the `electron` package is the path of its binary. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ELECTRON = require('electron') as unknown as string

const ANSWER_MS = 60_000
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

interface Bridge {
  proc: ChildProcess
  /** The bridge's log (stderr). */
  log: () => string
  /** What stdout carried that is not a JSON-RPC line — the protocol stream must carry nothing else.
   *  Complete only once `closed` has resolved. */
  noise: () => string[]
  request: (method: string, params?: unknown) => Promise<unknown>
  notify: (method: string) => void
  exited: Promise<number | null>
  /** The process is gone AND its output has been read to the end; `exit` alone comes before the last
   *  lines of the log have arrived. */
  closed: Promise<void>
}

function startBridge(install: Install): Bridge {
  const proc = spawn(
    ELECTRON,
    [
      FRONTEND,
      `--user-data-dir=${install.userData}`,
      '--mcp-proxy',
      // As the app writes it into a client's configuration on Linux, plus the runners' missing sandbox helper.
      ...(process.platform === 'linux' ? ['--ozone-platform=headless', '--no-sandbox'] : [])
    ],
    { cwd: FRONTEND, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  )
  let log = ''
  proc.stderr?.on('data', (b: Buffer) => (log += b.toString()))
  const noise: string[] = []
  const waiting = new Map<number, (result: unknown) => void>()
  let buffered = ''
  proc.stdout?.on('data', (b: Buffer) => {
    buffered += b.toString()
    for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
      const line = buffered.slice(0, nl).trim()
      buffered = buffered.slice(nl + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }
        if (typeof msg.id === 'number') waiting.get(msg.id)?.(msg.error ? { error: msg.error } : msg.result)
      } catch {
        noise.push(line)
      }
    }
  })
  const exited = new Promise<number | null>((done) => proc.once('exit', (code) => done(code)))
  const closed = new Promise<void>((done) => proc.once('close', () => done()))
  let nextId = 1
  const send = (msg: object): void => {
    proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
  }
  return {
    proc,
    log: () => log,
    noise: () => (buffered.trim() ? [...noise, buffered.trim()] : noise),
    exited,
    closed,
    notify: (method) => send({ method }),
    request: (method, params) => {
      const id = nextId++
      const answer = new Promise<unknown>((done, fail) => {
        const timer = setTimeout(
          () =>
            fail(new Error(`No answer to ${method} within ${ANSWER_MS / 1000} s. The bridge's log:\n${log}`)),
          ANSWER_MS
        )
        waiting.set(id, (result) => {
          clearTimeout(timer)
          done(result)
        })
        void exited.then((code) => {
          clearTimeout(timer)
          fail(new Error(`The bridge exited (code ${code}) before answering ${method}. Its log:\n${log}`))
        })
      })
      send({ id, method, params })
      return answer
    }
  }
}

/**
 * What of the snapshot `before` is still running. A process counts only if it is the same one — same
 * pid AND same command line — or names the test's data folder: Windows hands the pid of an exited
 * process to the next one that starts, and a stranger with a recycled pid is not a leftover of ours.
 */
function stillRunning(before: ProcessInfo[], install: Install): ProcessInfo[] {
  return processTree(
    before.map((p) => p.pid),
    install.root
  ).filter(
    (p) => p.command.includes(install.root) || before.some((b) => b.pid === p.pid && b.command === p.command)
  )
}

test('the stdio bridge answers a client over pipes, stays, and leaves when the client does', async () => {
  const install = freshInstall()
  const bridge = startBridge(install)
  const pid = bridge.proc.pid
  try {
    const init = (await bridge.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'PrismLCA end-to-end test', version: '0' }
    })) as { serverInfo?: { name?: string } }
    expect(init.serverInfo?.name).toBe('PrismLCA')
    bridge.notify('notifications/initialized')

    // No app is running: the built-in catalogue answers, and nothing is started for it.
    const listed1 = (await bridge.request('tools/list', {})) as { tools?: { name: string }[] }
    expect(listed1.tools?.map((t) => t.name)).toContain('orientation')

    // A client that is merely quiet is still there.
    await sleep(2000)
    expect(bridge.proc.exitCode).toBeNull()
    expect(await bridge.request('ping')).toEqual({})

    // The client goes: its end of stdin closes, and the bridge ends on its own, saying why.
    const before = processTree(pid === undefined ? [] : [pid], install.root)
    bridge.proc.stdin?.end()
    const code = await Promise.race([bridge.exited, sleep(20_000).then(() => 'still running' as const)])
    expect(code, bridge.log()).toBe(0)
    // The log and stdout are complete once the pipes are closed. Bounded: a helper process that outlived
    // the bridge would hold them open, and the leftover check below is what names it.
    await Promise.race([bridge.closed, sleep(10_000)])
    expect(bridge.log()).toContain('[prism-mcp-bridge] ready')
    expect(bridge.log()).toContain('The client closed standard input')
    expect(bridge.noise()).toEqual([])

    let left = stillRunning(before, install)
    for (const until = Date.now() + 10_000; left.length > 0 && Date.now() < until; ) {
      await sleep(500)
      left = stillRunning(before, install)
    }
    expect(left.length, `The bridge exited, but what it started is still running:${listed(left)}`).toBe(0)
  } finally {
    // Whatever went wrong above, nothing of this bridge outlives the test: its helpers name the test's
    // own data folder, and the main process is taken by its pid only while it is still ours — the pid of
    // a process that has exited may belong to anything by now.
    const alive = bridge.proc.exitCode === null && bridge.proc.signalCode === null && pid !== undefined
    const left = processTree(alive ? [pid] : [], install.root)
    if (left.length > 0) {
      endAll(left)
      await Promise.race([bridge.closed, sleep(5_000)])
    }
    removeInstall(install)
  }
})
