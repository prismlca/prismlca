/** The web-research sub-agents (BOM and free-form). */
// Split out of the monolithic tools.ts. Spec and run stay together on purpose:
// the prose description and the handler are edited as a pair, and the description guard in
// tools.test.ts scans spec text against implementation names.

import type { Tool } from '../context'
import { bool, num, obj, str, strArr } from '../schema'
import { RESEARCH_CAP_PHRASE, S, batchResult, runItem } from '../format'

export const researchTools: Tool[] = [
  {
    spec: {
      type: 'function',
      function: {
        name: 'research_bom',
        description:
          'Research a product\'s BILL OF MATERIALS on the web (components, materials, masses in kg, with sources) — for when the user describes a product but has no composition data. Runs as an isolated research sub-agent: web search only, it does NOT read or change the model, so afterwards YOU build the processes/exchanges from the result (and put the sources in the comments). IMPORTANT: the sub-agent shares NONE of this conversation — it only sees what you pass, so put every known specific (size, volume, mass, market/region, standard, year, intended use, anything the user stated) into "context", or the research will be about a generic product instead of theirs. Pass total_mass_kg whenever known: the result is mass-balance checked against it. Naming the components you want makes it much more accurate. READ THE BALANCE BEFORE BUILDING: "balance_ok" is true/false/null and **null means it could not be checked** — because a component could not be researched, so the list is incomplete by construction. "coverage" says how many of the requested components came back, "residual_kg" is the stated total minus the parts found. Unaccounted mass is a gap to close (research it separately or ask the user), NEVER a residual to hand to whichever part is still unknown — that turns a missing figure into a made-up one. Items may carry "mass_range_kg" [min, max] when the sources gave a range — build scenario spreads from that range instead of re-deriving one from the note text.',
        parameters: obj(
          {
            product: str(
              'The product to research, as specific as possible (e.g. "0.5 l PET single-use water bottle").'
            ),
            context: str(
              'Everything relevant you already know but the sub-agent cannot see: dimensions, volume/capacity, market or region, standard/model number, year, intended use, user constraints.'
            ),
            total_mass_kg: num('Total product mass in kg, if known — enables the mass-balance check.'),
            components: strArr(
              'Components to research individually (e.g. ["bottle body","cap","label"]). Omit to let the research enumerate them.'
            ),
            max_components: num('Cap on components researched (default 8, max 8).'),
            domains: strArr(
              'Bare hosts to restrict the web search to, e.g. ["meffert.de","hornbach.de"] — ONLY when you already know where the document lives (the manufacturer\'s site, the retailer page that links the safety data sheet, a register the result named under "suggested_domains"). Leave it out otherwise: a restricted search that misses the host returns "not found", not a wider search.'
            )
          },
          ['product']
        )
      }
    },
    surface: 'subagent',
    run: async (a, ctx) => {
      if (ctx.webSearchAllowed === false) {
        return S({
          error:
            'Web search is switched off — for this chat (the "+" menu) or in Settings → AI → Chat — and BOM research needs it. Ask the user to enable it, or ask them for the composition directly.'
        })
      }
      if (!ctx.research) return S({ error: 'Web research is not available in this context.' })
      const result = (await ctx.research({
        product: a.product,
        context: a.context ? String(a.context) : undefined,
        totalMassKg: typeof a.total_mass_kg === 'number' ? a.total_mass_kg : undefined,
        components: Array.isArray(a.components) ? a.components.map(String) : undefined,
        maxComponents: typeof a.max_components === 'number' ? a.max_components : undefined,
        domains: Array.isArray(a.domains) ? a.domains.map(String) : undefined
      })) as {
        items?: Array<{ component?: string; material?: string; mass_kg?: number; source_url?: string }>
        evidence?: Array<{ url: string; excerpt?: string }>
      }
      // Same provenance log the web research writes: the BOM's sourced masses are exactly the kind
      // of figure a report has to be able to attribute. Best-effort — never at the result's expense.
      if (ctx.activeDb && Array.isArray(result?.items) && result.items.length) {
        // The engine's excerpt behind a cited page, when it supplied one — the table row a mass came
        // from, kept with the figure so a reader can check it without re-opening the page.
        const excerptOf = (url: unknown): string | undefined =>
          (result.evidence ?? []).find((e) => e.url === url && e.excerpt)?.excerpt
        const findings = result.items
          .filter((i) => i.source_url)
          .map((i: Record<string, unknown>) => ({
            text: `${i.component}${i.material ? ` (${i.material})` : ''}: ${i.mass_kg} kg`,
            sources: [String(i.source_url)],
            ...(excerptOf(i.source_url) ? { excerpt: excerptOf(i.source_url) } : {}),
            // Structured on purpose: the health check reconciles these masses against what the
            // model actually books (bom_item_unbooked), and the report can weigh a figure by its
            // source class — neither works on prose alone.
            component: String(i.component ?? ''),
            ...(typeof i.mass_kg === 'number' ? { mass_kg: i.mass_kg } : {}),
            ...(Array.isArray(i.mass_range_kg) ? { mass_range_kg: i.mass_range_kg } : {}),
            ...(i.source_class ? { source_class: String(i.source_class) } : {}),
            ...(i.confidence ? { confidence: String(i.confidence) } : {})
          }))
        if (findings.length) {
          try {
            await ctx.api('POST', '/api/v1/provenance/research', {
              database: ctx.activeDb,
              entries: [{ question: `Bill of materials: ${String(a.product)}`, findings }]
            })
          } catch {
            /* logged provenance is a bonus, not a dependency */
          }
        }
      }
      return S(result)
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'research_web',
        description:
          'Research a question on the web in an ISOLATED context and get back short, sourced findings — for LCA facts you cannot get from the databases: end-of-life split rates, material compositions, prices, recycling quotas, regulatory limits (transport distances have their own tool when it is offered). Three ways to the web, and this is the most expensive: every leg is a sub-agent with its own paid search and takes MINUTES. ALREADY HAVE THE ADDRESS? If an inline web tool (web_fetch) is offered to you, call it yourself — a safety data sheet the user linked, a standard, a statistics page — and read the document instead of hoping a search finds it again; if no such tool is offered, hand the URL to research_web. ONE OR TWO FACTS? Search inline yourself and keep the full wording in front of you. USE research_web when the question is broad or covers several items, because the raw pages would otherwise flood this conversation and crowd out the model you are building. You may hand it URLs too — put them in the question or in \"context\" and it opens them — but for a single known document the inline fetch is the shorter road. Never invent an address: a wrong one costs a leg and comes back empty. The sub-agent shares NONE of this conversation, so put the relevant specifics (product, region, year, scope) into "context". Every statement it returns carries a source URL — unsourced statements are discarded rather than guessed, so a thin result means the facts were not findable, not that they are zero.',
        parameters: obj(
          {
            question: str('The question, specific and answerable (name the material/region/year you need).'),
            questions: {
              type: 'array',
              description: `Several independent questions in ONE call, as plain strings; the researchers run in parallel and results come back per question, in order. Prefer this over one call per question — each leg takes minutes, so asking them one after another spends that time twice. Every question shares the call-level "context"; for a question that needs its OWN context use "detailed_questions" instead. Pass ONE of "question", "questions" or "detailed_questions" — never two, never an empty list. There IS a ceiling on how many run in one call ${RESEARCH_CAP_PHRASE}: anything beyond it is NOT researched and comes back listed under "not_researched", so ask the most decisive questions first and read that field before assuming you have an answer to all of them.`,
              items: { type: 'string' }
            },
            detailed_questions: {
              type: 'array',
              description:
                'Several questions in ONE call where each carries its OWN context on top of the call-level one: [{question, context?}]. Objects only; for plain strings use "questions". Same ceiling as "questions".',
              items: {
                type: 'object',
                properties: { question: { type: 'string' }, context: { type: 'string' } },
                required: ['question']
              }
            },
            context: str(
              'What you already know that the sub-agent cannot see: product, region/market, year, system boundaries, user constraints. Shared by every question in "questions".'
            ),
            allow_unsourced: bool(
              'Accept statements without a source URL (default false). Only for questions where no citable source can be expected.'
            ),
            domains: strArr(
              'Bare hosts to restrict the web search to, e.g. ["meffert.de","hornbach.de"] — ONLY when you already know where the document lives (the manufacturer\'s site, the retailer page that links the safety data sheet, a register the result named under "suggested_domains"). Leave it out otherwise: a restricted search that misses the host returns "not found", not a wider search. Applies to every question in the call.'
            )
          },
          []
        )
      }
    },
    surface: 'subagent',
    run: async (a, ctx) => {
      if (ctx.webSearchAllowed === false) {
        return S({
          error:
            'Web search is switched off — for this chat (the "+" menu) or in Settings → AI → Chat — and this tool needs it. Ask the user to enable it, or ask them for the figure directly.'
        })
      }
      if (!ctx.researchWeb) return S({ error: 'Web research is not available in this context.' })
      const researchWeb = ctx.researchWeb
      type RQ = { question: string; context?: string }
      // Strings in `questions`, objects in `detailed_questions` — the `items.anyOf` union they shared
      // was one of the two schemas whose arrays arrived JSON-encoded as strings (V417; see
      // search_background for the measurement). Both lists at once used to be refused: a report writer
      // that filled both, and filled both again after the refusal, lost its whole literature search.
      // Now both are asked, the detailed ones first. A plain question already asked in detail is not
      // asked twice; two detailed ones stay two, since their contexts may differ (Germany, France).
      const asRQ = (q: unknown): RQ => (typeof q === 'string' ? { question: q } : (q as RQ))
      const usable = (q: RQ): boolean => !!q && typeof q.question === 'string' && !!q.question.trim()
      const detailed: RQ[] = (Array.isArray(a.detailed_questions) ? a.detailed_questions : [])
        .map(asRQ)
        .filter(usable)
      const inDetail = new Set(detailed.map((q) => q.question.trim()))
      const plain: RQ[] = (Array.isArray(a.questions) ? a.questions : [])
        .map(asRQ)
        .filter((q: RQ) => usable(q) && !inDetail.has(q.question.trim()))
      const list: RQ[] =
        detailed.length || plain.length ? [...detailed, ...plain] : [asRQ(a.question)].filter(usable)
      // Same trap as search_background (V279): a JSON-encoded array in the string slot must be named,
      // or the model retries the identical shape against "pass a non-empty array".
      if (!list.length)
        return S({
          error:
            typeof a.questions === 'string' && a.questions.trim()
              ? '"questions" arrived as ONE string, not an array — the array was JSON-encoded into ' +
                'a string. Resend questions as a real JSON array value, e.g. ' +
                '{"questions": ["typical lifetime of …", "recycling rate of …"]} — do not wrap the ' +
                'array in quotes.'
              : 'Pass "question", a non-empty "questions" array of strings, or "detailed_questions" (objects) — and drop the ones you do not use.'
        })
      // Every leg is its own sub-agent with its own paid web search, so the bill scales with the
      // WIDTH of the fan, not the call count. The ceiling is a setting; what it cuts is named rather
      // than dropped, so a half-answered research phase cannot pass for a complete one.
      // Already clamped where aiDefaults can be imported (agent.ts) — this module stays import-free.
      const width = Math.max(1, ctx.maxResearchQuestions ?? 4)
      const asked = list.slice(0, width)
      const skipped = list.slice(width)
      const one = (q: RQ, index?: number): Promise<unknown> =>
        researchWeb({
          question: q.question,
          // The call-level context is shared; a per-question context rides on top of it, so a batch
          // covering two products no longer has to split into two calls just to keep them apart.
          context:
            [a.context ? String(a.context) : '', q.context ? String(q.context) : '']
              .filter(Boolean)
              .join('\n') || undefined,
          allowUnsourced: a.allow_unsourced === true,
          domains: Array.isArray(a.domains) ? a.domains.map(String) : undefined,
          // So the shared progress line can say which of how many is speaking: the legs run in
          // parallel and each note replaces the last, which read as one question at a time.
          index,
          total: asked.length
        })
      // Persist what came back, per model. The full answer lives only in this conversation's context
      // and dies with it; the log (questions + sourced findings) is what lets the report print a
      // researched-sources bibliography and lets a chapter writer say where a figure came from. A
      // side effect must never cost the research result, so a failed write is swallowed.
      type Logged = {
        question: string
        findings: unknown
        evidence?: Array<{ url: string; excerpt?: string }>
      }
      const record = async (entries: Logged[]): Promise<void> => {
        const db = ctx.activeDb
        const usable = entries
          .filter((e) => Array.isArray(e.findings) && (e.findings as unknown[]).length)
          // Each finding takes the engine's excerpt of its first cited page along, when there is one.
          .map((e) => ({
            question: e.question,
            findings: (e.findings as Array<Record<string, unknown>>).map((f) => {
              const first = Array.isArray(f.sources) ? f.sources[0] : undefined
              const ex = (e.evidence ?? []).find((v) => v.url === first && v.excerpt)?.excerpt
              return ex ? { ...f, excerpt: ex } : f
            })
          }))
        if (!db || !usable.length) return
        try {
          await ctx.api('POST', '/api/v1/provenance/research', { database: db, entries: usable })
        } catch {
          /* logged provenance is a bonus, not a dependency */
        }
      }
      if (asked.length === 1 && !skipped.length) {
        const result = (await one(asked[0])) as { findings?: unknown; evidence?: Logged['evidence'] }
        await record([
          { question: asked[0].question, findings: result?.findings, evidence: result?.evidence }
        ])
        return S(result)
      }
      // In parallel, not in sequence. Two legs on the Kimi run took 116 s and 85 s back to back
      // because the tool took one question at a time; concurrently that is the longer of the two.
      const results = await Promise.all(asked.map((q, i) => runItem(q.question, () => one(q, i + 1))))
      await record(
        results
          .filter((r) => r.ok)
          .map((r) => ({
            question: String(r.item),
            findings: (r.result as { findings?: unknown })?.findings,
            evidence: (r.result as { evidence?: Logged['evidence'] })?.evidence
          }))
      )
      // What THIS call cost, legs and web-search fees included. The monthly ledger books it per
      // model, where a research fan is indistinguishable from chat traffic (the V244 confusion);
      // here the caller sees the price of the fan it just ordered.
      const legCosts = results
        .filter((r) => r.ok)
        .map((r) => (r.result as { cost?: { usd?: number; requests?: number } })?.cost)
      const usd = legCosts.reduce((sum, c) => sum + (c?.usd ?? 0), 0)
      const requests = legCosts.reduce((sum, c) => sum + (c?.requests ?? 0), 0)
      const batched = batchResult(results)
      const parsed = typeof batched === 'string' ? JSON.parse(batched) : batched
      if (requests) parsed.cost = { legs: asked.length, requests, usd: Number(usd.toFixed(4)) }
      if (!skipped.length) return S(parsed)
      return S({
        ...parsed,
        not_researched: skipped.map((q) => q.question),
        note: `Only ${width} question(s) are researched per call (Settings → AI → Limits). ${skipped.length} were not run — ask them in a follow-up call if you still need them.`
      })
    }
  }
]
