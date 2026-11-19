/**
 * Windows code signing for release builds: what is signed, and the only way to sign-windows.ps1.
 *
 *   win.signtoolOptions.sign (electron-builder.yml)   `sign`, one call per file electron-builder signs itself:
 *                                                     the installer, its uninstaller and the elevate.exe it stages
 *   afterSign (electron-builder.yml)                  `afterSign`, the whole unpacked app at once, after packing
 *                                                     and before the installer is built from it
 *   node scripts/release/sign-windows.mjs previous <dir>      before the sign-in: the previous release's signed files
 *   node scripts/release/sign-windows.mjs wait                waits for the SimplySign sign-in
 *   node scripts/release/sign-windows.mjs check <dir|file>…   every program file signed, ours to our standard
 *   node scripts/release/sign-budget.mjs estimate vX.Y.Z     before tagging: does this release need WINDOWS_SIGN_LIMIT?
 *
 * The rule: every program file we ship — any PE image, exe, dll, pyd or node — carries a valid embedded signature.
 * Smart App Control blocks unsigned code that Microsoft's cloud does not happen to know, and a company's App
 * Control can allow PrismLCA with one publisher rule only when everything is signed.
 *  - A file its maker signed (Intel, Microsoft) keeps that signature. Nothing is signed twice.
 *  - A file without a signature gets ours: our signed installer vouches for exactly these files anyway.
 *  - A file whose signature is not valid stops the release. It was changed after its maker signed it, or cannot
 *    be checked; our signature must not cover either.
 *  - Certum allows 5,000 signatures a month per certificate, and going over may block the certificate for the rest
 *    of the month. So a file whose code has not changed since the last published release keeps the signature it got
 *    there (previous-release.mjs, pe.mjs), and a run that would sign more than its limit stops before it signs any
 *    (sign-budget.mjs).
 *
 * The certificate subject is win.signtoolOptions.publisherName in electron-builder.yml, the same string every
 * installed PrismLCA compares an update's signature against: what we sign with and what the app accepts come
 * from one place. Signing happens only in release builds (PRISM_BUILD_KIND=release, set by the release
 * workflow); a local build stays unsigned.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// js-yaml comes with electron-updater, a runtime dependency.
import { load } from 'js-yaml'

import { codeDigest, programFiles, readPeLayout } from './pe.mjs'
import { carveAppArchive, downloadPreviousInstaller, publishTargetFrom, unpackProgramFiles } from './previous-release.mjs'
import { allowCommand, overLimit, signLimit } from './sign-budget.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(here, 'sign-windows.ps1')
const CONFIG = join(here, '..', '..', 'electron-builder.yml')

/** The one certificate subject from the text of electron-builder.yml. */
export function subjectFrom(configText) {
  const names = [].concat(load(configText)?.win?.signtoolOptions?.publisherName ?? [])
  if (names.length !== 1 || typeof names[0] !== 'string' || !names[0].startsWith('CN='))
    throw new Error('electron-builder.yml: win.signtoolOptions.publisherName must be the one certificate subject (CN=…)')
  return names[0]
}

/** Files of the unpacked app are signed together by afterSign; the hook signs what electron-builder adds later. */
export const inPackage = (file) => /[\\/]win-unpacked[\\/]/.test(String(file))

/** "Microsoft Corporation" from "CN=Microsoft Corporation, O=…": the signer as a person reads it. */
export const signerName = (subject) => /(?:^|,\s*)CN=("[^"]*"|[^,]*)/.exec(subject ?? '')?.[1].replace(/"/g, '') ?? '(none)'

/**
 * What a file's signature means for signing, from what Windows says about it (sign-windows.ps1 -Inspect) and
 * whether the file has a signature embedded at all: 'unsigned' (gets ours), 'valid' (keeps its own), 'broken'.
 * Valid means embedded, accepted by Windows, and — when it is ours — up to our standard (timestamp, SHA-256).
 * A catalog signature belongs to the machine that checks, not to the file, so it does not count.
 */
export function signatureState(fact, embedded) {
  if (!embedded) return 'unsigned'
  if (!fact || fact.status !== 'Valid' || fact.type === 'Catalog' || fact.problem) return 'broken'
  return 'valid'
}

/**
 * The plan for the unpacked app. `files`: { rel, embedded, signable, digest } per program file (digest: pe.mjs
 * codeDigest of an unsigned file); `facts`: rel → what Windows says about each embedded signature; `copies`:
 * digest → path of a previous release's file carrying the same code under our valid signature.
 */
export function planPackage(files, facts, copies) {
  const plan = { keep: [], reuse: [], sign: [], broken: [] }
  for (const f of files) {
    const state = signatureState(facts.get(f.rel), f.embedded)
    if (state === 'valid') plan.keep.push(f.rel)
    else if (state === 'broken') plan.broken.push(`${f.rel}: ${describe(facts.get(f.rel))}`)
    else if (!f.signable) plan.broken.push(`${f.rel}: its header has no room for a signature`)
    else if (copies.has(f.digest)) plan.reuse.push({ rel: f.rel, from: copies.get(f.digest) })
    else plan.sign.push(f.rel)
  }
  return plan
}

const describe = (fact) =>
  !fact ? 'not inspected' : fact.problem ? fact.problem.split('\n')[0] : `signature ${fact.status} (${fact.type || 'embedded'}, ${signerName(fact.subject)})`

/** The final check: every file signed and valid, ours to our standard. Problems, and how many each signer signed. */
export function checkVerdict(facts, embeddedFiles) {
  const problems = []
  const signers = new Map()
  for (const fact of facts) {
    const state = signatureState(fact, embeddedFiles.has(fact.file))
    if (state !== 'valid') problems.push(`${fact.file}: ${state === 'unsigned' ? 'not signed' : describe(fact)}`)
    else signers.set(signerName(fact.subject), (signers.get(signerName(fact.subject)) ?? 0) + 1)
  }
  return { problems, signers }
}

/** Groups paths so that one signtool command line stays well below Windows' 32,767 characters. */
export function batches(files, maxChars = 24000) {
  const out = []
  let batch = []
  let length = 0
  for (const f of files) {
    if (batch.length && length + f.length + 3 > maxChars) {
      out.push(batch)
      batch = []
      length = 0
    }
    batch.push(f)
    length += f.length + 3
  }
  if (batch.length) out.push(batch)
  return out
}

const config = () => readFileSync(CONFIG, 'utf-8')
const subject = () => subjectFrom(config())

function powershell(args) {
  const run = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
    // The subject goes in the environment: it holds quotes and commas that a command line would mangle.
    { stdio: 'inherit', env: { ...process.env, PRISM_SIGN_SUBJECT: subject() } }
  )
  if (run.error) throw run.error
  return run.status ?? 1
}

/** Runs `fn(listFile, dir)` with `files` written one per line to a temporary list (no command-line limit). */
function withList(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'prism-sign-'))
  try {
    const list = join(dir, 'files.txt')
    writeFileSync(list, `${files.join('\n')}\n`)
    return fn(list, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The inspection's answer as it is used here: every fact with its file as the path that was asked about. Windows
 * PowerShell writes a string that carries note properties as an object ({ value, PSPath, … }) — the path is taken
 * from there too, and an answer that names no file stops the run with the answer in the message, before a path
 * function fails on it somewhere else.
 */
export function readFacts(json) {
  const facts = JSON.parse(json)
  if (!Array.isArray(facts)) throw new Error(`the signature inspection answered no list: ${String(json).slice(0, 200)}`)
  return facts.map((fact) => {
    const file = typeof fact?.file === 'string' ? fact.file : fact?.file?.value
    if (typeof file !== 'string' || !file)
      throw new Error(`the signature inspection names no file: ${JSON.stringify(fact).slice(0, 300)}`)
    return { ...fact, file }
  })
}

/** What Windows says about each file's signature: { file, status, type, subject, problem }. Needs no key. */
function inspect(files) {
  if (!files.length) return []
  return withList(files, (list, dir) => {
    const out = join(dir, 'facts.json')
    if (powershell(['-Inspect', '-List', list, '-Out', out]) !== 0) throw new Error('inspecting signatures failed')
    const facts = readFacts(readFileSync(out, 'utf-8'))
    if (facts.length !== files.length)
      throw new Error(`the signature inspection answered for ${facts.length} of ${files.length} files`)
    return facts
  })
}

/** Signs, timestamps and checks `files`, one signtool call per batch. */
function signFiles(files) {
  for (const batch of batches(files))
    withList(batch, (list) => {
      if (powershell(['-Sign', '-List', list]) !== 0) throw new Error(`signing ${batch.length} file(s) failed`)
    })
}

function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
}

/** electron-builder's hook: one call per file, with the file in configuration.path. */
export async function sign(configuration) {
  const file = configuration.path
  if (process.env.PRISM_BUILD_KIND !== 'release') {
    console.log(`  • not signed, no release build: ${basename(file)}`)
    return
  }
  if (inPackage(file)) {
    console.log(`  • signed with the whole package after packing: ${file}`)
    return
  }
  const embedded = Boolean(readPeLayout(file)?.certSize)
  const fact = embedded ? inspect([file])[0] : null
  const state = signatureState(fact, embedded)
  if (state === 'valid') console.log(`  • keeps its signature (${signerName(fact.subject)}): ${file}`)
  else if (state === 'broken') throw new Error(`${file}: ${describe(fact)} — not signing over it`)
  else signFiles([file])
}

/** electron-builder's hook after packing: signs the unpacked app as a whole, keeping what it can. */
export async function afterSign(context) {
  if (context.electronPlatformName !== 'win32' || process.env.PRISM_BUILD_KIND !== 'release') return
  const tag = process.env.GITHUB_REF_NAME
  const { limit, note } = signLimit(process.env.WINDOWS_SIGN_LIMIT, tag)
  if (note) console.log(`  • ${note}`)
  const previous = readPrevious(process.env.PRISM_SIGN_PREVIOUS)
  const found = programFiles(context.appOutDir)
  const embedded = found.filter((f) => f.layout.certSize)
  const byFile = new Map(found.map((f) => [f.abs, f.rel]))
  const facts = new Map(inspect(embedded.map((f) => f.abs)).map((x) => [byFile.get(resolve(x.file)) ?? x.file, x]))
  const files = found.map((f) => ({
    rel: f.rel,
    embedded: Boolean(f.layout.certSize),
    signable: f.layout.security != null,
    digest: f.layout.certSize ? null : codeDigest(readFileSync(f.abs))
  }))
  const plan = planPackage(files, facts, previous?.copies ?? new Map())
  const counts =
    `${found.length} program files: ${plan.keep.length} keep their maker's signature, ` +
    `${plan.reuse.length} keep ours from ${previous ? previous.version : 'no previous release'}, ${plan.sign.length} to sign`
  console.log(`  • ${counts}`)
  if (plan.broken.length) throw new Error(`signatures that are not valid — not signing over them:\n  ${plan.broken.join('\n  ')}`)
  if (plan.sign.length > limit) throw new Error(overLimit(plan.sign.length, limit, tag, publishTargetFrom(config())))
  for (const { rel, from } of plan.reuse) copyFileSync(join(previous.root, from), join(context.appOutDir, rel))
  signFiles(plan.sign.map((rel) => join(context.appOutDir, rel)))
  console.log(`  • signed ${plan.sign.length} file(s), kept ${plan.reuse.length} earlier signature(s) of ours`)
  summary([`### Windows signatures`, `${counts}; the installer, its uninstaller and elevate.exe are signed on top.`])
}

const MANIFEST = 'previous.json'

/** The previous release's verified copies written by `previous`, or null when there are none. */
function readPrevious(dir) {
  if (!dir) return null
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf-8'))
  } catch {
    return null
  }
  return { version: manifest.version, root: join(dir, 'files'), copies: new Map(Object.entries(manifest.copies)) }
}

/**
 * Before the sign-in: unpacks the previous release's program files into `dir` and keeps a list of those that carry
 * our signature, valid and to our standard, by code digest. Stops before the sign-in when the run would clearly
 * spend more than its limit — the first signed release, when the previous one still had unsigned files.
 */
async function previous(dir) {
  const tag = process.env.GITHUB_REF_NAME
  const { limit, override, note } = signLimit(process.env.WINDOWS_SIGN_LIMIT, tag)
  if (note) console.log(note)
  const ours = subject()
  const target = publishTargetFrom(config())
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'files'), { recursive: true })
  let version
  let pe
  let facts
  try {
    const installer = join(dir, 'installer.exe')
    const archive = join(dir, 'app.7z')
    version = await downloadPreviousInstaller(target, installer)
    // The installer is checked before anything in it is unpacked: it must be ours, valid and to our standard.
    const [fact] = inspect([installer])
    if (signatureState(fact, Boolean(readPeLayout(installer)?.certSize)) !== 'valid' || fact.subject !== ours)
      throw new Error(`the ${version} installer is not signed by us: ${describe(fact)}`)
    await carveAppArchive(installer, archive)
    rmSync(installer)
    await unpackProgramFiles(archive, join(dir, 'files'))
    rmSync(archive)
    pe = programFiles(join(dir, 'files'))
    facts = new Map(inspect(pe.map((f) => f.abs)).map((x) => [resolve(x.file), x]))
  } catch (err) {
    const why = `No signed files from the previous release: ${err.message}`
    if (!override) {
      console.error(
        `✗ ${why}. Without them this run signs every unsigned program file, several hundred. Run the Windows job ` +
          `again, or allow it for this tag first: ${allowCommand(400, tag, target)}`
      )
      process.exit(1)
    }
    console.log(`::warning::${why}. WINDOWS_SIGN_LIMIT allows ${limit} new signatures for ${tag}.`)
    return
  }
  const copies = {}
  const broken = []
  let foreign = 0
  for (const f of pe) {
    const fact = facts.get(f.abs)
    const state = signatureState(fact, Boolean(f.layout.certSize))
    if (state === 'broken' && fact?.subject !== ours) broken.push(`${f.rel}: ${describe(fact)}`)
    if (state !== 'valid') continue
    if (fact.subject !== ours) foreign++
    else {
      const digest = codeDigest(readFileSync(f.abs))
      if (digest) copies[digest] = f.rel
    }
  }
  writeFileSync(join(dir, MANIFEST), JSON.stringify({ version, copies }, null, 1))
  const kept = Object.keys(copies).length
  const unsigned = pe.length - kept - foreign
  console.log(`${version}: ${pe.length} program files, ${kept} signed by us, ${foreign} by others, ${unsigned} without a usable signature`)
  // A maker's signature this machine does not accept (a missing root certificate, a revoked signer) would stop the
  // build at the same file after the sign-in; the files rarely change between releases, so say it now.
  if (broken.length) {
    console.error(`✗ signatures of other makers that this machine does not accept:\n  ${broken.join('\n  ')}`)
    process.exit(1)
  }
  // What the previous release shipped unsigned needs a signature now even if nothing changed: stop before the sign-in.
  if (unsigned > limit) {
    console.error(`✗ ${overLimit(unsigned, limit, tag, target)}`)
    process.exit(1)
  }
}

/** The final check of a built package: every program file below each dir, and each file named. */
function check(paths) {
  const files = []
  const embedded = new Set()
  for (const p of paths) {
    const st = lstatSync(p)
    const found = st.isDirectory() ? programFiles(p) : [{ abs: resolve(p), layout: readPeLayout(p) }]
    for (const f of found) {
      if (!f.layout) throw new Error(`${p} is not a Windows program file`)
      files.push(f.abs)
      if (f.layout.certSize) embedded.add(f.abs)
    }
  }
  const facts = inspect(files).map((x) => ({ ...x, file: resolve(x.file) }))
  const { problems, signers } = checkVerdict(facts, embedded)
  const bySigner = [...signers].map(([name, n]) => `${n} ${name}`).join(', ')
  if (problems.length) {
    console.error(`✗ ${problems.length} of ${files.length} program files are not signed as they must be:\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`✓ all ${files.length} program files carry a valid signature: ${bySigner}`)
  summary([`Signed program files in the package: ${bySigner}.`])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2)
  if (cmd === 'wait') process.exit(powershell(['-Wait']))
  else if (cmd === 'previous' && args.length === 1) await previous(resolve(args[0]))
  else if (cmd === 'check' && args.length) check(args)
  else {
    console.error('usage: sign-windows.mjs wait | previous <dir> | check <dir|file>…')
    process.exit(2)
  }
}

export default sign
