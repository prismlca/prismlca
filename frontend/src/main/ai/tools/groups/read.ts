/** Discovery and read-only lookups: models, datasets, graphs, background search. */
// Split out of the monolithic tools.ts. Spec and run stay together on purpose:
// the prose description and the handler are edited as a pair, and the description guard in
// tools.test.ts scans spec text against implementation names.

import type { Tool } from '../context'
import { providersOf, renderSkill } from '../../skillRender'
import { bool, num, obj, str, strArr } from '../schema'
import { NO_MODEL, S, batchResult, cap, fgDb, runItem } from '../format'
import { resolveCode } from '../resolve'
import { scopedDatabaseList } from '../../modelScope'
import { inspectedKey } from '../advice/hotspots'
import { alreadyAsked, withSearchWarnings, type SearchScope } from '../advice/warnings'
import type { ToolCtx } from '../context'

/**
 * Stamp hits from the user's own library with `library: true`.
 *
 * The flag is what the tool description promises: a My-processes dataset answers to the same names
 * as an ecoinvent one, and only this mark tells the model it is handling the user's own data —
 * maintained by them, possibly with unlinked inputs, and theirs to prefer when it is the intended
 * supplier.
 */
export function markOwnDatasets(answer: unknown, ctx: ToolCtx): void {
  const libraries = new Set(ctx.libraryDbs ?? [])
  if (!libraries.size) return
  // `hits`, which is what the backend returns. It once read `results` — a field that
  // never existed — so the flag the tool description promises the model was never once set, and
  // the tests asserted it against a hand-built shape the API does not produce.
  const hits = (answer as { hits?: Array<{ database?: string; library?: boolean }> })?.hits
  if (!Array.isArray(hits)) return
  for (const hit of hits) {
    if (hit && typeof hit === 'object' && libraries.has(hit.database ?? '')) hit.library = true
  }
}

/**
 * Most queries one `search_background` call may carry.
 *
 * Not a style rule — arithmetic. A tool result may hold 120,000 characters at most, and one search
 * query of sixteen hits serialises to 10,400-19,600 of them depending on how many are markets
 * carrying their supplier mix. Six is the ceiling divided by the WORST of those, so the answer
 * survives whole instead of being cut. Wider batches were measured losing entire queries in
 * silence: in one run, 7 of 12.
 */
export const MAX_BATCH_QUERIES = 6

/** Rows per database carried in `also_present` — the backend's reserve is already this small; the
 *  cap only guarantees the field can never become the longest list in the answer, which is the
 *  list the context budget shortens. */
const RESERVE_SHOWN = 3

/**
 * Move the rows a database got on the reserve out of the ranked list.
 *
 * They are in the answer so that "nothing came from my library" stays distinguishable from "my
 * library has nothing" — and they sit at the bottom of the ranking, because that is where they
 * honestly belong. But an over-long tool result is shortened from the END of its longest list, so
 * inside `hits` these are the first rows to go: measured, every one of them vanished from every
 * query of a ten-query batch. Out here they are a short list the shortener never picks, and they
 * say plainly what they are instead of looking like weak matches at position fourteen.
 */
export function liftReserved(answer: unknown): void {
  const a = answer as {
    hits?: Array<{ database?: string; reserved?: boolean }>
    also_present?: unknown
    also_present_note?: string
  }
  if (!Array.isArray(a?.hits)) return
  const ranked: Array<{ database?: string }> = []
  const byDb = new Map<string, Array<{ database?: string }>>()
  for (const hit of a.hits) {
    if (!hit?.reserved) {
      ranked.push(hit)
      continue
    }
    const db = hit.database ?? ''
    const rows = byDb.get(db) ?? []
    if (rows.length < RESERVE_SHOWN) {
      delete hit.reserved
      rows.push(hit)
    }
    byDb.set(db, rows)
  }
  if (!byDb.size) return
  a.hits = ranked
  a.also_present = [...byDb].map(([database, hits]) => ({ database, hits }))
  a.also_present_note =
    'Not matches. Every searched database contributes its best few rows here even when nothing ' +
    'in it fits, so you can tell "this database returned nothing" from "this database was never ' +
    'searched". Take one only if it really is the dataset you need.'
}

/**
 * The preferred background (Settings → Modelling) is carried by the SYSTEM PROMPT alone.
 *
 * There used to be a `markPreferred` here that flagged its hits and moved them to the front. It
 * never ran — same `results`/`hits` mistake as above — and reviving it was decided against
 * rather than repaired: pulling one database's hits to the front puts a second sorting
 * layer on top of whatever the backend ranked, and the backend now ranks all the searched
 * databases as one list. A preference is a tie-breaker for the model to apply when several
 * datasets fit, not a reordering of the evidence it is shown.
 */

import { IMPL } from '../impl'

/** The search backend's dataset-type codes from whatever the model sent — "M", "market", "Market group".
 *  A letter it does not know is an error naming the three that exist, not a silently ignored filter. */
export function normaliseActivityTypes(raw: unknown): { types: string[] } | { error: string } {
  const list: unknown[] = Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw]
  const out: string[] = []
  for (const item of list) {
    const t = String(item).trim().toLowerCase()
    if (!t) continue
    const code =
      t === 'p' || t === 'production' || t === 'process'
        ? 'P'
        : t === 'g' || t === 'market group' || t === 'market_group' || t === 'marketgroup'
          ? 'G'
          : t === 'm' || t === 'market'
            ? 'M'
            : null
    if (!code)
      return {
        error: `Unknown activity type "${item}". Use "P" (production), "M" (market) or "G" (market group).`
      }
    if (!out.includes(code)) out.push(code)
  }
  return { types: out }
}

export const readTools: Tool[] = [
  {
    spec: {
      type: 'function',
      function: {
        name: 'list_models',
        description:
          'List all databases: the user\'s foreground models (writable, kind="foreground"), the library (kind="library") and the read-only background databases (kind="background": ecoinvent and/or BAFU:20XY; kind="biosphere": elementary flows). Use to find model/database names.',
        parameters: obj({})
      }
    },
    run: async (_a, ctx) => {
      const dbs = await ctx.api('GET', '/api/v1/databases')
      // The in-app chat sees only what it may read (modelScope.ts); an MCP session sees everything.
      if (ctx.scope)
        return S({ active_model: ctx.activeDb, ...scopedDatabaseList(dbs, ctx.activeDb, ctx.scope) })
      return S({ active_model: ctx.activeDb, databases: dbs })
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'get_current_model',
        description:
          'Return the foreground model currently open on the canvas (the one the user is chatting about). Prefer this database for edits unless the user names another.',
        parameters: obj({})
      }
    },
    run: async (_a, ctx) => {
      // An external session also learns what the window shows — view, selection, results — so the
      // user can say "look at what I selected" without typing a name. The chat has no appState.
      const app = ctx.appState ? await ctx.appState().catch(() => null) : null
      return S({
        active_model: ctx.activeDb ?? null,
        hint: ctx.activeDb ? undefined : 'No model open.',
        ...(app ? { app } : {})
      })
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'search_background',
        description:
          'Semantic + facet search over the background database(s) released to this chat (ecoinvent, BAFU:20XY — see the system prompt for which) — and, when the user released it, their own library — to find activities to use as inputs. Each hit says in "database" where it comes from. A hit carrying "library": true is the USER\'S OWN dataset (imported or hand-built, maintained by them): when it is the intended supplier, prefer it and say so; do not treat it as vetted background data. Returns candidates with their database + code. Pass SEVERAL queries at once in "queries" when you need several datasets — one call per dataset is the usual reason a build takes hundreds of rounds; up to six per call, more is refused because the answer would be cut. Rows under "also_present" are NOT matches: each searched database puts its best few there even when nothing in it fits, so you can tell "returned nothing" from "was never searched". "activity_types" narrows a search to production datasets ("P"), markets ("M") or market groups ("G") — a market is what an INPUT usually links to (it carries the supply mix and transport), a production dataset is what you open to see a technology; without it all three come back. Geo-variants of one activity are folded into one hit by default (collapse_geo=true); collapse_geo=false lists every region as its own row. Keep countries and regions OUT of "query" — geography is not part of the search text, so a place name there finds nothing and only blurs the query; put it in "geographies" instead. Each hit carries "treatment": true when the dataset\'s reference product is NEGATIVE, meaning an exchange supplying it must have a negative amount — check this instead of guessing from the name. A hit does NOT carry the dataset\'s comment or its own inputs, and both regularly overturn the choice: a generic name can be calibrated on another application entirely (a "printed wiring board" on laptop boards, a "NiMH battery" on a laptop pack) and a dataset drawing a different named material in bulk is a product made from it, not the material. So for the few inputs that will carry the result, follow a hit with get_process_details BEFORE linking it — for a market, on the producer behind it too, because a market comment is boilerplate. WHEN THE ANSWER STARTS WITH A "warnings" LIST, ACT ON IT BEFORE USING ANY HIT — it repeats, in words, every honesty signal this answer carries (a signal in a small field three times fired and three times read past cost a run six queries for a material the first answer had already flagged). The individual fields remain, because the search ALWAYS returns its nearest neighbours and they look like answers. "unmatched_terms": parts of your query that appear in no result and carry a digit (an emission norm, a year, a size class) — that specifier does not exist, so what you got is a similar dataset; say so and pick deliberately. "terms_not_in_results": WORDS of your query that no result\'s name or reference product carries, which is the one signal for "is this material even in here" — it means EITHER the database names it differently (ecoinvent calls PVC "polyvinyl chloride", so check the hits first) OR there is no dataset and you need a proxy whose reasoning you write into the exchange comment. It does NOT by itself mean the material is absent. "weak_match": true means nothing resembled the query at all. Per hit, "weak": true marks a result below the same similarity threshold — a list can be labelled a strong match on the strength of one hit while the rest are unrelated, so trust the per-hit flag over the list-level one.',
        parameters: obj(
          {
            query: str('English natural-language query, e.g. "electricity production hard coal"'),
            queries: {
              type: 'array',
              description:
                'Several searches in ONE call, at most six, as plain strings — results are returned per ' +
                'query, in order, all under the call-level geographies/limit/activity_types. For a query ' +
                'that needs its OWN filter use "filtered_queries" instead. Pass ONE of "query", "queries" or ' +
                '"filtered_queries" — never two, and never an empty list.',
              items: { type: 'string' }
            },
            filtered_queries: {
              type: 'array',
              description:
                'Several searches in ONE call where each query carries its OWN geographies/limit/' +
                'activity_types — e.g. DE waste datasets and RER chemicals in one call, which the ' +
                'call-level filter cannot express. Objects only; for plain strings use "queries".',
              items: {
                type: 'object',
                properties: {
                  query: { type: 'string' },
                  geographies: { type: 'array', items: { type: 'string' } },
                  limit: { type: 'number' },
                  activity_types: { type: 'array', items: { type: 'string' } }
                },
                required: ['query']
              }
            },
            database: str(
              'One database to search, by name; omit for the default: every background database released to this chat plus, when released, the user\'s own "My processes".'
            ),
            databases: strArr(
              'Several databases to search in ONE call, by name (e.g. ["ecoinvent-3.12-cutoff", "My processes"]) — your own choice instead of the default set. Names from list_models.'
            ),
            geographies: strArr(
              'Optional geography codes, and they OUTRANK how well a dataset matches. ONE code (e.g. ' +
                '["DE"]) puts every hit in that region first, then RER / Europe without Switzerland / ' +
                'GLO / RoW, then the rest — so a poor match in the region you asked for is listed above ' +
                'a much better one outside it. Nothing is dropped: keep reading past the requested ' +
                'region before concluding that nothing fits. TWO OR MORE codes are a real filter — other ' +
                'regions are dropped, and "outside_geography_filter" says when a dataset named exactly ' +
                'like your query exists only outside them. When something you expect is missing, search ' +
                'once without geographies.'
            ),
            limit: num(
              'Max results per query (default 25, or 8 when several queries are given). Without ' +
                'it the answer gets LONGER when several background databases are searched, so ' +
                'that a second one adds datasets instead of crowding out the first. Set it only ' +
                'when you want a specific number: your value is the total and is not scaled.'
            ),
            activity_types: strArr(
              'Restrict to dataset types: any of "P" (production), "M" (market), "G" (market group). ' +
                'Omit for all three. The words "production" / "market" / "market group" are accepted too.'
            ),
            collapse_geo: bool(
              'Default true: the geo-variants of one activity are one hit listing its regions. false = one row per region.'
            ),
            literal: bool(
              'Default false. When a query carries an abbreviation ("PET", "rPET", "HDPE") or an everyday word ' +
                'the databases do not use ("truck" for lorry, "gasoline" for petrol, German words like "LKW"), the ' +
                'search also looks for it the way the databases write it, and "searched_as" in the answer says ' +
                'what it replaced. A query that asks for one transport mode ("freight by truck") also ranks that ' +
                "mode's transport services above the others. true searches only the text as typed, without either " +
                '— use it when "searched_as" shows a reading you did not mean.'
            )
          },
          []
        )
      }
    },
    run: async (a, ctx) => {
      type Q = { query: string; geographies?: string[]; limit?: number; activity_types?: string[] }
      const types = normaliseActivityTypes(a.activity_types)
      if ('error' in types) return S({ error: types.error })
      // Two list fields since V417: `queries` is strings only and `filtered_queries` is
      // objects only. The one schema that carried both as `items.anyOf` was the ONLY array in the whole
      // catalogue that arrived JSON-encoded as a string — 9 failed calls and 3 lost rounds on Sonnet 5.5
      // while 50+ homogeneous arrays in the same session came through intact. Both lists at once is
      // refused: the positional association between a query and its filter would be lost.
      if (
        Array.isArray(a.queries) &&
        a.queries.length &&
        Array.isArray(a.filtered_queries) &&
        a.filtered_queries.length
      )
        return S({
          error:
            'Pass EITHER "queries" (plain strings) OR "filtered_queries" (objects with their own filter), not both — ' +
            'put every query into one of them.'
        })
      const raw: unknown[] =
        Array.isArray(a.queries) && a.queries.length
          ? a.queries
          : Array.isArray(a.filtered_queries) && a.filtered_queries.length
            ? a.filtered_queries
            : a.query
              ? [a.query]
              : []
      const list: Q[] = raw
        .map((q) => (typeof q === 'string' ? { query: q } : (q as Q)))
        .filter((q) => q && typeof q.query === 'string' && q.query.trim())
      // A model that JSON-encodes the array into a string cannot see that in its own output: told
      // "pass a non-empty array" it retried the same shape three times, then fell back to six
      // single-query calls (measured on z-ai/glm-5.3-flash — the same family as V277).
      // Name what actually arrived, and the retry lands on the first attempt.
      // Second shape of the same mistake: the array wrapped XML-style as {"item": …} — MiniMax M3
      // sent {"queries": {"item": [...]}} seven times in a row (V327), each time told
      // only "pass a non-empty array", which it believed it had done.
      const wrapped =
        a.queries && typeof a.queries === 'object' && !Array.isArray(a.queries) && 'item' in a.queries
      if (!list.length)
        return S({
          error:
            typeof a.queries === 'string' && a.queries.trim()
              ? '"queries" arrived as ONE string, not an array — the array was JSON-encoded into ' +
                'a string. Resend queries as a real JSON array value, e.g. ' +
                '{"queries": ["steel tube", "powder coating"]} — do not wrap the array in quotes.'
              : wrapped
                ? '"queries" arrived as an OBJECT {"item": …}, not an array — send the plain JSON array ' +
                  'itself: {"queries": ["steel tube", "powder coating"]} or {"queries": [{"query": "steel tube", ' +
                  '"geographies": ["DE"]}]}. No "item" wrapper anywhere, for "geographies" either.'
                : 'Pass "query", a non-empty "queries" array of strings, or "filtered_queries" (objects) — and drop the ones you do not use.'
        })
      // A smaller default per query when several are asked for: ten queries × 25 hits would spend more
      // context on candidates than on the model being built.
      if (list.length > MAX_BATCH_QUERIES)
        return S({
          error:
            `${list.length} queries in one call is more than this tool can answer completely — ` +
            `send at most ${MAX_BATCH_QUERIES}. Beyond that the answer is cut to fit and whole ` +
            'queries come back empty without saying so. Split them across several calls, ' +
            `${MAX_BATCH_QUERIES} at a time, and keep the rest of the arguments as they are.`
        })
      const batch = list.length > 1
      const fallback = batch ? 8 : 25
      // The ceiling on how far the backend may scale that when several backgrounds are searched.
      // It has to be set here because only the caller knows what a row costs: a batch of ten
      // queries pays this ten times over, which is why it stops at 16 while a single query goes
      // to 40. A limit the model asked for explicitly is taken as a TOTAL and is not scaled — it
      // asked for a number of rows, so it gets that number.
      const cap = batch ? 16 : 40
      // Declared before `one` uses it: a single query returns before this line would run otherwise,
      // and a closure reaching into a temporal dead zone is a footgun for the next reader.
      const filed: Array<{ answer: unknown; geo: unknown; scope?: SearchScope }> = []
      const one = async (q: Q, record = true): Promise<unknown> => {
        const explicit = q.limit ?? a.limit
        const body: Record<string, unknown> = {
          query: q.query,
          limit: explicit ?? fallback,
          limit_cap: explicit ?? cap,
          // Slots kept for each searched database, so "nothing came from my library" stays
          // distinguishable from "my library has nothing". Two in a batch, where every row counts.
          reserve: batch ? 2 : 3
        }
        const chosen = Array.isArray(a.databases)
          ? (a.databases as unknown[]).map((d) => String(d).trim()).filter(Boolean)
          : []
        if (chosen.length) body.databases = chosen
        else if (a.database) body.database = a.database
        // Exactly what this chat released: the switched-on backgrounds plus, when released, the
        // library — additively, the backend limit counts per database, so a library hit never
        // displaces a background one. Skipped when the model aims at named databases on purpose
        // (an external session chooses this way; the chat's switches are not its settings — V383).
        if (!a.database && !chosen.length) {
          const released = [...new Set([...(ctx.backgroundDbs ?? []), ...(ctx.libraryDbs ?? [])])]
          if (released.length) body.databases = released
          else if (ctx.backgroundDbs !== undefined)
            return S({
              error:
                'No background database is released to this chat. Ask the user to switch one on in the chat\'s "+" menu (ecoinvent, BAFU:20XY or "My processes"), or pass "database" explicitly.'
            })
        }
        // Per-query filter wins; the call-level one stays the default for the rest.
        const geo = q.geographies ?? a.geographies
        if (geo) body.geographies = geo
        const qTypes = q.activity_types ? normaliseActivityTypes(q.activity_types) : types
        // Refused, like the call-level filter — dropping it ran the query over every type without a
        // word.
        if ('error' in qTypes) return { query: q.query, error: qTypes.error }
        if (qTypes.types.length) body.activity_types = qTypes.types
        if (a.collapse_geo === false) body.collapse_geo = false
        if (a.literal === true) body.literal = true
        // In a batch the model is sifting, not picking a region: twelve regions per hit are 77 % of
        // the payload and it has not decided on a dataset yet. Three chosen ones (GLO, RER, Europe
        // without Switzerland, RoW — in that order) carry more than twelve arbitrary ones did, and
        // `variants_total` still says how many exist. To pick a region, ask again with two or more
        // `geographies`: that path lists every matching variant.
        if (batch) body.variants_cap = 3
        const answer = await ctx.api('POST', '/api/v1/search/activities', body)
        markOwnDatasets(answer, ctx)
        liftReserved(answer)
        const scope = {
          databases:
            (body.databases as string[] | undefined) ?? (body.database ? [String(body.database)] : []),
          types: (body.activity_types as string[] | undefined) ?? [],
          literal: body.literal === true
        }
        if (!record) filed.push({ answer, geo, scope })
        return withSearchWarnings(alreadyAsked(answer, geo, ctx, record, scope))
      }
      if (list.length === 1) return S(await one(list[0]))
      // A batch judges every query against what stood BEFORE the call, then files them all — see
      // `alreadyAsked`. Filing as they land made siblings warn about each other (V276).
      const results = await Promise.all(list.map((q) => runItem(q.query, () => one(q, false))))
      for (const { answer, geo, scope } of filed) alreadyAsked(answer, geo, ctx, true, scope)
      return batchResult(results)
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'list_activities',
        description:
          'List the activities (processes) in a database. Use for a foreground model to see its processes, and to get the exact names you can then pass instead of codes. Set with_exchanges=true to read the WHOLE foreground in one call — every process with its exchanges, amounts, formulas and comments. That is the call for a final read-through (are the amounts and signs right?), which otherwise costs one request per process. Pass consumes_database + consumes_code to turn it round and list only the processes that CONSUME a given dataset, with their amounts and exchange uids — the first call of a dataset swap, since the uids feed straight into edit_exchange action="replace_input".',
        parameters: obj({
          database: str('Database/model name; omit for the model open on the canvas.'),
          with_exchanges: bool(
            "true = include each activity's exchanges. The open foreground model only — never ask this of a background database."
          ),
          consumes_database: str('With consumes_code: list only processes consuming THIS dataset.'),
          consumes_code: str('Code of the dataset to find the consumers of.')
        })
      }
    },
    run: async (a, ctx) => {
      const db = fgDb(a, ctx)
      if (!db) return NO_MODEL
      // The reverse read: same question ("which processes are in this model"), narrowed to the ones
      // consuming one dataset. It lives here rather than in a tool of its own because that is what
      // it is — a filtered activity list — and because the answer is what a dataset swap starts from.
      if (a.consumes_code) {
        return IMPL.find_consumers(
          { database: db, consumes_database: a.consumes_database ?? db, consumes_code: a.consumes_code },
          ctx
        )
      }
      // Guarded to the open foreground model: a background database holds tens of thousands of
      // activities, and pulling their exchanges would be a very expensive way to find that out.
      const full = a.with_exchanges === true && db === ctx.activeDb
      const acts = await ctx.api(
        'GET',
        `/api/v1/model/activities/${encodeURIComponent(db)}${full ? '?with_exchanges=true' : ''}`
      )
      const { items, note } = cap(Array.isArray(acts) ? acts : [], full ? 60 : 100)
      return S({
        database: db,
        activities: items,
        note,
        ...(a.with_exchanges === true && !full
          ? { warning: 'with_exchanges only works on the open foreground model; returned the plain list.' }
          : {})
      })
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'get_process_details',
        description:
          'Full detail of one or more activities: fields, ISIC/CPC classification, and their exchanges (inputs/outputs) with uids, formulas and comments. "reference_amount" and "treatment" tell you the sign of the reference product — decisive for how an exchange supplying this activity must be signed. READ "service_note" WHEN IT IS THERE: it quotes the dataset saying that it covers the PROCESSING only and NOT the material being processed (extrusion, rolling, drawing, coating, dyeing, canning). Such a dataset is priced per kilogram and looks exactly like a material, but supplies none — the material is a SECOND exchange next to it, and leaving it out silently removes the main ingredient (measured: an aluminium frame modelled with 0.95 kg of "section bar extrusion" alone lost 12.2 of its 22.8 kg CO2e). For a market the note names the supplier it came from. Checking what a market really mixes (which geographies, in what share) is what its exchanges are for. Pass "codes" to look up SEVERAL at once, and summary=true when you only need unit, location, reference product and sign rather than every exchange. detail="review" adds what a critical review asks and the build does not: the dataset\'s system boundary (included activities), product information, synonyms, validity period and source file, and per exchange its production volume and uncertainty distribution — use it when documenting or reviewing a dataset, not when linking one. For a unit conversion (a dataset billed in m³ when you have kilograms) call get_flow_properties instead of assuming a density.',
        parameters: obj(
          {
            database: str('Database name; omit for the model open on the canvas.'),
            code: str('Activity code — or use "name" instead.'),
            codes: {
              type: 'array',
              description:
                'Several activity codes in ONE call — verifying the datasets behind a build is six or seven lookups, and one call each is one round each. ALL of them are looked up in the SAME database: pass "database" explicitly when they are background datasets, because it otherwise defaults to the model open on the canvas and every code comes back "not found".',
              items: { type: 'string' }
            },
            name: str('Process name instead of the code; must match exactly one process.'),
            location: str('Location, to disambiguate a name used in several regions.'),
            summary: bool(
              'true = drop the full exchange list and return the header (name, product, location, unit, reference_amount, treatment, classification, service_note) plus the BIGGEST technosphere inputs, which is what says whether a dataset is a material or already a product. Much smaller; use it when checking units, signs and what a dataset really is, and call again without it when you need every exchange.'
            ),
            detail: str(
              '"review" = add the critical-review fields (system boundary, product information, synonyms, validity, per-exchange production volume and uncertainty). Omit for the normal read.'
            )
          },
          []
        )
      }
    },
    run: async (a, ctx) => {
      const db = fgDb(a, ctx)
      if (!db) return NO_MODEL
      // The header is what most lookups actually want — unit, geography, and the sign of the
      // reference product. Returning every exchange for that is a lot of payload for three fields.
      const trim = (full: any): any => {
        if (!a.summary || !full || typeof full !== 'object') return full
        const ex = Array.isArray(full.exchanges) ? full.exchanges : []
        // …and the largest inputs, because that is the question a summary is usually asked. One
        // real run opened `market for acrylic binder, with water, in 54% solution state` with
        // summary=true, got 1,900 characters of market boilerplate ("Each market represents the
        // consumption mix…") and `exchange_count: 5`, then linked `acrylic dispersion production,
        // with water, in 58% solution state` instead — which carries 0.2516 kg of titanium dioxide
        // per kilogram and is classified "Paints and varnishes". Nothing else told them apart: same
        // unit, same CPC 35110, treatment false on both, no weak flag, no unmatched term. The
        // difference was in the exchanges, and the summary had dropped exactly those while keeping
        // the paragraph that says the same thing about every market in the database. Six lines cost
        // a few hundred characters against a budget of 30,000.
        const inputs = ex
          .filter((e: any) => e?.type === 'technosphere' && Number.isFinite(Number(e?.amount)))
          .sort((x: any, y: any) => Math.abs(Number(y.amount)) - Math.abs(Number(x.amount)))
          .slice(0, 6)
          .map((e: any) => ({
            amount: e.amount,
            name: e.input?.name,
            unit: e.input?.unit,
            location: e.input?.location
          }))
        return {
          activity: full.activity ?? full,
          exchange_count: ex.length,
          biggest_inputs: inputs,
          note:
            `summary=true — the ${inputs.length} largest of ${ex.length} exchanges are shown; call again ` +
            'without it for all of them. READ THESE: a dataset that draws a different named material ' +
            'in bulk is not that material — it is a product made from it, or a service applied to it.'
        }
      }
      const one = async (code: string): Promise<any> => {
        const full = await ctx.api(
          'GET',
          `/api/v1/model/activities/${encodeURIComponent(db)}/${encodeURIComponent(code)}` +
            (a.detail === 'review' ? '?detail=review' : '')
        )
        // Remember that this dataset has been read, so the contribution list can say which of the
        // datasets that carry the result never were. Recorded even for `summary=true`: the summary
        // returns the activity header, comment included, which is where a dataset says what it was
        // built for.
        ctx.inspected?.add(inspectedKey(db, code))
        return trim(full)
      }

      const codes: string[] = Array.isArray(a.codes)
        ? a.codes.map((c: unknown) => String(c)).filter(Boolean)
        : []
      if (codes.length) {
        // Settled per code: one bad code must not take the other five answers with it.
        const results = await Promise.all(
          codes.map(async (code) => {
            try {
              return { code, ...(await one(code)) }
            } catch (e) {
              return { code, error: e instanceof Error ? e.message : String(e) }
            }
          })
        )
        return S({ results })
      }
      const r = await resolveCode(ctx, db, a)
      if ('error' in r) return r.error
      return S(await one(r.code))
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'get_flow_properties',
        description:
          'Reference-product flow properties (carbon content, dry mass, wet mass, price, heating value, …) of an activity. THIS IS WHERE A DENSITY COMES FROM: for a dataset measured in m³, "wet mass" and "dry mass" are the kilograms in one cubic metre — look it up here instead of assuming a textbook value, and quote it. Measured 2026-08-12: a model assumed 700 kg/m³ for MDF to convert its own kilograms into the m³ the dataset bills in, while the dataset itself carried wet mass 684 kg/m³. The same applies to any unit conversion you are about to do by hand (kg↔m³, carbon content for a biogenic balance, heating value for an energy recovery credit). Pass "input" (the name or code of one of the activity\'s inputs) to read THAT input\'s properties instead — the heating value of the gas a boiler burns, the carbon content of the plastic a moulding draws — without opening the input\'s own dataset first.',
        parameters: obj(
          {
            database: str('Database name; omit for the model open on the canvas.'),
            code: str('Activity code — or use "name" instead.'),
            name: str('Process name instead of the code.'),
            location: str('Location, to disambiguate a name used in several regions.'),
            input: str(
              "Optional: name (or code) of one of the activity's technosphere inputs — its properties are returned instead of the reference product's. A substring of the name works when it matches one input."
            )
          },
          []
        )
      }
    },
    run: async (a, ctx) => {
      const db = fgDb(a, ctx)
      if (!db) return NO_MODEL
      const r = await resolveCode(ctx, db, a)
      if ('error' in r) return r.error
      const input = a.input ? `?input=${encodeURIComponent(String(a.input))}` : ''
      return S(
        await ctx.api(
          'GET',
          `/api/v1/model/activities/${encodeURIComponent(db)}/${encodeURIComponent(r.code)}/properties${input}`
        )
      )
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'get_model_graph',
        description:
          'The node+edge graph of a foreground model (what the canvas shows): processes and their links.',
        parameters: obj(
          { database: str('Foreground model name; omit for the model open on the canvas.') },
          []
        )
      }
    },
    run: async (a, ctx) => {
      const db = fgDb(a, ctx)
      if (!db) return NO_MODEL
      return S(await ctx.api('GET', `/api/v1/model/graph/${encodeURIComponent(db)}`))
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'search_elementary_flows',
        description:
          'MODELLING use: find a biosphere (elementary) flow — emissions to air/water/soil, resource withdrawals — to attach as a direct exchange on a foreground process. Returns database+code for edit_exchange action="add" type="biosphere". To add a flow to your own LCIA method instead, use search_biosphere_flows (it returns the "ref" string that edit_lcia_method action="set_factor" needs).',
        parameters: obj({
          query: str('Flow name text, e.g. "Carbon dioxide, fossil".'),
          queries: {
            type: 'array',
            description:
              'Several flow names in ONE call — a use phase usually needs a handful at once (N2O, ammonia, nitrate, phosphate), and one call each is one round each.',
            items: { type: 'string' }
          },
          direction: str('Optional: "output" = emissions to nature, "input" = resources from nature.'),
          limit: num('Max results per query (default 15).')
        })
      }
    },
    run: async (a, ctx) => {
      const many: string[] = Array.isArray(a.queries)
        ? a.queries.map((q: unknown) => String(q)).filter(Boolean)
        : []
      const one = async (q: string): Promise<any> => {
        const params = new URLSearchParams({ query: q, limit: String(a.limit ?? 15) })
        if (a.direction) params.set('direction', a.direction)
        return ctx.api('GET', `/api/v1/model/flows?${params.toString()}`)
      }
      if (!many.length) {
        if (a.query == null) return S({ error: 'Pass "query" (one flow) or "queries" (several).' })
        return S(await one(String(a.query)))
      }
      // Independent lookups — run them together rather than one after another.
      return S({ results: await Promise.all(many.map(async (q) => ({ query: q, ...(await one(q)) }))) })
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'get_skill',
        description:
          'Load the full instructions of one or more skills by name (the skills are listed in your system prompt). Call this before carrying out a task that matches a skill. Pass "names" to load SEVERAL at once — a build usually needs three to five, and one call per skill is three to five wasted rounds; they all come from the same lookup either way.',
        parameters: obj({
          name: str('One skill name as listed.'),
          names: {
            type: 'array',
            description: 'Several skill names at once — preferred when you know you need more than one.',
            items: { type: 'string' }
          }
        })
      }
    },
    run: async (a, ctx) => {
      // One backend call already returns every skill, so loading five of them cost five rounds for
      // data that was in hand after the first (measured in a real run).
      // Enabled ones only — the same list the system prompt offers. A skill switched off in Settings
      // (or the chat's "+" menu) used to be served here anyway when asked for by name, so the switch
      // hid it without withholding it.
      const r = await ctx.api('GET', '/api/v1/ai/skills?enabled=true')
      const skills = (r?.skills ?? []) as Array<{
        id: string
        name: string
        description: string
        content: string
      }>
      const wanted: string[] =
        Array.isArray(a.names) && a.names.length
          ? a.names.map((n: unknown) => String(n))
          : a.name != null
            ? [String(a.name)]
            : []
      if (!wanted.length)
        return S({
          error: 'Pass "name" (one skill) or "names" (several).',
          available: skills.map((x) => x.name)
        })
      /** Content words of a skill name, for matching a request that is off by a word. */
      const words = (s: string): string[] =>
        s
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length > 1 && w !== 'the' && w !== 'and' && w !== 'from' && w !== 'for')
      const found = wanted.map((raw) => {
        const want = raw.toLowerCase().trim()
        // Substring matching runs one way only: the registry name must CONTAIN the request. So a
        // request that is off by one inserted word misses everything — measured in a
        // solar-lamp run, where "Bill of materials from product description" found nothing because
        // the skill is called "Bill of materials from **a** product description". The five other
        // skills in the same call arrived, so the gap was easy to miss, and the run whose central
        // task was a bill of materials never read the bill-of-materials skill. Fall back to a word
        // subset: every content word of the request appears in the name.
        const asked = words(raw)
        const s =
          skills.find((x) => x.name.toLowerCase() === want || x.id === raw) ||
          skills.find((x) => x.name.toLowerCase().includes(want)) ||
          (asked.length
            ? skills.find((x) => {
                const have = new Set(words(x.name))
                return asked.every((w) => have.has(w))
              })
            : undefined)
        // The text fits the chat: passages fenced for ecoinvent or BAFU stay only when that database
        // is released here (waste signs and markets differ between the two), and those fenced for web
        // search, the Eurostat tool or the distance tool only while that switch is on.
        if (s)
          return {
            name: s.name,
            description: s.description,
            content: renderSkill(s.content, providersOf(ctx.backgroundDbs), {
              web: ctx.webSearchAllowed,
              eurostat: ctx.eurostatAvailable,
              distances: ctx.distancesAvailable && !!ctx.distances
            })
          }
        // Say which name came closest, so a retry is one word away rather than a list to re-read.
        const scored = skills
          .map((x) => ({ name: x.name, hits: words(x.name).filter((w) => asked.includes(w)).length }))
          .sort((p, q) => q.hits - p.hits)
        const near = scored[0]?.hits ? scored[0].name : null
        return {
          name: raw,
          error: `No skill named "${raw}".${near ? ` Did you mean "${near}"?` : ''}`
        }
      })
      // A single request keeps its old shape, so nothing that already worked has to change.
      if (found.length === 1 && !('error' in found[0])) return S(found[0])
      const missing = found.filter((f) => 'error' in f)
      return S({ skills: found, ...(missing.length ? { available: skills.map((x) => x.name) } : {}) })
    }
  }
]
