/**
 * The release job's bridge check against stand-in bridges: small Node programs that behave as a working
 * bridge does, or as a broken one has (or could). The check against the real program runs in the
 * end-to-end suite (e2e/bridge.e2e.ts) and in the release job itself.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { STDIN_CLOSED_LINE, bridgeArgs, bridgeEnv, checkBridge } from './bridge-check.mjs'

const VERSION = '1.2.3'
const FAST = { answerMs: 5_000, quietMs: 100, exitMs: 1_500, closeMs: 500 }

/** One stand-in, its behaviour chosen by its first argument. */
const FAKE = `
const { spawn } = require('node:child_process')
const mode = process.argv[2]
const out = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n')
process.stderr.write('[prism-mcp-bridge] ready\\n')
if (mode === 'leaves-at-once') setTimeout(() => process.exit(0), 50)
else {
  if (mode === 'noisy') process.stdout.write('Loading PrismLCA...\\n{"status":"ok"}\\n')
  let buf = ''
  process.stdin.on('data', (b) => {
    buf += b
    for (let nl = buf.indexOf('\\n'); nl >= 0; nl = buf.indexOf('\\n')) {
      const msg = JSON.parse(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      if (msg.id === undefined) continue
      if (msg.method === 'initialize')
        out({ id: msg.id, result: {
          protocolVersion: mode === 'future-protocol' ? '2099-01-01' : msg.params.protocolVersion,
          ...(mode === 'bare-init' ? {} : { capabilities: mode === 'no-tools-capability' ? {} : { tools: {} } }),
          serverInfo: { name: 'PrismLCA', version: mode === 'old' ? '0.0.1' : '${VERSION}' }
        } })
      else if (msg.method === 'tools/list') {
        const tool = (name) => (mode === 'no-schema' ? { name } : { name, inputSchema: { type: 'object' } })
        out({ id: msg.id, result: { tools: mode === 'no-tools' ? [] : [tool('orientation'), tool('calculate')] } })
      } else out({ id: msg.id, result: {} })
    }
  })
  process.stdin.on('end', () => {
    if (mode === 'stays') return setInterval(() => {}, 1000)
    process.stderr.write('[prism-mcp-bridge] ${STDIN_CLOSED_LINE} — exiting (code 0).\\n')
    // A helper that inherits the pipes and outlives the bridge — not long, so that a run on Windows,
    // where the check leaves a tree alone once its root has exited, does not wait for it either.
    if (mode === 'helper') spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { stdio: 'inherit' })
    process.exit(mode === 'fails' ? 1 : 0)
  })
}
`

let dir: string
let fake: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'prism-bridge-check-test-'))
  fake = join(dir, 'fake-bridge.cjs')
  writeFileSync(fake, FAKE)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = (mode: string): ReturnType<typeof checkBridge> =>
  checkBridge({ command: process.execPath, args: [fake, mode], env: { ...process.env }, version: VERSION, timeouts: FAST })

// Starting a process takes its time on a Windows runner; the stand-ins themselves are quick.
describe('release check of the MCP bridge', { timeout: 15_000 }, () => {
  it('passes a bridge that answers, stays while the client is quiet, and leaves with it', async () => {
    const { problems, tools, log } = await run('good')
    expect(problems).toEqual([])
    expect(tools).toBe(2)
    expect(log).toContain(STDIN_CLOSED_LINE)
  })

  it('fails a bridge that takes its input for closed and exits after "ready" (Electron on Windows)', async () => {
    const { problems } = await run('leaves-at-once')
    expect(problems).toEqual(['the bridge exited (0) before answering initialize'])
  })

  it('fails a bridge that is still running after its client left, and ends it', async () => {
    const { problems } = await run('stays')
    expect(problems).toEqual(['still running 1.5 s after its standard input closed'])
  })

  it('fails a bridge whose client leaving is not an exit 0', async () => {
    expect((await run('fails')).problems).toEqual(['exited with 1 when its standard input closed, not 0'])
  })

  it('fails anything on stdout that is not protocol', async () => {
    const { problems } = await run('noisy')
    expect(problems).toEqual(['stdout carried 2 line(s) that are not protocol, first: Loading PrismLCA...'])
  })

  it('fails another program or another version, and a catalogue without orientation', async () => {
    expect((await run('old')).problems).toEqual(['the bridge reports version 0.0.1, the release is 1.2.3'])
    expect((await run('no-tools')).problems).toEqual(['tools/list has no orientation (0 tools)'])
  })

  it('fails answers an MCP client would reject, judged by the SDK the app ships', async () => {
    expect((await run('bare-init')).problems).toEqual([
      'an MCP client rejects the answer to initialize: capabilities: Invalid input: expected object, received undefined'
    ])
    expect((await run('future-protocol')).problems).toEqual([
      'initialize settled on protocol version 2099-01-01, which MCP clients do not support'
    ])
    expect((await run('no-tools-capability')).problems).toEqual(['initialize announces no tools capability'])
    expect((await run('no-schema')).problems).toEqual([
      'an MCP client rejects the answer to tools/list: tools.0.inputSchema: Invalid input: expected object, received undefined; ' +
        'tools.1.inputSchema: Invalid input: expected object, received undefined'
    ])
  })

  it('fails a bridge that exits but leaves a helper holding its pipes', async () => {
    const { problems } = await run('helper')
    expect(problems).toEqual(['exited, but something it started still held its output open 0.5 s later'])
  })

  it('fails a program that cannot be started at all', async () => {
    const { problems } = await checkBridge({
      command: join(dir, 'missing'),
      args: [],
      env: { ...process.env },
      version: VERSION,
      timeouts: FAST
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^the bridge exited \(not started: .*ENOENT.*\) before answering initialize$/)
  })
})

describe('how the release check starts the bridge', () => {
  it('as a client does, plus a user-data folder of its own and no sandbox helper on Linux', () => {
    expect(bridgeArgs([], '/tmp/x/user-data', 'linux')).toEqual([
      '--mcp-proxy',
      '--ozone-platform=headless',
      '--no-sandbox',
      '--user-data-dir=/tmp/x/user-data'
    ])
    expect(bridgeArgs([], 'C:\\t\\user-data', 'win32')).toEqual(['--mcp-proxy', '--user-data-dir=C:\\t\\user-data'])
    expect(bridgeArgs(['/repo/frontend'], 'D', 'darwin')).toEqual(['/repo/frontend', '--mcp-proxy', '--user-data-dir=D'])
  })

  it('without settings that would point it at another data folder or turn it into Node', () => {
    const env = bridgeEnv(
      {
        PATH: '/usr/bin',
        PRISM_BUILD_KIND: 'release',
        PRISM_DATA_DIR: '/home/me/prism',
        BRIGHTWAY2_DIR: '/home/me/bw',
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_RENDERER_URL: 'http://localhost:5173',
        ELECTRON_ENABLE_LOGGING: '1',
        XDG_CONFIG_HOME: '/home/me/.config'
      },
      '/tmp/x'
    )
    expect(env).toEqual({
      PATH: '/usr/bin',
      ELECTRON_ENABLE_LOGGING: '1',
      XDG_CONFIG_HOME: join('/tmp/x', 'config')
    })
  })
})
