/**
 * The Windows signature budget. Certum allows 5,000 signatures a month per certificate, and going over may block the
 * certificate for the rest of the month — no release until the next. A release run may therefore spend
 * DEFAULT_SIGN_LIMIT new signatures (sign-windows.mjs stops it before the first one otherwise); a larger run needs
 * the repository variable WINDOWS_SIGN_LIMIT, which counts for one tag only.
 *
 * Whoever makes a release finds out beforehand whether that release needs it, on any machine:
 *
 *   node scripts/release/sign-budget.mjs estimate vX.Y.Z      (in frontend/, X.Y.Z the version about to be tagged)
 *
 * It reads the previous release — which of its program files are unsigned, and from its packages' RECORD files which
 * file belongs to which package — and what has changed in this checkout since that release's tag (Python, Electron,
 * the packages in uv.lock), then prints the expected count and, when the default is too small, the command that
 * allows it.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { programFiles } from './pe.mjs'
import { carveAppArchive, downloadPreviousInstaller, publishTargetFrom, unpackProgramFiles } from './previous-release.mjs'

/** New signatures one release run may spend without an allowance: a large dependency update fits. */
export const DEFAULT_SIGN_LIMIT = 150

/**
 * How many new signatures this run may spend. WINDOWS_SIGN_LIMIT reads `<tag>=<count>` and counts only for that tag,
 * so an allowance made for one release cannot carry over to the next.
 */
export function signLimit(value, tag) {
  const text = String(value ?? '').trim()
  if (!text) return { limit: DEFAULT_SIGN_LIMIT, override: false }
  const m = /^(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)=(\d{1,5})$/.exec(text)
  if (!m) throw new Error(`WINDOWS_SIGN_LIMIT must read <tag>=<count>, e.g. v1.2.3=400; it reads "${text}"`)
  if (m[1] !== tag)
    return { limit: DEFAULT_SIGN_LIMIT, override: false, note: `WINDOWS_SIGN_LIMIT is set for ${m[1]}, not ${tag ?? 'this build'}: ignored` }
  return { limit: Number(m[2]), override: true }
}

/** The command that allows `count` new signatures for exactly this tag. */
export const allowCommand = (count, tag, { owner, repo }) =>
  `gh variable set WINDOWS_SIGN_LIMIT -R ${owner}/${repo} --body "${tag ?? 'vX.Y.Z'}=${count}"`

/** The sentence that stops a run over its limit, with the one command that allows it. */
export function overLimit(count, limit, tag, target) {
  return (
    `${count} files need a new signature, more than the ${limit} one run may spend (Certum: 5,000 a month). ` +
    'If that is expected — the first signed release, a new Python, a large dependency update — allow it for this tag ' +
    `and run the Windows job again: ${allowCommand(count + 10, tag, target)}`
  )
}

/** A package name as PEP 503 compares it: lower case, runs of - _ . as one hyphen. */
export const normalName = (name) => name.toLowerCase().replace(/[-_.]+/g, '-')

/**
 * Every package of a uv.lock: name → { version, binary, wheels }. `binary`: it has a wheel for 64-bit Windows;
 * `wheels`: those wheels' hashes, so a rebuilt wheel under the same version counts as a change too.
 */
export function lockedPackages(text) {
  const out = new Map()
  for (const block of text.split(/^\[\[package\]\]\n/m).slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1]
    if (!name) continue
    const version = /^version = "([^"]+)"/m.exec(block)?.[1] ?? '?'
    const wheels = [...block.matchAll(/url = "[^"]*win_amd64\.whl"[^\n]*?hash = "([^"]+)"/g)].map((m) => m[1])
    const known = out.get(name)
    out.set(name, {
      version: known ? [known.version, version].sort().join(' | ') : version,
      binary: Boolean(known?.binary) || /win_amd64\.whl/.test(block),
      wheels: [...(known?.wheels ?? []), ...wheels].sort().join(' ')
    })
  }
  return out
}

/** Packages added, removed, moved to another version or given other Windows wheels between two uv.lock texts. */
export function changedPackages(before, after) {
  const a = lockedPackages(before)
  const b = lockedPackages(after)
  const out = []
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const [x, y] = [a.get(name), b.get(name)]
    if (x?.version === y?.version && x?.wheels === y?.wheels) continue
    const to = y ? (x?.version === y.version ? `${y.version} (rebuilt)` : y.version) : null
    out.push({ name, from: x?.version ?? null, to, binary: Boolean(y?.binary ?? x?.binary) })
  }
  return out.sort((p, q) => p.name.localeCompare(q.name))
}

/** 'minor' when the Python minor version changed (every compiled package changes), 'patch' for a patch release. */
export function pythonChange(before, after) {
  const [a, b] = [before.trim(), after.trim()]
  if (a === b) return null
  return a.split('.').slice(0, 2).join('.') === b.split('.').slice(0, 2).join('.') ? 'patch' : 'minor'
}

/**
 * The files a package installed, from its `<name>-<version>.dist-info/RECORD` (CSV: path, hash, size; paths relative
 * to the folder that holds the dist-info). `recordRel`: the RECORD's own path in the package tree.
 */
export function recordEntries(recordRel, text) {
  const m = /(?:^|\/)([^/]+?)-[^-/]+\.dist-info\/RECORD$/.exec(recordRel)
  if (!m) return null
  const base = recordRel.slice(0, recordRel.length - m[0].length + (m[0].startsWith('/') ? 1 : 0))
  const files = []
  for (const line of text.split(/\r?\n/)) {
    const path = line.startsWith('"') ? /^"((?:[^"]|"")*)"/.exec(line)?.[1].replace(/""/g, '"') : line.split(',')[0]
    if (path && !path.startsWith('..') && !path.startsWith('/')) files.push(`${base}${path}`)
  }
  return { name: normalName(m[1]), files }
}

const BACKEND = 'resources/backend/_internal/'

/**
 * Expected new signatures for the next release. `files`: the previous release's program files { rel, signed };
 * `owners`: rel → package name, from the RECORDs; `changes`: { python: 'minor'|'patch'|null, electron: boolean,
 * packages: changedPackages() }. Counts generously: a file its maker signed counts too when its package changed.
 */
export function estimateSignatures(files, owners, changes) {
  const sign = new Set()
  const reasons = []
  const add = (why, rels) => {
    const before = sign.size
    for (const rel of rels) sign.add(rel)
    if (sign.size > before) reasons.push({ why, count: sign.size - before })
  }
  const where = (test) => files.filter((f) => test(f.rel)).map((f) => f.rel)
  add('without a signature in the previous release', files.filter((f) => !f.signed).map((f) => f.rel))
  add('built anew for every version', where((rel) => rel === 'PrismLCA.exe' || rel === 'resources/backend/prism-lca-backend.exe'))
  if (changes.python === 'minor') add('new Python minor version: every backend file', where((rel) => rel.startsWith('resources/backend/')))
  if (changes.python === 'patch')
    add('new Python patch release', where((rel) => rel.startsWith(BACKEND) && !rel.slice(BACKEND.length).includes('/') && !owners.has(rel)))
  if (changes.electron) add('new Electron', where((rel) => !rel.includes('/')))
  const untraced = []
  for (const p of changes.packages) {
    const name = normalName(p.name)
    let rels = where((rel) => owners.get(rel) === name)
    if (!rels.length) {
      const dir = `${BACKEND}${name.replace(/-/g, '_')}`
      rels = where((rel) => rel.startsWith(`${dir}/`) || rel.startsWith(`${dir}.libs/`))
    }
    if (rels.length) add(`${p.name} ${p.from ?? 'new'} → ${p.to ?? 'removed'}`, rels)
    else if (p.binary && p.to) untraced.push(p.name)
  }
  reasons.push({ why: 'installer, uninstaller, elevate.exe', count: 3 })
  return { count: sign.size + 3, reasons, untraced }
}

/**
 * The allowance to ask for, or null when the default covers it. The count is built from the previous release's
 * files, so a changed package's new wheel may bring files it did not have: the headroom is part of the comparison,
 * and a package nobody can trace to files counts 50.
 */
export function neededLimit({ count, untraced }) {
  const want = Math.ceil((count + 50 * untraced.length) * 1.15)
  return want <= DEFAULT_SIGN_LIMIT ? null : Math.ceil(want / 10) * 10
}

const here = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(here, '..', '..')
const ROOT = resolve(FRONTEND, '..')

/** What changed in this checkout since `tag`, read with git from the tag and from the files on disk. */
function changesSince(tag) {
  const atTag = (path) => {
    try {
      return execFileSync('git', ['-C', ROOT, 'show', `${tag}:${path}`], { encoding: 'utf-8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      throw new Error(`git cannot read ${path} at ${tag}; fetch the tags first (git fetch --tags)`)
    }
  }
  const now = (path) => readFileSync(join(ROOT, path), 'utf-8')
  const electron = (text) => JSON.parse(text).packages?.['node_modules/electron']?.version
  return {
    python: pythonChange(atTag('backend/.python-version'), now('backend/.python-version')),
    electron: electron(atTag('frontend/package-lock.json')) !== electron(now('frontend/package-lock.json')),
    packages: changedPackages(atTag('backend/uv.lock'), now('backend/uv.lock'))
  }
}

/** rel → package name for every file a RECORD below `dir` lists. */
function recordOwners(dir) {
  const owners = new Map()
  const visit = (abs) => {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name)
      if (statSync(p).isDirectory()) visit(p)
      else if (name === 'RECORD') {
        const found = recordEntries(relative(dir, p).split(sep).join('/'), readFileSync(p, 'utf-8'))
        for (const rel of found?.files ?? []) owners.set(rel, found.name)
      }
    }
  }
  visit(dir)
  return owners
}

async function estimate(tag) {
  const target = publishTargetFrom(readFileSync(join(FRONTEND, 'electron-builder.yml'), 'utf-8'))
  const dir = mkdtempSync(join(tmpdir(), 'prism-sign-estimate-'))
  try {
    const installer = join(dir, 'installer.exe')
    const archive = join(dir, 'app.7z')
    const unpacked = join(dir, 'files')
    const version = await downloadPreviousInstaller(target, installer)
    await carveAppArchive(installer, archive)
    rmSync(installer)
    await unpackProgramFiles(archive, unpacked)
    rmSync(archive)
    const files = programFiles(unpacked).map((f) => ({ rel: f.rel, signed: Boolean(f.layout.certSize) }))
    const changes = changesSince(`v${version}`)
    const result = estimateSignatures(files, recordOwners(unpacked), changes)
    const unsigned = files.filter((f) => !f.signed).length
    const packages = changes.packages.filter((p) => p.binary)
    console.log(`Previous release ${version}: ${files.length} program files, ${unsigned} without a signature.`)
    console.log(
      `Changed since v${version}: Python ${changes.python ?? 'unchanged'}, Electron ${changes.electron ? 'changed' : 'unchanged'}, ` +
        `${packages.length} package(s) with Windows binaries${packages.length ? ` (${packages.map((p) => `${p.name} ${p.from ?? 'new'} → ${p.to ?? 'removed'}`).join(', ')})` : ''}.`
    )
    console.log(`Expected new signatures for ${tag}: about ${result.count}`)
    for (const r of result.reasons) console.log(`  ${String(r.count).padStart(4)}  ${r.why}`)
    if (result.untraced.length)
      console.log(`Changed packages with Windows binaries that no file of the previous release traces to (50 each): ${result.untraced.join(', ')}`)
    const limit = neededLimit(result)
    if (limit == null) console.log(`→ No WINDOWS_SIGN_LIMIT needed: within the ${DEFAULT_SIGN_LIMIT} a run may spend.`)
    else console.log(`→ Before tagging, allow it for this tag:\n  ${allowCommand(limit, tag, target)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, tag] = process.argv.slice(2)
  if (cmd === 'estimate' && /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(tag ?? '')) await estimate(tag)
  else {
    console.error('usage: sign-budget.mjs estimate vX.Y.Z   (the tag about to be released)')
    process.exit(2)
  }
}
