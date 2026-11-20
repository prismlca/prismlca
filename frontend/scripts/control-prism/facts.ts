/**
 * What the running app says about itself, gathered in the host, which holds it: where the main process
 * runs from and keeps its profile, which settings reached it, and — on Linux, from /proc — the backend's
 * own environment, its working folder, the code its environment installs, and the files the app's
 * processes hold open. Provider keys are reported as present or absent, never by value.
 */
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RunningApp } from '../../e2e/app'
import type { ProcessInfo } from '../../e2e/processes'
import { inside } from './doctor'

export interface BackendFacts {
  pid: number
  cwd: string | null
  dataDir: string | null
  brightwayDir: string | null
  pythonPath: string | null
  /** Where the environment's editable install points (its .pth), when there is one. */
  editableSrc: string | null
}

export interface AppFacts {
  alive: boolean
  appPath: string
  userData: string
  rendererUrl: string
  env: Record<string, string | null>
  /** The provider key variables of main/secrets.ts, present or not. */
  keyVars: { name: string; set: boolean }[]
  processes: ProcessInfo[]
  /** Linux only: read from /proc. */
  backends: BackendFacts[] | null
  openInRealDirs: string[] | null
}

export const ENV_KEYS = [
  'PRISM_DATA_DIR',
  'XDG_CONFIG_HOME',
  'PRISM_DOWNLOAD_DIR',
  'BRIGHTWAY2_DIR',
  'PRISM_BRIGHTWAY_DIR',
  'ELECTRON_RENDERER_URL',
  'PRISM_EMBEDDING_BACKEND',
  'PRISM_IGNORE_DEV_KEYS'
]

/** main/secrets.ts ENV_VAR, plus Google's other spelling. */
export const KEY_VARS = [
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'ORS_API_KEY',
  'MAPBOX_API_KEY'
]

function procEnv(pid: number): Record<string, string> {
  const env: Record<string, string> = {}
  for (const pair of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
    const eq = pair.indexOf('=')
    if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return env
}

/** The editable install's path file of the environment `python` belongs to (…/.venv/bin/python). */
function editableSrc(python: string): string | null {
  const lib = join(dirname(dirname(python)), 'lib')
  try {
    for (const v of readdirSync(lib)) {
      try {
        return readFileSync(
          join(lib, v, 'site-packages', '_editable_impl_prism_lca_backend.pth'),
          'utf8'
        ).trim()
      } catch {
        /* another interpreter folder */
      }
    }
  } catch {
    /* not a virtual environment */
  }
  return null
}

function backendFacts(p: ProcessInfo): BackendFacts | null {
  try {
    const env = procEnv(p.pid)
    let cwd: string | null = null
    try {
      cwd = readlinkSync(`/proc/${p.pid}/cwd`)
    } catch {
      /* gone */
    }
    const python = readFileSync(`/proc/${p.pid}/cmdline`, 'utf8').split('\0')[0]
    return {
      pid: p.pid,
      cwd,
      dataDir: env.PRISM_DATA_DIR ?? null,
      brightwayDir: env.PRISM_BRIGHTWAY_DIR ?? null,
      pythonPath: env.PYTHONPATH ?? null,
      editableSrc: editableSrc(python)
    }
  } catch {
    return null
  }
}

function openFilesIn(p: ProcessInfo, dirs: string[]): string[] {
  let fds: string[]
  try {
    fds = readdirSync(`/proc/${p.pid}/fd`)
  } catch {
    return []
  }
  const hits: string[] = []
  for (const fd of fds) {
    try {
      const target = readlinkSync(`/proc/${p.pid}/fd/${fd}`)
      if (dirs.some((d) => inside(target, d))) hits.push(`${target} (pid ${p.pid})`)
    } catch {
      /* closed meanwhile */
    }
  }
  return hits
}

export async function gatherAppFacts(
  running: RunningApp,
  processes: ProcessInfo[],
  real: string[]
): Promise<AppFacts> {
  const proc = running.app.process()
  const alive = proc.exitCode === null && proc.signalCode === null
  const main = await running.app.evaluate(
    ({ app }, { keys, keyVars }) => ({
      appPath: app.getAppPath(),
      userData: app.getPath('userData'),
      env: Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null])),
      keyVars: keyVars.map((name) => ({ name, set: !!process.env[name] }))
    }),
    { keys: ENV_KEYS, keyVars: KEY_VARS }
  )
  let backends: BackendFacts[] | null = null
  let openInRealDirs: string[] | null = null
  if (process.platform === 'linux') {
    // The backend's interpreter, not `uv run` in front of it.
    backends = processes
      .filter((p) => /prism-lca-backend/.test(p.command) && !/\buv\b.*\brun\b/.test(p.command))
      .map(backendFacts)
      .filter((b): b is BackendFacts => b !== null)
    openInRealDirs = processes.flatMap((p) => openFilesIn(p, real))
  }
  return { alive, ...main, rendererUrl: running.page.url(), processes, backends, openInRealDirs }
}
