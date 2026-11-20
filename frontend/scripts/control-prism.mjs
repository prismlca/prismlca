#!/usr/bin/env node
/**
 * Starts control-prism (scripts/control-prism/cli.ts): bundles it with esbuild when a source is newer than
 * the bundle, then runs it. The bundle goes to .cache/control-prism.cjs — one folder below frontend/,
 * which is where the end-to-end harness it reuses (e2e/app.ts) expects to find frontend/ from.
 *
 * Usage, from frontend/:  node scripts/control-prism.mjs <command> …   (help lists the commands)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontend = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = join(frontend, '.cache', 'control-prism.cjs')
const sources = [join(frontend, 'scripts', 'control-prism'), join(frontend, 'e2e')]

function newest(dir) {
  let t = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    t = Math.max(t, e.isDirectory() ? newest(full) : statSync(full).mtimeMs)
  }
  return t
}

const stale =
  !existsSync(bundle) ||
  statSync(bundle).mtimeMs < Math.max(...sources.map(newest), statSync(fileURLToPath(import.meta.url)).mtimeMs)
if (stale) {
  mkdirSync(dirname(bundle), { recursive: true })
  // Written beside the bundle and renamed over it, so a second command starting meanwhile never runs half a file.
  const tmp = `${bundle}.${process.pid}.tmp`
  const { build } = await import('esbuild')
  await build({
    entryPoints: [join(frontend, 'scripts', 'control-prism', 'cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    outfile: tmp,
    logLevel: 'warning'
  })
  renameSync(tmp, bundle)
}
const r = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: 'inherit', cwd: frontend })
process.exit(r.status ?? 1)
