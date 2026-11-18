/**
 * Every custom property a stylesheet reads must be defined somewhere.
 *
 * A `var()` of a name nobody defines falls back silently: to its fallback if it has one, otherwise
 * to the property's initial value. Either way it paints the same colour in both themes, and nothing
 * looks broken until someone compares the dark theme by eye. This test collects every `--name:`
 * declaration in the app stylesheets and the token file, and every `var(--name)` they read, and
 * names the reads that resolve to nothing.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { tokenSource } from './themeTokenSource'

const STYLES = join(__dirname, '../styles')

/** Properties a component sets inline on the element, so no sheet declares them. */
const SET_INLINE: Record<string, string> = {
  '--at': 'components/EffortScale.tsx: the position of each step on the scale, 0..1'
}

/** A sheet's text with its comments blanked, so a name mentioned in prose is neither a read nor a
 *  definition. The line breaks stay, so the line numbers in a failure point into the file. */
function code(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''))
}

describe('custom property references in the stylesheets', () => {
  const sheets = readdirSync(STYLES)
    .filter((f) => f.endsWith('.css'))
    .map((f) => ({ name: `styles/${f}`, css: code(join(STYLES, f)) }))
  const all = [
    ...sheets,
    { name: 'index.css', css: code(join(__dirname, '../index.css')) },
    { name: 'prism-theme.css', css: code(join(__dirname, tokenSource)) }
  ]

  it('finds the stylesheets and the token file', () => {
    expect(sheets.length).toBeGreaterThan(10)
    expect(all.at(-1)!.css).toMatch(/--text\s*:/)
  })

  it('reads no custom property that no sheet defines', () => {
    const defined = new Set(Object.keys(SET_INLINE))
    for (const { css } of all) for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1])
    const missing: string[] = []
    for (const { name, css } of all) {
      css.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/var\(\s*(--[\w-]+)/g)) {
          if (!defined.has(m[1])) missing.push(`${name}:${i + 1}: ${m[1]}`)
        }
      })
    }
    expect(missing).toEqual([])
  })
})
