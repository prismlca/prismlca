/**
 * `doctor`: whether what the session drives can stand as a witness for the checkout. Three questions, each
 * answered from what the processes report about themselves rather than from what the launch intended:
 *
 * - Is the running app the build of the checkout as it is now? (stamp, fingerprints, renderer URL, app path)
 * - Does the instance belong to this session? (record in this checkout, host answering with its token)
 * - Do its data and profile live in folders of its own? (the main process's paths and environment; on Linux
 *   also the backend's environment and the files the app's processes hold open)
 * - What does it hold? A copy of the person's data says where from and when, the search embeds the way
 *   its index was built, and stored provider keys are there only when launch was asked for them — and
 *   then readable.
 * - Can it be driven? Whether the window answers a plain question asked past the driver (windowProbe.ts),
 *   and what the driver is busy with — so a stuck driver is not taken for a frozen window, nor the other
 *   way round.
 *
 * The facts are gathered in two places — the host knows the app (facts.ts), the command line knows the
 * checkout — and judged in one pure function, so the verdicts can be tested without an app.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, posix, relative, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppFacts } from './facts'
import type { SessionRecord } from './session'
import type { DriverState } from './watchdog'
import type { WindowProbe } from './windowProbe'

export interface DoctorInput {
  frontend: string
  record: SessionRecord
  app: AppFacts | null
  /** Why the host did not answer, when it did not. */
  hostError?: string
  /** What the window said when asked past the driver; null when it was not asked. */
  window: WindowProbe | null
  current: { src: string; out: string | null; backend: string }
  stamp: { src: string; out: string } | null
  realDirs: string[]
  /** Files under the real dirs modified since the launch. */
  realChanged: string[]
  /** The checkout's provider key files (`.secrets/*-key`). */
  devKeyFiles: string[]
  /** The names a developer's backend/.env sets. */
  backendEnvKeys: string[]
}

export type Status = 'ok' | 'FAIL' | 'note'
export interface Check {
  status: Status
  text: string
}

/** Whether `path` is `dir` or lies inside it. */
export function inside(path: string, dir: string): boolean {
  const r = relative(resolve(dir), resolve(path))
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

/** The folders a normal start of PrismLCA uses for this user: Electron's profile and the engine's data. */
export function realDirs(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = homedir()
): string[] {
  // Paths in the platform's own form, also when a test asks for another platform's folders.
  if (platform === 'win32') {
    const at = win32.join
    const roaming = env.APPDATA ?? at(home, 'AppData', 'Roaming')
    const local = env.LOCALAPPDATA ?? at(home, 'AppData', 'Local')
    return [at(roaming, 'prism-lca'), at(roaming, 'PrismLCA'), at(local, 'Prism LCA')]
  }
  const at = posix.join
  if (platform === 'darwin') {
    const support = at(home, 'Library', 'Application Support')
    return [at(support, 'prism-lca'), at(support, 'PrismLCA'), at(support, 'Prism LCA')]
  }
  const config = env.XDG_CONFIG_HOME || at(home, '.config')
  const data = env.XDG_DATA_HOME || at(home, '.local', 'share')
  return [at(config, 'prism-lca'), at(config, 'PrismLCA'), at(data, 'Prism LCA')]
}

/** Files under `dirs` modified after `since` (ms), at most `limit` of them. */
export function changedSince(dirs: string[], since: number, limit = 20): string[] {
  const found: string[] = []
  const visit = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (found.length >= limit) return
      const full = join(dir, e.name)
      if (e.isDirectory()) visit(full)
      else {
        try {
          if (statSync(full).mtimeMs > since) found.push(full)
        } catch {
          /* gone meanwhile */
        }
      }
    }
  }
  for (const d of dirs) if (existsSync(d)) visit(d)
  return found
}

const short = (h: string | null | undefined): string => (h ? h.slice(0, 10) : 'none')

export function judge(input: DoctorInput): Check[] {
  const { record, app, frontend } = input
  const checks: Check[] = []
  const add = (ok: boolean, good: string, bad: string): void => {
    checks.push(ok ? { status: 'ok', text: good } : { status: 'FAIL', text: bad })
  }

  // Ownership
  add(
    resolve(record.frontend) === resolve(frontend),
    `the session "${record.name}" was launched from this checkout`,
    `the session record names ${record.frontend}, not this checkout — it is not yours to drive`
  )
  if (!app) {
    checks.push({ status: 'FAIL', text: hostSilent(input) })
    return checks
  }
  add(
    app.alive,
    "the app is running and its host answers with this session's token",
    'the app is not running — run stop, then launch'
  )
  checks.push(...judgeDriving(input.window, app.driver))
  add(
    resolve(app.appPath) === resolve(frontend),
    `the app runs from this checkout (${app.appPath})`,
    `the app runs from ${app.appPath}, not from this checkout`
  )

  // Build
  const { current, stamp } = input
  add(
    stamp !== null && current.out !== null && stamp.out === current.out && stamp.src === current.src,
    `out/ is the build of the sources as they are now (sources ${short(current.src)})`,
    stamp === null
      ? 'out/ carries no control-prism stamp, so nobody knows what it was built from — run restart (it builds first)'
      : current.out !== stamp.out
        ? 'out/ changed after control-prism built it — run restart (it builds first)'
        : `the sources changed since the build (built from ${short(stamp.src)}, now ${short(current.src)}) — run restart (it builds first)`
  )
  add(
    record.build.src === current.src && record.build.out === current.out,
    'the running app was started from that build',
    'the running app was started from an older build — run restart (it builds first and keeps the data)'
  )
  add(
    record.backendSrc === current.backend,
    'the backend runs the backend sources as they are now',
    'the backend sources changed since the app started, and the backend still runs the old ones — run restart'
  )
  const outUrl = pathToFileURL(join(frontend, 'out', 'renderer')).href
  add(
    app.rendererUrl.startsWith(outUrl) && !app.env.ELECTRON_RENDERER_URL,
    'the window shows the built renderer from out/',
    `the window shows ${app.rendererUrl}, not the built renderer in out/`
  )

  // Isolation
  const root = record.install.root
  const own = (label: string, value: string | null): void =>
    add(
      value !== null && inside(value, root),
      `${label} is the session's own (${value})`,
      value === null
        ? `${label} is not set — the app would use your real one`
        : `${label} is ${value}, outside the session's folder ${root}`
    )
  own('userData', app.userData)
  own('PRISM_DATA_DIR', app.env.PRISM_DATA_DIR)
  own('XDG_CONFIG_HOME', app.env.XDG_CONFIG_HOME)
  own('PRISM_DOWNLOAD_DIR', app.env.PRISM_DOWNLOAD_DIR)
  own('PRISM_BRIGHTWAY_DIR', app.env.PRISM_BRIGHTWAY_DIR)
  add(
    !app.env.BRIGHTWAY2_DIR,
    "Brightway's own BRIGHTWAY2_DIR is not passed in",
    `BRIGHTWAY2_DIR is passed in (${app.env.BRIGHTWAY2_DIR})`
  )
  const keyVars = app.keyVars.filter((k) => k.set).map((k) => k.name)
  add(
    keyVars.length === 0,
    'no provider key from your environment reaches the app',
    `provider keys from your environment reach the app (${keyVars.join(', ')}) — a check could spend on them`
  )
  if (input.devKeyFiles.length > 0) {
    add(
      !!app.env.PRISM_IGNORE_DEV_KEYS,
      `the checkout's key files (${input.devKeyFiles.length} in .secrets/) are not read by the app`,
      `the app reads the checkout's key files in .secrets/ — a check could spend on them`
    )
  }
  checks.push(...judgeKeys(record, app))
  checks.push(...judgeData(record, app))
  for (const real of input.realDirs) {
    for (const [label, value] of [
      ['userData', app.userData],
      ['PRISM_DATA_DIR', app.env.PRISM_DATA_DIR]
    ] as const) {
      if (value && (inside(value, real) || inside(real, value))) {
        checks.push({ status: 'FAIL', text: `${label} (${value}) overlaps your real profile ${real}` })
      }
    }
  }
  if (app.backends === null) {
    checks.push({
      status: 'note',
      text: "the backend's own environment is only read on Linux; not checked here"
    })
  } else if (app.backends.length === 0) {
    checks.push({ status: 'FAIL', text: "no backend process found among the app's processes" })
  } else {
    for (const b of app.backends) {
      add(
        b.dataDir !== null && inside(b.dataDir, root),
        `the backend (pid ${b.pid}) keeps its data in ${b.dataDir}`,
        `the backend (pid ${b.pid}) has PRISM_DATA_DIR=${b.dataDir}, outside ${root}`
      )
      const backendDir = resolve(frontend, '..', 'backend')
      add(
        b.cwd !== null && resolve(b.cwd) === backendDir,
        `the backend runs in this checkout's backend/`,
        `the backend runs in ${b.cwd}, not in ${backendDir}`
      )
      add(
        b.brightwayDir !== null && inside(b.brightwayDir, root),
        `the backend keeps its Brightway projects in ${b.brightwayDir}`,
        `the backend has PRISM_BRIGHTWAY_DIR=${b.brightwayDir}, outside ${root}`
      )
      if (!record.keys) {
        add(
          b.keySettings.length === 0,
          'the backend has no provider key (nor one from backend/.env)',
          `the backend has provider keys (${b.keySettings.join(', ')}) though launch was not asked for them — ` +
            'its search could spend on them'
        )
      }
      const src = join(backendDir, 'src')
      const first = (b.pythonPath ?? '').split(/[:;]/).find((p) => p !== '')
      if (record.backend.via === 'shim') {
        add(
          first !== undefined && resolve(first) === src,
          `the backend imports this worktree's code first (${src})`,
          `the backend's PYTHONPATH (${b.pythonPath}) does not start with this worktree's backend/src`
        )
      } else {
        add(
          first === undefined,
          'no PYTHONPATH reaches the backend',
          `the backend has PYTHONPATH=${b.pythonPath}, which can put another checkout's code first`
        )
        add(
          b.editableSrc !== null && resolve(b.editableSrc) === src,
          `the backend's environment installs this checkout's code (${b.editableSrc})`,
          b.editableSrc === null
            ? "the backend's environment shows no editable install of this checkout's code"
            : `the backend's environment installs ${b.editableSrc}, not this checkout's backend/src`
        )
      }
    }
  }
  if (app.openInRealDirs !== null) {
    add(
      app.openInRealDirs.length === 0,
      "none of the app's processes holds a file of your real profile open",
      `the app's processes hold files of your real profile open: ${app.openInRealDirs.slice(0, 5).join(', ')}`
    )
  }
  if (input.backendEnvKeys.length > 0) {
    checks.push({
      status: 'note',
      text:
        `backend/.env sets ${input.backendEnvKeys.join(', ')}; the instance overrides PRISM_DATA_DIR, ` +
        'PRISM_BRIGHTWAY_DIR and the provider keys, the rest applies to it'
    })
  }
  if (input.realChanged.length > 0) {
    checks.push({
      status: 'note',
      text:
        `${input.realChanged.length}${input.realChanged.length >= 20 ? '+' : ''} file(s) in your real profile changed since the ` +
        `launch (e.g. ${input.realChanged.slice(0, 3).join(', ')}). If your own PrismLCA is running, that is ` +
        'it; the checks above say whether this instance could have.'
    })
  }
  return checks
}

const secs = (ms: number): string => `${Math.round(ms / 1000)} s`

/** The window's answer to a plain question, in a few words. */
function answered(w: Extract<WindowProbe, { outcome: 'answers' }>): string {
  return `document ${w.readyState}, ${w.ms} ms`
}

/** The host did not answer: whether the window does says whether the driver or the app is stuck. */
export function hostSilent(input: DoctorInput): string {
  const host = `the host does not answer${input.hostError ? ` (${input.hostError})` : ''}`
  const w = input.window
  const logs = `the window's console so far is in ${input.record.logs}/console.log`
  switch (w?.outcome) {
    case 'answers':
      return (
        `${host}, but the window does (${answered(w)})${w.attached ? '' : ' — and nothing holds it any more'}: ` +
        `the driver is stuck, not the app. restart keeps the data; when that gets no answer either, stop ` +
        `ends the session (${logs})`
      )
    case 'window-silent':
    case 'browser-silent':
      return (
        `${host}, and neither does the window (${w.why}): the app itself is frozen or busy — run doctor ` +
        `again in a minute; if it stays so, stop ends the session (${logs})`
      )
    case 'no-window':
      return `${host}, and the app has no main window open — run stop, then launch`
    case 'unreachable':
      return `${host}, and the window could not be asked past it (${w.why}) — run stop, then launch`
    default:
      return `${host} — run stop, then launch`
  }
}

/** With the host answering: whether the window answers past the driver, the driver still holds it, and
 *  the driver is free. */
export function judgeDriving(w: WindowProbe | null, driver: DriverState | undefined): Check[] {
  const checks: Check[] = []
  switch (w?.outcome) {
    case 'answers':
      checks.push(
        w.attached
          ? { status: 'ok', text: `the window answers a plain question past the driver (${answered(w)})` }
          : {
              status: 'FAIL',
              text:
                `the window answers a plain question past the driver (${answered(w)}), but nothing holds it ` +
                'any more: the driver has lost the window — restart (it keeps the data)'
            }
      )
      break
    case 'window-silent':
      checks.push({
        status: 'FAIL',
        text:
          `the window does not answer a plain question past the driver (${w.why}): it is frozen or busy — ` +
          'run doctor again in a minute; if it stays so, restart'
      })
      break
    case 'browser-silent':
      checks.push({
        status: 'FAIL',
        text: `the app does not answer on its DevTools port (${w.why}): it is frozen or busy — run doctor again in a minute`
      })
      break
    case 'no-window':
      checks.push({
        status: 'FAIL',
        text: `the app has no main window open${w.pages.length ? ` (its pages: ${w.pages.join(', ')})` : ''}`
      })
      break
    case 'unreachable':
      checks.push({ status: 'note', text: `the window could not be asked past the driver: ${w.why}` })
      break
  }
  if (driver?.outstanding) {
    const o = driver.outstanding
    checks.push({
      status: 'FAIL',
      text:
        `the driver gave up on ${o.what} ${secs(o.ms)} ago, and it has not settled: it may still land, so ` +
        'nothing is driven until it has — restart frees the session'
    })
  }
  // A look given up on cannot act, but a call into Playwright that never answers is a stuck driver's mark.
  const overdue = driver?.overdue ?? []
  if (overdue.length > 0) {
    const named = overdue.slice(0, 3).map((o) => `${o.what} (${secs(o.ms)} ago)`)
    checks.push({
      status: 'note',
      text:
        `the driver gave up on ${named.join(', ')}${overdue.length > 3 ? ` and ${overdue.length - 3} more` : ''}, ` +
        'and Playwright has not answered since: when more commands are given up on, the driver is stuck — restart'
    })
  }
  for (const b of driver?.busy ?? []) {
    checks.push({
      status: 'note',
      text:
        `the driver is busy with ${b.what} for ${secs(b.ms)}` +
        (b.leftMs === null ? '' : ` (it gives up on it in ${secs(Math.max(b.leftMs, 0))})`) +
        '; commands wait their turn behind it'
    })
  }
  return checks
}

/** The person's stored keys: absent unless launch was asked for them, and readable when it was. */
export function judgeKeys(record: SessionRecord, app: AppFacts): Check[] {
  const stored = app.storedKeys.map((k) => k.provider)
  // Older session records have no `keys`: they were launched without.
  if (!record.keys) {
    return stored.length === 0
      ? [{ status: 'ok', text: "no provider key is stored in the session's profile" }]
      : [
          {
            status: 'FAIL',
            text:
              `the session's profile holds stored keys (${stored.join(', ')}) though launch was not asked ` +
              'for them — typed in during the session, or copied by mistake; a check could spend on them'
          }
        ]
  }
  if (stored.length === 0) {
    return [
      {
        status: 'note',
        text: 'launch was asked for your stored keys, but there were none — a chat will ask for a key'
      }
    ]
  }
  const unreadable = app.storedKeys.filter((k) => !k.readable).map((k) => k.provider)
  if (unreadable.length > 0) {
    return [
      {
        status: 'FAIL',
        text:
          `the app cannot decrypt your stored key(s) for ${unreadable.join(', ')} — its key store` +
          `${app.keyStore ? ` (${app.keyStore})` : ''} is not the one that encrypted them, so chats with them fail`
      }
    ]
  }
  return [
    {
      status: 'note',
      text:
        `your stored keys for ${stored.join(', ')} are in this session and readable: a chat, a report or a ` +
        'research call bills your provider accounts'
    }
  ]
}

/** Where the data came from, and whether the search embeds the way the data was indexed. */
export function judgeData(record: SessionRecord, app: AppFacts): Check[] {
  const model = app.env.PRISM_EMBEDDING_BACKEND
  if (record.mode === 'copy') {
    const copy = record.copy
    return [
      {
        status: copy ? 'ok' : 'FAIL',
        text: copy
          ? `the data is a copy of yours (${copy.from.data}, profile ${copy.from.profile}) taken at ` +
            `${copy.at}; nothing changed while it was copied`
          : 'the session says it runs on a copy, but its record does not say of what'
      },
      model !== 'hashing'
        ? {
            status: 'ok',
            text: `the search embeds with the app's own model${model ? ` (${model})` : ''}, as the copied index was built`
          }
        : {
            status: 'FAIL',
            text: "the search embeds with hashing, but the copied index was built with the app's model — its results would be noise"
          }
    ]
  }
  return [
    model === 'hashing'
      ? { status: 'ok', text: 'the search embeds offline (hashing): no model is loaded or downloaded' }
      : {
          status: 'FAIL',
          text: `the search embeds with ${model ?? "the app's default model"}, which an empty install would download first`
        }
  ]
}
