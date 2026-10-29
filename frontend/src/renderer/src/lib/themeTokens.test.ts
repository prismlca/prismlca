/**
 * The two dark-theme token tables must stay byte-equal.
 *
 * CSS forces the dark palette to be written twice — once under the system preference
 * (`@media (prefers-color-scheme: dark)`), once for the explicit switch (`[data-theme='dark']`) —
 * because a media query cannot join a selector list. Before the tables were collapsed, the palette
 * existed FOUR times and a colour change had to be made in four places; now it is twice, adjacent,
 * and this test is what keeps "twice" from drifting into "two slightly different darks".
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { tokenSource } from './themeTokenSource'

const css = readFileSync(join(__dirname, tokenSource), 'utf8')

/** The `--name: value` pairs of the first block whose header matches `selector`. */
function tokens(selector: RegExp): Record<string, string> {
  const start = css.search(selector)
  expect(start, `selector ${selector} not found`).toBeGreaterThanOrEqual(0)
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}

describe('theme token tables', () => {
  it('defines the dark palette identically for system preference and explicit switch', () => {
    const media = tokens(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root/)
    const explicit = tokens(/:root\[data-theme='dark'\]/)
    expect(explicit).toEqual(media)
  })

  it('gives every light token a dark counterpart and vice versa', () => {
    const light = tokens(/:root,\s*:root\[data-theme='light'\]/)
    const dark = tokens(/:root\[data-theme='dark'\]/)
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort())
  })
})
