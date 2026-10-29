/**
 * Tripwire for an accepted audit exception (frontend/scripts/release/audit-exceptions.json,
 * GHSA-fgmj-fm8m-jvvx / CVE-2026-45249): ECharts < 6.1 renders `series.data[i].name` of a **Lines**
 * series as raw HTML in its default tooltip. PrismLCA is not affected only because it draws no Lines
 * series — model and process names, which can come from someone else's .prism bundle, end up in chart
 * data. Whoever adds `type: 'lines'` must first move to echarts 6.1 (or give that series an escaping
 * tooltip formatter) and remove the exception.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : sources(p)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

describe('ECharts series types', () => {
  it('uses no Lines series while echarts is below 6.1 (accepted advisory GHSA-fgmj-fm8m-jvvx)', () => {
    const offenders = sources(join(__dirname, 'renderer')).filter((p) =>
      /type:\s*['"]lines['"]/.test(readFileSync(p, 'utf-8'))
    )
    expect(offenders).toEqual([])
  })
})
