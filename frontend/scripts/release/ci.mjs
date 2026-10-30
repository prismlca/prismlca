#!/usr/bin/env node
/**
 * The release workflow's checks (.github/workflows/release.yml):
 *
 *   node scripts/release/ci.mjs verify-tag                 tag vX.Y.Z[-spike.N] == every version source
 *   node scripts/release/ci.mjs electron-support           supported line, newest patch
 *   node scripts/release/ci.mjs audit                      shipped advisories fixed or assessed
 *   node scripts/release/ci.mjs check-artifacts <kind> <dir>   one package, unpacked (kind: appimage|deb|win)
 *   node scripts/release/ci.mjs notes <version>            release notes from CHANGELOG.md
 *   node scripts/release/ci.mjs build-info <dir>...        build-info.txt for the files given
 *
 * The decisions live in lib.mjs (tested); this file only gathers the facts. Each command exits 1 with
 * a sentence when the release must stop.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  auditRequirements,
  auditVerdict,
  checkReleaseRef,
  electronSupport,
  feedProblems,
  isSpike,
  notesFor,
  npmAuditReport,
  pipAuditReport,
  pyName
} from './lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(here, '..', '..')
const ROOT = resolve(FRONTEND, '..')
const BACKEND = join(ROOT, 'backend')
const SHELL = process.platform === 'win32'
const sh = (cmd, args, cwd = ROOT, okCodes = [0]) => {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], shell: SHELL, maxBuffer: 1 << 28 })
  } catch (err) {
    if (okCodes.includes(err.status)) return err.stdout
    throw err
  }
}
const die = (msg) => {
  console.error(`✗ ${msg}`)
  process.exit(1)
}
const frontendVersion = () => JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf-8')).version
const backendVersion = () => /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(BACKEND, 'pyproject.toml'), 'utf-8'))?.[1]

function verifyTag() {
  const problem = checkReleaseRef(process.env.GITHUB_REF, frontendVersion(), backendVersion())
  if (problem) die(problem)
  console.log(`✓ tag ${process.env.GITHUB_REF} matches frontend and backend`)
}

function electronCheck() {
  const installed = JSON.parse(readFileSync(join(FRONTEND, 'node_modules/electron/package.json'), 'utf-8')).version
  const tags = JSON.parse(sh('npm', ['view', 'electron', 'dist-tags', '--json'], FRONTEND))
  const { block, warn } = electronSupport(installed, tags)
  for (const w of warn) console.warn(`! ${w}`)
  if (block.length) die(block.join('; '))
  console.log(`✓ Electron ${installed} is supported and current`)
}

function audit() {
  const findings = []
  const report = (fn, ...args) => {
    try {
      return fn(...args)
    } catch (err) {
      die(err.message)
    }
  }
  // npm: `npm audit` exits 1 when it finds something — that is data here; whether the request itself
  // worked, npmAuditReport decides.
  const npmAll = report(npmAuditReport, sh('npm', ['audit', '--json'], FRONTEND, [0, 1]))
  const npmShipped = report(npmAuditReport, sh('npm', ['audit', '--omit=dev', '--json'], FRONTEND, [0, 1]))
  const shippedNames = new Set(Object.keys(npmShipped.vulnerabilities ?? {}))
  for (const [name, v] of Object.entries(npmAll.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via !== 'object') continue
      const id = String(via.url ?? '').split('/').pop() || String(via.source)
      findings.push({ id, package: name, severity: via.severity ?? v.severity, shipped: shippedNames.has(name) })
    }
  }
  // Python: pip-audit checks the whole locked closure (auditRequirements), not the environment this
  // runner happens to have installed. Shipped is what PyInstaller bundles: the runtime export, no extras.
  const uvExport = (...extra) =>
    sh('uv', ['export', '--no-hashes', '--format', 'requirements-txt', '--no-emit-project', '--no-header', '--no-annotate', ...extra], BACKEND)
  const runtime = new Set(auditRequirements(uvExport()).pins.map((p) => pyName(p.split('==')[0])))
  const { pins, unpinned } = auditRequirements(uvExport('--all-extras'))
  if (unpinned.length) die(`pip-audit cannot check what is not an exact pin: ${unpinned.join('; ')}`)
  const tmp = mkdtempSync(join(tmpdir(), 'prism-audit-'))
  const reqFile = join(tmp, 'requirements.txt')
  writeFileSync(reqFile, `${pins.join('\n')}\n`)
  const pipArgs = ['run', '--with', 'pip-audit', 'pip-audit', '-r', reqFile, '--no-deps', '--disable-pip', '-f', 'json', '--progress-spinner', 'off']
  const pip = report(pipAuditReport, sh('uv', pipArgs, BACKEND, [0, 1]), pins)
  rmSync(tmp, { recursive: true, force: true })
  const seen = new Set()
  for (const dep of pip.dependencies) {
    const shipped = runtime.has(pyName(dep.name))
    if (dep.skip_reason) {
      if (shipped) die(`pip-audit could not check ${dep.name}: ${dep.skip_reason} — an unchecked package is not a clean one`)
      console.warn(`! pip-audit could not check build-only ${dep.name}: ${dep.skip_reason}`)
    }
    for (const v of dep.vulns ?? []) {
      if (seen.has(`${dep.name} ${v.id}`)) continue
      seen.add(`${dep.name} ${v.id}`)
      findings.push({ id: v.id, package: dep.name, severity: 'unrated', shipped })
    }
  }
  const exceptions = JSON.parse(readFileSync(join(here, 'audit-exceptions.json'), 'utf-8'))
  const verdict = auditVerdict(findings, exceptions, new Date().toISOString().slice(0, 10))
  for (const f of verdict.accepted) console.log(`~ accepted ${f.package} ${f.id}: ${f.reason}`)
  for (const f of verdict.reported) console.log(`· build-only ${f.package} ${f.id} (${f.severity})`)
  for (const e of verdict.expired) console.log(`! exception expired ${e.package} ${e.id} (${e.expires})`)
  for (const e of verdict.stale) console.log(`! exception no longer needed: ${e.package} ${e.id}`)
  if (verdict.blocked.length)
    die(`advisories to fix or assess in audit-exceptions.json:\n${verdict.blocked.map((f) => `  ${f.package} ${f.id} (${f.severity})`).join('\n')}`)
  console.log(`✓ audit: nothing shipped is open (${verdict.accepted.length} assessed, ${verdict.reported.length} build-only)`)
}

/** Every file below `dir`, relative paths with forward slashes. */
function walk(dir, prefix = '') {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    if (statSync(p).isDirectory()) out.push(...walk(p, rel))
    else out.push(rel)
  }
  return out
}

function checkArtifacts(kind, dir) {
  if (!['appimage', 'deb', 'win'].includes(kind) || !dir || !existsSync(dir)) die('usage: check-artifacts appimage|deb|win <unpacked dir>')
  const files = walk(dir)
  const has = (re) => files.some((f) => re.test(f))
  const problems = []
  // package-type decides electron-updater's Linux updater — deb only.
  const pt = files.find((f) => /(^|\/)resources\/package-type$/.test(f))
  const ptValue = pt ? readFileSync(join(dir, pt), 'utf-8').trim() : null
  if (kind === 'deb' && ptValue !== 'deb') problems.push(`deb must carry resources/package-type = deb, has ${ptValue ?? 'none'}`)
  if (kind !== 'deb' && ptValue !== null) problems.push(`${kind} must not carry resources/package-type (has "${ptValue}")`)
  const upd = files.find((f) => /(^|\/)resources\/app-update\.yml$/.test(f))
  if (!upd) problems.push('resources/app-update.yml is missing — the update check would have no feed')
  else if (!/owner:\s*prismlca/.test(readFileSync(join(dir, upd), 'utf-8')) || !/repo:\s*prismlca/.test(readFileSync(join(dir, upd), 'utf-8')))
    problems.push('app-update.yml does not point at prismlca/prismlca')
  for (const name of ['LICENSE.electron.txt', 'LICENSES.chromium.html'])
    if (!has(new RegExp(`(^|/)${name.replace('.', '\\.')}$`))) problems.push(`${name} is missing`)
  // The AGPL text and the notices: unpacked next to app.asar, where licence.ts opens them with the OS
  // viewer (they were missing from every package before this check). The window icon travels inside app.asar.
  for (const name of ['LICENSE.txt', 'THIRD-PARTY-NOTICES.md'])
    if (!has(new RegExp(`(^|/)resources/app\\.asar\\.unpacked/resources/${name.replace(/\./g, '\\.')}$`)))
      problems.push(`resources/app.asar.unpacked/resources/${name} is missing`)
  const asar = files.find((f) => /(^|\/)resources\/app\.asar$/.test(f))
  if (!asar) problems.push('resources/app.asar is missing')
  else if (!listAsar(join(dir, asar)).includes('resources/icon.png')) problems.push('resources/icon.png is not inside app.asar')
  // The backend bundle: present, and nothing in it that it must not carry (licence or data reasons).
  if (!has(/(^|\/)resources\/backend\/prism-lca-backend(\.exe)?$/)) problems.push('the backend executable is missing')
  for (const [re, what] of [
    [/\/_internal\/pyxlsb\//, 'pyxlsb (LGPL, must stay out)'],
    [/\.spold$/i, 'an ecoSpold file'],
    // The licensed ecoinvent release files, not Brightway's own bundled tables such as
    // bw2io/data/lcia/lcia_39_ecoinvent.zip (Brightway's redistribution, DATENHERKUNFT.md).
    [/ecoinvent[ _-]?\d+\.\d+[^/]*\.(7z|zip)$/i, 'an ecoinvent release archive'],
    [/ecoSpold0?2[^/]*\.(7z|zip)$/i, 'an ecoSpold02 archive'],
    [/LCIA_implementation/i, 'the ecoinvent LCIA implementation'],
    [/(^|\/)databases\//, 'a databases/ folder']
  ])
    if (has(re)) problems.push(`the package contains ${what}`)
  // Intel OpenMP (End User License Agreement for Developer Tools): only the copy PyTorch's Windows build
  // needs is allowed, nowhere else — the bundle threads MKL through oneTBB on every platform.
  const intelOpenMp = files.filter((f) => /libiomp/i.test(f))
  const allowed = kind === 'win' ? /(^|\/)_internal\/torch\/lib\/libiomp(stubs)?5md\.dll$/i : null
  for (const f of intelOpenMp)
    if (!allowed?.test(f)) problems.push(`the package contains Intel OpenMP outside torch/lib on Windows: ${f}`)
  if (problems.length) die(`${kind}: ${problems.length} problem(s):\n  ${problems.join('\n  ')}`)
  console.log(`✓ ${kind}: package-type, feed, licences, backend and exclusions are right (${files.length} files)`)
}

/**
 * File names inside an asar archive, read from its header without any dependency: a Chromium pickle
 * (uint32 payload size, uint32 header size, uint32 string size, uint32 JSON length) followed by the
 * JSON directory tree.
 */
function listAsar(file) {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const jsonLength = head.readUInt32LE(12)
    const json = Buffer.alloc(jsonLength)
    readSync(fd, json, 0, jsonLength, 16)
    const out = []
    const visit = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const rel = prefix ? `${prefix}/${name}` : name
        if (child.files) visit(child, rel)
        else out.push(rel)
      }
    }
    visit(JSON.parse(json.toString('utf-8')), '')
    return out
  } finally {
    closeSync(fd)
  }
}

function notes(version) {
  if (isSpike(version)) {
    process.stdout.write(`Spike build ${version} — rehearses the release pipeline. Not a release; deleted afterwards.\n`)
    return
  }
  const text = notesFor(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf-8'), version)
  if (!text) die(`CHANGELOG.md has no section for ${version}`)
  process.stdout.write(`${text}\n`)
}

function buildInfo(paths) {
  // Versions from the lockfiles, not from node_modules or a venv: the draft job checks out the tag and
  // installs nothing, and the lockfiles are what every build job installed from.
  const lock = JSON.parse(readFileSync(join(FRONTEND, 'package-lock.json'), 'utf-8')).packages ?? {}
  const npmVersion = (name) => lock[`node_modules/${name}`]?.version ?? 'unknown'
  const uvLock = readFileSync(join(BACKEND, 'uv.lock'), 'utf-8')
  const pyVersion = (name) =>
    new RegExp(`\\[\\[package\\]\\]\\nname = "${name}"\\nversion = "([^"]+)"`).exec(uvLock)?.[1] ?? 'unknown'
  const python = existsSync(join(BACKEND, '.python-version')) ? readFileSync(join(BACKEND, '.python-version'), 'utf-8').trim() : 'unknown'
  const lines = [
    `PrismLCA ${frontendVersion()} — build information`,
    `commit: ${process.env.GITHUB_SHA ?? 'unknown'}`,
    `tag: ${process.env.GITHUB_REF_NAME ?? '(none)'}`,
    `workflow run: ${process.env.GITHUB_SERVER_URL ?? ''}/${process.env.GITHUB_REPOSITORY ?? ''}/actions/runs/${process.env.GITHUB_RUN_ID ?? ''}`,
    `electron: ${npmVersion('electron')}`,
    `electron-builder: ${npmVersion('electron-builder')}`,
    `electron-updater: ${npmVersion('electron-updater')}`,
    `python: ${python}`,
    `pyinstaller: ${pyVersion('pyinstaller')}`,
    `build runners: see the workflow run (each job logs its runner image)`,
    '',
    'sha256 of the release files:'
  ]
  for (const p of paths.flatMap((d) => (statSync(d).isDirectory() ? walk(d).map((f) => join(d, f)) : [d])).sort())
    lines.push(`${createHash('sha256').update(readFileSync(p)).digest('hex')}  ${basename(p)}`)
  process.stdout.write(`${lines.join('\n')}\n`)
}

// The update feed against the files that will be uploaded: run on dist/ before the release is created.
function checkFeed(dir) {
  const files = readdirSync(dir)
  const feeds = files.filter((f) => /^latest.*\.yml$/.test(f)).map((name) => ({ name, text: readFileSync(join(dir, name), 'utf-8') }))
  if (feeds.length === 0) die(`no latest*.yml in ${dir}`)
  const problems = feedProblems(feeds, files)
  if (problems.length) die(`update feed does not match the release files:\n  ${problems.join('\n  ')}`)
  console.log(`update feed ok: ${feeds.map((f) => f.name).join(', ')} name only files that are there`)
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'verify-tag') verifyTag()
else if (cmd === 'electron-support') electronCheck()
else if (cmd === 'audit') audit()
else if (cmd === 'check-artifacts') checkArtifacts(rest[0], rest[1])
else if (cmd === 'notes') notes(rest[0])
else if (cmd === 'build-info') buildInfo(rest)
else if (cmd === 'check-feed') checkFeed(rest[0])
else die('usage: ci.mjs verify-tag | electron-support | audit | check-artifacts <kind> <dir> | notes <version> | build-info <files…> | check-feed <dir>')
