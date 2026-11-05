/**
 * The real probes against stand-ins in a temporary directory: sockets this test process listens on
 * itself, lock files, a fake logind tree. Nothing here looks at the machine's own displays.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ownerOf, sessionDisplaysOf, tcpListenersOf, xServerOf, type ProbeRoots } from './displayProbe'

const linux = process.platform === 'linux'
const uid = process.getuid?.() ?? -1

let dir: string
let roots: ProbeRoots
const servers: Server[] = []
const children: ChildProcess[] = []

function listen(path: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(path, () => {
      servers.push(s)
      resolve(s)
    })
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prism-xprobe-'))
  roots = { x11Dir: join(dir, 'x11'), lockDir: dir, proc: '/proc', logind: join(dir, 'systemd') }
  mkdirSync(roots.x11Dir)
})

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()))
  for (const c of children.splice(0)) c.kill()
  rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!linux)('xServerOf', () => {
  it('confirms a server process that holds both listeners of its display', async () => {
    const path = join(roots.x11Dir, 'X7')
    await listen(path)
    await listen(`\0${path}`)
    writeFileSync(join(dir, '.X7-lock'), `${String(process.pid).padStart(10)}\n`)
    expect(xServerOf('7', roots)).toEqual({ uid, holds: true })
    expect(ownerOf(path)).toMatchObject({ uid, socket: true, dir: false })
  })

  it('does not confirm a server without the abstract listener', async () => {
    const path = join(roots.x11Dir, 'X7')
    await listen(path)
    writeFileSync(join(dir, '.X7-lock'), `${process.pid}\n`)
    expect(xServerOf('7', roots)).toEqual({ uid, holds: false })
  })

  it('does not confirm a process that holds neither listener', async () => {
    const path = join(roots.x11Dir, 'X7')
    await listen(path)
    await listen(`\0${path}`)
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    children.push(other)
    writeFileSync(join(dir, '.X7-lock'), `${other.pid}\n`)
    expect(xServerOf('7', roots)).toEqual({ uid, holds: false })
  })

  it('finds no server behind a lock naming no live process, a link or a malformed lock', async () => {
    const lock = join(dir, '.X7-lock')
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf-8'
    }).stdout
    writeFileSync(lock, `${gone}\n`)
    expect(xServerOf('7', roots)).toBeNull()
    rmSync(lock)
    writeFileSync(join(dir, 'real-lock'), `${process.pid}\n`)
    symlinkSync(join(dir, 'real-lock'), lock)
    expect(xServerOf('7', roots)).toBeNull()
    rmSync(lock)
    writeFileSync(lock, 'not a pid\n')
    expect(xServerOf('7', roots)).toBeNull()
    expect(xServerOf('../7', roots)).toBeNull()
  })

  it('reads no lock that is not a regular file', () => {
    const lock = join(dir, '.X7-lock')
    const made = spawnSync('mkfifo', [lock])
    if (made.status !== 0) return // no mkfifo here: nothing to check
    const t0 = Date.now()
    expect(xServerOf('7', roots)).toBeNull()
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})

describe('sessionDisplaysOf', () => {
  function logind(users: Record<string, string>, sessions: Record<string, string>): void {
    mkdirSync(join(roots.logind, 'users'), { recursive: true })
    mkdirSync(join(roots.logind, 'sessions'), { recursive: true })
    for (const [u, text] of Object.entries(users)) writeFileSync(join(roots.logind, 'users', u), text)
    for (const [id, text] of Object.entries(sessions)) writeFileSync(join(roots.logind, 'sessions', id), text)
  }

  it("lists the displays of the user's live sessions only", () => {
    logind(
      { '1000': 'NAME=u\nSTATE=active\nSESSIONS=2 c1 5 9\n', '1001': 'SESSIONS=7\n' },
      {
        '2': 'UID=1000\nSTATE=active\nTYPE=x11\nDISPLAY=:0\n',
        c1: 'UID=1000\nSTATE=online\nTYPE=tty\n',
        '5': 'UID=1000\nSTATE=closing\nDISPLAY=:1\n',
        '9': 'UID=1001\nSTATE=active\nDISPLAY=:2\n',
        '7': 'UID=1001\nSTATE=active\nDISPLAY=:3\n'
      }
    )
    expect(sessionDisplaysOf(1000, roots)).toEqual([':0'])
    expect(sessionDisplaysOf(1001, roots)).toEqual([':3'])
    expect(sessionDisplaysOf(1002, roots)).toEqual([])
  })

  it('skips session ids that are not plain names', () => {
    logind({ '1000': 'SESSIONS=../users/1000 2\n' }, { '2': 'UID=1000\nSTATE=online\nDISPLAY=:4.0\n' })
    expect(sessionDisplaysOf(1000, roots)).toEqual([':4'])
  })
})

describe('tcpListenersOf', () => {
  const head =
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
  const row = (addr: string, st: string, uid: number): string =>
    `   0: ${addr} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  ${uid}        0 1 1 0 100 0 0 10 0`

  it('lists the owners of loopback and wildcard listeners on the port, IPv4 and IPv6', () => {
    const proc = join(dir, 'proc')
    mkdirSync(join(proc, 'net'), { recursive: true })
    writeFileSync(
      join(proc, 'net', 'tcp'),
      [
        head,
        row('0100007F:177A', '0A', 1000), // 127.0.0.1:6010
        row('00000000:177A', '0A', 1001), // 0.0.0.0:6010
        row('0100A8C0:177A', '0A', 1002), // 192.168.0.1:6010, not loopback
        row('0100007F:177A', '01', 1003), // a connection, not a listener
        row('0100007F:177B', '0A', 1004) // another port
      ].join('\n')
    )
    writeFileSync(
      join(proc, 'net', 'tcp6'),
      [
        head,
        row('00000000000000000000000001000000:177A', '0A', 1000), // ::1
        row('0000000000000000FFFF00000100007F:177A', '0A', 1005), // ::ffff:127.0.0.1
        row('00000000000000000000000000000000:177A', '0A', 1006), // ::
        row('B80D0120000000000000000001000000:177A', '0A', 1007) // 2001:db8::1, not loopback
      ].join('\n')
    )
    expect(tcpListenersOf(6010, { ...roots, proc })).toEqual([1000, 1001, 1000, 1005, 1006])
    expect(tcpListenersOf(6012, { ...roots, proc })).toEqual([])
    expect(tcpListenersOf(6010, { ...roots, proc: join(dir, 'missing') })).toEqual([])
  })
})
