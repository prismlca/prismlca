/** The web-research sub-agents (BOM and free-form). */
// Split out of the monolithic tools.ts. Spec and run stay together on purpose:
// the prose description and the handler are edited as a pair, and the description guard in
// tools.test.ts scans spec text against implementation names.

import type { Tool } from '../context'
import { bool, num, obj, str, strArr } from '../schema'
import { RESEARCH_CAP_PHRASE, S, batchResult, runItem } from '../format'
import type { BomResult } from '../../researchBom'
import { bomLogEntry } from './bomLogEntry'

/**
 * The `recipe` argument read, or the refusal that names how it arrived. A weak model JSON-encodes nested values into
 * strings; the refusal says so, since "recipe must be an object" alone gets the same string back.
 */
export function recipeArg(
  raw: unknown
): { of?: string; mass_kg?: number; ingredients?: string[]; inci_list?: string[] } | string | undefined {
  if (raw === undefined || raw === null) return undefined
  const asObject =
    '{"of": "liquid soap (contents of the pouch)", "mass_kg": 0.51, "ingredients": ["Aqua", "Sodium Laureth Sulfate"]}'
  if (typeof raw === 'string')
    return `"recipe" arrived as ONE string, not an object — the object was JSON-encoded into a string. Resend it as a real JSON object value, e.g. ${asObject} — do not wrap it in quotes.`
  if (typeof raw !== 'object' || Array.isArray(raw))
    return `"recipe" must be an object, e.g. ${asObject}; for a product that is the mixture itself, "of" names the product.`
  const r = raw as Record<string, unknown>
  if (
    r.mass_kg !== undefined &&
    // 0 is padding, as in any count: a mixture of no mass is not a figure anyone means.
    r.mass_kg !== 0 &&
    !(typeof r.mass_kg === 'number' && Number.isFinite(r.mass_kg) && r.mass_kg > 0)
  )
    return `"recipe.mass_kg" arrived as ${JSON.stringify(r.mass_kg)} — it must be a positive number of kilograms (e.g. 0.51), or left out when unknown.`
  for (const key of ['ingredients', 'inci_list'] as const)
    if (r[key] !== undefined && !Array.isArray(r[key]))
      return typeof r[key] === 'string'
        ? `"recipe.${key}" arrived as ONE string, not an array — resend it as a real JSON array value with one ingredient per entry, e.g. ["Aqua", "Sodium Laureth Sulfate", "Glycerin"].`
        : `"recipe.${key}" must be an array of strings, one ingredient per entry.`
  const of = typeof r.of === 'string' && r.of.trim() ? r.of.trim() : undefined
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter((i) => i.trim()) : [])
  const ingredients = list(r.ingredients)
  const inci = list(r.inci_list)
  return {
    ...(of ? { of } : {}),
    ...(typeof r.mass_kg === 'number' && r.mass_kg > 0 ? { mass_kg: r.mass_kg } : {}),
    ...(ingredients.length ? { ingredients } : {}),
    ...(inci.length ? { inci_list: inci } : {})
  }
}

export const researchTools: Tool[] = [
  {
    spec: {
      type: 'function',
      function: {
        name: 'research_bom',
        description:
          'Research a product\'s BILL OF MATERIALS on the web (components, materials, masses in kg, with sources) — for when the user describes a product but has no composition data. Runs as an isolated research sub-agent: web search only, it does NOT read or change the model, so afterwards YOU build the processes/exchanges from the result (and put the sources in the comments). IMPORTANT: the sub-agent shares NONE of this conversation — it only sees what you pass, so put every known specific (size, volume, mass, market/region, retailer, article number or EAN, standard, year, intended use, anything the user stated) into "context", or the research will be about a generic product instead of theirs. Naming the components you want makes it much more accurate; do not list the total weight as a component — every researcher reports the whole product\'s mass when a source states it ("totals_found"). HAVE A DOCUMENT THAT LISTS THE PARTS (manual, exploded view, spare-parts list, datasheet, EPD)? Take "components" from its list — open it yourself first if you have not read it — at most 8, the small parts grouped (e.g. "screws, nuts and washers"), and put its address into "context", named as the document it is: every researcher opens it first. A MIXTURE in the product (soap, detergent, paint, food, concrete, a rubber compound) goes under "recipe", never its ingredients under "components": researched one by one, ingredients come from different recipes on different bases and do not add up. READ "summary" FIRST: what was summed, against which total, and what is still open. "balance_ok" is true/false/null and **null means it could not be checked** — a component has no mass, a research leg failed, entries overlap, the figures rest on different versions of the product, or no usable total exists; the note says which. "mass_kg" is always the mass of all pieces of an entry together ("count" says how many); "packaging" entries ("sales" or "transport") are kept out of "sum_kg". "recipe" in the result says whether the mixture\'s lines close against the total its source states ("closes", "gap_pct", "gap_kg"), which known ingredients it lacks ("missing_ingredients"), and whether it is the product\'s own recipe or a frame formulation; its ingredients stand in "items" with "group": "recipe" once a mass is known, and a recipe that does not close keeps "balance_ok" null. "requests" gives each requested component\'s status, "unresolved" names every open one with its reason, "residual_kg" is the total minus the parts found. Unaccounted mass is a gap to close (research it separately or ask the user), NEVER a residual to hand to whichever part is still unknown — that turns a missing figure into a made-up one. "versions" appears when the sources showed more than one version of the product (another EAN, board thickness, weight): find out which one the user means before you build. Items may carry "mass_range_kg" [min, max] when the sources gave a range — build scenario spreads from that range instead of re-deriving one from the note text. Items may carry "alternatives": other figures the research found for the same part (another variant, another source) — never summed; the entry\'s own figure is the one counted, and when the user\'s product is one of the alternatives, book that figure instead.',
        parameters: obj(
          {
            product: str(
              'The product to research, as specific as possible (e.g. "0.5 l PET single-use water bottle").'
            ),
            context: str(
              'Everything relevant you already know but the sub-agent cannot see: dimensions, volume/capacity, market or region, standard/model number, year, intended use, user constraints.'
            ),
            total_mass_kg: num(
              "The product's own mass in kg WITHOUT sales packaging — only a figure the user stated or a source gave, never your own estimate (the balance would then check your estimate against itself). Leave it out when unknown: the research looks for it."
            ),
            components: strArr(
              'Components to research individually (e.g. ["bottle body","cap","label"]). Omit to let the research enumerate them. A mixture\'s ingredients go under "recipe", not here.'
            ),
            recipe: {
              ...obj(
                {
                  of: str(
                    'What the mixture is, e.g. "liquid soap (contents of the pouch)", "tread compound" — or the product itself when it is the mixture ("ready-mix concrete C30/37").'
                  ),
                  mass_kg: num(
                    "The mixture's mass in the product in kg — from the label or the user; a stated fill volume times a stated density will do. It scales the recipe's shares to kg and is never checked. Omit when unknown: the research looks for it, and without one the ingredients come back as shares only."
                  ),
                  ingredients: strArr(
                    'Ingredients known from THIS product, one per entry — what the user said, or a printed composition that is not an INCI list (a cosmetic\'s INCI list goes in "inci_list"); never a list of typical ingredients. The research covers each one and names those its recipe lacks.'
                  ),
                  inci_list: strArr(
                    'THIS product\'s INCI list (a cosmetic\'s printed ingredient list), every name exactly as printed, one per entry — a "+/-" or "may contain" part too, with its marker. Covered like "ingredients", in place of any list the research finds.'
                  )
                },
                []
              ),
              description:
                'Research the recipe of a MIXTURE in the product — or of the product, when it is one — in one leg of its own: one named formulation, checked against the total its source states. Containers, caps and packaging stay in "components".'
            },
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
      const recipe = recipeArg(a.recipe)
      if (typeof recipe === 'string') return S({ error: recipe })
      const call = {
        product: a.product,
        context: a.context ? String(a.context) : undefined,
        totalMassKg: typeof a.total_mass_kg === 'number' ? a.total_mass_kg : undefined
      }
      const result = (await ctx.research({
        ...call,
        components: Array.isArray(a.components) ? a.components.map(String) : undefined,
        maxComponents: typeof a.max_components === 'number' ? a.max_components : undefined,
        domains: Array.isArray(a.domains) ? a.domains.map(String) : undefined,
        ...(recipe ? { recipe } : {})
      })) as Partial<BomResult>
      // Same provenance log the web research writes: the BOM's sourced masses are exactly the kind of figure a
      // report has to be able to attribute, and the check — also of a call that found no mass at all — is what
      // the reviewer holds a booked figure against (bomLogEntry.ts). Best-effort, never at the result's expense.
      const entry = bomLogEntry(call, result)
      if (ctx.activeDb && entry) {
        try {
          await ctx.api('POST', '/api/v1/provenance/research', { database: ctx.activeDb, entries: [entry] })
        } catch {
          /* logged provenance is a bonus, not a dependency */
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
      // The call-level context is shared; a per-question context rides on top of it, so a batch
      // covering two products no longer has to split into two calls just to keep them apart.
      const contextOf = (q: RQ): string | undefined =>
        [a.context ? String(a.context) : '', q.context ? String(q.context) : ''].filter(Boolean).join('\n') ||
        undefined
      /** Each leg's figure check, by the question it was asked for: it goes to the log, not to the model, which
       *  reads the verdicts on the findings themselves. By the object, not its text: two detailed questions may
       *  share a text and differ in their context. */
      const checks = new Map<RQ, unknown>()
      const one = async (q: RQ, index?: number): Promise<unknown> => {
        const r = (await researchWeb({
          question: q.question,
          context: contextOf(q),
          allowUnsourced: a.allow_unsourced === true,
          domains: Array.isArray(a.domains) ? a.domains.map(String) : undefined,
          // So the shared progress line can say which of how many is speaking: the legs run in
          // parallel and each note replaces the last, which read as one question at a time.
          index,
          total: asked.length
        })) as { web_check?: unknown } | undefined
        if (!r || typeof r !== 'object' || !('web_check' in r)) return r
        const { web_check, ...shown } = r
        checks.set(q, web_check)
        return shown
      }
      // Persist what came back, per model. The full answer lives only in this conversation's context
      // and dies with it; the log (questions + sourced findings) is what lets the report print a
      // researched-sources bibliography and lets a chapter writer say where a figure came from. A
      // side effect must never cost the research result, so a failed write is swallowed.
      type Logged = {
        question: string
        // What the research was given, so the log can tell two askings of one question apart.
        context?: string
        findings: unknown
        evidence?: Array<{ url: string; excerpt?: string }>
        /** The figure check: why it ran, what it found, what it cost (webCheck.ts). */
        web_check?: unknown
      }
      const record = async (entries: Logged[]): Promise<void> => {
        const db = ctx.activeDb
        const usable = entries
          .filter((e) => Array.isArray(e.findings) && (e.findings as unknown[]).length)
          // Each finding takes the engine's excerpt of its first cited page along, when there is one.
          .map((e) => ({
            question: e.question,
            ...(e.context ? { context: e.context } : {}),
            ...(e.web_check ? { web_check: e.web_check } : {}),
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
          {
            question: asked[0].question,
            context: contextOf(asked[0]),
            findings: result?.findings,
            evidence: result?.evidence,
            web_check: checks.get(asked[0])
          }
        ])
        return S(result)
      }
      // In parallel, not in sequence. Two legs on the Kimi run took 116 s and 85 s back to back
      // because the tool took one question at a time; concurrently that is the longer of the two.
      const results = await Promise.all(asked.map((q, i) => runItem(q.question, () => one(q, i + 1))))
      await record(
        results
          .map((r, i) => ({ r, q: asked[i] }))
          .filter(({ r }) => r.ok)
          .map(({ r, q }) => ({
            question: String(r.item),
            context: contextOf(q),
            findings: (r.result as { findings?: unknown })?.findings,
            evidence: (r.result as { evidence?: Logged['evidence'] })?.evidence,
            web_check: checks.get(q)
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
