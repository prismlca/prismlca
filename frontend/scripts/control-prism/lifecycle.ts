/**
 * Starting, restarting and stopping a session, each under the session's lock so two commands cannot act
 * on it at once, and cleaning up after a session whose host is gone.
 *
 * What a cleanup may end is decided by identity, never by a path in a command line: the host as recorded
 * at launch, the app's processes as the host last recorded them, the app's own Chromium processes (they
 * carry this session's profile folder as `--user-data-dir`), and what those started. A program someone
 * runs on the session's folders — a `tail` on a log, a database viewer — is not the session's.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { FRONTEND, freshInstall, removeInstall } from '../../e2e/app'
import { endAll, leftovers, listed, listProcesses, type ProcessInfo } from '../../e2e/processes'
import type { Parsed } from './args'
import { planBackend, withPathFirst } from './backend'
import { backendFingerprint, build, buildState } from './build'
import { Exit, out, send } from './client'
import { hostAlive } from './host'
import {
  controlDir,
  lockSession,
  newToken,
  NO_PATH_RULE,
  readSession,
  removeSession,
  updateSession,
  writeSession,
  type SessionRecord
} from './session'

function sessionProcesses(record: SessionRecord): ProcessInfo[] {
  const known = record.host ? [record.host, ...record.processes] : [...record.processes]
  const profile = `--user-data-dir=${record.install.userData}`
  for (const p of listProcesses()) if (p.command.includes(profile)) known.push(p)
  return leftovers(known, NO_PATH_RULE)()
}

/** Ends what a session left behind, removes its folders unless `keep`, and its record. */
export function cleanUpDead(record: SessionRecord, keep: boolean): string[] {
  const lines: string[] = []
  const left = sessionProcesses(record)
  if (left.length > 0) {
    endAll(left)
    lines.push(`ended what was still running:${listed(left)}`)
  } else lines.push('nothing of it was still running')
  if (!keep) {
    removeInstall(record.install)
    lines.push(`removed ${record.install.root}`)
  }
  removeSession(FRONTEND, record.name, record.token)
  return lines
}

/** The fingerprints of a build of the sources as they are now — building first unless --no-build forbids it. */
export function currentBuild(flags: Parsed['flags']): { src: string; out: string } {
  let state = buildState(FRONTEND)
  if (!state.current) {
    if (flags['no-build'])
      throw new Exit(1, `out/ is not current: ${state.reason}. Run build, or leave out --no-build.`)
    out(`out/ is not current (${state.reason})`)
    build(FRONTEND, out)
    state = buildState(FRONTEND)
    if (!state.current) throw new Exit(1, `out/ is still not current after the build: ${state.reason}`)
  }
  return { src: state.stamp.src, out: state.stamp.out }
}

function locked<T>(name: string, run: () => Promise<T>): Promise<T> {
  let release: () => void
  try {
    release = lockSession(FRONTEND, name)
  } catch (e) {
    return Promise.reject(new Exit(1, (e as Error).message))
  }
  return run().finally(release)
}

export function launch(name: string, bundle: string, flags: Parsed['flags']): Promise<void> {
  return locked(name, async () => {
    const existing = readSession(FRONTEND, name)
    if (existing) {
      if (hostAlive(existing, listProcesses())) {
        throw new Exit(
          1,
          `session "${name}" is running already — drive it, or stop it first (or use --session <other>)`
        )
      }
      out(`session "${name}" ended without stop; cleaning up first`)
      cleanUpDead(existing, false).forEach(out)
    }
    const stamp = currentBuild(flags)
    const idleMinutes = flags.idle === undefined ? 60 : Number(flags.idle)
    if (!Number.isFinite(idleMinutes) || idleMinutes < 1)
      throw new Exit(2, '--idle takes minutes (at least 1)')

    const install = freshInstall()
    const logs = join(controlDir(FRONTEND), 'logs', name)
    rmSync(logs, { recursive: true, force: true })
    mkdirSync(logs, { recursive: true })
    const plan = planBackend(FRONTEND, join(install.root, 'bin'))
    if (plan.warning) out(`warning: ${plan.warning}`)
    const record: SessionRecord = {
      name,
      frontend: FRONTEND,
      token: newToken(),
      status: 'starting',
      host: null,
      hostRecorded: false,
      install,
      mode: 'fresh',
      seeded: !!flags.seed,
      build: stamp,
      backendSrc: backendFingerprint(FRONTEND),
      backend: { via: plan.via, detail: plan.detail },
      logs,
      launchedAt: new Date().toISOString(),
      processes: [],
      idleMinutes
    }
    writeSession(record)
    // The app inherits the host's environment (minus what the end-to-end harness strips). An import path
    // set in the caller's shell would let the backend load another checkout's code: only the shim sets one.
    const env = { ...process.env }
    delete env.PYTHONPATH
    if (plan.pathDir) env.PATH = withPathFirst(plan.pathDir, process.env.PATH)
    const logFd = openSync(join(logs, 'host.out'), 'a')
    const child = spawn(process.execPath, [bundle, '__host', name], {
      cwd: FRONTEND,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env
    })
    child.unref()
    const host = listProcesses().find((p) => p.pid === child.pid) ?? null
    // The host waits for this before its first write, so the two never overwrite each other.
    updateSession(FRONTEND, name, record.token, { host, hostRecorded: true })

    out(
      `launching session "${name}" in ${install.root}${flags.seed ? ' (with seed — about a minute)' : ''} …`
    )
    const limit = Date.now() + (flags.seed ? 600_000 : 300_000)
    for (;;) {
      const now = readSession(FRONTEND, name)
      if (now?.token !== record.token)
        throw new Exit(1, `the record of session "${name}" was replaced meanwhile`)
      if (now.status === 'ready') {
        out(`ready: session "${name}", backend via ${plan.detail}`)
        out(`next: doctor, then drive (help lists the commands; frontend/features/ maps the pages)`)
        return
      }
      if (
        now.status === 'failed' ||
        now.status === 'exited' ||
        child.exitCode !== null ||
        Date.now() > limit
      ) {
        const why =
          now.status === 'failed' || now.status === 'exited'
            ? (now.detail ?? now.status)
            : child.exitCode !== null
              ? `the host exited (${child.exitCode})`
              : 'the launch took too long'
        cleanUpDead(now, true)
        throw new Exit(1, `the launch failed: ${why}\nlogs: ${logs} (host.log, host.out, app.log)`)
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  })
}

export function restart(record: SessionRecord, flags: Parsed['flags']): Promise<string> {
  return locked(record.name, async () => {
    const started = { build: currentBuild(flags), backendSrc: backendFingerprint(FRONTEND) }
    return send(record, 'restart', [JSON.stringify(started)], {})
  })
}

/** Stops through the host when it answers, and by identity when it does not. */
export function stop(record: SessionRecord, flags: Parsed['flags']): Promise<string[]> {
  return locked(record.name, async () => {
    if (record.status === 'ready' && hostAlive(record, listProcesses())) {
      try {
        const text = await send(record, 'stop', [], flags)
        // The host leaves a moment after its answer. Then whatever it could not end is ended here, and the
        // record goes.
        for (const until = Date.now() + 5000; hostAlive(record, listProcesses()) && Date.now() < until; ) {
          await new Promise((r) => setTimeout(r, 200))
        }
        return [text, ...cleanUpDead(record, true).filter((l) => !l.startsWith('nothing'))]
      } catch (e) {
        out(`the host did not stop the app (${(e as Error).message.split('\n')[0]}); ending it directly`)
      }
    }
    return cleanUpDead(record, !!flags.keep)
  })
}
