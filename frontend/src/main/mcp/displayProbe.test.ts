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

import { ownerOf, sessionDisplaysOf, xServerOf, type ProbeRoots } from './displayProbe'

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
