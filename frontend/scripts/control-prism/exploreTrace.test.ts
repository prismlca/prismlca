import { describe, expect, it } from 'vitest'
import type { TraceState } from './bombadil'
import { describeAction, dialogType, named, readCoverageTable, restOrder, TraceDigest } from './exploreTrace'

/** A trace state as `bombadil trace --json` prints it, with the snapshots of features/explore/lib.ts. */
function state(
  index: number,
  seconds: number,
  o: {
    action?: unknown
    page?: string
    dialog?: string | null
    section?: string | null
    doc?: number
    violations?: string[]
    rest?: { id: number; verdict: string | null; windows: number; page?: string }
    loading?: string[]
    branches?: number[]
    banner?: string | null
  } = {}
): TraceState {
  return {
    index,
    metadata: {
      timestamp: 1_000_000_000 + seconds * 1e6,
      action: 'action' in o ? o.action : 'Wait',
      state: { branches: o.branches ?? [] },
      snapshots: [
        {
          name: 'where',
          value: {
            doc: o.doc ?? 1,
            page: o.page ?? 'Model',
            dialog: o.dialog ?? null,
            section: o.section ?? null
          }
        },
        {
          name: 'rest',
          value: o.rest
            ? { page: o.rest.page ?? 'Model', last: [{ commits: 400, ms: 1000 }], ...o.rest }
            : null
        },
        { name: 'loading', value: o.loading ?? [] },
        { name: 'serverErrorBanner', value: o.banner ?? null }
      ],
      violations: (o.violations ?? []).map((name) => ({ name, violation: { Always: {} } }))
    }
  }
}

const TABLE = readCoverageTable(
  [
    '{"id":1,"script":"index.js","function":"Workbench.onSelectionChange","line":1}',
    '{"id":2,"script":"index.js","function":"useStore","line":1}',
    '{"id":3,"script":"index.js","function":"<top>","line":1}',
    '{"id":4,"script":"index.js","function":"Settings","line":1}',
    '{"id":5,"script":"index.js","fun' // cut off when the run ended
  ].join('\n')
)

describe('the digest of a run', () => {
  it('counts pages, dialog types by kind, documents and coverage', () => {
    const d = new TraceDigest(TABLE)
    d.add(state(0, 0, { action: null, page: 'Overview', doc: 1 }))
    d.add(state(1, 1, { action: 'Reload', page: 'Overview', doc: 2, branches: [3] }))
    d.add(state(2, 2, { page: 'Model', doc: 2, dialog: 'Export bottle', branches: [1] }))
    d.add(state(3, 3, { page: 'Model', doc: 2, dialog: 'Export empty', branches: [1, 2] }))
    d.add(
      state(4, 4, { page: 'Settings', doc: 2, dialog: 'Settings', section: 'Language', branches: [4, 99] })
    )
    const r = d.result()
    expect(r.states).toBe(5)
    expect(r.seconds).toBe(4)
    expect(r.documents).toBe(2)
    expect(r.pages).toEqual([
      { page: 'Model', share: 40 },
      { page: 'Overview', share: 40 },
      { page: 'Settings', share: 20 }
    ])
    expect(r.dialogTypes).toEqual(['Export <name>', 'Settings'])
    expect(r.sections).toEqual(['Settings > Language'])
    // block 99 is not in the table (another script); <top> is no named function
    expect(r.coverage).toEqual({ hit: 4, total: 4, named: 3 })
    expect(r.actions).toEqual({ '(start)': 1, Reload: 1, Wait: 3 })
  })

  it('makes episodes of violating states up to 10 s apart and keeps the state each began in', () => {
    const d = new TraceDigest(null)
    const click = {
      Click: { fingerprint: { tag: 'button', accessible_name: 'Calculate' }, point: { x: 10.4, y: 20.6 } }
    }
    d.add(state(0, 0))
    d.add(
      state(1, 5, {
        action: click,
        violations: ['noServerErrorBanner'],
        banner: 'EmptyBiosphere: — Unexpected server error'
      })
    )
    d.add(
      state(2, 6, {
        violations: ['noServerErrorBanner'],
        banner: 'EmptyBiosphere: — Unexpected server error'
      })
    )
    d.add(state(3, 7))
    // Bombadil reports a condition that stays in bursts: 10 s later is still the same episode, 11 s is not.
    d.add(state(4, 16, { violations: ['noServerErrorBanner'], banner: 'still' }))
    d.add(state(5, 27, { violations: ['noServerErrorBanner'], banner: 'again' }))
    const v = d.result().violations
    expect(v).toHaveLength(1)
    expect(v[0].episodes).toBe(2)
    expect(v[0].shown[0]).toMatchObject({
      first: 1,
      at: 5,
      states: 3,
      action: 'Click <button> "Calculate" at 10,21',
      detail: 'the window shows: EmptyBiosphere: — Unexpected server error'
    })
    expect(v[0].shown[1]).toMatchObject({ first: 5, states: 1, detail: 'the window shows: again' })
  })

  it('names the functions that ran in the windows of a busy observation, not those of the input before it', () => {
    const d = new TraceDigest(TABLE)
    const more = { Custom: { name: 'observeRestMore', arguments: [] } }
    d.add(
      state(0, 0, {
        action: { Custom: { name: 'observeRest', arguments: [] } },
        branches: [4],
        rest: { id: 1, verdict: null, windows: 1 }
      })
    )
    d.add(state(1, 1, { action: more, branches: [1, 2], rest: { id: 1, verdict: null, windows: 2 } }))
    for (let i = 2; i <= 14; i++)
      d.add(
        state(i, i, {
          action: more,
          branches: i % 4 ? [1, 2] : [1],
          rest: { id: 1, verdict: null, windows: i + 1 }
        })
      )
    d.add(
      state(15, 15, {
        action: more,
        branches: [1, 2],
        rest: { id: 1, verdict: 'busy', windows: 15 },
        violations: ['restAfterInput']
      })
    )
    const r = d.result()
    expect(r.rest).toEqual({ observations: 1, verdicts: { busy: 1 } })
    // useStore ran in 11 of the 14 windows from the third on (79 %), the selection callback in all of them
    expect(r.restBusyFunctions).toEqual(['Workbench.onSelectionChange'])
    expect(r.violations[0].shown[0].detail).toBe(
      'observation of Model: busy after 15 window(s); commits in the last: 400'
    )
  })

  it('tells loading that ended in place from loading left behind and loading still on at the end', () => {
    const d = new TraceDigest(null)
    d.add(state(0, 0, { loading: ['load'] }))
    d.add(state(1, 2, { loading: [] }))
    d.add(state(2, 3, { loading: ['calc'], page: 'Results' }))
    d.add(state(3, 9, { loading: ['calc'], page: 'Model' }))
    d.add(state(4, 10, { loading: ['busy'], page: 'Model' }))
    expect(d.result().loading).toEqual({
      load: { began: 1, ended: 1, left: 0, open: 0, maxSeconds: 2 },
      calc: { began: 2, ended: 1, left: 1, open: 0, maxSeconds: 6 },
      busy: { began: 1, ended: 0, left: 0, open: 1, maxSeconds: 0 }
    })
  })
  it('says which loading did not end, and which exception came, in words', () => {
    const d = new TraceDigest(null)
    d.add(state(0, 40, { loading: ['load', 'busy'], violations: ['loadEnds'] }))
    d.add(state(1, 41, { violations: ['noUnhandledPromiseRejections'] }))
    const shown = Object.fromEntries(d.result().violations.map((v) => [v.property, v.shown[0].detail]))
    expect(shown.loadEnds).toBe(
      '"load" did not end within its deadline in the same document, page and dialog (loading now: load, busy)'
    )
    // without the snapshot the violation itself is shown
    expect(shown.noUnhandledPromiseRejections).toBe('{"Always":{}}')
  })
})

describe('reading a trace', () => {
  it('describes actions in one line', () => {
    expect(describeAction(null)).toBe('(start)')
    expect(describeAction('Reload')).toBe('Reload')
    expect(describeAction({ Custom: { name: 'chooseOption', arguments: [2, 10] } })).toBe(
      'chooseOption(2, 10)'
    )
    expect(describeAction({ PressKey: { code: 27 } })).toBe('PressKey {"code":27}')
    expect(
      describeAction({
        Click: {
          fingerprint: { tag: 'body', structural_path: 'body' },
          point: { x: [0, 1919], y: [0, 1079] }
        }
      })
    ).toBe('Click <body> "body" at [0,1919],[0,1079]')
  })

  it('counts dialogs by kind and functions by name', () => {
    expect(dialogType('Duplicate bottle')).toBe('Duplicate <name>')
    expect(dialogType('Model info')).toBe('Model info')
    expect(
      ['Workbench', 'useCanvasModel', 'Workbench.onSelectionChange', 'XYPanZoom.update'].map(named)
    ).toEqual([true, true, true, true])
    // not named: bundle internals, minified library names, short or lower-case words
    expect(['<top>', 'a', 'Ab', 'R$1', 'Ie$1', 'user'].map(named)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false
    ])
  })

  it('lists what ran at rest callbacks first, then hooks, then components', () => {
    expect(
      ['Workbench', 'useStore', 'Workbench.onSelectionChange', 'NodeWrapper', 'XYPanZoom.update'].sort(
        (a, b) => restOrder(a) - restOrder(b) || a.localeCompare(b)
      )
    ).toEqual(['Workbench.onSelectionChange', 'XYPanZoom.update', 'useStore', 'NodeWrapper', 'Workbench'])
  })
})
