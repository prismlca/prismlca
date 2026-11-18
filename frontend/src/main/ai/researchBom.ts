/**
 * The bill-of-materials researcher behind `research_bom`: one isolated web-research leg per named component
 * (or one that enumerates them), a bounded retry and follow-up pass, and the sources settled against what the
 * search engine actually cited. Reading a leg's answer lives in bomAnswer.ts, judging the list in bomBalance.ts.
 */
import { parseBomAnswer, type BomLeg } from './bomAnswer'
import { weighBom, type BomWeighing, type LegOutcome } from './bomBalance'
import { CitationBook, isProviderLink, type Evidence } from './citationBook'
import { settleLinks } from './researchNote'
import { RETRY_BUDGET_MS, extractJson, normalizeDomains, runResearch, type CostSink } from './subagent'

const BOM_SYSTEM = `You research bills of materials for life-cycle assessment.
Answer with ONE JSON object ONLY — no prose, no code fence:
{"items": [{"component": string, "material": string, "mass_kg": number | null, "count": integer,
            "mass_each_kg": number, "mass_range_kg": [number, number], "packaging": boolean,
            "includes": [string], "version": string, "source_url": string, "source_class": string,
            "confidence": string, "note": string}],
 "product_mass": [{"mass_kg": number, "basis": "net" | "gross" | "unknown", "version": string,
                   "source_url": string, "note": string}],
 "versions_seen": [{"version": string, "differs_by": string, "mass_kg": number, "sold_by": string,
                    "source_url": string}]}
Only "component", "material", "mass_kg" and "source_url" are needed in every entry; leave out what does not apply.

Items:
- Masses in kilograms as plain numbers. "mass_kg" is the mass of ALL pieces the entry stands for (five
  shelves together, not one). When your source gives the mass of ONE piece, write it as "mass_each_kg" with
  "count" (how many of them the product has) and leave "mass_kg" out — the tool multiplies. Never a piece
  mass without a count.
- An entry is one part, or a set of identical parts — never the whole product. A weight your source gives for
  the complete product (article weight, shipping weight) goes into "product_mass", also when you were asked
  for a part, and is never that part's figure.
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
- "packaging": true for sales or transport packaging (box, film, pallet) — not for parts of the product.
- "includes": when your figure already contains another listed component (a pouch weighed with its spout),
  name that component as it was listed.
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
"gross" with packaging (shipping weight), "unknown" when the source does not say.

versions_seen (leave it out when the sources show only one version): every other version of THIS product your
sources showed — its EAN, article number or name, what differs, its weight if stated, where it is sold. Not
comparable products of other makers.

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
  /** The host allow list the legs ran under, when the caller set one. */
  domains?: string[]
  sources: string[]
}

/** A leg that found nothing parses to this — the weighing calls it failed, with the reason given. */
const EMPTY: BomLeg = { items: [], unresolved: [], product_masses: [], versions_seen: [] }

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
}): Promise<BomResult> {
  const cap = Math.max(1, Math.min(opts.maxComponents ?? 8, 8))
  const named = (opts.components ?? []).map((c) => c.trim()).filter(Boolean)
  const components = named.slice(0, cap)
  // Over the limit is named, not dropped: a list cut to eight cannot pass for the product.
  const notResearched = named.slice(cap)
  const domains = normalizeDomains(opts.domains)
  // Every page the engine cited across all legs and passes — the evidence the items can point to.
  const book = new CitationBook()

  const ask = async (question: string, label: string, brief = false): Promise<BomLeg> => {
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
      {
        q:
          `${question}\n\nBE BRIEF: the JSON object with one entry — the mass in kg and one source URL. ` +
          'Do not survey alternatives: one sourced figure is enough, and its note still says whose figure it is.',
        budgetMs: RETRY_BUDGET_MS
      }
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
          system: BOM_SYSTEM,
          model: opts.model,
          signal: opts.signal,
          onCost: opts.onCost,
          budgetMs: attempts[i].budgetMs,
          domains: domains.length ? domains : undefined,
          onCitations: (c) => book.add(c)
        })
      } catch (e) {
        // Out of time, or the connection died. One narrow retry is worth it; a second is not, and the
        // user pressing Stop must still end everything at once.
        if (!timedOut && !opts.signal?.aborted) {
          timedOut = true
          opts.onProgress?.(`${label}: ran out of time — retrying with a narrower question`)
          continue
        }
        throw e
      }
      if (!text) continue
      try {
        const leg = parseBomAnswer(extractJson(text))
        const n = leg.items.length
        const open = leg.unresolved.length
        opts.onProgress?.(
          `${label}: ${n} entr${n === 1 ? 'y' : 'ies'}` +
            (open ? `, ${open} without a mass` : '') +
            (leg.product_masses.length ? ', whole-product mass found' : '')
        )
        return leg
      } catch {
        /* try once more with a stricter instruction */
      }
    }
    opts.onProgress?.(`${label}: nothing usable`)
    return EMPTY
  }

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
    const others = components.filter((o) => o !== c)
    return others.length
      ? `\nResearched separately, by other researchers: ${others.map((o) => `"${o}"`).join(', ')}.`
      : ''
  }
  const legs = components.length
    ? components.map((c) =>
        ask(
          `${brief}${siblings(c)}\n\nResearch ONLY the component "${c}": its material and its mass in kg. ` +
            `Answer with the JSON object; "items" holds the entry for "${c}" — more than one only when it ` +
            'consists of parts of different materials, or when part of it has no mass found (that part gets ' +
            'its own entry with "mass_kg": null).',
          c
        )
      )
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
  const settled = await Promise.allSettled(legs)
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

  // ONE bounded follow-up pass for the components that came back without a usable mass: the first three
  // of them, in parallel, on the 90-second narrow question. Bounded like the upgrade pass of the web legs —
  // never after a Stop, never more than once — so this is a second look at named gaps, not free iteration.
  // An answer belongs to the gap it was asked for, whatever the leg called the part: matching by name lost
  // a coating the follow-up had found, because it spelt the component differently.
  const gaps = outcomes.flatMap((o, i) =>
    (o.leg?.unresolved ?? []).filter((u) => u.reason !== 'failed').map((u) => ({ o: i, u }))
  )
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
            'one entry in "items".',
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
      outcomes[o].leg = {
        items: leg.items.concat(r.value.items),
        unresolved: landed
          ? leg.unresolved.flatMap((x) => (x === u ? r.value.unresolved : [x]))
          : leg.unresolved,
        product_masses: leg.product_masses.concat(r.value.product_masses),
        versions_seen: leg.versions_seen.concat(r.value.versions_seen)
      }
      if (landed && !r.value.unresolved.length) resolved++
    })
    follow_up = { asked: targets.length, resolved }
    opts.onProgress?.(`follow-up: ${resolved} of ${targets.length} resolved`)
  }

  const weighed = weighBom(outcomes, {
    totalMassKg: opts.totalMassKg,
    notResearched,
    itemCap: Math.max(cap * 3, 12)
  })
  const { items } = weighed
  // A leg may quote the provider's link to a page instead of the page (Google): stored as the page —
  // and a link that leads to no page is no source at all, so the figure stays and loses it.
  let deadLinks = 0
  const settle = (url: string | undefined): string | undefined => {
    if (!url) return undefined
    const page = book.canonical(url)
    if (isProviderLink(page) && !book.has(page)) {
      deadLinks++
      return undefined
    }
    return page
  }
  for (const i of items) i.source_url = settle(i.source_url)
  for (const t of weighed.totals_found ?? []) if (t.source_url) t.source_url = settle(t.source_url)
  // The addresses an unresolved component's note names get the same treatment: the page, not the
  // provider's link to it, and no link that leads nowhere.
  const unresolved = weighed.unresolved.map((u) => {
    const s = settleLinks(u, (url) => book.page(url))
    const url = u.source_url ? book.page(u.source_url) : null
    const { source_url: _dropped, ...rest } = s
    return url ? { ...rest, source_url: url } : rest
  })
  const sources = [
    ...new Set(
      [...items.map((i) => i.source_url), ...(weighed.totals_found ?? []).map((t) => t.source_url)].filter(
        (u): u is string => !!u
      )
    )
  ]
  // The engine's record against the model's: an item whose URL the search never returned is marked,
  // not dropped — the leg may have opened the page directly or written it from memory, and the
  // parent should know which figures rest on a citation the engine can vouch for.
  if (book.size) for (const i of items) if (i.source_url) i.cited_by_search = book.has(i.source_url)
  const evidence = book.evidenceFor(sources)
  const uncited = book.size ? items.filter((i) => i.source_url && !i.cited_by_search).length : 0
  const uncitedNote = uncited
    ? `${uncited} item${uncited === 1 ? "'s" : "s'"} source_url was NOT among the pages the search engine returned (cited_by_search: false) — the leg opened it directly or wrote it from memory; verify before relying on it.`
    : ''
  const deadNote = deadLinks
    ? `${deadLinks} figure${deadLinks === 1 ? '' : 's'} named a search-result link that leads to no page — kept without a source_url; verify before relying on it.`
    : ''
  const emptyNote =
    items.length === 0 && !unresolved.length
      ? 'The research returned no usable figures — ask the user for the composition, or try a more specific product description.'
      : ''
  return {
    product: opts.product,
    ...weighed,
    unresolved,
    ...(follow_up ? { follow_up } : {}),
    ...(notResearched.length ? { not_researched: notResearched } : {}),
    sources,
    evidence,
    ...(domains.length ? { domains } : {}),
    note: [emptyNote, weighed.note, uncitedNote, deadNote].filter(Boolean).join(' ') || undefined
  }
}
