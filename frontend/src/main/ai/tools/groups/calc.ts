/** Running the numbers: LCIA, comparison, and explaining the last result. */
// Split out of the monolithic tools.ts. Spec and run stay together on purpose:
// the prose description and the handler are edited as a pair, and the description guard in
// tools.test.ts scans spec text against implementation names.

import type { Tool } from '../context'
import { bool, num, obj, str, strArr } from '../schema'
import { S, batchResult, runItem } from '../format'
import { delegate } from '../impl'

/**
 * What a comparison is read for, added to the backend's bare matrix: each subject's difference to the
 * FIRST one in percent (the first subject is the reference — put the baseline there), and per indicator
 * which subject scores lowest. `normalize_to_first` adds the ratio as well (reference = 1). The ranking
 * is left out when the rows are not alternatives with the same functional unit — `show_ranking: false` —
 * because "lowest" means nothing between a part and the whole it belongs to.
 */
export function annotateComparison(
  r: any,
  opts: { normalize_to_first?: boolean; show_ranking?: boolean } = {}
): any {
  const subjects: any[] = Array.isArray(r?.subjects) ? r.subjects : []
  const methods: any[] = Array.isArray(r?.methods) ? r.methods : []
  if (subjects.length < 2 || !methods.length) return r
  const first = subjects[0]
  const lowest: Record<string, string> = {}
  for (const m of methods) {
    const key = m.key
    const ref = Number(first?.scores?.[key])
    let best: { label: string; score: number } | null = null
    for (const s of subjects) {
      const v = Number(s?.scores?.[key])
      if (!Number.isFinite(v)) continue
      if (Number.isFinite(ref) && ref !== 0) {
        s.vs_first ??= {}
        s.vs_first[key] = { delta_pct: Number((((v - ref) / Math.abs(ref)) * 100).toPrecision(4)) }
        if (opts.normalize_to_first) s.vs_first[key].ratio = Number((v / ref).toPrecision(4))
      }
      // Signed, not absolute: a credit (−10) IS the smallest impact, which is what the field name and
      // the reading below promise.
      if (best === null || v < best.score) best = { label: s.label, score: v }
    }
    if (best) lowest[key] = best.label
  }
  const out = { ...r, reference: first.label }
  if (opts.show_ranking !== false) out.lowest_per_indicator = lowest
  out.reading =
    `"vs_first" on each subject is its difference to "${first.label}" (the first subject) in percent` +
    (opts.normalize_to_first ? ', "ratio" the score relative to it (reference = 1)' : '') +
    (opts.show_ranking !== false
      ? '; "lowest_per_indicator" names the subject with the smallest impact per indicator — meaningful ' +
        'only when the subjects are alternatives with the same functional unit.'
      : '.')
  return out
}

/** `database` defaults to the open model, like every other tool; without either there is nothing to score. */
function withActiveDb(a: any, ctx: { activeDb: string | null }): any {
  if (typeof a?.database === 'string' && a.database.trim()) return a
  if (!ctx.activeDb)
    return {
      error:
        'No model is open and no "database" was given — pass the model name, or open one with canvas_view action="open_model".'
    }
  return { ...a, database: ctx.activeDb }
}

export const calcTools: Tool[] = [
  {
    spec: {
      type: 'function',
      function: {
        name: 'calculate',
        description:
          'Compute the LCIA score of an activity for one or more methods. Get method arrays from list_methods — or pass "method_family" ("EF v3.1", "IPCC 2021", "ReCiPe 2016") to score EVERY standard indicator of that family in one call, without listing them first. Pass "codes" to score SEVERAL activities in one call — comparing a handful of background datasets is what a proxy decision is made of, and one call each is one round each. "direct_split": true adds how much of each score the activity emits ITSELF ("direct": its own combustion or process emissions) versus what its inputs bring ("upstream") — the gate-to-gate check; a market or an assembly is ~0 % direct, a boiler ~80 %.',
        parameters: obj(
          {
            database: str('Database name; omit for the model open on the canvas.'),
            code: str('Activity code.'),
            codes: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Several activity codes in ONE call, all in "database"; results are returned per code, in order.'
            },
            method: strArr('A single method as its string tuple (from list_methods).'),
            methods: {
              type: 'array',
              items: { type: 'array', items: { type: 'string' } },
              description: 'Multiple methods at once.'
            },
            method_family: str(
              'A whole LCIA method family by name, e.g. "EF v3.1" — every standard indicator of it, ' +
                'no "no LT" or "incl. biogenic" twins unless you name such a family. Replaces method/methods.'
            ),
            amount: num('Reference amount (default 1).'),
            direct_split: bool(
              'true = also return "direct" (the activity\'s own emissions), "upstream" and "direct_share" per score.'
            ),
            job: str(
              'Background mode for a LONG calculation (a whole method family, many methods): "start" answers at once ' +
                'with a job_id; "status" reports progress; "result" returns the scores when done; "cancel" stops it ' +
                'between methods. Omit for an immediate answer. One code per job.'
            ),
            job_id: str('The job to read or cancel (job="status" | "result" | "cancel").')
          },
          []
        )
      }
    },
    // `codes` was the one batch key missing from the set every other read tool offers, and the model
    // reached for it anyway: five background datasets to compare, one call, refused
    // with "code: Field required". The loop is trivial — the engine solves one activity at a time
    // regardless — so the convention may as well be complete.
    run: async (a0, ctx) => {
      // Every other tool acts on the open model when `database` is left out; this one demanded it and
      // refused an otherwise complete first call.
      const a = withActiveDb(a0, ctx)
      if ('error' in a) return S(a)
      // The job form: an external client's tool timeout is shorter than a whole
      // family on a deep model, and a client that gives up and retries would compute it twice.
      if (a.job) {
        const { job, job_id, codes: _codes, ...body } = a
        void _codes
        switch (String(job)) {
          case 'start':
            if (!a.code) return S({ error: 'Pass "code" — one activity per job.' })
            return S({
              ...(await ctx.api('POST', '/api/v1/calc/jobs', body)),
              hint: 'Poll with job="status" and the job_id; read the scores with job="result" once state is "done".'
            })
          case 'status':
          case 'result': {
            if (!job_id) return S({ error: 'Pass "job_id".' })
            const r = await ctx.api(
              'GET',
              `/api/v1/calc/jobs/${encodeURIComponent(String(job_id))}${job === 'result' ? '?result=true' : ''}`
            )
            if (job === 'result' && r?.state === 'running')
              return S({ ...r, hint: 'Still running — poll again with job="status".' })
            return S(r)
          }
          case 'cancel':
            if (!job_id) return S({ error: 'Pass "job_id".' })
            return S(await ctx.api('POST', `/api/v1/calc/jobs/${encodeURIComponent(String(job_id))}/cancel`))
          default:
            return S({ error: `Unknown job "${String(job)}". One of: start | status | result | cancel.` })
        }
      }
      const codes = Array.isArray(a.codes) ? a.codes.map((c: unknown) => String(c)).filter(Boolean) : []
      if (!codes.length) {
        if (!a.code) return S({ error: 'Pass "code" for one activity or "codes" for several.' })
        return S(await ctx.api('POST', '/api/v1/calc/lcia', a))
      }
      const { codes: _drop, ...rest } = a
      const results = []
      for (const code of codes) {
        results.push(await runItem(code, () => ctx.api('POST', '/api/v1/calc/lcia', { ...rest, code })))
      }
      return batchResult(results)
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'compare',
        description:
          'Compare several subjects across several methods (matrix of scores). Put the BASELINE or reference first: every other subject gets its difference to it in percent ("vs_first"), and per indicator the subject with the smallest impact is named ("lowest_per_indicator"). Pass "methods" as tuples from list_methods, or "method_family" ("EF v3.1") for every standard indicator of a family at once. Set show_ranking=false when the subjects are NOT alternatives with the same functional unit (a part against the whole, scope subtotals against a total) — a "lowest" is meaningless there.',
        parameters: obj(
          {
            subjects: {
              type: 'array',
              description: 'Subjects to compare.',
              items: obj(
                {
                  database: str('db'),
                  code: str('code'),
                  label: str('optional label'),
                  amount: num('amount')
                },
                ['database', 'code']
              )
            },
            methods: {
              type: 'array',
              items: { type: 'array', items: { type: 'string' } },
              description: 'Method tuples. Either this or method_family.'
            },
            method_family: str(
              'A whole method family by name ("EF v3.1", "IPCC 2021") as the indicator rows.'
            ),
            normalize_to_first: bool(
              'true = also give each score as a ratio to the first subject (reference = 1).'
            ),
            show_ranking: bool(
              'Default true. false = no "lowest_per_indicator" — for part/whole comparisons.'
            )
          },
          ['subjects']
        )
      }
    },
    run: async (a, ctx) => {
      const hasMethods = Array.isArray(a.methods) && a.methods.length > 0
      if (!hasMethods && !a.method_family)
        return S({ error: 'Pass "methods" (a list of method tuples from list_methods) or "method_family".' })
      const { normalize_to_first, show_ranking, ...body } = a
      const r = await ctx.api('POST', '/api/v1/calc/compare', body)
      return S(
        annotateComparison(r, {
          normalize_to_first: !!normalize_to_first,
          show_ranking: show_ranking !== false
        })
      )
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'explain_result',
        description:
          'Explain WHY a score is what it is. mode="tree" gives the contribution tree (which processes carry the impact; optional aggregate_by="tag:<dimension>" or "geo" for a per-phase breakdown, and "scenario" to see the tree under a scenario\'s overrides); mode="flows" gives the top elementary flows (which emissions/resources drive it; direct_split=true says per flow how much the activity emits itself; phase={dimension, value} keeps only the flows of that tag value, e.g. the emissions that make up the Raw materials phase — a phase may be spread over several processes and inputs); mode="inventory" gives QUANTITIES rather than impacts — how much of every material one functional unit pulls in, which is the read for checking a recipe against a declared mass ("how many grams of glycerine are in one tube"); mode="matrix" is the HOTSPOT MATRIX — the processes down the rows, the indicators in "methods" across, each cell a process\'s OWN impact and share; a process is in it when it reaches the cutoff in at least one indicator and then carries its full row, so a material at 0.3 % of climate change but 40 % of land use is visible in both. Use "matrix" for the hotspot chapter and for any trade-off question across several indicators; "tree" for where a single indicator\'s impact sits in the supply chain. Pass "methods" (a list of tuples) to explain SEVERAL indicators in one call instead of one call per indicator. Get the method tuples from list_methods.',
        parameters: obj(
          {
            mode: str('One of: tree | flows | inventory | matrix.'),
            database: str('Model/database name; omit for the model open on the canvas.'),
            code: str('Activity code.'),
            method: strArr('LCIA method tuple.'),
            methods: {
              type: 'array',
              description:
                'Several LCIA method tuples at once; results are returned per indicator, in order.',
              items: strArr('LCIA method tuple.')
            },
            amount: num('Functional-unit amount (default 1).'),
            aggregate_by: str(
              'mode=tree only: "tag:<dimension>" or "geo". ADDS a grouped breakdown; it does not ' +
                'replace anything, so the same answer still carries the flat contributor list. One ' +
                'call gives you both views — asking again without it repeats work you already have.'
            ),
            scenario: str(
              'mode=tree only: a scenario id from list_scenarios — the tree is then computed with that ' +
                "scenario's parameter overrides. This is how you show WHERE a scenario's difference " +
                'comes from; compare_scenarios only gives the totals.'
            ),
            scenarios: {
              type: 'array',
              description:
                'mode=tree only: several scenario ids at once, one tree each, in order — and pass ' +
                '"aggregate_by" with them to get the phases per scenario, which is the comparison a ' +
                'sensitivity chapter is written from. Include the baseline by leaving one entry empty.',
              items: str('Scenario id from list_scenarios; "" for the baseline.')
            },
            top_n: num(
              'How many rows to return: flows for mode="flows" (default 20), contributors for ' +
                'mode="tree" (default 25), processes for mode="matrix" (default 30). The tree is also cut at a 1 % contribution and a depth ' +
                'limit, so a process missing from it is BELOW the cutoff, not absent from the model.'
            ),
            cutoff: num(
              'mode=matrix only: the share (0.01 = 1 %) a process must reach in at least ONE indicator to get a row. Default 0.01.'
            ),
            direct_split: bool(
              'mode=flows only: true = each flow also carries "direct", the part the activity emits itself, and the answer the direct/upstream split of the total.'
            ),
            phase: {
              ...obj(
                {
                  dimension: str('Tag group, e.g. "Life-cycle phase".'),
                  value: str('Tag value, e.g. "Raw materials".')
                },
                ['dimension', 'value']
              ),
              description:
                'mode=flows only: the flows of ONE tag value (a life-cycle phase), wherever its processes and inputs sit in the model.'
            }
          },
          ['mode', 'code']
        )
      }
    },
    run: async (a0, ctx) => {
      const a = withActiveDb(a0, ctx)
      if ('error' in a) return S(a)
      // The matrix takes ALL methods in one call — that is its point — so it goes before the per-method batching.
      if (a.mode === 'matrix')
        return delegate({ matrix: 'contribution_matrix' }, { ...a, action: 'matrix' }, ctx)
      const many: any[] = Array.isArray(a.methods) && a.methods.length ? a.methods : []
      // `scenario` falls back to the call's own: the batch helper used to overwrite an explicitly
      // requested scenario with `undefined`, and the single call and the methods batch answered the
      // baseline.
      const call = (method: unknown, scenario?: unknown): Promise<unknown> =>
        delegate(
          { tree: 'contribution', flows: 'top_elementary_flows', inventory: 'inventory_per_unit' },
          {
            ...a,
            methods: undefined,
            scenarios: undefined,
            method,
            action: a.mode,
            scenario: scenario ?? a.scenario
          },
          ctx
        )
      // Several scenarios, one call. The per-scenario tree existed already; only the batch did not,
      // so "the phases per scenario" — the view a sensitivity chapter is written from — cost one call
      // per variant and was skipped instead (V310, LH-Lasur run). An empty entry is the baseline.
      const variants: any[] = Array.isArray(a.scenarios) && a.scenarios.length ? a.scenarios : []
      // One after another, not Promise.all: the backend's contribution channel is global and a later
      // member superseded an earlier one mid-traversal (calc_superseded / 409).
      if (variants.length) {
        const results = []
        for (const sc of variants) {
          results.push(
            await runItem(sc, async () => {
              const out = await call(a.method, sc || undefined)
              return typeof out === 'string' ? JSON.parse(out) : out
            })
          )
        }
        return batchResult(results)
      }
      // No "methods" given: behave exactly as before, method and all — including the case where it is
      // absent, which the backend answers with its default indicator.
      if (!many.length) return call(a.method) as Promise<string>
      // `delegate` hands back an already-serialised result; parse it so the batch envelope carries
      // the object rather than a string containing JSON.
      const results = []
      for (const m of many) {
        results.push(
          await runItem(m, async () => {
            const out = await call(m)
            return typeof out === 'string' ? JSON.parse(out) : out
          })
        )
      }
      return batchResult(results)
    }
  }
]
