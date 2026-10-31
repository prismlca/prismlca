/** Parameters, formulas and scenarios. */
// Split out of the monolithic tools.ts. Spec and run stay together on purpose:
// the prose description and the handler are edited as a pair, and the description guard in
// tools.test.ts scans spec text against implementation names.

import type { Tool } from '../context'
import { bool, num, obj, objArr, str, strArr } from '../schema'
import { AI, S, batchResult, runItem } from '../format'
import { IMPL, delegate } from '../impl'
import { formulaKept } from '../formulaKept'

export const paramsTools: Tool[] = [
  {
    spec: {
      type: 'function',
      function: {
        name: 'evaluate_formula',
        description:
          'What would this formula come to? Evaluates an expression against the open model\'s current parameter values and returns the number — WITHOUT storing anything. Use it before writing a parameterised exchange instead of working the arithmetic out yourself, and for what-if questions: "overrides" substitutes values for this evaluation only ({"d_last_mile": 20}). Reports which parameters it used, and names any it does not know rather than failing vaguely.',
        parameters: obj(
          {
            formula: str('The expression, e.g. "mass_fertiliser * n_content * 44/28".'),
            overrides: {
              type: 'object',
              description: 'Parameter values to substitute for this evaluation only; nothing is saved.',
              additionalProperties: { type: 'number' }
            }
          },
          ['formula']
        )
      }
    },
    run: async (a, ctx) => {
      if (!ctx.activeDb)
        return S({ error: 'No model is open. Formulas are model-scoped — open a model first.' })
      return S(
        await ctx.api('POST', '/api/v1/params/evaluate', {
          database: ctx.activeDb,
          formula: String(a.formula ?? ''),
          overrides: a.overrides && typeof a.overrides === 'object' ? a.overrides : null
        })
      )
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'list_parameters',
        description:
          'List the active model\'s parameters (named variables usable in exchange formulas): name, value or formula, unit, group, comment, and — when the modeller set one — "allowed", what the value is allowed to be ("greater than 0", "between 0 and 1", "one of 0.25, 0.5, 0.75"). Parameters are model-scoped: without "database" this lists the open model\'s, with it another model\'s (a comparison model\'s, to reuse the same names and values). Read this before writing a value or a formula: a value outside "allowed" is refused, and this is where you see the rule before you hit it. Set comments_only=true to get just names + comments + allowed, or with_usage=true to also see WHICH exchanges each parameter drives — the blast radius before you change one, and the way to spot a parameter nothing uses.',
        parameters: obj({
          database: str('Model to read; omit for the open model.'),
          comments_only: bool('Return only name + comment for each parameter (default false).'),
          with_usage: bool('Also list the exchanges whose formula references each parameter.')
        })
      }
    },
    run: async (a, ctx) => {
      const db = (typeof a.database === 'string' && a.database.trim()) || ctx.activeDb
      if (!db) return S({ error: 'No model is open. Parameters are model-scoped — open a model first.' })
      const usage = a.with_usage ? '&with_usage=true' : ''
      const list = (await ctx.api(
        'GET',
        `/api/v1/params?database=${encodeURIComponent(db)}${usage}`
      )) as Array<Record<string, unknown>>
      // `allowed` rides along even in the short form: it is what a writer needs *before* writing, and it
      // is one phrase. Omitted where there is no rule, so the shape stays as small as it was.
      if (a.comments_only)
        return S(
          list.map((p) => ({
            name: p.name,
            comment: p.description ?? null,
            ...(p.allowed ? { allowed: p.allowed } : {})
          }))
        )
      if (a.with_usage) {
        const unused = list.filter((p) => !(p.used_by_count as number)).map((p) => p.name)
        return S({ parameters: list, unused: unused.length ? unused : undefined })
      }
      return S(list)
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'edit_parameter',
        description:
          'Create, update or delete parameters of the active model. action="set" (the default — omit it and you get "set") creates/updates by name: give EITHER value OR formula (a formula may reference other parameter names and use + - * / **, sqrt/exp/log/min/max/clip/round/abs and "A if cond else B"), plus optional unit, group and comment. action="delete" removes it (fails if a formula still references it). Pass "parameters" to set a whole batch in ONE call, and prefer it: a batch is a single transaction with a single recalculation, and inside it a formula MAY reference a parameter created in the same call, so you do not have to order them. All or nothing — if one item is refused, none of them is written, and the answer says which. Changing a parameter recomputes every dependent exchange. A parameter may carry a rule the modeller set — only positive, only negative, a range, or one of a list — and a value outside it is refused, naming the parameter and what it allows; the same holds for what a formula computes. Call list_parameters first and read "allowed" rather than discovering the rule from a refusal. You cannot set or change a rule: it is the modeller\'s decision about their own study, so if a number you were given breaks one, say which parameter and what it allows, and ask.',
        parameters: obj(
          {
            action: str('set (default) | delete.'),
            name: str('Parameter name (letters, digits, underscores).'),
            value: num(
              'Fixed numeric value (action=set; omit when passing a formula). A parameter that has a formula keeps it, and the formula wins, unless clear_formula is true.'
            ),
            formula: str('Formula instead of a fixed value, e.g. "mass * (1 - recycled_share)".'),
            clear_formula: bool(
              "true = drop the parameter's formula and store the value you pass as a fixed number. Only to replace a formula on purpose; leave it false for any other change (unit, group, comment)."
            ),
            unit: str('Optional unit label.'),
            group: str('Optional grouping label.'),
            comment: str('Optional note on meaning, source or assumptions.'),
            parameters: objArr(
              'Several parameters at once (all are "set"); each item takes the fields above.',
              {
                name: str('Parameter name.'),
                value: num('Fixed numeric value.'),
                formula: str('Formula instead of a value.'),
                clear_formula: bool("true = replace this parameter's formula with the value."),
                unit: str('Unit label.'),
                group: str('Grouping label.'),
                comment: str('Note on meaning, source or assumptions.')
              }
            )
          },
          []
        )
      }
    },
    run: async (a, ctx) => {
      const items: any[] = Array.isArray(a.parameters) && a.parameters.length ? a.parameters : []
      if (items.length) {
        // ONE request, not one per item. Fanning out looked like parallelism and was the opposite:
        // every write recalculates the whole model and they queue on the same lock, so 22
        // parameters took 183.9 s where each of them alone takes ~10 (V228). The batch endpoint
        // also lets a formula name a parameter created beside it, which the fan-out could not —
        // three of those 22 failed on ordering alone, with a message about undefined variables that
        // were being defined two rows below (V232).
        if (!ctx.activeDb)
          return S({ error: 'No model is open. Parameters are model-scoped — open a model first.' })
        try {
          const r: any = await ctx.api('POST', '/api/v1/params/bulk', {
            database: ctx.activeDb,
            parameters: items.map((it) => ({
              name: it.name,
              amount: it.formula ? undefined : it.value,
              formula: it.formula || (it.clear_formula === true ? '' : undefined),
              unit: it.unit,
              group: it.group,
              description: it.comment
            })),
            ...AI
          })
          // Same shape the fan-out returned, so nothing reading this had to change — and the same
          // economy as the single write: keep the parameters this call wrote, not the model's whole
          // list, which the endpoint answers with and which would be re-paid on every later round.
          const all: any[] = Array.isArray(r?.parameters) ? r.parameters : []
          const wanted = new Set(items.map((it) => it.name))
          const mine = all.filter((p: any) => wanted.has(p?.name))
          const folded = batchResult(
            items.map((it) => ({
              ok: true,
              item: it,
              result: { parameter: mine.find((p: any) => p?.name === it.name) ?? null }
            }))
          )
          const kept = formulaKept(items, mine)
          // Notes that still quote a changed parameter's previous value ride along (V339) — the batch
          // summary above keeps only the parameters, and this is the one field worth the extra bytes.
          if ((Array.isArray(r?.stale_notes) && r.stale_notes.length) || kept)
            return S({
              ...JSON.parse(folded),
              ...(r?.stale_notes?.length ? { stale_notes: r.stale_notes, hint: r.hint } : {}),
              ...kept
            })
          return folded
        } catch (e) {
          // One transaction means one outcome: nothing was written. Say that, rather than leaving
          // the model to guess which items landed.
          const msg = e instanceof Error ? e.message : String(e)
          return S({
            total: items.length,
            succeeded: 0,
            failed: items.length,
            error: msg,
            hint:
              'The whole batch was refused and nothing was written — parameters are set in one ' +
              'transaction. Fix the item the message names and send the batch again.'
          })
        }
      }
      return delegate({ set: 'set_parameter', delete: 'delete_parameter' }, a, ctx, undefined, 'set')
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'list_scenarios',
        description:
          "List a model's scenarios (named parameter-override sets): id, name, description and overrides (each a number or a formula string). Scenarios are model-scoped: without \"database\" this lists the open model's, with it another model's. Read this to get a scenario id before comparing, editing a value, duplicating or deleting.",
        parameters: obj({ database: str('Model to read; omit for the open model.') })
      }
    },
    run: async (a, ctx) => {
      const db = (typeof a.database === 'string' && a.database.trim()) || ctx.activeDb
      if (!db) return S({ error: 'No model is open. Scenarios are model-scoped — open a model first.' })
      return S(await ctx.api('GET', `/api/v1/scenarios?database=${encodeURIComponent(db)}`))
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'compare_scenarios',
        description:
          'Score an activity for the baseline and one or more of the active model\'s scenarios. Returns the baseline first, then each scenario. Pass "methods" (a list of tuples) to score SEVERAL indicators in one call — a sensitivity reported for one indicator because the others would have cost a call each is a thinner study, not a decision. Get scenario ids from list_scenarios; get the method tuples from list_methods. A result row with "replaces_formula" names the parameters whose own formula that scenario\'s override replaced.',
        parameters: obj(
          {
            code: str('Activity code (the reference product to score).'),
            scenario_ids: strArr('Scenario ids to include alongside the baseline.'),
            method: strArr(
              'LCIA method tuple (from list_methods). Omit to use the first method the model has ' +
                "already been calculated with, or the study's default indicator if it has one — pass " +
                'it explicitly whenever the answer names an indicator.'
            ),
            methods: {
              type: 'array',
              description:
                'Several LCIA method tuples at once; results are returned per indicator, in order.',
              items: strArr('LCIA method tuple.')
            },
            amount: num('Functional-unit amount (default 1).')
          },
          ['code', 'scenario_ids']
        )
      }
    },
    run: async (a, ctx) => {
      if (!ctx.activeDb) return S({ error: 'No model is open.' })
      const one = (method: unknown): Promise<unknown> =>
        ctx.api('POST', '/api/v1/scenarios/compare', {
          database: ctx.activeDb,
          code: a.code,
          scenario_ids: a.scenario_ids,
          method,
          amount: a.amount ?? 1.0
        })
      const many: any[] = Array.isArray(a.methods) && a.methods.length ? a.methods : []
      if (!many.length) return S(await one(a.method))
      // ONE request for all indicators. The fan-out below it replaced looked like parallelism and was
      // the opposite: every request applied every scenario again, and each apply throws the factorised
      // LCA away — 16 indicators × 4 subjects = 64 factorisations, 187 s and 226 s in a
      // real run, where `calculate` over the same 16 indicators took 3 s. The endpoint now applies each
      // scenario once and scores every indicator inside that window (V331). Same shape as before, so
      // nothing reading the answer had to change.
      try {
        const r: any = await ctx.api('POST', '/api/v1/scenarios/compare', {
          database: ctx.activeDb,
          code: a.code,
          scenario_ids: a.scenario_ids,
          methods: many,
          amount: a.amount ?? 1.0
        })
        const per: any[] = Array.isArray(r?.results) ? r.results : []
        return batchResult(per.map((res, i) => ({ ok: true, item: many[i], result: res })))
      } catch (e) {
        return S({ error: e instanceof Error ? e.message : String(e) })
      }
    }
  },
  // =========================================================================
  // Consolidated tools
  //
  // Why: tool-selection accuracy degrades well before 70 tools (OpenAI recommends staying far under
  // 20; Cursor caps MCP tools at 40; RAG-MCP, arXiv:2505.03275, measures 13.6% → 43.1% selection
  // accuracy once the visible set shrinks). Anthropic's tool-writing guidance says the same:
  // consolidate related operations into one task-shaped tool instead of exposing every endpoint.
  //
  // How: these tools DELEGATE to the single-purpose implementations above, which stay untouched and
  // callable (`TOOL_BY_NAME`). Only the consolidated names are offered to the model — the originals
  // are listed in SUPERSEDED_TOOLS and filtered out of `toolSpecs`/`toolCatalog`. That keeps the
  // change reversible, keeps behaviour byte-identical, and keeps old names working if a skill or
  // saved prompt still mentions one.
  // =========================================================================
  {
    spec: {
      type: 'function',
      function: {
        name: 'edit_scenario',
        description:
          'Create or change scenarios of the active model (a scenario is a named set of parameter overrides). action="create" needs name (+ optional description/overrides); "set_value" sets ONE override (id, param, value); "duplicate" and "delete" take the id. Pass "scenarios" to create a WHOLE SET in one call — a sensitivity analysis is normally four or five of them, and one call each is one round each. An override is a number, or a formula over the model\'s parameters written as a string. Either one REPLACES the parameter\'s own formula while the scenario is applied. For a parameter computed from others you can override its inputs instead (its formula then follows them) — choose by what the scenario means. Read ids with list_scenarios; score them with compare_scenarios. Undoable.',
        parameters: obj(
          {
            action: str('One of: create | set_value | duplicate | delete.'),
            name: str('Scenario name (action=create).'),
            description: str('Optional description (action=create).'),
            overrides: {
              type: 'object',
              description:
                'Parameter overrides (action=create) as name → number or formula string, e.g. ' +
                '{"recycling_rate": 0.8} or {"pkg_mass": "1.2 * bottles * 0.02"}. A formula is evaluated with ' +
                "the model's parameters and refused if it names an unknown one or refers to itself.",
              additionalProperties: { anyOf: [{ type: 'number' }, { type: 'string' }] }
            },
            scenarios: {
              type: 'array',
              description:
                'Several scenarios to create in ONE call, each {name, description?, overrides}. ' +
                'Only for action="create"; the top-level fields are ignored when this is given.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  overrides: {
                    type: 'object',
                    additionalProperties: { anyOf: [{ type: 'number' }, { type: 'string' }] }
                  }
                },
                required: ['name']
              }
            },
            id: str('Scenario id (all actions except create).'),
            param: str('Parameter name (action=set_value).'),
            value: {
              anyOf: [{ type: 'number' }, { type: 'string' }],
              description: 'Override value (action=set_value): a number, or a formula string.'
            }
          },
          ['action']
        )
      }
    },
    run: async (a, ctx) => {
      const many = Array.isArray(a.scenarios) ? a.scenarios : null
      if (many?.length) {
        // One item's failure must not lose the others: a sensitivity set is built as a unit, and
        // "three of five landed" is recoverable while "the call threw" is not.
        const results = []
        for (const it of many) {
          results.push(
            await runItem(it, async () => {
              // IMPL answers the model's string; inside a batch the item wants the object, or the
              // caller reads JSON inside JSON.
              const r = await IMPL.create_scenario({ ...a, scenarios: undefined, ...(it as object) }, ctx)
              return typeof r === 'string' ? JSON.parse(r) : r
            })
          )
        }
        return batchResult(results)
      }
      return delegate(
        {
          create: 'create_scenario',
          set_value: 'set_scenario_value',
          duplicate: 'duplicate_scenario',
          delete: 'delete_scenario'
        },
        a,
        ctx
      )
    }
  }
]
