import { describe, expect, it } from 'vitest'
import type { RunRecord } from './exploreRun'
import { findingsOf, renderReport } from './exploreReport'
import type { RunDigest } from './exploreTrace'

const digest = (over: Partial<RunDigest> = {}): RunDigest => ({
  states: 100,
  seconds: 300,
  documents: 2,
  actions: {},
  pages: [
    { page: 'Model', share: 60 },
    { page: 'Overview', share: 39.9 },
    { page: '(none)', share: 0.1 }
  ],
  dialogTypes: ['Settings'],
  sections: [],
  coverage: { hit: 10, total: 100, named: 5 },
  violations: [],
  rest: { observations: 3, verdicts: { rest: 3 } },
  restBusyFunctions: [],
  loading: {},
  ...over
})

const run = (session: string, over: Partial<RunRecord> = {}): RunRecord => ({
  session,
  label: 'explore',
  dir: `/out/${session}`,
  seconds: 300,
  outcome: 'complete',
  bombadil: { exit: 0, seconds: 300 },
  digest: digest(),
  namedFunctions: ['Workbench'],
  hitBlocks: [1, 2],
  totalBlocks: 100,
  backend: { unhandled: 0, groups: [] },
  consoleErrors: 0,
  refused: { count: 0, byKind: {}, targets: [] },
  load: [2],
  screenshots: {},
  stopped: true,
  ...over
})

const meta = {
  title: 'control-prism explore — test',
  checkout: '/c',
  bombadil: '0.8.0',
  spec: { hash: 'abc', verified: true },
  runs: 2,
  seconds: 300
}

describe('the report', () => {
  it('counts the pages of the app, not the start before them, and the runs together', () => {
    const text = renderReport(meta, [run('a'), run('b', { hitBlocks: [2, 3] })])
    expect(text).toContain('No findings, every run complete.')
    expect(text).toContain('| a | complete | 100 | 2 | 1 | 10.0 % | 0 |')
    expect(text).toContain('Together: 3.0 % of the blocks, 1 named functions, 2 pages, 1 dialog types.')
  })

  it('puts findings first and keeps an open run open', () => {
    const red = run('a', {
      digest: digest({
        violations: [
          {
            property: 'restAfterInput',
            episodes: 2,
            shown: [
              {
                property: 'restAfterInput',
                first: 44,
                at: 21,
                states: 3,
                where: { doc: 1, page: 'Model', dialog: null, section: null },
                action: 'observeRestMore()',
                detail: 'observation of Model: busy after 15 window(s)'
              }
            ]
          }
        ],
        restBusyFunctions: ['Workbench.onSelectionChange', 'useStore']
      }),
      screenshots: { 'restAfterInput@44': 'a/states/44.jpeg' },
      backend: {
        unhandled: 3,
        groups: [
          { exception: 'KeyError: x', where: 'api/v1/models.py:12 in rename', count: 3, firstLine: 40 }
        ]
      }
    })
    const open = run('b', { outcome: 'open', why: 'Bombadil broke; the window still answers' })
    const text = renderReport(meta, [red, open])
    expect(text).toContain('2 finding(s); 1 run(s) not complete.')
    expect(text).toContain('### a: restAfterInput — 2 episode(s)')
    expect(text).toContain(
      '- at 0:21, state 44 (page Model), after `observeRestMore()`: observation of Model: busy after 15 window(s) — [screenshot](a/states/44.jpeg)'
    )
    expect(text).toContain('Workbench.onSelectionChange, useStore')
    expect(text).toContain('### a: Unhandled error KeyError: x — ×3')
    expect(text).toContain('**OPEN** — Bombadil exit 0 after 300 s; Bombadil broke; the window still answers')
  })

  it('reports console errors only where no property did', () => {
    expect(findingsOf(run('a', { consoleErrors: 2 })).map((f) => f.source)).toEqual(['console'])
    const seen = run('a', {
      consoleErrors: 2,
      digest: digest({ violations: [{ property: 'noConsoleErrors', episodes: 1, shown: [] }] })
    })
    expect(findingsOf(seen).map((f) => f.source)).toEqual(['property'])
  })

  it('warns when the spec has not passed its controls', () => {
    expect(renderReport({ ...meta, spec: { hash: 'abc', verified: false } }, [])).toContain(
      'The spec has changed since its positive controls last passed'
    )
  })
})
