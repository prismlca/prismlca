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
import { mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { FRONTEND, freshInstall, installIn, removeInstall, type Install } from '../../e2e/app'
import { planBackend } from '../../e2e/backend'
import { endAll, leftovers, listed, listProcesses, type ProcessInfo } from '../../e2e/processes'
import type { Parsed } from './args'
import { backendFingerprint, build, buildState } from './build'
import { Exit, out, send } from './client'
import {
  chooseProfile,
  CloneUnsupported,
  CopyError,
  copiesDir,
  size,
  personFolders,
  takeCopy,
  type CopyReport
} from './copy'
import { readConsoleFile } from './consoleLog'
import { hostAlive } from './host'
import { SEAL_LOG } from './sealed'
import { copyKeys, forgetKeys } from './keys'
import {
  controlDir,
  keptCopyNotice,
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

/** Ends what a session left behind, removes its stored keys, its folders unless `keep`, and its record.
 *  The keys go first and on their own: removing the folders is best effort, and a key that stayed must
 *  leave the record in place for another try. */
export function cleanUpDead(record: SessionRecord, keep: boolean): string[] {
  const lines: string[] = []
  const left = sessionProcesses(record)
  if (left.length > 0) {
    endAll(left)
    lines.push(`ended what was still running:${listed(left)}`)
  } else lines.push('nothing of it was still running')
  let hadKeys: boolean
  try {
    hadKeys = forgetKeys(record.install.userData)
  } catch (e) {
    throw new Exit(1, `${(e as Error).message} — remove it, then run stop again`)
  }
  if (!keep) {
    removeInstall(record.install)
    lines.push(`removed ${record.install.root}`)
  } else if (hadKeys) lines.push(`kept ${record.install.root}, without the stored keys`)
  removeSession(FRONTEND, record.name, record.token)
  return lines
}

/** Removes folders prepared for a session that never got its record (keys first, see cleanUpDead). */
function discard(install: Install): void {
  forgetKeys(install.userData)
  removeInstall(install)
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

interface Prepared {
  install: Install
  mode: SessionRecord['mode']
  copy?: CopyReport
  keys: string[] | null
}

/** The session's folders: fresh ones, or a copy of the person's data and profile — with their stored keys
 *  only when asked. */
async function prepareInstall(name: string, flags: Parsed['flags']): Promise<Prepared> {
  const wantsKeys = !!flags.keys
  const person = personFolders()
  const profile = chooseProfile(person.profiles)
  if ((flags.copy || wantsKeys) && profile === null) {
    throw new Exit(1, `found no PrismLCA profile to copy from (looked in ${person.profiles.join(', ')})`)
  }
  const withKeys = (install: Install): string[] | null => {
    if (!wantsKeys) return null
    const keys = copyKeys(profile!, install.userData)
    out(keys.length > 0 ? `with your stored keys: ${keys.join(', ')}` : `${profile} has no stored keys`)
    return keys
  }
  if (!flags.copy) {
    const install = freshInstall()
    try {
      return { install, mode: 'fresh', keys: withKeys(install) }
    } catch (e) {
      discard(install)
      throw e
    }
  }
  const base = copiesDir()
  mkdirSync(base, { recursive: true })
  const install = installIn(mkdtempSync(join(base, `${name}-`)))
  out(`copying your data (${person.data}) and profile (${profile}) to ${install.root} …`)
  const started = Date.now()
  try {
    const copy = await takeCopy(
      { data: person.data, profile: profile!, install, full: !!flags['full-copy'] },
      out
    )
    out(
      `copied ${copy.files} files (${size(copy.bytes)}${copy.shared ? ', blocks shared with yours' : ''}) ` +
        `in ${((Date.now() - started) / 1000).toFixed(1)} s${copy.attempts > 1 ? ` on try ${copy.attempts}` : ''}`
    )
    return { install, mode: 'copy', copy, keys: withKeys(install) }
  } catch (e) {
    discard(install)
    if (e instanceof CloneUnsupported) {
      throw new Exit(
        1,
        `${e.message}. A full copy takes as much space as your data (${person.data}) and a while; ` +
          'pass --full-copy to make one.'
      )
    }
    if (e instanceof CopyError) throw new Exit(1, e.message)
    throw e
  }
}

export function launch(name: string, bundle: string, flags: Parsed['flags']): Promise<void> {
  if (flags.copy && (flags.seed || flags.fresh))
    return Promise.reject(
      new Exit(2, `--${flags.seed ? 'seed' : 'fresh'} means an empty install; a --copy has your data already`)
    )
  if (flags['full-copy'] && !flags.copy)
    return Promise.reject(new Exit(2, '--full-copy says how to --copy; it needs --copy'))
  if (flags.sealed && flags.keys)
    return Promise.reject(
      new Exit(2, '--keys is of no use to a --sealed instance: it refuses the providers the keys are for')
    )
  return locked(name, async () => {
    const existing = readSession(FRONTEND, name)
    if (existing) {
      if (hostAlive(existing, listProcesses())) {
        throw new Exit(
          1,
          `session "${name}" is running already — drive it, or stop it first (or use --session <other>)`
        )
      }
      const kept = keptCopyNotice(existing)
      if (kept) throw new Exit(1, `${kept} — or launch with --session <other> for a new one`)
      out(`session "${name}" ended without stop; cleaning up first`)
      cleanUpDead(existing, false).forEach(out)
    }
    const stamp = currentBuild(flags)
    const idleMinutes = flags.idle === undefined ? 60 : Number(flags.idle)
    if (!Number.isFinite(idleMinutes) || idleMinutes < 1)
      throw new Exit(2, '--idle takes minutes (at least 1)')

    const { install, mode, copy, keys } = await prepareInstall(name, flags)
    const logs = join(controlDir(FRONTEND), 'logs', name)
    let plan: ReturnType<typeof planBackend>
    let record: SessionRecord
    try {
      rmSync(logs, { recursive: true, force: true })
      mkdirSync(logs, { recursive: true })
      // launch() in the host applies the same plan; asked here to report it and to record it for doctor.
      plan = planBackend(FRONTEND)
      record = {
        name,
        frontend: FRONTEND,
        token: newToken(),
        status: 'starting',
        host: null,
        hostRecorded: false,
        install,
        mode,
        ...(copy ? { copy } : {}),
        seeded: !!flags.seed,
        keys,
        seal: flags.sealed ? join(logs, SEAL_LOG) : null,
        build: stamp,
        backendSrc: backendFingerprint(FRONTEND),
        backend: { via: plan.via, detail: plan.detail },
        logs,
        launchedAt: new Date().toISOString(),
        processes: [],
        idleMinutes
      }
      writeSession(record)
    } catch (e) {
      // Until the record is written nothing knows these folders: a copy, and keys in it, must not stay.
      discard(install)
      throw e
    }
    if (plan.warning) out(`warning: ${plan.warning}`)
    out(
      `launching ${flags.sealed ? 'sealed ' : ''}session "${name}" in ${install.root}` +
        `${flags.seed ? ' (with seed — about a minute)' : ''}` +
        `${mode === 'copy' ? ' (your data: the backend loads it and its search model — up to a minute)' : ''} …`
    )
    try {
      await startHost(record, bundle, flags.seed ? 600_000 : 300_000)
    } catch (e) {
      if (!(e instanceof HostFailed)) throw e
      cleanUpDead(e.record, true)
      throw new Exit(1, `the launch failed: ${e.message}\nlogs: ${logs} (host.log, host.out, app.log)`)
    }
    out(`ready: session "${name}", backend via ${plan.detail}`)
    if (record.seal) out(`sealed: what it refuses goes to ${record.seal} (refused lists it)`)
    out(`next: doctor, then drive (help lists the commands; frontend/features/ maps the pages)`)
  })
}

/** The host did not get the app's window; what it started is ended, the record is the caller's to settle. */
class HostFailed extends Error {
  constructor(
    readonly record: SessionRecord,
    message: string
  ) {
    super(message)
  }
}

/** Starts the host of the written `record` and waits until it has the window, at most `ms`. */
async function startHost(record: SessionRecord, bundle: string, ms: number): Promise<void> {
  // The host inherits this environment unchanged; launch() strips what must not reach the app.
  const logFd = openSync(join(record.logs, 'host.out'), 'a')
  const child = spawn(process.execPath, [bundle, '__host', record.name], {
    cwd: FRONTEND,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd]
  })
  child.unref()
  const host = listProcesses().find((p) => p.pid === child.pid) ?? null
  // The host waits for this before its first write, so the two never overwrite each other.
  updateSession(FRONTEND, record.name, record.token, { host, hostRecorded: true })
  const limit = Date.now() + ms
  for (;;) {
    const now = readSession(FRONTEND, record.name)
    if (now?.token !== record.token)
      throw new Exit(1, `the record of session "${record.name}" was replaced meanwhile`)
    if (now.status === 'ready') return
    if (now.status === 'failed' || now.status === 'exited' || child.exitCode !== null || Date.now() > limit) {
      const why =
        now.status === 'failed' || now.status === 'exited'
          ? (now.detail ?? now.status)
          : child.exitCode !== null
            ? `the host exited (${child.exitCode})`
            : 'it took too long'
      const left = sessionProcesses(now)
      if (left.length > 0) endAll(left)
      throw new HostFailed(now, why)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}

export function restart(record: SessionRecord, bundle: string, flags: Parsed['flags']): Promise<string> {
  return locked(record.name, async () => {
    const now = readSession(FRONTEND, record.name)
    if (now?.token !== record.token)
      throw new Exit(1, `the record of session "${record.name}" was replaced meanwhile; ask again`)
    if (!hostAlive(now, listProcesses()) && keptCopyNotice(now)) return revive(now, bundle, flags)
    const started = { build: currentBuild(flags), backendSrc: backendFingerprint(FRONTEND) }
    return send(now, 'restart', [JSON.stringify(started)], {})
  })
}

/**
 * Starts the app again on the copy a session kept when it ended without stop (keptCopyNotice) — the idle
 * stop, the app closing, the host dying: the same session, launched at the same time, on the same folders
 * and logs, so what was built there can be driven again (and the run tools that know the session by its
 * launch time still know it). It starts without the stored keys, which left the copy with the idle stop.
 */
async function revive(record: SessionRecord, bundle: string, flags: Parsed['flags']): Promise<string> {
  const lines: string[] = []
  const left = sessionProcesses(record)
  if (left.length > 0) {
    endAll(left)
    lines.push(`ended what was still running of it:${listed(left)}`)
  }
  if (forgetKeys(record.install.userData)) lines.push('removed the stored keys it still had')
  const build = currentBuild(flags)
  const plan = planBackend(FRONTEND)
  const next: SessionRecord = {
    ...record,
    token: newToken(),
    status: 'starting',
    detail: undefined,
    port: undefined,
    host: null,
    hostRecorded: false,
    keys: null,
    build,
    backendSrc: backendFingerprint(FRONTEND),
    backend: { via: plan.via, detail: plan.detail },
    processes: [],
    idleKept: undefined
  }
  // Counted before the new host starts: what it logs from here on is this start's.
  const seen = readConsoleFile(join(record.logs, 'console.log')).length
  writeSession(next)
  if (plan.warning) lines.push(`warning: ${plan.warning}`)
  lines.forEach(out)
  out(
    `starting session "${record.name}" again on its copy in ${record.install.root} (the backend loads it ` +
      'and its search model — up to a minute) …'
  )
  try {
    await startHost(next, bundle, 300_000)
  } catch (e) {
    if (!(e instanceof HostFailed)) throw e
    // The copy and the record stay: restart can try again, stop removes them.
    const detail = `the app did not start again on the copy: ${e.message}`
    updateSession(FRONTEND, next.name, next.token, { status: 'failed', detail })
    throw new Exit(1, `${detail}\nlogs: ${record.logs} (host.log, host.out, app.log)`)
  }
  return (
    `the app runs again on the copy of session "${record.name}", without stored keys; backend via ` +
    `${plan.detail}\nthe console counts on from before: console --since ${seen} shows only this start's ` +
    'messages\nnext: doctor, then drive'
  )
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
