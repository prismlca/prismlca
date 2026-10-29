/**
 * The `eurostat_eol` tool: official EU waste statistics for end-of-life scenarios, four Eurostat
 * tables behind ONE tool (like `distances`, hidden entirely when
 * the feature is off for a chat, so the model is not told it exists).
 *
 * The work happens in main/eurostat (HTTP, JSON-stat decoding, the day-long cache, the dataset
 * descriptions); it is INJECTED as `ctx.eurostat`, like the distances service, so this module stays
 * import-free. Attribution rides in the result (where the model reads it) and as `notice` on the
 * tool-call row (Eurostat's re-use policy asks for the source to be named).
 */
import type { Tool, ToolCtx } from '../context'
import { num, obj, objArr, str } from '../schema'
import { batchResult, S } from '../format'

/** Items per call, as for `distances`. */
export const MAX_EUROSTAT_QUERIES = 10
/**
 * Characters of item answers one batch call may carry: items are answered in
 * order until the next one would not fit, and the rest are NAMED as not included — never a JSON cut
 * mid-table. One all-countries answer is ~20–26k, so two of those fit; single countries are 2–4k.
 * Below the agent's own budget (resultBudget.ts: 30k + 6k per item), so this cut is the one the
 * model sees.
 */
export const MAX_EUROSTAT_BATCH_CHARS = 60_000

interface EolOut {
  dataset: string
  scope: string
  year: number
  year_note?: string
  waste_code?: string
  waste_label?: string
  values: { rows: Array<[string, string, string, number, string]>; count: number }
  flags_and_status: { warning: string | null; flagged_values: number; total_values: number }
  dataset_metadata: { table: string; api_query: string; attribution: string; last_update: string | null }
}

const EUROSTAT_NOTICE = 'Source: Eurostat (© European Union).'

/**
 * Same provenance log the web research and distances write: an EoL share from a statistical office
 * is exactly the kind of figure a report has to attribute. One POST for the whole call; best-effort,
 * never at the result's expense.
 */
async function logProvenance(ctx: ToolCtx, outs: EolOut[]): Promise<void> {
  const db = ctx.activeDb
  const withValues = outs.filter((o) => o.values.count)
  if (!db || !withValues.length) return
  const entries = withValues.map((out) => ({
    question: `Eurostat end-of-life statistics: ${out.dataset}${out.waste_code ? ` ${out.waste_code}` : ''} ${out.scope} ${out.year}`,
    findings: [
      {
        text:
          `${out.values.count} values from Eurostat table ${out.dataset} (${out.waste_label ?? 'all waste'}), ` +
          `${out.scope}, ${out.year}${out.year_note ? ` — ${out.year_note}` : ''}. ` +
          `${out.flags_and_status.warning ?? 'All values final.'} ${out.dataset_metadata.attribution}`,
        sources: [out.dataset_metadata.table, out.dataset_metadata.api_query],
        source_class: 'official',
        confidence: out.flags_and_status.flagged_values ? 'medium' : 'high'
      }
    ]
  }))
  try {
    await ctx.api('POST', '/api/v1/provenance/research', { database: db, entries })
  } catch {
    /* logged provenance is a bonus, not a dependency */
  }
}

export const eurostatTools: Tool[] = [
  {
    spec: {
      type: 'function',
      function: {
        name: 'eurostat_eol',
        description:
          'Official Eurostat waste statistics for end-of-life (EoL) modelling in Europe: the real treatment mix (landfill, incineration, energy recovery, recycling, backfilling) as tonnes, kg per capita and shares. Use it when the user asks for an actual EoL split, recycling or collection rate for an EU country or the EU. Four tables: "env_wasoper" — final treatment of ALL waste GENERATED in the country, industrial waste included, trade-corrected (imports/exports), major mineral waste excluded, percent unit, no breakdown by material: a coarse fallback, not the default for a product; "env_wastrt" — waste TREATED in the country’s plants regardless of origin, by EWC-Stat waste category (pass waste_code, e.g. W074 plastics, W071 glass, W072 paper & cardboard, W061 ferrous metals, W075 wood, W076 textiles; TOTAL when omitted); "env_waspac" — packaging waste generated and recycled by material (waste_code W150102 plastic, W150101 paper & cardboard, W150107 glass, W150104 metallic, W150103 wooden; W1501 = all), with recycling RATES — prefer the "2025 target" rate, measured after sorting. Which table fits is decided by the product\'s FUNCTION, not its material: anything that contains, protects or carries goods on their way to the user — bottle, film, can, crate, carton, pallet, sack — is packaging waste (Directive 94/62/EC), so take env_waspac with its material code. The same material in a non-packaging product — a PET fibre in a fleece, a PVC window frame, a wooden chair — is NOT packaging, and the route it is thrown away by decides: with household waste → env_wasmun, its incineration and landfill shares (residual waste is not recycled); collected separately as that material (scrap metal at a recycling yard) → env_wastrt with the waste code. env_wastrt pools every waste of that material treated in the country, industrial scrap and imports included, so for a PET bottle it reads 80 % recycling where packaging shows 51 %; "env_wasmun" — municipal (household) waste generated and treated, no material breakdown. country is Eurostat’s geo code (ISO-2: DE, FR, IT …, EL for Greece; EU27_2020 for the EU); leave it out for ALL reporting countries at once. year defaults to the latest with data; env_wasoper and env_wastrt exist for EVEN years only. The answer is a table (columns country, operation, unit, value, flags) plus lookups for the codes. Always read flags_and_status.warning: a value flagged p (provisional), e (estimated), i (imputed) or b (break in series) is not final — tell the user so before using it. Keep the unit with every figure (tonnes vs. percent vs. kg per capita). Recycling figures are amounts entering sorting/recycling, not secondary material produced: say that sorting losses still have to be accounted for in the recycling datasets. A cell under not_available (confidential, missing) is unknown — never zero. When the shares you derive leave a remainder (e.g. 0.4 % "other recovery"), keep it as its own parameter such as eol_other rather than folding it into landfill or incineration to make the split sum to 1 — say what it is. Several countries, materials or years: pass them as `queries` in ONE call (each item its own dataset/country/year/waste_code, at most 10) instead of calling repeatedly; a time series is one item per year.',
        parameters: obj(
          {
            dataset: {
              type: 'string',
              enum: ['env_wasoper', 'env_wastrt', 'env_waspac', 'env_wasmun'],
              description:
                'Which table: env_waspac (packaging) | env_wasmun (municipal waste: products thrown away with household waste) | env_wastrt (by waste category: material collected separately) | env_wasoper (all waste of the country, coarse fallback).'
            },
            country: str(
              'Eurostat geo code: ISO-2 such as "DE", "FR" (Greece is "EL"), or "EU27_2020" for the EU aggregate. Omit for every reporting country.'
            ),
            year: num('Four-digit year, e.g. 2022. Omit for the latest year with data.'),
            waste_code: str(
              'Only for env_wastrt (EWC-Stat, e.g. "W074" plastics) and env_waspac (e.g. "W150102" plastic packaging). Omit for the total. An unknown code answers with the list of known ones.'
            ),
            queries: objArr(
              `Several lookups in ONE call — several countries, materials or years; each item takes the same four fields (dataset required per item). At most ${MAX_EUROSTAT_QUERIES}; answered per item, in order. Give each item a country: an item without one lists every country (~25,000 characters), and once the answers reach ${MAX_EUROSTAT_BATCH_CHARS} characters the remaining items are reported as not included (already fetched, so a follow-up call for them is instant).`,
              {
                dataset: {
                  type: 'string',
                  enum: ['env_wasoper', 'env_wastrt', 'env_waspac', 'env_wasmun'],
                  description: 'The table for this item.'
                },
                country: str('Eurostat geo code for this item; omit for every reporting country.'),
                year: num('Four-digit year; omit for the latest with data.'),
                waste_code: str(
                  'Waste category (env_wastrt) or packaging material (env_waspac); omit for the total.'
                )
              }
            )
          },
          []
        )
      }
    },
    run: async (a, ctx) => {
      if (ctx.eurostatAvailable === false || !ctx.eurostat)
        return S({ error: 'Eurostat statistics are not available in this chat.' })
      const eurostat = ctx.eurostat
      const items: unknown[] = Array.isArray(a?.queries) && a.queries.length ? a.queries : []
      if (!items.length) {
        if (!a?.dataset)
          return S({
            error: `dataset is required (one of env_wasoper | env_wastrt | env_waspac | env_wasmun) — or pass several lookups as "queries".`
          })
        let out: EolOut
        try {
          out = (await eurostat(a)) as EolOut
        } catch (e) {
          return S({ error: e instanceof Error ? e.message : String(e) })
        }
        await logProvenance(ctx, [out])
        return { result: S(out), notice: out.dataset_metadata.attribution }
      }

      // The batch: every accepted item is fetched at once (cached GETs, no rate gate), then answered
      // in the order asked until the size cap — the same shape every other batch tool answers with.
      const accepted = items.slice(0, MAX_EUROSTAT_QUERIES)
      const settled = await Promise.all(
        accepted.map(async (item) => {
          try {
            return { ok: true as const, item, out: (await eurostat(item)) as EolOut }
          } catch (e) {
            return { ok: false as const, item, error: e instanceof Error ? e.message : String(e) }
          }
        })
      )
      const results: Array<{ ok: boolean; item: unknown; result?: unknown; error?: string }> = []
      const logged: EolOut[] = []
      let used = 0
      let cut = false
      for (const s of settled) {
        if (!s.ok) {
          results.push({ ok: false, item: s.item, error: s.error })
          continue
        }
        const size = S(s.out).length
        if (cut || used + size > MAX_EUROSTAT_BATCH_CHARS) {
          cut = true
          results.push({
            ok: false,
            item: s.item,
            error: `Not included: this answer (${size} characters, ${s.out.scope}) would take the call past ${MAX_EUROSTAT_BATCH_CHARS} characters. It is fetched and cached — ask for it in a separate call; a country per item keeps answers small.`
          })
          continue
        }
        used += size
        logged.push(s.out)
        results.push({ ok: true, item: s.item, result: s.out })
      }
      for (const extra of items.slice(MAX_EUROSTAT_QUERIES))
        results.push({
          ok: false,
          item: extra,
          error: `Not run: at most ${MAX_EUROSTAT_QUERIES} queries per call — ask for this one in a further call.`
        })
      await logProvenance(ctx, logged)
      const notice = logged[0]?.dataset_metadata.attribution ?? EUROSTAT_NOTICE
      return { result: batchResult(results), notice }
    }
  }
]
