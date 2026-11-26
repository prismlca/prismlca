/**
 * The bill-of-materials researcher behind `research_bom`: one isolated web-research leg per named component
 * (or one that enumerates them), one for the recipe of a mixture when the caller asks for it, a bounded retry and
 * follow-up pass, and the sources settled against what the search engine actually cited. Reading a leg's answer
 * lives in bomAnswer.ts and bomRecipe.ts, judging the list in bomBalance.ts and recipeBalance.ts, settling its
 * sources in bomSources.ts.
 */
import { parseBomAnswer, type BomLeg } from './bomAnswer'
import { weighBom, type BomWeighing, type LegOutcome } from './bomBalance'
import {
  RECIPE_BRIEF,
  RECIPE_SYSTEM,
  parseRecipeAnswer,
  recipeQuestion,
  type RecipeLeg,
  type RecipeRequest
} from './bomRecipe'
import { settleSources } from './bomSources'
import {
  admissiblePage,
  crossCheckNote,
  crossChecks,
  crossFigures,
  leadWords,
  leadsFor,
  type CrossCheck
} from './bomCrossCheck'
import { weighRecipe } from './recipeBalance'
import { CitationBook, type Evidence } from './citationBook'
import { evidenceNote } from './webContent'
import {
  RETRY_BUDGET_MS,
  extractJson,
  legFailure,
  normalizeDomains,
  retryCanHelp,
  runResearch,
  type CostSink
} from './subagent'

const BOM_SYSTEM = `You research bills of materials for life-cycle assessment.
Answer with ONE JSON object ONLY — no prose, no code fence:
{"items": [{"component": string, "material": string, "mass_kg": number | null, "count": integer,
            "mass_each_kg": number, "mass_range_kg": [number, number], "packaging": "no" | "sales" | "transport",
            "includes": [string], "alternatives": [{"mass_kg": number, "material": string, "source_url": string,
            "note": string}], "version": string, "source_url": string, "source_class": string,
            "confidence": string, "note": string}],
 "product_mass": [{"mass_kg": number, "basis": "net" | "gross" | "unknown", "version": string,
                   "source_url": string, "note": string}],
 "versions_seen": [{"version": string, "differs_by": string, "mass_kg": number, "sold_by": string,
                    "source_url": string}],
 "for_others": [{"component": string, "mass_kg": number, "source_url": string}]}
Only "component", "material", "mass_kg" and "source_url" are needed in every entry; leave out what does not apply.

A document about THIS product whose address the brief gives — a datasheet, manual, parts list or EPD named as such —
is there because it may hold your figure: OPEN it first and take your part from it. When your part or its mass is not
in it, say so in the note and search on as usual; a document without your figure is no reason to stop. A shop page
given to identify the product is not such a document: open it only when it helps.

Items:
- Masses in kilograms as plain numbers. "mass_kg" is the mass of ALL pieces the entry stands for (five
  shelves together, not one). When your source gives the mass of ONE piece, write it as "mass_each_kg" with
  "count" (how many of them the product has) and leave "mass_kg" out — the tool multiplies. Never a piece
  mass without a count.
- An entry is one part, or a set of identical parts — never the whole product. A weight your source gives for
  the complete product (article weight, shipping weight) goes into "product_mass", also when you were asked
  for a part, and is never that part's figure.
- Every entry is summed as a part of the product, so never give the same part twice. Figures that stand for the
  same part — either this or that: another variant of it (with or without an aluminium layer, a label or a direct
  print), another source's figure, a comparable product's part — are not parts of their own: write the one you
  would model with as the entry's figure and the others under "alternatives" (each with its "mass_kg" for all
  pieces like the entry's, its "source_url", and its "material" when it differs), and say in "note" why you
  chose that one. An alternative could replace the entry's figure; the mass of something inside it (the valve
  in a tube's weight) is not one. Parts that are ALL in the product together (a tyre and its tube) stay separate
  entries, each with its own material.
- Name the concrete polymer/metal/alloy in "material" (e.g. "PET", "HDPE", "aluminium 3104"), not a generic
  word like "plastic"; every entry needs a source_url you actually consulted; if a figure is a typical
  industry value rather than a measured one, say so in "note". Prefer standards, EPDs, manufacturer data and
  peer-reviewed sources.
- "mass_range_kg" is optional: when your sources give a RANGE rather than one figure, put [min, max] there, on
  the same basis as your figure (per piece when you gave "mass_each_kg"), and set the figure to the value
  inside that range you would model with, saying in "note" how you chose it. When the sources give a single
  figure, omit it — never invent a spread.
- A figure you work out from sourced data is a valid answer: a sheet thickness or dimensions times a published
  density, a comparable product's listed part, a spare part's weight. Say in "note" how you got it and from
  which sources; its confidence is at most medium. Never work a part's mass out from the whole product's mass
  or from the other parts — that is the caller's balance, not a figure.
- A component you identified but found NO mass for still gets an entry: "mass_kg": null, and the "note" says
  what you did find (a material, a range for a similar product, "no figure anywhere"). Never write 0 for an
  unknown mass and never guess one — a null is a gap the caller can close, a guess is not. Equally, do not
  list a part you have no evidence exists.
- "packaging": "no" for every part of the product itself (a frame, a shelf, a wheel, the pouch that holds a soap);
  "sales" only for what the product is sold in (its retail box, blister, film); "transport" only for shipping
  cartons, pallets and stretch film shared by several units.
- "includes": when your figure already contains another listed component (a pouch weighed with its spout, a tread
  with its rubber compound), name that component as it was listed.
- "version": only when your sources tell versions of THIS product apart (EAN, article number, board thickness,
  weight, market) — the version of the WHOLE product your figure belongs to, never the number of a spare part or
  of the part itself. Omit it when the sources show one version, and for a comparable product's figure.
- "source_class" is the source's kind: official (authority, standard, EPD, peer review), industry
  (manufacturer, trade association, patent), media (press, blogs, buying guides) or community (forums,
  reviews) — when unsure, pick the LOWER one, never official. A patent is a real source and worth using, but
  it is not official: nobody has checked its figures against the product you are costing.
- "confidence" is high, medium or low for the FIGURE itself, and the note must carry its reason (e.g. "three
  comparable products agree", "single listing, format differs"). The note also says whose figure it is: THIS
  product's own (its datasheet, its listing, a measurement of it) or a comparable product's. When this
  product's own figure is not published, a comparable product's is a valid answer — give it and name that
  product by brand and model; it is never "high" for this product.

product_mass (leave it out when no source states one): the mass of THIS complete product, or of one of its
versions, as a source states it — never a comparable product's, which belongs in a note — one entry per figure
found, never computed by you. "basis": "net" without packaging (article weight),
"gross" with its sales packaging (the weight as sold), "unknown" when the source does not say.

versions_seen (leave it out when the sources show only one version): every other version of THIS product your
sources showed — its EAN, article number or name, what differs, its weight if stated, where it is sold. Not
comparable products of other makers.

for_others (leave it out when nothing applies): when a page you read for your part also states the mass of a part of
THIS product that the brief says other researchers cover, give that figure here — "component" as the brief names it,
or the one part the page gives when the brief names several together ("axle" of "axle, bearings, screws"); "mass_kg"
for all its pieces; the page as "source_url". Only a mass the page itself states for that part: never one you worked
out, never the whole product's. Do not search for these parts — their researchers answer for them; your figure only
checks theirs.

Return the JSON as soon as your figures stand — an answer still unwritten when time runs out is lost.`

export interface BomResult extends BomWeighing {
  product: string
  /** The one bounded follow-up for components without a mass: how many were asked again, how many landed. */
  follow_up?: { asked: number; resolved: number }
  /** Components named in the call but over the limit per call — not researched at all. */
  not_researched?: string[]
  /** Pages the search engine cited that the items' `source_url`s point to, with excerpts when the
   *  engine supplied them (Exa). The engine's record of what was read, not the model's. */
  evidence: Evidence[]
  /** What the titles and excerpts under `evidence` are, said where the caller reads them (webContent.ts). */
  evidence_note?: string
  /** The host allow list the legs ran under, when the caller set one. */
  domains?: string[]
  /** Figures that pages read for one component state for another, held against that component's own figure —
   *  never summed (bomCrossCheck.ts). */
  cross_checks?: CrossCheck[]
  /** Whether every figure in `items` names a page it came from; absent when there is no figure. Kept apart from
   *  `balance_ok`: a sum can close on a figure nobody can cite. */
  all_sourced?: boolean
  /** The figures in `items` without a usable source (none named, or a link that leads to no page), by name. */
  unsourced?: string[]
  sources: string[]
}

/** A leg that found nothing parses to this — the weighing calls it failed, with the reason given. */
const EMPTY: BomLeg = { items: [], unresolved: [], product_masses: [], versions_seen: [] }

/** How one kind of leg is asked and read: its instruction, its answer's reader, its short question after a timeout. */
interface LegKind<T> {
  system: string
  parse: (json: unknown) => T
  /** Appended to the question for the one short attempt a timed-out leg gets. */
  brief: string
  /** The progress line for an answer that was read. */
  progress: (answer: T) => string
  empty: T
}

const PARTS: LegKind<BomLeg> = {
  system: BOM_SYSTEM,
  parse: parseBomAnswer,
  brief:
    'BE BRIEF: the JSON object with one entry — the mass in kg and one source URL. ' +
    'Do not survey alternatives: one sourced figure is enough, and its note still says whose figure it is.',
  progress: (leg) => {
    const n = leg.items.length
    const open = leg.unresolved.length
    const others = leg.for_others?.length ?? 0
    return (
      `${n} entr${n === 1 ? 'y' : 'ies'}` +
      (open ? `, ${open} without a mass` : '') +
      (leg.product_masses.length ? ', whole-product mass found' : '') +
      (others ? `, ${others} figure${others === 1 ? '' : 's'} for other parts` : '')
    )
  },
  empty: EMPTY
}

const RECIPE: LegKind<RecipeLeg> = {
  system: RECIPE_SYSTEM,
  parse: parseRecipeAnswer,
  brief: RECIPE_BRIEF,
  progress: (leg) =>
    `${leg.lines.length} line${leg.lines.length === 1 ? '' : 's'}` +
    (leg.formulation ? ` from ${leg.formulation.name}` : ''),
  empty: { lines: [], contents_masses: [], versions_seen: [], problems: [] }
}

/**
 * Research a product's bill of materials. Each named component is researched in its own parallel
 * leg (isolated context); without a component list one leg enumerates and quantifies them.
 * One retry per leg if the model wrapped its answer in prose instead of returning JSON.
 */
export async function researchBom(opts: {
  product: string
  /**
   * Everything the parent conversation already knows and the sub-agent cannot see: dimensions,
   * volume/capacity, market/region, standard or model number, year, intended use, user constraints.
   * Context isolation is the point of a sub-agent — but it also means the leg starts from a blank
   * slate, so whatever is not forwarded here is simply lost.
   */
  context?: string
  totalMassKg?: number
  components?: string[]
  maxComponents?: number
  model?: string
  signal?: AbortSignal
  /** Every leg bills separately (own model + paid web search) — pass this so the parent's cost
   *  ledger and cost limit account for the research too. */
  onCost?: CostSink
  /** One line per leg as it starts and finishes, for the parent's trace: a call that takes minutes
   *  must be able to say what it is working on. */
  onProgress?: (note: string) => void
  /** Restrict the legs' web search to these hosts (bare domains). Set by the caller when it knows
   *  where the product's own documents live — the manufacturer, the retailer with the datasheet. */
  domains?: string[]
  /** Ceiling on the provider's web lookups inside one request of a leg (Settings → AI → Limits). */
  webLookups?: number
  /** Research the recipe of a mixture in one leg of its own (bomRecipe.ts): what it is of, the mass it is scaled
   *  to, the ingredients known. Without components, it is the only leg. */
  recipe?: RecipeRequest
}): Promise<BomResult> {
  const cap = Math.max(1, Math.min(opts.maxComponents ?? 8, 8))
  const named = (opts.components ?? []).map((c) => c.trim()).filter(Boolean)
  const components = named.slice(0, cap)
  // Over the limit is named, not dropped: a list cut to eight cannot pass for the product.
  const notResearched = named.slice(cap)
  const domains = normalizeDomains(opts.domains)
  // Every page the engine cited across all legs and passes — the evidence the items can point to.
  const book = new CitationBook()

  const askAs = async <T>(kind: LegKind<T>, question: string, label: string, brief = false): Promise<T> => {
    opts.onProgress?.(`researching ${label}`)
    // Two failure shapes, two remedies. An answer that will not parse gets a stricter instruction on
    // the same budget; a leg that runs out of TIME gets one shorter, narrower attempt. Without the
    // second, a timed-out leg was simply lost: measured, two of six legs died on the
    // 5-minute ceiling — the PVC profile and the edge spacer, the two heaviest non-glass parts — and
    // the parent then spent a separate 285-second research_web call asking the same two questions
    // again. A retry inside the call is the same work without the extra round.
    // The three attempts a leg gets, in order. The last one exists for the timeout case only: it asks
    // for a single sourced figure instead of a survey, on a fraction of the budget.
    const attempts: Array<{ q: string; budgetMs?: number }> = [
      { q: question },
      { q: `${question}\n\nReturn ONLY the JSON object, nothing else.` },
      { q: `${question}\n\n${kind.brief}`, budgetMs: RETRY_BUDGET_MS }
    ]
    // The follow-up pass for unresolved components runs the short, narrow attempt only: one figure,
    // one source, 90 seconds — the same shape the timeout retry has.
    let timedOut = brief
    for (let i = 0; i < attempts.length; i++) {
      // After a timeout, skip straight to the short, narrow question — repeating the long one would
      // spend the same minutes to hit the same ceiling.
      if (timedOut && i < attempts.length - 1) continue
      let text: string
      try {
        text = await runResearch({
          logAs: 'research_bom',
          webLookups: opts.webLookups,
          question: attempts[i].q,
          system: kind.system,
          model: opts.model,
          signal: opts.signal,
          onCost: opts.onCost,
          budgetMs: attempts[i].budgetMs,
          domains: domains.length ? domains : undefined,
          onCitations: (c) => book.add(c),
          // Out of time with part of an answer: should it not parse, the next attempt is the short one.
          onTimeout: () => (timedOut = true)
        })
      } catch (e) {
        // Out of time, or the connection died. One narrow retry is worth it; a second is not, the user
        // pressing Stop must still end everything at once, and a refused key or account fails at once.
        if (!timedOut && !opts.signal?.aborted && retryCanHelp(e)) {
          timedOut = true
          opts.onProgress?.(`${label}: ${legFailure(e)} — retrying with a narrower question`)
          continue
        }
        if (!opts.signal?.aborted) opts.onProgress?.(`${label}: ${legFailure(e)}`)
        throw e
      }
      if (!text) continue
      try {
        const answer = kind.parse(extractJson(text))
        opts.onProgress?.(`${label}: ${kind.progress(answer)}`)
        return answer
      } catch {
        /* try once more with a stricter instruction */
      }
    }
    opts.onProgress?.(`${label}: nothing usable`)
    return kind.empty
  }
  const ask = (question: string, label: string, brief = false): Promise<BomLeg> =>
    askAs(PARTS, question, label, brief)
  // The mixture, when the caller names one: "of" defaults to the product itself (a concrete, a mortar).
  const recipeOf = opts.recipe ? opts.recipe.of?.trim() || opts.product : undefined

  // Everything the leg needs to know, since it shares no history with the parent conversation. A total the
  // caller passed helps the leg find the right product, and is fenced off from becoming a part's mass: a leg
  // that derives "frame = total − shelves" makes the balance check the caller's figure against itself.
  const brief =
    `Product: ${opts.product}.` +
    (opts.context?.trim() ? `\nKnown specifics: ${opts.context.trim()}` : '') +
    (opts.totalMassKg
      ? `\nTotal product mass: about ${opts.totalMassKg} kg — given to identify the product; never derive a part's mass from it.`
      : '')
  // Each leg learns which components the others cover: so a figure that contains one of them can say so
  // ("includes"), and a leg asked for the frame knows the shelves are not its business.
  const siblings = (c: string): string => {
    const others = [...components.filter((o) => o !== c), ...(recipeOf ? [`the recipe of ${recipeOf}`] : [])]
    return others.length
      ? `\nResearched separately, by other researchers: ${others.map((o) => `"${o}"`).join(', ')}.`
      : ''
  }
  // The recipe leg runs beside the component legs and outside their follow-up pass, which would ask the ingredients
  // one by one again — the very cut that made a recipe from four sources.
  const recipeLeg = recipeOf
    ? askAs(
        RECIPE,
        recipeQuestion(brief, recipeOf, opts.recipe as RecipeRequest, components),
        `the recipe of ${recipeOf}`
      )
    : undefined
  const legs = components.length
    ? components.map((c) =>
        ask(
          `${brief}${siblings(c)}\n\nResearch ONLY the component "${c}": its material and its mass in kg. ` +
            `Answer with the JSON object; "items" holds the entry for "${c}" — more than one only when it ` +
            'consists of parts of different materials that are all in the product, or when part of it has no ' +
            'mass found (that part gets its own entry with "mass_kg": null). Other figures for ' +
            `"${c}" itself — a variant, another source — go under "alternatives" of its entry.`,
          c
        )
      )
    : recipeOf
      ? []
      : [
          ask(
            `${brief}\n\nList every relevant component with its material and mass in kg (at most ${cap} entries) ` +
              'in the JSON object. Include the small parts a teardown would find — coatings, adhesives, ' +
              'fasteners, labels, seals, additives — when the product has them; a part whose mass you cannot ' +
              'find is listed with "mass_kg": null, not left out and not guessed.',
            'the component list'
          )
        ]

  // Settled, not all: a leg that runs out of its time budget or loses its connection used to take every
  // other leg's findings with it, so eight researched components became an empty result because the
  // ninth timed out. What came back is kept, and what did not is named by component.
  const [settled, recipeSettled] = await Promise.all([
    Promise.allSettled(legs),
    recipeLeg ? Promise.allSettled([recipeLeg]) : Promise.resolve([])
  ])
  const outcomes: LegOutcome[] = settled.map((r, i) => ({
    request: components.length ? components[i] : null,
    ...(r.status === 'fulfilled'
      ? { leg: r.value }
      : { error: r.reason instanceof Error ? r.reason.message : String(r.reason) })
  }))

  // A requested part whose researcher found only the whole product's mass is a gap like any other: named, and
  // asked again below for the part alone. Left as a bare whole-product answer it had no entry to follow up.
  for (const o of outcomes) {
    const leg = o.leg
    if (o.request === null || !leg || leg.items.length || leg.unresolved.length || !leg.product_masses.length)
      continue
    o.leg = {
      ...leg,
      unresolved: [
        {
          component: o.request,
          reason: 'whole_product_only',
          note: "Only the whole product's mass came back (see totals_found) — no figure for this part alone."
        }
      ]
    }
  }

  // What the first round's pages said about the parts other legs research: a page for a gap goes to its follow-up.
  const admissible = admissiblePage(book, `${opts.product}\n${opts.context ?? ''}`)
  const firstFigures = crossFigures(outcomes, admissible)
  const leadsOf = (g: { o: number; u: { component: string } }) =>
    leadsFor(firstFigures, outcomes[g.o].request, g.u.component)

  // ONE bounded follow-up pass for the components that came back without a usable mass: the first three
  // of them, in parallel, on the 90-second narrow question. Bounded like the figure check of the web legs —
  // never after a Stop, never more than once — so this is a second look at named gaps, not free iteration.
  // An answer belongs to the gap it was asked for, whatever the leg called the part: matching by name lost
  // a coating the follow-up had found, because it spelt the component differently. A gap another leg's page
  // states a figure for goes first: of the three the pass takes, it is the likeliest to land.
  const gaps = outcomes
    .flatMap((o, i) =>
      (o.leg?.unresolved ?? []).filter((u) => u.reason !== 'failed').map((u) => ({ o: i, u }))
    )
    .sort((a, b) => Number(leadsOf(b).length > 0) - Number(leadsOf(a).length > 0))
  let follow_up: BomResult['follow_up']
  if (gaps.length && !opts.signal?.aborted) {
    const targets = gaps.slice(0, 3)
    opts.onProgress?.(
      `no mass for ${targets.map((t) => t.u.component).join(', ')} — one short follow-up pass`
    )
    const again = await Promise.allSettled(
      targets.map((t) =>
        ask(
          `${brief}\n\nResearch ONLY the component "${t.u.component}"` +
            (t.u.material ? ` (${t.u.material})` : '') +
            ': the mass of that part alone in kg — not of the whole product. Answer with the JSON object, ' +
            'one entry in "items".' +
            leadWords(leadsOf(t)),
          `${t.u.component} (follow-up)`,
          true
        )
      )
    )
    let resolved = 0
    again.forEach((r, k) => {
      if (r.status !== 'fulfilled') return
      const { o, u } = targets[k]
      const leg = outcomes[o].leg as BomLeg
      // A figure that landed replaces the gap with what the follow-up found — including any part of it the
      // follow-up again named without a mass. Only a gap with nothing left open counts as resolved.
      const landed = r.value.items.length > 0
      // A gap that came with figures only as alternatives keeps them: they stand beside the figure the follow-up
      // found, so a landing answers the gap without erasing what made it one.
      const carried = u.alternatives?.length
        ? r.value.items.map((it, k) =>
            k === 0 ? { ...it, alternatives: [...(it.alternatives ?? []), ...(u.alternatives ?? [])] } : it
          )
        : r.value.items
      outcomes[o].leg = {
        items: leg.items.concat(carried),
        unresolved: landed
          ? leg.unresolved.flatMap((x) => (x === u ? r.value.unresolved : [x]))
          : leg.unresolved,
        product_masses: leg.product_masses.concat(r.value.product_masses),
        versions_seen: leg.versions_seen.concat(r.value.versions_seen),
        ...(leg.for_others || r.value.for_others
          ? { for_others: [...(leg.for_others ?? []), ...(r.value.for_others ?? [])] }
          : {})
      }
      if (landed && !r.value.unresolved.length) resolved++
    })
    follow_up = { asked: targets.length, resolved }
    opts.onProgress?.(`follow-up: ${resolved} of ${targets.length} resolved`)
  }

  // Held against each part's own figure once the follow-up is in, so a figure it found is checked too.
  const cross = crossChecks(crossFigures(outcomes, admissible), outcomes, (url) => book.canonical(url))

  const recipeOutcome = recipeSettled[0]
  const recipe =
    opts.recipe && recipeOf
      ? weighRecipe(recipeOutcome?.status === 'fulfilled' ? recipeOutcome.value : undefined, {
          of: recipeOf,
          request: opts.recipe,
          canonical: (url) => book.canonical(url),
          ...(recipeOutcome?.status === 'rejected'
            ? {
                error:
                  recipeOutcome.reason instanceof Error
                    ? recipeOutcome.reason.message
                    : String(recipeOutcome.reason)
              }
            : {})
        })
      : undefined
  const weighed = weighBom(outcomes, {
    totalMassKg: opts.totalMassKg,
    notResearched,
    itemCap: Math.max(cap * 3, 12),
    ...(recipe ? { recipe } : {})
  })
  // The weighing never reads an address, so the sources are settled after it: a figure left without a page is
  // kept in the sums and named (bomSources.ts).
  const sourced = settleSources(weighed, book)
  const emptyNote =
    weighed.items.length === 0 && !sourced.unresolved.length && !weighed.recipe?.lines.length
      ? 'The research returned no usable figures — ask the user for the composition, or try a more specific product description.'
      : ''
  return {
    product: opts.product,
    ...weighed,
    summary: [weighed.summary, sourced.sentence].filter(Boolean).join(' '),
    unresolved: sourced.unresolved,
    ...(sourced.all_sourced !== undefined ? { all_sourced: sourced.all_sourced } : {}),
    ...(sourced.unsourced ? { unsourced: sourced.unsourced } : {}),
    ...(follow_up ? { follow_up } : {}),
    ...(notResearched.length ? { not_researched: notResearched } : {}),
    sources: sourced.sources,
    ...evidenceNote(sourced.evidence),
    evidence: sourced.evidence,
    ...(domains.length ? { domains } : {}),
    ...(cross.length ? { cross_checks: cross } : {}),
    note:
      [emptyNote, weighed.note, crossCheckNote(cross), ...sourced.notes].filter(Boolean).join(' ') ||
      undefined
  }
}
