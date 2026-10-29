#!/usr/bin/env node
/**
 * Prepare a release: `npm run release -- <patch|minor|x.y.z> [--skip-tests] [--no-push]` (in frontend/).
 *
 * One command sets the version EVERYWHERE (frontend/package.json + lockfile, backend/pyproject.toml +
 * uv.lock), drafts the CHANGELOG section, waits until the maintainer has
 * read and finished it, then makes one commit `release: vX` with an annotated tag `vX` on it. Pushing
 * the tag starts the release workflow — so the push is asked for, never assumed.
 *
 * Nothing is guessed: the bump is named by the caller, the previous release is the last one published
 * on GitHub, and a section that still holds a TODO line is not released.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import { TODO, changelogSection, insertSection, nextVersion, pickPreviousRelease, whatsNewSince } from './lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(here, '..', '..')
const ROOT = resolve(FRONTEND, '..')
const BACKEND = join(ROOT, 'backend')
const CHANGELOG = join(ROOT, 'CHANGELOG.md')

const args = process.argv.slice(2)
const bump = args.find((a) => !a.startsWith('--'))
const skipTests = args.includes('--skip-tests')
const noPush = args.includes('--no-push')

// On Windows npm, npx and uv are .cmd/.exe shims that only a shell finds.
const SHELL = process.platform === 'win32'
const run = (cmd, cmdArgs, cwd = ROOT, opts = {}) =>
  execFileSync(cmd, cmdArgs, {
    cwd,
    encoding: 'utf-8',
    stdio: opts.inherit ? 'inherit' : 'pipe',
    shell: SHELL && cmd !== 'git'
  })
const git = (...a) => run('git', a).trim()
const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = async (q) => (await rl.question(q)).trim()
const yes = async (q) => /^(y|yes|j|ja)$/i.test(await ask(`${q} (y/N) `))

function fail(message) {
  console.error(`\n✗ ${message}`)
  rl.close()
  process.exit(1)
}

function githubRepo() {
  const yml = readFileSync(join(FRONTEND, 'electron-builder.yml'), 'utf-8')
  const owner = /^\s*owner:\s*(\S+)/m.exec(yml)?.[1]
  const repo = /^\s*repo:\s*(\S+)/m.exec(yml)?.[1]
  if (!owner || !repo) fail('electron-builder.yml names no publish owner/repo')
  return { owner, repo, url: `https://github.com/${owner}/${repo}` }
}

async function previousRelease({ owner, repo }) {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`, {
      headers: { Accept: 'application/vnd.github+json' }
    })
    if (res.status === 404) return null // private or empty repo: no published release yet
    if (!res.ok) fail(`GitHub answered ${res.status} for the release list — try again, or check the network`)
    return pickPreviousRelease(await res.json())
  } catch (err) {
    fail(`could not ask GitHub for the previous release: ${err instanceof Error ? err.message : err}`)
  }
}

async function main() {
  // 1. The tree is what will be released: clean, on main, level with origin/main.
  if (git('status', '--porcelain')) fail('the working tree has uncommitted changes — commit or stash them first')
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch !== 'main') fail(`releases are made from main, not ${branch}`)
  git('fetch', 'origin', 'main')
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main'))
    fail('main is not level with origin/main — pull or push first, so the tag lands on what everyone has')

  // 2. The same checks the workflow runs, locally first (minutes, not a failed release run).
  if (!skipTests) {
    console.log('Running the test suites (use --skip-tests only if they just ran) …')
    run('uv', ['run', 'pytest', '-n', 'auto', '-q'], BACKEND, { inherit: true })
    run('npx', ['vitest', 'run'], FRONTEND, { inherit: true })
    run('npm', ['run', 'lint'], FRONTEND, { inherit: true })
    run('npm', ['run', 'typecheck'], FRONTEND, { inherit: true })
  }

  // 3. The version, chosen by the caller.
  const pkg = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf-8'))
  let version
  try {
    version = nextVersion(pkg.version, bump)
  } catch (err) {
    fail(err.message)
  }
  if (git('tag', '--list', `v${version}`)) fail(`tag v${version} exists already`)
  if (!(await yes(`Release ${pkg.version} → ${version}?`))) fail('stopped')

  // 4. The previous release decides what the changelog draft covers.
  const gh = githubRepo()
  const previous = await previousRelease(gh)
  console.log(previous ? `Previous release: ${previous.tag} (${previous.publishedAt})` : 'No published release yet — this is the first.')

  // 5. Every version source at once, then a check that they agree.
  run('npm', ['version', version, '--no-git-tag-version'], FRONTEND)
  // --no-sync, then a full sync: a plain `uv version` syncs EXACTLY to the default extras and would
  // remove pytest, ruff and PyInstaller from the environment the next steps need.
  run('uv', ['version', version, '--no-sync'], BACKEND)
  run('uv', ['sync', '--locked', '--extra', 'dev', '--extra', 'build'], BACKEND)
  const fe = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf-8')).version
  const be = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(BACKEND, 'pyproject.toml'), 'utf-8'))?.[1]
  if (fe !== version || be !== version) fail(`versions disagree after the bump: frontend ${fe}, backend ${be}`)

  // 5b. Files generated from the version: the third-party notices name it ("PrismLCA version x"), and
  // the website's licence page copies the notices. Regenerated here and checked, or the release commit
  // would fail test_committed_files_are_current.
  run('uv', ['run', 'python', 'scripts/third_party_notices.py'], BACKEND)
  const site = existsSync(join(ROOT, 'Website2'))
  if (site) run('uv', ['run', 'python', 'scripts/website_licences.py'], BACKEND)
  run(
    'uv',
    ['run', 'pytest', '-q', 'tests/test_third_party_notices.py', 'tests/test_version_sync.py', 'tests/test_website_licences.py'],
    BACKEND,
    { inherit: true }
  )

  // 6. The changelog draft — read and finished by a person before anything is committed.
  const whatsNew = JSON.parse(readFileSync(join(FRONTEND, 'src/renderer/src/assets/whats-new.json'), 'utf-8'))
  const today = new Date().toISOString().slice(0, 10)
  const section = changelogSection({
    version,
    date: today,
    previous,
    entries: whatsNewSince(whatsNew, previous?.publishedAt),
    repoUrl: gh.url
  })
  const before = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, 'utf-8') : '# Changelog\n'
  writeFileSync(CHANGELOG, insertSection(before, section))
  console.log(`\nCHANGELOG.md has a draft section for ${version}. Edit it now (lines with "${TODO}" must go).`)
  for (;;) {
    await ask('Press Enter when the section is final … ')
    const text = readFileSync(CHANGELOG, 'utf-8')
    if (!text.includes(TODO)) break
    console.log(`Still a "${TODO}" line in CHANGELOG.md.`)
  }

  // 7. One commit, one annotated tag on exactly that commit.
  const generated = ['THIRD-PARTY-NOTICES.md', 'frontend/resources/THIRD-PARTY-NOTICES.md']
  if (site) generated.push('Website2/THIRD-PARTY-NOTICES.md', 'Website2/LICENSE.txt', 'Website2/licenses.html')
  git(
    'add',
    'frontend/package.json',
    'frontend/package-lock.json',
    'backend/pyproject.toml',
    'backend/uv.lock',
    'CHANGELOG.md',
    ...generated
  )
  // Nothing else may ride along: whatever changed beyond these is a surprise worth stopping for.
  const stray = git('status', '--porcelain').split('\n').filter((l) => l && !l.startsWith('M  ') && !l.startsWith('A  '))
  if (stray.length) fail(`unexpected changes besides the release files:\n${stray.join('\n')}`)
  git('commit', '-m', `release: v${version}`)
  git('tag', '-a', `v${version}`, '-m', `PrismLCA ${version}`)
  console.log('\n' + git('show', '--stat', '--format=%h %s', 'HEAD'))

  // 8. The push starts the release workflow: asked for, never assumed.
  if (noPush || !(await yes(`Push main and tag v${version} to origin (starts the release workflow)?`))) {
    console.log(`\nNot pushed. When ready: git push origin main && git push origin v${version}`)
  } else {
    git('push', 'origin', 'main')
    git('push', 'origin', `v${version}`)
    console.log(`\nPushed. The release workflow builds the draft for v${version}.`)
  }
  rl.close()
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
