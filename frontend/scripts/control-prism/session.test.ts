import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lockSession } from './session'

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
