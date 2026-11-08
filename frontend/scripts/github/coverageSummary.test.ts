/** The coverage summary CI writes to a run's summary page (.github/scripts/coverage-summary.mjs). */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const { summarize } = (await import(
  pathToFileURL(join(__dirname, '..', '..', '..', '.github', 'scripts', 'coverage-summary.mjs')).href
)) as { summarize: (fe: unknown, be: unknown, top?: number) => string }

const lines = (covered: number, total: number) => ({
  lines: { covered, total, pct: (100 * covered) / total }
})

const frontend = {
  total: lines(75, 100),
  '/home/runner/work/prismlca/prismlca/frontend/src/main/index.ts': lines(0, 40),
  '/home/runner/work/prismlca/prismlca/frontend/src/renderer/src/lib/api.ts': lines(38, 40),
  'D:\\a\\prismlca\\prismlca\\frontend\\src\\preload\\index.ts': lines(17, 20)
}

const backend = {
  totals: { covered_lines: 930, num_statements: 1000, percent_covered: 93 },
  files: {
    'src/prism_lca/server.py': { summary: { missing_lines: 50, num_statements: 90, percent_covered: 44.4 } },
    'src/prism_lca/engine/lca.py': {
      summary: { missing_lines: 20, num_statements: 600, percent_covered: 96.7 }
    }
  }
}

describe('coverage summary', () => {
  it('states both totals and the files with the most uncovered lines first, by repository path', () => {
    const md = summarize(frontend, backend, 2)
    expect(md).toContain('| Frontend | 75.0 % (75 of 100) |')
    expect(md).toContain('| Backend | 93.0 % (930 of 1000) |')
    const fe = md.slice(md.indexOf('### Frontend'), md.indexOf('### Backend'))
    expect(fe.indexOf('`frontend/src/main/index.ts` | 40 | 0.0 %')).toBeGreaterThan(-1)
    expect(fe.indexOf('`frontend/src/main/index.ts`')).toBeLessThan(
      fe.indexOf('`frontend/src/preload/index.ts`')
    )
    expect(fe).not.toContain('api.ts') // only the top two
    expect(md).toContain('| `backend/src/prism_lca/server.py` | 50 | 44.4 % |')
  })
})
