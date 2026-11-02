/**
 * No two files in one folder whose names differ only in case before the extension.
 *
 * Imports leave the extension out, and Windows and macOS do not tell `Sensitivity` from `sensitivity`: an
 * import of the component `Sensitivity.tsx` found the helper module `sensitivity.ts` beside it, and the
 * Windows installer build failed while every check here passed — they run on Linux, which tells the two
 * apart. This test makes the build machines' view the rule everywhere.
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = __dirname

function collisions(dir: string, out: string[] = []): string[] {
  const seen = new Map<string, string>()
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      collisions(path, out)
      continue
    }
    const stem = name.split('.')[0]
    const other = seen.get(stem.toLowerCase())
    if (other !== undefined && other !== stem) out.push(`${relative(SRC, dir)}: ${other} / ${stem}`)
    else seen.set(stem.toLowerCase(), stem)
  }
  return out
}

describe('file names', () => {
  it('never differ only in case within one folder', () => {
    expect(collisions(SRC)).toEqual([])
  })
})
