/**
 * Windows code signing for release builds, the only way to sign-windows.ps1:
 *
 *   win.signtoolOptions.sign (electron-builder.yml)   electron-builder calls this for every executable it would
 *                                                     sign; only our own are signed, the rest is skipped with a line
 *   node scripts/release/sign-windows.mjs wait          waits for the SimplySign sign-in (release workflow)
 *   node scripts/release/sign-windows.mjs check <file>… checks files signed earlier in the build
 *
 * The certificate subject is win.signtoolOptions.publisherName in electron-builder.yml, the same string every
 * installed PrismLCA compares an update's signature against: what we sign with and what the app accepts come
 * from one place. Signing happens only in release builds (PRISM_BUILD_KIND=release, set by the release
 * workflow); a local build stays unsigned.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// js-yaml comes with electron-updater, a runtime dependency.
import { load } from 'js-yaml'

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(here, 'sign-windows.ps1')
const CONFIG = join(here, '..', '..', 'electron-builder.yml')

// Ours: the app, the backend, the installer and the uninstaller NSIS writes next to it. Every other executable
// electron-builder offers (third-party ones inside the backend bundle) goes out as its maker signed it, or not
// at all, but never under our name.
const OURS = [
  /[\\/]win-unpacked[\\/]PrismLCA\.exe$/,
  /[\\/]win-unpacked[\\/]resources[\\/]backend[\\/]prism-lca-backend\.exe$/,
  /[\\/]PrismLCA-Setup-\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\.__uninstaller)?\.exe$/
]
export const isOurs = (file) => OURS.some((re) => re.test(String(file)))

/** The one certificate subject from the text of electron-builder.yml. */
export function subjectFrom(configText) {
  const names = [].concat(load(configText)?.win?.signtoolOptions?.publisherName ?? [])
  if (names.length !== 1 || typeof names[0] !== 'string' || !names[0].startsWith('CN='))
    throw new Error('electron-builder.yml: win.signtoolOptions.publisherName must be the one certificate subject (CN=…)')
  return names[0]
}

function powershell(args) {
  const subject = subjectFrom(readFileSync(CONFIG, 'utf-8'))
  const run = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
    // The subject goes in the environment: it holds quotes and commas that a command line would mangle.
    { stdio: 'inherit', env: { ...process.env, PRISM_SIGN_SUBJECT: subject } }
  )
  if (run.error) throw run.error
  return run.status ?? 1
}

/** electron-builder's hook: one call per file, with the file in configuration.path. */
export async function sign(configuration) {
  const file = configuration.path
  if (process.env.PRISM_BUILD_KIND !== 'release') {
    console.log(`  • not signed, no release build: ${basename(file)}`)
    return
  }
  if (!isOurs(file)) {
    console.log(`  • not signed, not ours: ${file}`)
    return
  }
  if (powershell(['-Sign', file]) !== 0) throw new Error(`signing ${basename(file)} failed`)
}

export default sign

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...files] = process.argv.slice(2)
  if (cmd === 'wait') process.exit(powershell(['-Wait']))
  if (cmd === 'check' && files.length) process.exit(powershell(['-Check', ...files.map((f) => resolve(f))]))
  console.error('usage: sign-windows.mjs wait | check <file>…')
  process.exit(2)
}
