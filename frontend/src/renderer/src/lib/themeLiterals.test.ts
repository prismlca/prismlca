/**
 * A stylesheet that spells a theme colour as a literal paints the light value in both themes.
 *
 * The alert red is the case that bit: tints written as `rgba(204,75,55,…)` stayed the light `--bad`
 * on the dark canvas, beside text and buttons in the dark `--bad`. A tint of a token is
 * `color-mix(in srgb, var(--bad) N%, transparent)`, and a `var()` of a token always defined in
 * prism-theme.css needs no fallback. This test reads every colour of the light token table and looks
 * for it in every app stylesheet, as hex (with or without alpha, long or short) and as an rgb triple
 * (comma- or space-separated). Comments are skipped: they do not paint.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { tokenSource } from './themeTokenSource'

const STYLES = join(__dirname, '../styles')
const theme = readFileSync(join(__dirname, tokenSource), 'utf8')
const lightStart = theme.search(/:root,\s*:root\[data-theme='light'\]/)
const lightTable = theme.slice(theme.indexOf('{', lightStart) + 1, theme.indexOf('}', lightStart))

/** Light-table tokens a sheet may spell as a literal. The light surface is plain white, and white is
 *  a colour of its own in the sheets: the toggle knob, the report's paper, the sheen on a progress
 *  bar. A literal cannot say which of the two it means. */
const EXEMPT = new Set(['--surface'])

/** Every colour token of the light table, with its six-digit hex value. */
const LIGHT = [...lightTable.matchAll(/(--[\w-]+)\s*:\s*#([0-9a-fA-F]{6})\s*;/g)].map(
  (m) => [m[1], m[2].toLowerCase()] as const
)
const GUARDED = LIGHT.filter(([token]) => !EXEMPT.has(token))

function literalPattern(hex: string): RegExp {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const forms = [`#${hex}(?:[0-9a-f]{2})?\\b`, `\\b${r}[\\s,]+${g}[\\s,]+${b}\\b`]
  if (hex[0] === hex[1] && hex[2] === hex[3] && hex[4] === hex[5]) {
    forms.push(`#${hex[0]}${hex[2]}${hex[4]}[0-9a-f]?\\b`)
  }
  return new RegExp(forms.join('|'), 'i')
}

/** The sheet with every comment blanked out, line breaks kept so that line numbers still match. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
}

describe('theme colours in the stylesheets', () => {
  const sheets = readdirSync(STYLES).filter((f) => f.endsWith('.css'))

  it('finds the stylesheets', () => {
    expect(sheets.length).toBeGreaterThan(10)
  })

  it('reads the colour tokens from the light table', () => {
    const tokens = LIGHT.map(([token]) => token)
    expect(tokens).toEqual(expect.arrayContaining(['--bad', '--green', '--navy', '--text', '--wait']))
    for (const token of EXEMPT) expect(tokens).toContain(token)
  })

  for (const [token, hex] of GUARDED) {
    it(`never spells the light ${token} as a literal`, () => {
      const pattern = literalPattern(hex)
      const hits: string[] = []
      for (const sheet of sheets) {
        withoutComments(readFileSync(join(STYLES, sheet), 'utf8'))
          .split('\n')
          .forEach((line, i) => {
            if (pattern.test(line)) hits.push(`${sheet}:${i + 1}: ${line.trim()}`)
          })
      }
      expect(hits).toEqual([])
    })
  }
})
