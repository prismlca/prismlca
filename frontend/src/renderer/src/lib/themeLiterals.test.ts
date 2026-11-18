/**
 * A stylesheet that spells a theme colour as a literal paints the light value in both themes.
 *
 * The alert red is the case that bit: tints written as `rgba(204,75,55,…)` stayed the light `--bad`
 * on the dark canvas, beside text and buttons in the dark `--bad`. A tint of a token is
 * `color-mix(in srgb, var(--bad) N%, transparent)`, and a `var()` of a token always defined in
 * prism-theme.css needs no fallback. This test reads the light value from the token table and looks
 * for it in every app stylesheet, as hex and as an rgb triple (comma- or space-separated).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { tokenSource } from './themeTokenSource'

const STYLES = join(__dirname, '../styles')
const theme = readFileSync(join(__dirname, tokenSource), 'utf8')
const lightStart = theme.search(/:root,\s*:root\[data-theme='light'\]/)
const lightTable = theme.slice(theme.indexOf('{', lightStart) + 1, theme.indexOf('}', lightStart))

/** Tokens whose light value must not appear as a literal in an app stylesheet. */
const GUARDED = ['--bad']

function lightHex(token: string): string {
  const m = lightTable.match(new RegExp(`${token}\\s*:\\s*#([0-9a-fA-F]{6})\\s*;`))
  expect(m, `${token} has no six-digit hex value in the light table`).not.toBeNull()
  return m![1].toLowerCase()
}

function literalPattern(hex: string): RegExp {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return new RegExp(`#${hex}\\b|\\b${r}[\\s,]+${g}[\\s,]+${b}\\b`, 'i')
}

describe('theme colours in the stylesheets', () => {
  const sheets = readdirSync(STYLES).filter((f) => f.endsWith('.css'))

  it('finds the stylesheets', () => {
    expect(sheets.length).toBeGreaterThan(10)
  })

  for (const token of GUARDED) {
    it(`never spells the light ${token} as a literal`, () => {
      const pattern = literalPattern(lightHex(token))
      const hits: string[] = []
      for (const sheet of sheets) {
        readFileSync(join(STYLES, sheet), 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (pattern.test(line)) hits.push(`${sheet}:${i + 1}: ${line.trim()}`)
          })
      }
      expect(hits).toEqual([])
    })
  }
})
