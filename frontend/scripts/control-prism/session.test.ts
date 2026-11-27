import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { keptCopyNotice, lockSession, type SessionRecord } from './session'

describe('lockSession', () => {
  let frontend: string
  let lock: string
  const children: ChildProcess[] = []

  beforeEach(() => {
    frontend = mkdtempSync(join(tmpdir(), 'cp-lock-'))
    mkdirSync(join(frontend, '.cache', 'control-prism', 'sessions'), { recursive: true })
    lock = join(frontend, '.cache', 'control-prism', 'sessions', 'default.lock')
  })
  afterEach(() => {
    for (const c of children.splice(0)) c.kill('SIGKILL')
    rmSync(frontend, { recursive: true, force: true })
  })

  /** A process that sleeps; `marker` lands on its command line. */
  async function sleeper(marker: string): Promise<ChildProcess> {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', marker], { stdio: 'ignore' })
    children.push(child)
    await new Promise((r) => setTimeout(r, 300))
    return child
  }

  it('takes a free lock and gives it back', () => {
    const release = lockSession(frontend, 'default')
    expect(existsSync(lock)).toBe(true)
    release()
    expect(existsSync(lock)).toBe(false)
  })

  it('gives back only its own lock', () => {
    const release = lockSession(frontend, 'default')
    writeFileSync(lock, '424242')
    release()
    expect(existsSync(lock)).toBe(true)
  })

  it('refuses while another control-prism command holds it', async () => {
    const holder = await sleeper('control-prism-holder')
    writeFileSync(lock, String(holder.pid))
    expect(() => lockSession(frontend, 'default')).toThrow(`pid ${holder.pid}`)
  })

  it('takes over a lock whose holder is gone, or whose pid now belongs to something else', async () => {
    writeFileSync(lock, '999999999')
    lockSession(frontend, 'default')()
    const stranger = await sleeper('not-the-driver')
    writeFileSync(lock, String(stranger.pid))
    lockSession(frontend, 'default')()
  })

  it('takes over a lock written before its pid was handed to the process that has it now', async () => {
    const later = await sleeper('control-prism-later')
    writeFileSync(lock, String(later.pid))
    const before = new Date(Date.now() - 60_000)
    utimesSync(lock, before, before)
    lockSession(frontend, 'default')()
  })
})

describe('keptCopyNotice', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cp-kept-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const ended = (patch: Partial<SessionRecord>): SessionRecord =>
    ({
      name: 'run',
      mode: 'copy',
      status: 'exited',
      idleMinutes: 240,
      install: { root, data: join(root, 'data'), userData: join(root, 'user-data'), downloads: '' },
      ...patch
    }) as SessionRecord

  it('sends a copy that is over to restart or stop, never to a launch that would remove it', () => {
    // The copy holds what was built in it — a practice run's models nobody has decided about yet.
    const notice = keptCopyNotice(ended({ idleKept: true }))
    expect(notice).toContain('the idle stop ended it after 240 min without a command')
    expect(notice).toContain(`still in ${root}`)
    expect(notice).toMatch(
      /restart starts the app on it again \(without stored keys\); stop removes the copy/
    )
    expect(notice).not.toContain('launch')
    expect(keptCopyNotice(ended({}))).toContain('(it ended without stop)')
  })

  it('has nothing to say about a fresh session, nor about a copy whose folder is gone', () => {
    expect(keptCopyNotice(ended({ mode: 'fresh' }))).toBeNull()
    rmSync(root, { recursive: true, force: true })
    expect(keptCopyNotice(ended({ idleKept: true }))).toBeNull()
  })
})
