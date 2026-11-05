/**
 * The Windows publisher check for a downloaded update: the verifier `NsisUpdater` calls before it accepts
 * an installer (updater.ts installs it through `guardUpdateSignature`).
 *
 * The pin itself is unchanged: `NsisUpdater` reads `publisherName` from app-update.yml and hands it in, and
 * the subject is compared exactly as electron-updater's own verifier compares it (`parseDn`,
 * `signedByPublisher`; updateSignature.test.ts runs both side by side). What differs is the failure
 * mode: a check that cannot be completed refuses the update instead of letting it through. Three answers:
 *  - `null`: Windows reports a valid signature by the pinned publisher for exactly this file;
 *  - a string: Windows reports something else (unsigned, another signer, a broken signature) —
 *    `NsisUpdater` turns it into ERR_UPDATER_INVALID_SIGNATURE;
 *  - a rejection with `SIGNATURE_UNCHECKED`: there was no usable answer at all.
 * electron-updater does not call the verifier for a file it serves from its download cache, nor when
 * app-update.yml names no publisher, and its cache also skips the web-installer refusal;
 * `confirmChecked` closes all three after every Windows download.
 *
 * PowerShell is started by its absolute path under %SystemRoot%, without a shell. The script uses only
 * what Constrained Language mode allows, takes the file from an environment variable (no quoting), and
 * writes ASCII-only JSON, so a subject with non-ASCII letters survives any console code page.
 */
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { win32 } from 'node:path'

/** The error code of a refusal because the signature could not be checked (updater.ts words it). */
export const SIGNATURE_UNCHECKED = 'ERR_PRISMLCA_SIGNATURE_UNCHECKED'

/** A cold PowerShell start (module load, a virus scan of the installer) can take a while. */
export const CHECK_TIMEOUT_MS = 30_000

/** The environment variable that carries the installer's path into the script. */
export const FILE_VARIABLE = 'PRISMLCA_UPDATE_FILE'

/** NsisUpdater's code for an installer that is not signed by the pinned publisher (updater.ts words it). */
const INVALID_SIGNATURE = 'ERR_UPDATER_INVALID_SIGNATURE'
/** electron-updater's code for a refused web installer. */
const WEB_INSTALLER = 'ERR_UPDATER_WEB_INSTALLER_DISABLED'

/** How many installers the guard has accepted: a download that does not raise it was never checked. */
let acceptedCount = 0
export function acceptedChecks(): number {
  return acceptedCount
}

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  `$s = Get-AuthenticodeSignature -LiteralPath $env:${FILE_VARIABLE}`,
  '$o = @{ Status = [int]$s.Status; Path = [string]$s.Path; Subject = [string]$s.SignerCertificate.Subject }',
  '$j = ConvertTo-Json -InputObject $o -Compress',
  "$a = ''",
  "foreach ($c in [char[]]$j) { if ([int]$c -gt 126) { $a += '\\u{0:x4}' -f [int]$c } else { $a += $c } }",
  '$a'
].join('; ')

export const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', SCRIPT]

export type PowerShellRun = {
  /** As execFile reports it: a failed start, a non-zero exit or a kill after the timeout. */
  error: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null
  stdout: string
  stderr: string
}
export type RunPowerShell = (
  exe: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number
) => Promise<PowerShellRun>

const runPowerShell: RunPowerShell = (exe, args, env, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      exe,
      args,
      { env, timeout: timeoutMs, windowsHide: true, shell: false, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout), stderr: String(stderr) })
    )
  })

function notOwners(why: string): Error {
  return Object.assign(new Error(`the downloaded update is not signed by the application owner: ${why}`), {
    code: INVALID_SIGNATURE
  })
}

function unchecked(why: string): Error {
  return Object.assign(new Error(`the update signature could not be checked: ${why}`), {
    code: SIGNATURE_UNCHECKED
  })
}

/** Windows PowerShell 5.1 under %SystemRoot%, never whatever PATH finds first; null without a SystemRoot. */
export function powerShellPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = env.SystemRoot || env.windir
  if (!root || !win32.isAbsolute(root)) return null
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** The child's environment: ours, minus a PSModulePath that would load another PowerShell's modules. */
export function childEnv(file: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    const k = key.toLowerCase()
    if (value === undefined || k === 'psmodulepath' || k === FILE_VARIABLE.toLowerCase()) continue
    out[key] = value
  }
  out[FILE_VARIABLE] = file
  return out
}

/**
 * A distinguished name as electron-updater reads it (builder-util-runtime `parseDn`, ported line by line,
 * quirks included): the pin must accept and refuse exactly the subjects it accepted and refused before.
 */
export function parseDn(input: string): Map<string, string> {
  let quoted = false
  let key: string | null = null
  let token = ''
  let nextNonSpace = 0
  const seq = input.trim()
  const result = new Map<string, string>()
  for (let i = 0; i <= seq.length; i++) {
    if (i === seq.length) {
      if (key !== null) result.set(key, token)
      break
    }
    const ch = seq[i]
    if (quoted) {
      if (ch === '"') {
        quoted = false
        continue
      }
    } else {
      if (ch === '"') {
        quoted = true
        continue
      }
      if (ch === '\\') {
        i++
        const ord = parseInt(seq.slice(i, i + 2), 16)
        if (Number.isNaN(ord)) {
          token += String(seq[i])
        } else {
          i++
          token += String.fromCharCode(ord)
        }
        continue
      }
      if (key === null && ch === '=') {
        key = token
        token = ''
        continue
      }
      if (ch === ',' || ch === ';' || ch === '+') {
        if (key !== null) result.set(key, token)
        key = null
        token = ''
        continue
      }
    }
    if (ch === ' ' && !quoted) {
      if (token.length === 0) continue
      if (i > nextNonSpace) {
        let j = i
        while (seq[j] === ' ') j++
        nextNonSpace = j
      }
      if (
        nextNonSpace >= seq.length ||
        seq[nextNonSpace] === ',' ||
        seq[nextNonSpace] === ';' ||
        (key === null && seq[nextNonSpace] === '=') ||
        (key !== null && seq[nextNonSpace] === '+')
      ) {
        i = nextNonSpace - 1
        continue
      }
    }
    token += ch
  }
  return result
}

/** electron-updater's rule: a full DN must agree in every attribute it names; a bare name is the CN. */
export function signedByPublisher(publisherNames: string[], subjectText: string): boolean {
  const subject = parseDn(subjectText)
  for (const name of publisherNames) {
    const dn = parseDn(name)
    if (dn.size) {
      if (Array.from(dn.keys()).every((key) => dn.get(key) === subject.get(key))) return true
    } else if (name === subject.get('CN')) {
      return true
    }
  }
  return false
}

/** One file on Windows: case-insensitive, and through the real path where it resolves (PowerShell may
 *  spell it in another case, or long where we gave an 8.3 short name). */
export function samePath(a: string, b: string): boolean {
  const canonical = (p: string): string => {
    try {
      return realpathSync.native(p)
    } catch {
      return win32.normalize(p)
    }
  }
  return canonical(a).toUpperCase() === canonical(b).toUpperCase()
}

type Answer = { status: number; path: string; subject: string }

function parseAnswer(stdout: string): Answer | null {
  let data: unknown
  try {
    data = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const { Status, Path, Subject } = data as Record<string, unknown>
  if (!Number.isInteger(Status) || typeof Path !== 'string' || typeof Subject !== 'string') return null
  return { status: Status as number, path: Path, subject: Subject }
}

/**
 * The verifier for `NsisUpdater.verifyUpdateCodeSignature`. Anything short of a complete answer from
 * Windows about this very file rejects with `SIGNATURE_UNCHECKED` — never `null`.
 */
export async function verifyUpdateSignature(
  publisherNames: string[],
  file: string,
  run: RunPowerShell = runPowerShell,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const exe = powerShellPath(env)
  if (!exe) throw unchecked('SystemRoot is not set')
  let result: PowerShellRun
  try {
    result = await run(exe, POWERSHELL_ARGS, childEnv(file, env), CHECK_TIMEOUT_MS)
  } catch (err) {
    throw unchecked(`PowerShell could not be started: ${err instanceof Error ? err.message : String(err)}`)
  }
  const { error, stdout, stderr } = result
  // stderr alone decides nothing: PowerShell writes progress records there even when it succeeds. The
  // verdict rests on the exit code and the answer on stdout; stderr only explains a refusal.
  const said = stderr.trim() ? ` (stderr: ${stderr.trim().split(/\r?\n/)[0]})` : ''
  if (error) {
    const how = error.killed ? `stopped after ${CHECK_TIMEOUT_MS / 1000} s` : `code ${String(error.code)}`
    throw unchecked(`PowerShell failed (${how}): ${error.message.split('\n')[0]}${said}`)
  }
  const answer = parseAnswer(stdout)
  if (!answer) throw unchecked(`PowerShell gave no readable answer${said}`)
  const expected = publisherNames.join(' | ')
  if (answer.status !== 0)
    return `signature status ${answer.status}, signer "${answer.subject}", expected "${expected}"`
  if (!samePath(answer.path, file)) throw unchecked(`PowerShell checked ${answer.path} instead of ${file}`)
  if (!signedByPublisher(publisherNames, answer.subject))
    return `signed by "${answer.subject}", expected "${expected}"`
  return null
}

type NsisInternals = {
  verifyUpdateCodeSignature?: unknown
  /** NsisUpdater's own entry point: reads the pin from app-update.yml and calls the verifier with it. */
  verifySignature?: (file: string) => Promise<string | null>
}

/**
 * Put `verifyUpdateSignature` in place of electron-updater's default verifier. Throws when the updater no
 * longer offers the setter or its own entry point — the check then fails with a sentence instead of
 * running unguarded.
 */
export function guardUpdateSignature(u: unknown, run: RunPowerShell = runPowerShell): void {
  const target = u as NsisInternals | null
  if (!target || !('verifyUpdateCodeSignature' in target) || typeof target.verifySignature !== 'function')
    throw new Error('its signature guard could not be applied, so no request was sent')
  const verify = async (names: string[], file: string): Promise<string | null> => {
    const verdict = await verifyUpdateSignature(names, file, run)
    if (verdict === null) acceptedCount++
    return verdict
  }
  target.verifyUpdateCodeSignature = verify
  if (target.verifyUpdateCodeSignature !== verify)
    throw new Error('its signature guard could not be applied, so no request was sent')
}

/**
 * After a Windows download, before it may be offered for install. `downloaded` is what the download
 * resolved to: exactly one full installer, never one with a separate package (a web installer, which the
 * cache would otherwise hand on). The installer must have passed the guard during this download
 * (`acceptedBefore` is `acceptedChecks()` from before it started). One served from electron-updater's
 * cache, or downloaded while app-update.yml named no publisher, is checked now through NsisUpdater's own
 * entry point, and refused when the pin is never consulted.
 */
export async function confirmChecked(u: unknown, downloaded: unknown, acceptedBefore: number): Promise<void> {
  const files = Array.isArray(downloaded) ? downloaded : []
  if (files.length > 1)
    throw Object.assign(new Error('the release offers a web installer, which this version does not accept'), {
      code: WEB_INSTALLER
    })
  const file = typeof files[0] === 'string' ? files[0] : null
  if (acceptedCount > acceptedBefore && file) return
  const nsis = u as NsisInternals | null
  if (!file || typeof nsis?.verifySignature !== 'function')
    throw unchecked('the downloaded installer was not checked')
  const verdict = await nsis.verifySignature(file)
  if (verdict !== null) throw notOwners(verdict)
  if (acceptedCount === acceptedBefore) throw unchecked('no publisher is configured to check against')
}
