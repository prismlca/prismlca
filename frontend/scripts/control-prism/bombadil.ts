/**
 * Bombadil, the property-based UI tester that `explore` runs: one pinned release, fetched on first use from its
 * GitHub release into the user's cache and checked against the SHA-256 written here every time before it runs.
 * Nothing else needs it, and it is not among the app's dependencies. Its release has no Windows binary, so
 * `explore` does not run there.
 *
 * Also how its traces are read: `bombadil trace --json` prints one state per line.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Exit } from './client'

export const BOMBADIL_VERSION = '0.8.0'
const RELEASE = `https://github.com/antithesishq/bombadil/releases/download/v${BOMBADIL_VERSION}/`

/** The release's binaries by `platform-arch`, with the SHA-256 the release names for each. */
export const BINARIES: Record<string, { asset: string; sha256: string }> = {
  'linux-x64': {
    asset: 'bombadil-x86_64-linux',
    sha256: 'd9d1d2832cb23c874744a4f20526d2064ce8571c31f8ecd01ddf8e1c44da4814'
  },
  'linux-arm64': {
    asset: 'bombadil-aarch64-linux',
    sha256: '8ac5e26b609296ec7017480220baf310617b9a799352c6fd5e723b2a30d246d3'
  },
  'darwin-arm64': {
    asset: 'bombadil-aarch64-darwin',
    sha256: '2ea26a68ac9b5296a8828ff138fb17a3343f7e8cf50647e9d1a81074505f995c'
  }
}

export function binaryFor(platform: string, arch: string): { asset: string; sha256: string } | null {
  return BINARIES[`${platform}-${arch}`] ?? null
}

/** Where the binary is kept: the user's cache, shared by every checkout, one folder per version. */
export function bombadilDir(): string {
  const base =
    process.env.XDG_CACHE_HOME ||
    (process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches') : join(homedir(), '.cache'))
  return join(base, 'prismlca', 'bombadil', `v${BOMBADIL_VERSION}`)
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The path of the pinned binary for this machine, fetched first if it is not in the cache. Every call checks the
 *  file against the pinned SHA-256: a cached file that does not match is fetched again, a download that does not
 *  match is thrown away. */
export async function ensureBombadil(log: (line: string) => void): Promise<string> {
  const pinned = binaryFor(process.platform, process.arch)
  if (!pinned) {
    throw new Exit(
      1,
      `Bombadil ${BOMBADIL_VERSION} has no binary for ${process.platform}-${process.arch} ` +
        `(it has ${Object.keys(BINARIES).join(', ')}); explore runs on Linux and on macOS with Apple silicon`
    )
  }
  const dir = bombadilDir()
  const file = join(dir, pinned.asset)
  if (existsSync(file)) {
    if (sha256(readFileSync(file)) === pinned.sha256) return file
    log(`the cached ${file} does not match its pinned SHA-256; fetching it again`)
    rmSync(file, { force: true })
  }
  mkdirSync(dir, { recursive: true })
  log(`fetching Bombadil ${BOMBADIL_VERSION} (${pinned.asset}) from its GitHub release …`)
  let bytes: Uint8Array
  try {
    const res = await fetch(RELEASE + pinned.asset, { signal: AbortSignal.timeout(300_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    bytes = new Uint8Array(await res.arrayBuffer())
  } catch (e) {
    throw new Exit(1, `could not fetch ${RELEASE + pinned.asset}: ${(e as Error).message}`)
  }
  const got = sha256(bytes)
  if (got !== pinned.sha256) {
    throw new Exit(
      1,
      `the downloaded ${pinned.asset} has SHA-256 ${got}, not the pinned ${pinned.sha256}; nothing was kept`
    )
  }
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, bytes)
  chmodSync(tmp, 0o755)
  renameSync(tmp, file)
  log(`kept it in ${file} (SHA-256 checked)`)
  return file
}

/** One state of a trace, as `bombadil trace --json` prints it (only what explore reads). */
export interface TraceState {
  index: number
  metadata: {
    /** Microseconds since the epoch. */
    timestamp: number
    action: unknown
    state: {
      url?: string
      resources?: Record<string, number>
      branches?: number[] | null
    }
    snapshots: { name: string | null; value: unknown }[]
    violations: { name: string; violation: unknown }[] | null
  }
}

/** The states of a trace, one at a time (a long run's trace prints hundreds of megabytes of JSON). */
export async function* traceStates(bin: string, trace: string): AsyncGenerator<TraceState> {
  const child = spawn(bin, ['trace', '--json', trace], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
  const exited = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? 1)))
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    if (line.trim()) yield JSON.parse(line) as TraceState
  }
  const code = await exited
  if (code !== 0) throw new Error(`bombadil trace exited with ${code}: ${stderr.trim().split('\n')[0]}`)
}

/** Writes the screenshot of state `index` into `dir` and returns its file, or null when the state has none. */
export function traceScreenshot(
  bin: string,
  trace: string,
  index: number,
  dir: string
): Promise<string | null> {
  mkdirSync(dir, { recursive: true })
  return new Promise((resolve) => {
    const child = spawn(bin, ['trace', '--state', String(index), '--screenshots', dir, trace], {
      stdio: 'ignore'
    })
    child.on('close', () => {
      const file = readdirSync(dir).find((f) => f.startsWith(`${index}.`))
      resolve(file ? join(dir, file) : null)
    })
    child.on('error', () => resolve(null))
  })
}
