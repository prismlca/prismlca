/**
 * The MCP bridge of a built program, started once the way an MCP client starts it: the binary with
 * `--mcp-proxy`, three pipes, JSON-RPC lines. The release job runs it on the packaged program
 * (`ci.mjs bridge-check`), so the program people install has answered a client before it is published;
 * the end-to-end suite runs the same check on the build tree, which is how it is tried on Windows
 * before a release depends on it.
 *
 * Required: `initialize` answered by PrismLCA of the version being released, in a form and protocol
 * version the MCP SDK's client accepts and with the tools capability; a tool list the SDK's client
 * accepts, with `orientation` in it; an answer to `ping` after a quiet moment; exit 0 once standard
 * input closes and the pipes released soon after; nothing on stdout but JSON-RPC. No app is running and
 * none is started — listing the tools does not launch one, so the check needs no display and no backend.
 *
 * Not checked here: processes the bridge leaves behind once it has exited and released its pipes. Which
 * processes it starts does not change with packaging, and the end-to-end suite looks for leftovers on
 * Linux and Windows on every pull request.
 *
 * The answers are judged by the schemas of the SDK the app ships, so the check needs `node_modules`;
 * ci.mjs loads it only for this command.
 */
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import {
  InitializeResultSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsResultSchema,
  SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/sdk/types.js'

export const BRIDGE_TIMEOUTS = {
  /** A packaged first start on a cold runner, virus scan included, is slow; a hang is not. */
  answerMs: 60_000,
  /** A client that is merely quiet is still there: the bridge must not take silence for leaving. */
  quietMs: 2_000,
  /** From the closed stdin to the bridge's exit. */
  exitMs: 20_000,
  /** From the exit to the end of its stdout and stderr; a helper still holding them is a leftover. */
  closeMs: 10_000
}

/** What the bridge writes on stderr when it ends because the client closed its standard input
 *  (src/main/mcp/proxyMain.ts) — the reason a client that leaves must cause, not any other. */
export const STDIN_CLOSED_LINE = 'The client closed standard input'

/**
 * The bridge's arguments: what a client puts after the program (`--mcp-proxy`, and on Linux the
 * headless platform, as Settings → AI → MCP writes it), `--no-sandbox` on Linux because the runners
 * have no setuid sandbox helper (the start check passes it too), and a user-data folder of the check's
 * own, so no settings or endpoint file of the machine it runs on are read.
 */
export function bridgeArgs(leading, userDataDir, platform = process.platform) {
  const linux = platform === 'linux' ? ['--ozone-platform=headless', '--no-sandbox'] : []
  return [...leading, '--mcp-proxy', ...linux, `--user-data-dir=${userDataDir}`]
}

/** The caller's environment without anything that would point the program somewhere else: PrismLCA
 *  and Brightway settings, Electron's run-as-Node switch and dev-server URL. Config goes below `dir`. */
export function bridgeEnv(base, dir) {
  const env = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || /^(PRISM_|BRIGHTWAY|ELECTRON_RUN_AS_NODE$|ELECTRON_RENDERER_URL$)/.test(k)) continue
    env[k] = v
  }
  env.XDG_CONFIG_HOME = join(dir, 'config')
  return env
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Why `schema` rejects `value`, in one line — or null when an SDK client would accept it. */
function rejected(schema, value) {
  const parsed = schema.safeParse(value)
  if (parsed.success) return null
  return parsed.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(answer)'}: ${issue.message}`)
    .join('; ')
}

/** `promise`, or `fallback` once `ms` have passed. The timer goes with the race: a pending one would keep
 *  the release step waiting for nothing after the bridge has long finished. */
function within(promise, ms, fallback) {
  let timer
  const late = new Promise((done) => (timer = setTimeout(() => done(fallback), ms)))
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

/**
 * Ends the bridge and whatever it started. On POSIX it leads its own process group (spawned detached),
 * which stays reserved while any member lives, so the group is safe to signal even after the bridge
 * itself has exited. On Windows the tree hangs on the bridge's pid, which may belong to a stranger
 * once the bridge is gone — so only while it still runs.
 */
function endTree(proc) {
  if (proc.pid === undefined) return
  if (process.platform === 'win32') {
    if (proc.exitCode === null && proc.signalCode === null)
      spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(-proc.pid, 'SIGKILL')
  } catch {
    /* the group is gone already */
  }
}

/**
 * Starts `command args` as an MCP client would and talks to it. Resolves with the problems found (empty
 * when the bridge did everything above), the bridge's log (stderr) and the number of tools it listed.
 */
export async function checkBridge({ command, args, env, version, timeouts = {} }) {
  const t = { ...BRIDGE_TIMEOUTS, ...timeouts }
  const problems = []
  const proc = spawn(command, args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32'
  })
  let log = ''
  proc.stderr.on('data', (b) => (log += b.toString()))
  // Writing to a bridge that is already gone fails with EPIPE; the request's own failure says it better.
  proc.stdin.on('error', () => {})
  const noise = []
  const waiting = new Map()
  let buffered = ''
  proc.stdout.on('data', (b) => {
    buffered += b.toString()
    for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
      const line = buffered.slice(0, nl).trim()
      buffered = buffered.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        msg = null
      }
      if (msg?.jsonrpc !== '2.0') noise.push(line)
      else if (typeof msg.id === 'number') waiting.get(msg.id)?.(msg)
    }
  })
  const exited = new Promise((done) => {
    proc.once('exit', (code, signal) => done(code ?? signal))
    proc.once('error', (e) => done(`not started: ${e.message}`))
  })
  let isClosed = false
  const closed = new Promise((done) =>
    proc.once('close', () => {
      isClosed = true
      done(true)
    })
  )
  const send = (msg) => proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
  let nextId = 1
  const request = (method, params) => {
    const id = nextId++
    const answer = new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no answer to ${method} within ${t.answerMs / 1000} s`)), t.answerMs)
      waiting.set(id, (msg) => {
        clearTimeout(timer)
        if (msg.error) fail(new Error(`${method} failed: ${JSON.stringify(msg.error)}`))
        else done(msg.result)
      })
      void exited.then((code) => {
        clearTimeout(timer)
        fail(new Error(`the bridge exited (${code}) before answering ${method}`))
      })
    })
    send({ id, method, params })
    return answer
  }

  let tools = 0
  try {
    // What the SDK's client checks before it calls a server connected, and what a client needs to list tools.
    const init = await request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'PrismLCA release check', version }
    })
    const badInit = rejected(InitializeResultSchema, init)
    if (badInit) problems.push(`an MCP client rejects the answer to initialize: ${badInit}`)
    else if (!SUPPORTED_PROTOCOL_VERSIONS.includes(init.protocolVersion))
      problems.push(`initialize settled on protocol version ${init.protocolVersion}, which MCP clients do not support`)
    if (badInit === null && !init.capabilities.tools) problems.push('initialize announces no tools capability')
    const server = init?.serverInfo ?? {}
    if (server.name !== 'PrismLCA') problems.push(`initialize answered as "${server.name}", not PrismLCA`)
    if (server.version !== version) problems.push(`the bridge reports version ${server.version}, the release is ${version}`)
    send({ method: 'notifications/initialized' })

    const list = await request('tools/list', {})
    const badList = rejected(ListToolsResultSchema, list)
    if (badList) problems.push(`an MCP client rejects the answer to tools/list: ${badList}`)
    const names = (Array.isArray(list?.tools) ? list.tools : []).map((tool) => tool?.name)
    tools = names.length
    if (!names.includes('orientation')) problems.push(`tools/list has no orientation (${names.length} tools)`)

    await sleep(t.quietMs)
    await request('ping')

    // The client leaves: its end of stdin closes, and the bridge must go on its own, with exit 0.
    proc.stdin.end()
    const code = await within(exited, t.exitMs, 'running')
    if (code === 'running') problems.push(`still running ${t.exitMs / 1000} s after its standard input closed`)
    else if (code !== 0) problems.push(`exited with ${code} when its standard input closed, not 0`)
    else {
      if (!(await within(closed, t.closeMs, false)))
        problems.push(`exited, but something it started still held its output open ${t.closeMs / 1000} s later`)
      if (!log.includes(STDIN_CLOSED_LINE)) problems.push(`its log does not say "${STDIN_CLOSED_LINE}"`)
    }
  } catch (e) {
    problems.push(e.message)
  } finally {
    // Whatever went wrong above, nothing of the bridge outlives the check.
    if (!isClosed) {
      endTree(proc)
      await within(closed, 5_000, false)
    }
  }
  if (buffered.trim()) noise.push(buffered.trim())
  if (noise.length) problems.push(`stdout carried ${noise.length} line(s) that are not protocol, first: ${noise[0].slice(0, 200)}`)
  return { problems, log, tools }
}
