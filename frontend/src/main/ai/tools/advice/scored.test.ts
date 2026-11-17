import { describe, expect, it } from 'vitest'

import { noteScored, scoredFor, seedScored, type ScoredRecord } from './scored'

const GWP = ['IPCC 2021', 'climate change', 'GWP100']
const ACID = ['EF v3.1', 'acidification', 'accumulated exceedance (AE)']
const WATER = ['EF v3.1', 'water use', 'UDP']
const json = (x: unknown): string => JSON.stringify(x)
const scores = (...ms: string[][]): string =>
  json({ activity: { database: 'Barrow', code: 'fu' }, results: ms.map((method) => ({ method, score: 1 })) })

describe('noteScored', () => {
  it('records what the result scored, a whole family included, under the model it scored', () => {
    const r: ScoredRecord = new Map()
    noteScored(r, 'calculate', { code: 'fu', methods: [GWP] }, 'Barrow', scores(GWP))
    noteScored(r, 'calculate', { code: 'fu', method_family: 'EF v3.1' }, 'Barrow', scores(ACID, WATER))
    noteScored(
      r,
      'explain_result',
      { mode: 'tree', code: 'fu', method: GWP },
      'Barrow',
      json({ meta: { method: GWP } })
    )
    expect([...scoredFor(r, 'Barrow').values()]).toEqual([
      'IPCC 2021 | climate change | GWP100',
      'EF v3.1 | acidification | accumulated exceedance (AE)',
      'EF v3.1 | water use | UDP'
    ])
  })

  it('leaves out what failed: the whole call, one entry of a batch, a job not yet delivered', () => {
    const r: ScoredRecord = new Map()
    noteScored(r, 'calculate', { code: 'fu', method: ACID }, 'Barrow', json({ error: 'unknown method' }))
    const batch = {
      total: 2,
      results: [
        { i: 0, ok: true, result: { meta: { method: GWP } } },
        { i: 1, ok: false, error: 'no such method' }
      ]
    }
    noteScored(r, 'explain_result', { code: 'fu', methods: [GWP, ['bogus']] }, 'Barrow', json(batch))
    noteScored(
      r,
      'calculate',
      { code: 'fu', method_family: 'EF v3.1', job: 'start' },
      'Barrow',
      json({ job_id: 'j1' })
    )
    expect([...scoredFor(r, 'Barrow').values()]).toEqual(['IPCC 2021 | climate change | GWP100'])
  })

  it('files a model under the name the backend resolves, whatever its spelling', () => {
    const r: ScoredRecord = new Map()
    noteScored(
      r,
      'calculate',
      { database: 'bottle glass', code: 'fu', method: ACID },
      'Bottle Glass',
      scores(ACID)
    )
    expect(scoredFor(r, 'Bottle Glass').size).toBe(1)
    expect(scoredFor(r, 'bottle-glass').size).toBe(1)
  })

  it('keeps a proxy comparison on background datasets apart from the model', () => {
    const r: ScoredRecord = new Map()
    noteScored(
      r,
      'calculate',
      { database: 'ecoinvent', codes: ['a', 'b'], method: GWP },
      'Barrow',
      scores(GWP)
    )
    const matrix = json({ methods: [{ key: 'k', unit: 'mol', method: ACID }], rows: [] })
    noteScored(
      r,
      'compare',
      {
        subjects: [
          { database: 'Barrow', code: 'fu' },
          { database: 'Other', code: 'x' }
        ]
      },
      'Barrow',
      matrix
    )
    expect([...scoredFor(r, 'Barrow').keys()]).toEqual([JSON.stringify(ACID)])
    expect(scoredFor(r, 'ecoinvent').size).toBe(1)
    expect(scoredFor(r, 'Other').size).toBe(1)
  })

  it('reads the Results page set-up as the open model, from what the view holds', () => {
    const r: ScoredRecord = new Map()
    const view = json({ tab: 'overview', subjects: ['fu'], scenarios: ['s1'], methods: [ACID, WATER] })
    noteScored(r, 'setup_results', { tab: 'overview', methods: [ACID, WATER, GWP] }, 'Barrow', view)
    expect(scoredFor(r, 'Barrow').size).toBe(2) // GWP did not take; 'fu' and 's1' are no indicators
  })

  it('falls back to the arguments only when the result cannot be read', () => {
    const r: ScoredRecord = new Map()
    noteScored(r, 'calculate', { code: 'fu', method_family: 'EF v3.1' }, 'Barrow', '[result dropped]')
    expect([...scoredFor(r, 'Barrow').values()]).toEqual([
      'every standard indicator of the method family "EF v3.1"'
    ])
  })

  it('ignores other tools and a run without a model', () => {
    const r: ScoredRecord = new Map()
    noteScored(r, 'get_process_details', { code: 'x' }, 'Barrow', json({ method: GWP }))
    noteScored(r, 'calculate', { code: 'fu', method: GWP }, null, scores(GWP))
    expect(r.size).toBe(0)
    expect(() => noteScored(undefined, 'calculate', { method: GWP }, 'Barrow', scores(GWP))).not.toThrow()
  })
})

describe('seedScored', () => {
  it('pairs each scoring call of a carried transcript with its result', () => {
    const r: ScoredRecord = new Map()
    seedScored(
      r,
      [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'a', function: { name: 'calculate', arguments: json({ code: 'fu', method: GWP }) } },
            { id: 'b', function: { name: 'calculate', arguments: json({ code: 'fu', method: ACID }) } },
            { id: 'c', function: { name: 'calculate', arguments: '{"code": ' } },
            { id: 'd', function: { name: 'calculate', arguments: json({ code: 'fu', method: WATER }) } }
          ]
        },
        { role: 'tool', tool_call_id: 'a', content: scores(GWP) },
        { role: 'tool', tool_call_id: 'b', content: json({ error: 'unknown method' }) },
        { role: 'tool', tool_call_id: 'c', content: scores(ACID) }
        // 'd' never got a result: the run was stopped before it ran.
      ],
      'Barrow'
    )
    expect([...scoredFor(r, 'Barrow').values()]).toEqual(['IPCC 2021 | climate change | GWP100'])
  })
})
