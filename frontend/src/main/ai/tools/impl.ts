/** Every single-purpose implementation behind the consolidated tools, in ONE map on purpose:
 * `delegate` routes action names across domains, and NON_TOOL_IMPL_NAMES must be derived over the
 * complete map or its guard test silently stops covering part of it. */
import type { Tool, ToolCtx } from './context'
import { geoName, isAggregate } from '../../../shared/geographyNames'
import { AI, S, cap, oneScenario } from './format'
import { formulaKept } from './formulaKept'
import {
  NEEDS_A_LOOK,
  NEEDS_A_LOOK_FLOOR,
  NEEDS_A_LOOK_TOP_N,
  unopenedLinkedHotspots
} from './advice/hotspots'

/**
 * Single-purpose implementations behind the consolidated tools. They are NOT registered as tools:
 * the model sees the consolidated surface only (see the note on TOOLS below), and each capability
 * exists exactly once, here.
 */
export const IMPL: Record<string, Tool['run']> = {
  get_model_info: async (a, ctx) => {
    const db = a.database || ctx.activeDb
    if (!db) return S({ error: 'No model open — pass a database name.' })
    const meta = await ctx.api('GET', `/api/v1/study?database=${encodeURIComponent(db)}`)
    const empty = !meta || Object.values(meta).every((v) => !v)
    return S({
      database: db,
      study: meta ?? {},
      hint: empty
        ? 'No goal & scope recorded yet — consider clarifying it with the user and saving it with model_info action="set".'
        : undefined
    })
  },
  set_model_info: async (a, ctx) => {
    const { database, add_limitations: added, ...fields } = a ?? {}
    const db = database || ctx.activeDb
    if (!db) return S({ error: 'No model open — pass a database name.' })
    // Empty values are model padding, never intent: GPT-5.6 sends every schema field on every call
    // ("" / []), and the backend stores what arrives — so one padded `set` WIPED a study's recorded
    // goal & scope mid-run (V292; the model happened to notice and re-send). An empty string or an
    // empty list here means "not this field", the same reading `edit_process` applies. This also
    // keeps a padded `limitations: []` from reading as "replace the list with nothing" (V288).
    for (const k of Object.keys(fields)) {
      const v = (fields as Record<string, unknown>)[k]
      if ((typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length))
        delete (fields as Record<string, unknown>)[k]
    }
    // `limitations` replaces the whole list, which is right for an edit and wrong for an afterthought:
    // adding the fifth limitation meant resending the other four correctly from memory. This reads the
    // current list and appends, so a late "and this too" cannot quietly drop what was already recorded.
    if (Array.isArray(added) && added.length) {
      if (Array.isArray(fields.limitations)) {
        return S({
          error:
            'Pass either "limitations" (replaces the whole list) or "add_limitations" (appends), not both.'
        })
      }
      const meta = await ctx.api('GET', `/api/v1/study?database=${encodeURIComponent(db)}`)
      const current = Array.isArray(meta?.limitations) ? meta.limitations : []
      // Same text twice is an accident, not an emphasis.
      const seen = new Set(
        current.map((l: unknown) =>
          String((l as { text?: string })?.text ?? '')
            .trim()
            .toLowerCase()
        )
      )
      const fresh = added.filter((l: unknown) => {
        const key = String((l as { text?: string })?.text ?? '')
          .trim()
          .toLowerCase()
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      fields.limitations = [...current, ...fresh]
    }
    // `ai_model`: the study records which LLM wrote its words (V128) — the backend stamps it only
    // when this call actually sets content.
    return S(await ctx.api('POST', '/api/v1/study', { ...fields, database: db, ai_model: ctx.model, ...AI }))
  },
  list_geographies: async (a, ctx) => {
    // Codes from the database, names as the region picker shows them (shared/geographyNames.ts — the
    // workspace's own release first): "RER" alone is a code to remember, "RER — Europe" is a region to
    // reason about. `query` filters by either.
    const [codes, named] = await Promise.all([
      ctx.api('GET', `/api/v1/search/geographies/${encodeURIComponent(a.database)}`) as Promise<string[]>,
      (ctx.api('GET', '/api/v1/search/geography-names') as Promise<{ names?: Record<string, string> }>).catch(
        () => ({ names: {} })
      )
    ])
    const names = named?.names ?? {}
    const q = String(a.query ?? '')
      .trim()
      .toLowerCase()
    const all = (Array.isArray(codes) ? codes : []).map((code) => {
      return { code, name: geoName(code, names) ?? null, aggregate: isAggregate(code) }
    })
    const hits = q
      ? all.filter((g) => g.code.toLowerCase().includes(q) || (g.name ?? '').toLowerCase().includes(q))
      : all
    // Aggregates first (RER, GLO, RoW and the grid regions are what a search filter usually wants), then
    // countries; alphabetical within each.
    hits.sort((x, y) => Number(y.aggregate) - Number(x.aggregate) || x.code.localeCompare(y.code))
    return S({
      database: a.database,
      count: hits.length,
      geographies: hits,
      reading:
        '"aggregate": true marks a region or market area (RER = Europe, GLO = global, RoW = rest of world) rather than a country; a name of null means no name is known for the code.'
    })
  },
  read_source: async (a, ctx) => {
    // A file the user attached earlier. It is still stored with the project, so a long conversation
    // that pushed the attachment out of the context can get the part it needs back — cheaply, if it
    // names a page range or a sheet instead of asking for the whole file (see ai/attachments.ts).
    const id = String(a.source ?? a.id ?? '').trim()
    if (!id)
      return S({ error: 'Pass "source" — the id shown with the attached file, e.g. "3f9c…-spec.pdf".' })
    const query = new URLSearchParams()
    if (a.pages) query.set('pages', String(a.pages))
    if (a.sheet) query.set('sheet', String(a.sheet))
    const suffix = query.toString() ? `?${query}` : ''
    const r = await ctx.api('GET', `/api/v1/files/attachments/${encodeURIComponent(id)}/text${suffix}`)
    return S({
      name: r?.name,
      kind: r?.kind,
      pages: r?.pages,
      text: r?.text ?? '',
      truncated: r?.truncated || undefined,
      note: r?.note
    })
  },
  lookup_classification: async (a, ctx) => {
    const [isic, cpc] = await Promise.all([
      ctx.api('GET', '/api/v1/model/isic-sections'),
      ctx.api('GET', '/api/v1/model/cpc-vocabulary')
    ])
    const q = String(a.query ?? '').toLowerCase()
    const all = (cpc?.cpc ?? []) as Array<{ code: string; name: string }>
    const matches = q ? all.filter((c) => c.code.includes(q) || c.name.toLowerCase().includes(q)) : all
    const { items, note } = cap(matches, 30)
    return S({ isic_sections: isic?.sections ?? [], cpc_matches: items, note })
  },
  contribution: async (a, ctx) => {
    const r = await ctx.api('POST', '/api/v1/calc/contribution', { cutoff: 0.01, max_depth: 6, ...a })
    // The raw tree can be tens of kB; the chatbot needs the total + the biggest contributors.
    // Flatten to the top nodes by |direct impact| (they sum to the total), keep meta+aggregation.
    // Two quantities per node, and they are NOT interchangeable — which is why both are named here.
    // This list once carried `direct` beside `share`, where `direct` is the node's own
    // emissions (`cumulative - children`) and `share` was `cumulative / total`, its whole subtree.
    // Under a heading that says "by direct impact" they read as one number and its percentage, and a
    // model reported "flat glass production ~2.7 kg, 33 %" — 2.7 kg is 25.6 %, and 33 % is the 3.53 kg
    // of the entire glass chain. The share column summed to 122.7 % because parents and children both
    // counted, while the direct column summed to 97.4 % of the total, as it should.
    const flat: Array<{
      name: string
      database: string
      code: string
      geo: string
      direct: number
      direct_share: number
      cumulative: number
      cumulative_share: number
      /** Only present when the activity is reached by more than one supply chain. */
      paths?: number
    }> = []
    const total = Number(r?.meta?.total) || 0
    // One row per ACTIVITY, not per path. A dataset reached through two supply chains appeared twice
    // with the same name and the same code and different numbers, and nothing said why. Measured:
    // `titanium dioxide production, sulfate process` [RER] stood in the list twice
    // (cumulative 3.24 and 4.90) because the model bought titanium dioxide directly AND inside its
    // binder. The model quoted the second row — "titanium dioxide ~5 kg, 18 %" — for a substance
    // carrying 11.46 kg and 41 % of the result. Summing is safe here and only here: the subtrees of
    // two distinct paths are disjoint, so their cumulatives add up to what that activity really
    // drags in. `paths` says when it happened, because two paths to one dataset is worth knowing on
    // its own — it is usually a recipe counting something twice.
    const byKey = new Map<string, (typeof flat)[number] & { paths: number }>()
    /** The model's own database: everything else in the tree is background. */
    const fg = String(r?.tree?.db ?? a.database ?? '')
    const walk = (n: any): void => {
      if (!n) return
      // database + code together identify the process — codes can repeat across databases,
      // and follow-up tools (get_activity, expand, …) need the pair.
      const key = `${n.db}\u0000${n.c}\u0000${n.g ?? ''}`
      const seen = byKey.get(key)
      if (seen) {
        seen.direct += n.dir
        seen.direct_share = total ? seen.direct / total : 0
        seen.cumulative += n.imp
        seen.cumulative_share += n.shr
        seen.paths += 1
      } else {
        byKey.set(key, {
          name: n.n,
          database: n.db,
          code: n.c,
          geo: n.g,
          direct: n.dir,
          direct_share: total ? n.dir / total : 0,
          cumulative: n.imp,
          cumulative_share: n.shr,
          paths: 1
        })
      }
      for (const ch of n.ch ?? []) walk(ch)
    }
    walk(r?.tree)
    const unread = unopenedLinkedHotspots(r?.tree, fg, ctx.inspected)
    flat.push(...[...byKey.values()].map((v) => (v.paths > 1 ? v : ({ ...v, paths: undefined } as any))))
    flat.sort((x, y) => Math.abs(y.direct) - Math.abs(x.direct))
    // The 25 was fixed and undocumented, so the only way to learn of it was the footnote on a
    // result that had already been cut. Now it is a parameter with the old value as its default.
    const limit = Number.isFinite(Number(a.top_n)) ? Math.max(1, Math.min(200, Number(a.top_n))) : 25
    const { items, note } = cap(flat, limit)
    return S({
      meta: r?.meta,
      aggregation: r?.aggregation,
      top_contributors_by_direct_impact: items,
      ...(unread.length
        ? {
            not_yet_inspected: unread,
            inspect_these:
              `${unread.length} dataset(s) among the biggest contributors to this result (everything ` +
              `above ${Math.round(NEEDS_A_LOOK * 100)} %, plus the top ${NEEDS_A_LOOK_TOP_N} down to ` +
              `${Math.round(NEEDS_A_LOOK_FLOOR * 100)} %) ` +
              'have not been opened in this chat. Call get_process_details on them (one call takes a ' +
              '"codes" list) NEXT — before scenarios, review_model, limitations or the report: a dataset ' +
              'often states in its own ' +
              'comment what it was built for, and a name alone cannot tell you that a generic ' +
              '"printed wiring board" is calibrated on laptop boards. For a MARKET, read the producer ' +
              'behind it too — the market comment is boilerplate and the sentence you need sits one ' +
              'level down.'
          }
        : {}),
      how_to_read:
        'Each row carries TWO different quantities. "direct"/"direct_share" is what is left with this ' +
        'process once its EXPANDED suppliers are taken out: its own emissions PLUS every supplier the ' +
        'tree did not open (below the cut-off, or beyond the depth limit) — so a process with many small ' +
        'inputs can show a large "direct" figure that is not its own emissions; lower the cut-off or ' +
        'raise the depth to split it. These figures add up to the total, and that is what this ' +
        'list is ranked by. "cumulative"/"cumulative_share" is the whole chain beneath it, so those ' +
        'OVERLAP between a process and its suppliers and must never be summed. Quote a figure with ' +
        'its own percentage: pairing a direct amount with a cumulative share overstates it. One row ' +
        'per activity: where "paths" is present the same dataset is reached by that many supply ' +
        'chains and its figures are already added together — a material with paths > 1 is bought ' +
        'more than once, which is worth checking against your recipe.',
      note
    })
  },
  top_elementary_flows: async (a, ctx) => {
    const r = await ctx.api('POST', '/api/v1/calc/elementary-flows', { top_n: 15, ...a })
    if (a.direct_split && r && typeof r === 'object')
      r.reading =
        'Per flow, "impact" is the whole supply chain and "direct" the part this activity emits itself; ' +
        '"direct"/"upstream"/"direct_share" at the top split the total the same way. A market or an ' +
        'assembly has ~0 direct; a combustion process carries most of its CO2 as direct.'
    return S(r)
  },
  contribution_matrix: async (a, ctx) => {
    const given: unknown[] =
      Array.isArray(a.methods) && a.methods.length ? a.methods : a.method ? [a.method] : []
    if (!given.length)
      return S({
        error:
          'mode="matrix" needs "methods": a list of method tuples from list_methods (up to 10) — the matrix is processes × THESE indicators.'
      })
    const methods = given.slice(0, 10)
    const r = await ctx.api('POST', '/api/v1/calc/contribution-matrix', {
      database: a.database,
      code: a.code,
      methods,
      amount: a.amount,
      cutoff: a.cutoff ?? 0.01,
      top_n: a.top_n ?? 30,
      scenario: a.scenario
    })
    const meta = r?.meta ?? {}
    return S({
      ...r,
      note: given.length > 10 ? `Only the first 10 of ${given.length} methods were computed.` : undefined,
      reading:
        'Rows are processes, "values"/"shares" run in the order of meta.methods. Each cell is the ' +
        "process's OWN impact (its emissions, not its supply chain), so a column adds up to that " +
        'indicator\'s total; "rest" is what the processes below the cutoff carry together. A process is ' +
        `in the matrix when it reaches the cutoff (${meta.cutoff ?? a.cutoff ?? 0.01}) in at least one ` +
        `indicator — ${meta.n_included ?? '?'} did, ${meta.n_shown ?? '?'} are shown. Read across a row ` +
        'for a trade-off (large in one indicator, small in another) and down a column for the hotspots of one.'
    })
  },
  inventory_per_unit: async (a, ctx) =>
    S(await ctx.api('POST', '/api/v1/calc/inventory', { database: a.database ?? ctx.activeDb, ...a })),
  find_consumers: async (a, ctx) => {
    const db = a.database ?? ctx.activeDb
    if (!db) return S({ error: 'No model open — pass a database name.' })
    const q = `input_database=${encodeURIComponent(a.consumes_database)}&input_code=${encodeURIComponent(a.consumes_code)}`
    return S(await ctx.api('GET', `/api/v1/model/consumers/${encodeURIComponent(db)}?${q}`))
  },
  create_model: async (a, ctx) => {
    const r = await ctx.api('POST', '/api/v1/databases/foreground', { name: a.name })
    if (a.goal || a.scope) {
      await ctx.api('POST', '/api/v1/study', {
        database: a.name,
        goal: a.goal,
        scope: a.scope,
        ai_model: ctx.model,
        ...AI
      })
    }
    return S(r)
  },
  duplicate_model: async (a, ctx) => S(await ctx.api('POST', '/api/v1/databases/foreground/duplicate', a)),
  rename_model: async (a, ctx) => {
    const was = ctx.activeDb
    const answer = await ctx.api('POST', '/api/v1/databases/foreground/rename', { ...a, ...AI })
    // The renamed model is the open one: carry the session over, or every following call falls back
    // to a name the database no longer has (V275). The renderer follows through the reload that
    // MUTATING_TOOLS triggers; this is the half that lives in the run.
    // The name the backend gave it (it trims), not the one asked for: the chat's model fence names it.
    const renamed = String(answer?.name ?? a?.name ?? '')
    if (renamed && was && String(a?.database ?? was) === was) ctx.activeDb = renamed
    return S(ctx.activeDb === renamed && was !== renamed ? { ...answer, active_model_now: renamed } : answer)
  },
  add_exchange: async (a, ctx) =>
    S(await ctx.api('POST', '/api/v1/model/exchanges', { type: 'technosphere', ...a, ...AI })),
  set_exchange_amount: async (a, ctx) =>
    S(await ctx.api('POST', '/api/v1/model/exchanges/amount', { ...a, ...AI })),
  remove_exchange: async (a, ctx) =>
    S(await ctx.api('POST', '/api/v1/model/exchanges/remove', { ...a, ...AI })),
  create_tag_group: async (a, ctx) => {
    try {
      return S(await ctx.api('POST', '/api/v1/model/tag-groups', { name: a.name, ...AI }))
    } catch (e) {
      // Creating a group that is already there IS what the caller wanted — the group exists. Tag
      // groups are project-wide, so a dimension made in another model of the same project lands
      // here, and the refusal cost a failed call and a retry every time (V305, LH-Lasur run). Only
      // the exact name is a no-op: a near-duplicate under another spelling comes back as
      // `group_dimension_exists` and stays a refusal, because that one is a decision.
      if ((e as { code?: string })?.code === 'group_exists')
        return S({ ok: true, created: false, name: a.name })
      throw e
    }
  },
  add_tag_value: async (a, ctx) =>
    S(await ctx.api('POST', '/api/v1/model/tag-groups/values', { ...a, ...AI })),
  set_tag: async (a, ctx) => S(await ctx.api('POST', '/api/v1/model/tags/set', { ...a, ...AI })),
  merge_tag_value: async (a, ctx) =>
    S(
      await ctx.api('POST', '/api/v1/model/tag-groups/values/merge', {
        group: a.group,
        value: a.value,
        into: a.into,
        ...AI
      })
    ),
  merge_tag_group: async (a, ctx) =>
    S(await ctx.api('POST', '/api/v1/model/tag-groups/merge', { name: a.name, into: a.into, ...AI })),
  set_parameter: async (a, ctx) => {
    if (!ctx.activeDb)
      return S({ error: 'No model is open. Parameters are model-scoped — open a model first.' })
    const r: any = await ctx.api('POST', '/api/v1/params', {
      database: ctx.activeDb,
      name: a.name,
      amount: a.formula ? undefined : a.value,
      formula: a.formula || (a.clear_formula === true ? '' : undefined),
      unit: a.unit,
      group: a.group,
      description: a.comment,
      ...AI
    })
    // The endpoint answers with the model's WHOLE parameter list, which the Parameters page throws
    // away and reloads for itself. Only the assistant is charged for it — and a batch fans out to
    // one call per parameter, so setting sixteen returned 1+2+…+16 = 136 records in a single 35k
    // tool result, then paid for all of it again on every later round. Keep the one that was written.
    const all = Array.isArray(r?.parameters) ? r.parameters : null
    const mine = all?.find((p: any) => p?.name === a.name)
    return S(mine ? { parameter: mine, ...formulaKept([a], [mine]) } : r)
  },
  delete_parameter: async (a, ctx) => {
    if (!ctx.activeDb)
      return S({ error: 'No model is open. Parameters are model-scoped — open a model first.' })
    return S(await ctx.api('POST', '/api/v1/params/delete', { database: ctx.activeDb, name: a.name, ...AI }))
  },
  set_exchange_formula: async (a, ctx) =>
    S(
      await ctx.api('POST', '/api/v1/params/exchange-formula', {
        activity_database: a.activity_database,
        activity_code: a.activity_code,
        uid: a.uid,
        formula: a.formula || null,
        ...AI
      })
    ),
  set_exchange_comment: async (a, ctx) =>
    S(
      await ctx.api('POST', '/api/v1/model/exchanges/comment', {
        activity_database: a.activity_database,
        activity_code: a.activity_code,
        uid: a.uid,
        comment: a.comment ?? '',
        ...AI
      })
    ),
  create_scenario: async (a, ctx) => {
    if (!ctx.activeDb)
      return S({ error: 'No model is open. Scenarios are model-scoped — open a model first.' })
    const r: any = await ctx.api('POST', '/api/v1/scenarios', {
      database: ctx.activeDb,
      name: a.name,
      description: a.description || '',
      overrides: a.overrides || {},
      ...AI
    })
    return S(oneScenario(r))
  },
  set_scenario_value: async (a, ctx) =>
    S(
      oneScenario(
        await ctx.api('POST', '/api/v1/scenarios/value', { id: a.id, param: a.param, value: a.value, ...AI })
      )
    ),
  duplicate_scenario: async (a, ctx) => {
    if (!ctx.activeDb) return S({ error: 'No model is open.' })
    return S(
      oneScenario(
        await ctx.api('POST', '/api/v1/scenarios/duplicate', { database: ctx.activeDb, id: a.id, ...AI })
      )
    )
  },
  delete_scenario: async (a, ctx) => {
    if (!ctx.activeDb) return S({ error: 'No model is open.' })
    return S(await ctx.api('POST', '/api/v1/scenarios/delete', { database: ctx.activeDb, id: a.id, ...AI }))
  },
  duplicate_lcia_method: async (a, ctx) =>
    S(
      await ctx.api('POST', '/api/v1/lcia/duplicate', {
        src: a.src,
        family: a.family,
        name: a.name,
        description: a.description ?? null
      })
    ),
  create_lcia_method: async (a, ctx) =>
    S(
      await ctx.api('POST', '/api/v1/lcia/method', {
        family: a.family,
        name: a.name,
        unit: a.unit || '',
        description: a.description ?? null
      })
    ),
  set_method_factor: async (a, ctx) =>
    S(await ctx.api('POST', '/api/v1/lcia/factor', { method: a.method, ref: a.ref, cf: a.cf })),
  remove_method_flow: async (a, ctx) =>
    S(await ctx.api('POST', '/api/v1/lcia/flow/remove', { method: a.method, ref: a.ref })),
  rename_lcia_method: async (a, ctx) =>
    S(await ctx.api('POST', '/api/v1/lcia/method/rename', { method: a.method, name: a.name })),
  set_method_family: async (a, ctx) =>
    S(await ctx.api('POST', '/api/v1/lcia/family', { family: a.family, description: a.description || '' })),
  // `family` is the canonical name of the family being acted on; `old` is accepted as an alias
  // because a model that has seen the endpoint's field names may reach for it.
  edit_method_family: async (a, ctx) =>
    S(
      await ctx.api('POST', '/api/v1/lcia/family/edit', {
        old: a.old ?? a.family,
        name: a.name,
        description: a.description || ''
      })
    ),
  // Both deletes ask the user themselves — unless an approval card already did (ctx.preApproved):
  // one confirmation per irreversible step, not two. In every approval mode, "Ask only before
  // deleting" (MCP) and the chat with its card off included: together with delete_model they are
  // the floor no mode lowers.
  delete_lcia_method: async (a, ctx) => {
    const label = (a.method as string[]).join(' · ')
    if (ctx.preApproved) return S(await ctx.api('POST', '/api/v1/lcia/delete', { method: a.method }))
    const r = await ctx.ui('ask_user', {
      question: `Delete the custom LCIA method "${label}"? This cannot be undone.`,
      options: [{ label: 'Delete' }, { label: 'Cancel' }]
    })
    const answers: string[] = Array.isArray(r?.answers) ? r.answers.map(String) : []
    if (!answers.includes('Delete')) return S({ cancelled: true })
    return S(await ctx.api('POST', '/api/v1/lcia/delete', { method: a.method }))
  },
  delete_method_family: async (a, ctx) => {
    if (ctx.preApproved) return S(await ctx.api('POST', '/api/v1/lcia/family/delete', { family: a.family }))
    const r = await ctx.ui('ask_user', {
      question: `Delete the custom family "${a.family}" and all its methods? This cannot be undone.`,
      options: [{ label: 'Delete' }, { label: 'Cancel' }]
    })
    const answers: string[] = Array.isArray(r?.answers) ? r.answers.map(String) : []
    if (!answers.includes('Delete')) return S({ cancelled: true })
    return S(await ctx.api('POST', '/api/v1/lcia/family/delete', { family: a.family }))
  },
  // With the AI's own source: these used to send no body, so the backend's default booked an
  // assistant undo under the user's name in the audit log. Scoped to the session's model: an undo
  // never takes back a change in another model — the user's, or another agent's.
  undo: async (_a, ctx) =>
    S(
      await ctx.api('POST', '/api/v1/model/undo', {
        ...AI,
        ...(ctx.activeDb ? { database: ctx.activeDb } : {})
      })
    ),
  redo: async (_a, ctx) =>
    S(
      await ctx.api('POST', '/api/v1/model/redo', {
        ...AI,
        ...(ctx.activeDb ? { database: ctx.activeDb } : {})
      })
    ),
  jump_to_process: async (a, ctx) => S(await ctx.ui('jump_to_process', a)),
  auto_layout: async (_a, ctx) => S(await ctx.ui('auto_layout', {})),
  clear_canvas: async (_a, ctx) => S(await ctx.ui('clear_canvas', {})),
  remove_from_canvas: async (a, ctx) => S(await ctx.ui('remove_from_canvas', a)),
  // The app-side way back for an external agent: bring the window to
  // the front, open another model, open a page. `switch_model` also moves the session's own notion
  // of the active model — deliberately, not automatically: following the window would redirect a
  // build in progress.
  focus_window: async (_a, ctx) => S(await ctx.ui('show_window', {})),
  switch_model: async (a, ctx) => {
    const r = await ctx.ui('open_model', { database: a.database })
    if (r && typeof r === 'object' && !('error' in r)) ctx.activeDb = String(a.database)
    return S(r)
  },
  switch_page: async (a, ctx) => S(await ctx.ui('open_page', { page: a.page }))
}

/**
 * Route a consolidated tool's `action`/`kind` to the implementation that handles it.
 *
 * `need` lists the arguments each action additionally requires. A flat JSON Schema cannot express
 * "required, but only for this action", so without this check a model that picks the wrong field
 * name reaches the API and gets an opaque HTTP 422 back — which it cannot learn from, so it retries
 * the same call until the round budget is gone (observed in the live evals: 12 identical 422s).
 * Naming the missing argument instead lets it self-correct in one round.
 */
export async function delegate(
  routes: Record<string, string>,
  args: any,
  ctx: ToolCtx,
  need?: Record<string, string[]>,
  /**
   * Action assumed when the model omits `action` entirely. Only pass one where a single action is
   * unmistakably meant — "set" on a parameter carrying a name and a value cannot be anything else.
   * Rejecting those calls bought nothing: in a real session ten consecutive, otherwise perfectly
   * formed calls died on `Unknown action ""`, and the model's retry was the same call plus the word.
   */
  fallback?: string
): ReturnType<Tool['run']> {
  const raw = String(args?.action ?? '').trim()
  const key = raw || (fallback && routes[fallback] ? fallback : raw)
  const target = routes[key]
  if (!target) {
    return S({
      error: raw
        ? `Unknown action "${raw}". Expected one of: ${Object.keys(routes).join(', ')}.`
        : `Missing "action". Expected one of: ${Object.keys(routes).join(', ')}.`
    })
  }
  const missing = (need?.[key] ?? []).filter(
    (k) => args?.[k] === undefined || args[k] === null || args[k] === ''
  )
  if (missing.length) {
    const passed = Object.keys(args ?? {}).filter((k) => k !== 'action' && k !== 'kind')
    return S({
      error:
        `action="${key}" also requires: ${missing.join(', ')}. ` +
        `You passed: ${passed.length ? passed.join(', ') : 'nothing else'}. Retry with the missing argument(s).`
    })
  }
  // Arguments are forwarded unchanged: the consolidated schemas deliberately reuse the original
  // parameter names, and the implementation ignores the extra `action` field.
  return IMPL[target](args, ctx)
}
