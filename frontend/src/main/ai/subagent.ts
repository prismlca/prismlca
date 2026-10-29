/**
 * Research sub-agent.
 *
 * The architectural idea in one line: **a sub-agent is just a tool whose implementation happens to
 * be another LLM loop.** The main chat loop stays exactly as it is — no orchestrator, no framework,
 * no second runtime.
 *
 * Why a sub-agent earns its keep for research (and almost nowhere else in PrismLCA):
 *   - it needs NO internal tools, only web search ⇒ read-only, it cannot touch the user's model;
 *   - it produces a lot of junk context (many pages, dead ends) ⇒ isolating that from the main
 *     conversation is the whole point — the parent only ever sees the compact result;
 *   - per-item questions run in PARALLEL;
 *   - the answer is verifiable (mass balance + mandatory sources).
 */
import { streamChat } from './client'
import { AiProviderError, type ChatMessage, type Citation } from './providers/types'
import { providerDefaults } from './models'
import { getActiveProvider } from './providers/state'
import { collectText, costOf } from './stream'

/**
 * Default for the research legs when Settings → AI → Models leaves "Research model" empty.
 * Cheap with solid synthesis; web search costs ~$0.005/request. These legs bill under THIS model in
 * the cost table, not under the chat model — which is why the setting exists and says so.
 */
export const RESEARCH_MODEL = providerDefaults('openrouter').research
/** A research leg may take a few web round-trips, but must never run away. */
const MAX_RESEARCH_ROUNDS = 6

/**
 * Wall-clock ceiling for one leg. Rounds alone did not bound anything: a single request that never
 * finishes is one round, and in a live run that was 34 minutes of a `research_bom` with no
 * progress, no log line and no way out but Stop — which discards the whole turn, research included.
 *
 * Six minutes is generous for a handful of web round-trips and short enough that a hung provider costs
 * a leg rather than an evening. The client's own stall detector catches a dead stream sooner; this
 * catches the other shape, a stream that dribbles forever without ever finishing. Raised from five
 * alongside the sharper levers against the failure that actually eats budgets: legs run
 * at low reasoning effort, are told their budget, and write findings as they go — the ceiling is the
 * backstop, not the plan.
 */
const LEG_BUDGET_MS = 360_000

/**
 * Budget for the one retry a timed-out leg gets. Deliberately a fraction of the full one: the retry
 * asks for a single sourced number rather than a survey, so if THAT cannot land in 90 seconds the
 * question is not going to be answered by waiting longer — and the parent is already several minutes
 * into a call whose other legs have long finished.
 */
const RETRY_BUDGET_MS = 90_000

/** Books a request's usage. Research legs run on their OWN model and web search bills per request
 *  (~$0.005), so without this sink a turn's real cost stayed invisible — and the caller's cost limit
 *  could not see it either. */
export type CostSink = (
  modelId: string,
  u: { cost?: number; prompt?: number; cached?: number; completion?: number }
) => void

export interface ResearchOpts {
  /** The question, phrased so the answer can be checked (ask for units and sources). */
  question: string
  /** System framing for this leg. */
  system: string
  model?: string
  signal?: AbortSignal
  onCost?: CostSink
  /** Wall-clock ceiling for this leg; defaults to LEG_BUDGET_MS. */
  budgetMs?: number
  /** One line about what this leg is doing, for the parent's trace. */
  onProgress?: (note: string) => void
  /** Restrict the provider's web search to these hosts (see StreamChatOpts.webDomains). */
  domains?: string[]
  /** Pages the provider's web search cited while this leg ran — the engine's word on what was read. */
  onCitations?: (citations: Citation[]) => void
}

/**
 * Run one bounded research leg: web search only, no function tools — so it cannot call PrismLCA tools,
 * cannot mutate anything, and cannot recurse into itself. Returns the model's final text.
 *
 * Bounded in time as well as in rounds: past its budget the leg is abandoned and this throws, so the
 * caller can say what happened instead of returning an empty answer that looks like "nothing found".
 */
export async function runResearch(opts: ResearchOpts): Promise<string> {
  const budgetMs = opts.budgetMs ?? LEG_BUDGET_MS
  // Our own clock, kept separate from the caller's signal so "the user pressed Stop" and "this leg ran
  // out of time" stay distinguishable — they need different words in the answer.
  const clock = new AbortController()
  const timer = setTimeout(() => clock.abort(), budgetMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, clock.signal]) : clock.signal
  try {
    return await runLeg(opts, signal, clock)
  } finally {
    clearTimeout(timer)
  }
}

async function runLeg(opts: ResearchOpts, signal: AbortSignal, clock: AbortController): Promise<string> {
  // The leg is told its budget and told to write early. Both exist because of how a leg actually
  // dies: the partial text of an aborted stream IS kept and parsed (a truncated last line has no URL
  // and drops out), so a timeout only loses everything when the model saved its answer for a grand
  // finale — or spent the whole budget thinking. Naming the budget is what the big research products
  // do; it costs one line.
  const minutes = Math.max(1, Math.round((opts.budgetMs ?? LEG_BUDGET_MS) / 60_000))
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        `${opts.system}\n\nTime budget: about ${minutes} minute${minutes === 1 ? '' : 's'} of wall ` +
        'clock. Spend it searching and reading, not deliberating — and write your answer early: if ' +
        'time runs out, only what is already written survives.'
    },
    { role: 'user', content: opts.question }
  ]
  let text = ''
  // The provider default when Settings leaves the research model empty — resolved HERE, so the id
  // the leg requests is the id its costs are booked under.
  const legModel = opts.model ?? providerDefaults(getActiveProvider()).research
  for (let round = 0; round < MAX_RESEARCH_ROUNDS; round++) {
    if (signal.aborted) break
    let roundText = ''
    // No `tools` array beyond the provider's server-side web tools, which `webSearch` attaches
    // (OpenRouter: web_search+web_fetch; OpenAI: the Responses API web_search).
    // Reasoning effort LOW: a research leg's job is retrieval, and the thinking dial is the budget
    // that actually runs out — GLM 5.3 defaults to effort "max" (per OpenRouter's model listing) and
    // spent an entire eval leg reasoning without writing a line.
    roundText = await collectText({
      model: legModel,
      messages,
      webSearch: true,
      webDomains: opts.domains,
      onCitations: opts.onCitations,
      reasoningEffort: 'low',
      signal,
      onCost: opts.onCost
    })
    text = roundText.trim()
    // Without function tools there is nothing to feed back — one pass is the whole leg.
    if (text) break
  }
  // Out of time, not out of answers. Said as an error rather than returned as "" so the caller can tell
  // the user which of the two happened; a silent empty leg reads as "the web knows nothing about this".
  if (clock.signal.aborted && !text)
    throw new Error(
      `The research ran past its ${Math.round((opts.budgetMs ?? LEG_BUDGET_MS) / 60_000)}-minute budget and was stopped. ` +
        'Ask again with a narrower question, or supply the figures yourself.'
    )
  return text
}

export interface BomItem {
  component: string
  material: string
  mass_kg: number
  /** Researched span [min, max] in kg, present only when the sources gave a range rather than one
   *  figure. `mass_kg` is the leg's chosen value inside it; the span is what a scenario spread can
   *  build on mechanically — before this field the range lived as prose in `note`, and the parent
   *  re-derived it by reading text. */
  mass_range_kg?: [number, number]
  source_url?: string
  /** Source kind as judged by the leg: official | industry | media | community. */
  source_class?: string
  /** The leg's confidence in the figure: high | medium | low (words, not a numeric scale — see WebFinding). */
  confidence?: string
  note?: string
  /** True when `source_url` is a page the search engine actually returned to the leg (a `url_citation`
   *  annotation); false when the leg wrote a URL the engine never cited — from memory, or a page it
   *  opened directly. Absent when the provider annotates nothing. */
  cited_by_search?: boolean
}

/**
 * A component the research named but could not put a mass on. Kept and reported rather than dropped:
 * PCFBench (arXiv 2608.27716) measures 47–86 % of generated bills of materials carrying "ghost"
 * zero-mass parts and a quarter to a third of the parts missing outright — and the
 * parser used to delete the first kind silently and let the second pass as a clean list.
 */
export interface UnresolvedComponent {
  component: string
  material?: string
  /** `no_mass`: the leg found the part but no figure; `zero_mass`: it wrote 0, which is a ghost. */
  reason: 'no_mass' | 'zero_mass'
  note?: string
}

/** A cited page as the result hands it on: the engine's URL, and the excerpt the model read when
 *  the engine supplied one (Exa highlights; a direct OpenAI search carries none). */
export interface Evidence {
  url: string
  title?: string
  excerpt?: string
}

/** Longest excerpt kept per evidence entry — enough to show the table row a figure came from. */
const EXCERPT_CHARS = 400
/** Evidence entries per result; the legs cite a handful, the cap only stops a runaway listing. */
const MAX_EVIDENCE = 12

/** One comparable key per URL: scheme, `www.`, trailing slash and fragment do not make a different page. */
export function urlKey(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/#.*$/, '')
    .replace(/[.,;)]+$/, '')
    .replace(/\/+$/, '')
}

/** Collect citations across a leg's passes, one entry per page, first excerpt wins. */
export class CitationBook {
  private readonly byKey = new Map<string, Evidence>()
  add(citations: Citation[]): void {
    for (const c of citations) {
      const key = urlKey(c.url)
      if (!key) continue
      const cur = this.byKey.get(key)
      const excerpt = c.excerpt?.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS)
      if (!cur) {
        this.byKey.set(key, {
          url: c.url,
          ...(c.title ? { title: c.title } : {}),
          ...(excerpt ? { excerpt } : {})
        })
      } else if (!cur.excerpt && excerpt) cur.excerpt = excerpt
    }
  }
  get size(): number {
    return this.byKey.size
  }
  has(url: string): boolean {
    return this.byKey.has(urlKey(url))
  }
  /** The cited pages behind these URLs, in the order the URLs are given, each page once. */
  evidenceFor(urls: string[]): Evidence[] {
    const out: Evidence[] = []
    const seen = new Set<string>()
    for (const u of urls) {
      const key = urlKey(u)
      const e = this.byKey.get(key)
      if (e && !seen.has(key)) {
        seen.add(key)
        out.push(e)
      }
      if (out.length >= MAX_EVIDENCE) break
    }
    return out
  }
}

/**
 * A bare host out of whatever the model or the caller wrote — "https://www.destatis.de/DE/x" and
 * "destatis.de" both become "destatis.de". Null for anything that is not a host.
 */
export function normalizeDomain(raw: string): string | null {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '')
    .replace(/[.,;:]+$/, '')
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null
}

/** Normalise, de-duplicate and cap a domain list; the cap is OpenAI's documented ceiling. */
export function normalizeDomains(raw: unknown, cap = 20): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const r of raw) {
    const d = typeof r === 'string' ? normalizeDomain(r) : null
    if (d && !out.includes(d)) out.push(d)
    if (out.length >= cap) break
  }
  return out
}

/** Pull the first JSON array/object out of a model answer (they like to wrap it in prose or fences). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([[{][\s\S]*?)```/)
  const candidate = fenced
    ? fenced[1]
    : text.slice(Math.min(...[text.indexOf('['), text.indexOf('{')].filter((i) => i >= 0).concat([0])))
  const start = candidate.search(/[[{]/)
  if (start < 0) throw new Error('no JSON found in the answer')
  // Walk to the matching bracket so trailing prose is ignored.
  const open = candidate[start]
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let inString = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    // Brackets inside a string are text, not structure: a note like "]-shaped profile" ended the
    // array early and a valid answer was thrown away and re-asked.
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1))
    }
  }
  throw new Error('unterminated JSON in the answer')
}

/** Coerce a parsed answer into BOM items, dropping anything without a component and a mass. */
export function parseBomItems(parsed: unknown): BomItem[] {
  return parseBomAnswer(parsed).items
}

/**
 * Split a leg's answer into items with a mass and components without one. A named part with no
 * figure — `mass_kg` null, missing, unparsable or 0 — is a gap to report, not a row to delete: the
 * follow-up pass asks for exactly these, and the balance verdict cannot be "ok" while they are open.
 */
export function parseBomAnswer(parsed: unknown): { items: BomItem[]; unresolved: UnresolvedComponent[] } {
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { items?: unknown })?.items)
      ? ((parsed as { items: unknown[] }).items as unknown[])
      : []
  const out: BomItem[] = []
  const unresolved: UnresolvedComponent[] = []
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const component = String(r.component ?? r.part ?? r.name ?? '').trim()
    if (!component) continue
    const rawMass = r.mass_kg ?? r.mass ?? r.mass_in_kg
    const mass = rawMass == null || rawMass === '' ? NaN : Number(rawMass)
    if (!Number.isFinite(mass) || mass <= 0) {
      const material = String(r.material ?? r.materials ?? '').trim()
      unresolved.push({
        component,
        ...(material ? { material } : {}),
        reason: Number.isFinite(mass) ? 'zero_mass' : 'no_mass',
        ...(r.note ? { note: String(r.note).slice(0, 300) } : {})
      })
      continue
    }
    const klass = String(r.source_class ?? '')
      .trim()
      .toLowerCase()
    const conf = String(r.confidence ?? '')
      .trim()
      .toLowerCase()
    // A usable range brackets the point value; anything else contradicts it, and the point value is
    // what everything downstream keys on — so a contradictory or degenerate range is dropped, never
    // "repaired" here (same stance as the judgement vocabularies: validated or absent).
    const rawRange = (r.mass_range_kg ?? r.mass_range) as unknown
    let range: [number, number] | undefined
    if (Array.isArray(rawRange) && rawRange.length === 2) {
      const lo = Number(rawRange[0])
      const hi = Number(rawRange[1])
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && lo < hi && mass >= lo && mass <= hi)
        range = [lo, hi]
    }
    out.push({
      component,
      material: String(r.material ?? r.materials ?? '').trim(),
      mass_kg: mass,
      ...(range ? { mass_range_kg: range } : {}),
      source_url: r.source_url ? String(r.source_url) : r.source ? String(r.source) : undefined,
      // Only the enum values pass — a free-text judgement here would be indistinguishable from the
      // checked one, and "when unsure pick the lower" only works over a closed set.
      ...(['official', 'industry', 'media', 'community'].includes(klass) ? { source_class: klass } : {}),
      ...(['high', 'medium', 'low'].includes(conf) ? { confidence: conf } : {}),
      note: r.note ? String(r.note) : undefined
    })
  }
  return { items: out, unresolved }
}

/**
 * Whether the parts add up to the stated total.
 *
 * `balance_ok: null` means "could not be checked", and that is the answer whenever a component is
 * missing from the list — not just when no total was given. This is the fix for the most expensive
 * finding of an early live run: two of six research legs had died, the four survivors summed
 * to 25.7 of 30 kg, and because 14.3 % happened to fall inside the tolerance the result said
 * `balance_ok: true` in the same object that said "2 of 6 research legs failed". The model read the
 * seal, treated 25.7 kg as a near-complete composition, and made the missing 4.3 kg the residual mass
 * of the PVC profile — 3.95 kg where association EPDs say 6–9. A check that reports "passed" on an
 * incomplete list is worse than no check, because it invites exactly that.
 *
 * `residual_kg` is stated either way: a signed number is what the caller needs to decide whether to
 * look for a missing part or to distrust the total, and deriving it from `sum_kg` and the total is the
 * kind of arithmetic the tool should not leave to a language model.
 */
export function massBalance(
  items: BomItem[],
  totalKg?: number,
  tolerance = 0.15,
  opts: { lost?: number; unresolved?: string[] } = {}
): {
  sum_kg: number
  /** What the parts can sum to when each stays inside its researched range — [min, max]. Present
   *  only when at least one item carries a range; a span equal to the sum would say nothing. */
  sum_range_kg?: [number, number]
  balance_ok: boolean | null
  residual_kg?: number
  note?: string
} {
  const sum = items.reduce((s, i) => s + i.mass_kg, 0)
  const sum_kg = Number(sum.toFixed(6))
  // Items with a researched range contribute [min, max]; the rest their point value.
  const span: [number, number] | undefined = items.some((i) => i.mass_range_kg)
    ? [
        Number(items.reduce((s, i) => s + (i.mass_range_kg?.[0] ?? i.mass_kg), 0).toFixed(6)),
        Number(items.reduce((s, i) => s + (i.mass_range_kg?.[1] ?? i.mass_kg), 0).toFixed(6))
      ]
    : undefined
  const base = span ? { sum_kg, sum_range_kg: span } : { sum_kg }
  if (!totalKg || !Number.isFinite(totalKg) || totalKg <= 0) {
    return { ...base, balance_ok: null, note: 'No total mass given — could not check the balance.' }
  }
  const residual_kg = Number((totalKg - sum).toFixed(6))
  const open = opts.unresolved?.filter(Boolean) ?? []
  if (opts.lost || open.length) {
    // Two ways to the same verdict: a leg that never came back, or a part the research named without
    // a figure. The second is named by name — "incomplete" alone invites guessing which part it was.
    const missing = opts.lost
      ? `${opts.lost} component${opts.lost === 1 ? '' : 's'} could not be researched`
      : `${open.length} named component${open.length === 1 ? ' has' : 's have'} no researched mass`
    const named = open.length ? ` (no mass found for: ${open.join(', ')})` : ''
    return {
      ...base,
      balance_ok: null,
      residual_kg,
      note:
        `Balance NOT checked: ${missing}${named}, so the list is incomplete by construction. The ` +
        `${residual_kg} kg between the parts found (${sum_kg} kg) and the stated total (${totalKg} kg) ` +
        'is unaccounted mass, not a tolerance: find the missing components or ask the user, and do ' +
        'NOT hand the remainder to one part as its mass.'
    }
  }
  const off = Math.abs(sum - totalKg) / totalKg
  if (off > tolerance) {
    // With ranges on record the verdict can say which of the two repairs applies: masses placed
    // differently inside their researched spans, or a genuinely missing component / wrong total.
    const reach = span
      ? totalKg >= span[0] && totalKg <= span[1]
        ? ` The researched ranges DO reach the total (parts span ${span[0]}–${span[1]} kg) — place the masses inside their ranges before doubting the total.`
        : ` Even the researched ranges cannot reach it (parts span ${span[0]}–${span[1]} kg) — a component is missing or the total is wrong.`
      : ''
    return {
      ...base,
      balance_ok: false,
      residual_kg,
      note: `Components sum to ${sum_kg} kg but the stated total is ${totalKg} kg (${Math.round(off * 100)}% off) — check the figures before modelling them.${reach}`
    }
  }
  // Inside the tolerance, so the verdict stands — but the tolerance is 15 %, and on a 30 kg product
  // that is up to 4.5 kg of unnamed mass. Saying "ok" and nothing else invited the residual to be
  // quietly assigned to whichever part was still unknown. The number goes out with the verdict; what
  // it means is a judgement the caller has to make, so the sentence names both readings.
  const share = Math.abs(residual_kg) / totalKg
  return {
    ...base,
    balance_ok: true,
    residual_kg,
    note:
      share >= 0.05
        ? `Within tolerance, but ${residual_kg} kg of the stated ${totalKg} kg is not covered by any ` +
          'listed component — small unlisted parts (fasteners, adhesive, coatings) or a component ' +
          'that was missed. Do not assign it to one part without saying so.'
        : undefined
  }
}

const BOM_SYSTEM = `You research bills of materials for life-cycle assessment.
Answer with a JSON array ONLY — no prose, no code fence — where each entry is:
{"component": string, "material": string, "mass_kg": number, "mass_range_kg": [number, number],
 "source_url": string, "source_class": string, "confidence": string, "note": string}
Rules: masses in kilograms as plain numbers; name the concrete polymer/metal/alloy in "material"
(e.g. "PET", "HDPE", "aluminium 3104"), not a generic word like "plastic"; every entry needs a
source_url you actually consulted; if a figure is a typical industry value rather than a measured
one, say so in "note". Prefer standards, EPDs, manufacturer data and peer-reviewed sources.
"mass_range_kg" is optional: when your sources give a RANGE rather than one figure, put [min, max]
there and set "mass_kg" to the value inside that range you would model with, saying in "note" how
you chose it. When the sources give a single figure, omit "mass_range_kg" — never invent a spread.
Return the JSON as soon as your figures stand — an answer still unwritten when time runs out is lost.
A component you identified but found NO mass for still gets an entry: "mass_kg": null, and the
"note" says what you did find (a material, a range for a similar product, "no figure anywhere").
Never write 0 for an unknown mass and never estimate one — a null is a gap the caller can close,
a guess is not. Equally, do not list a part you have no evidence exists.
"source_class" is the source's kind: official (authority, standard, EPD, peer review), industry
(manufacturer, trade association, patent), media (press, blogs, buying guides) or community (forums,
reviews) — when unsure, pick the LOWER one, never official. A patent is a real source and worth
using, but it is not official: nobody has checked its figures against the product you are costing. "confidence" is high, medium or low
for the FIGURE itself, and the note must carry its reason (e.g. "three comparable products agree",
"single listing, format differs"). The note also says whose figure it is: THIS product's own (its
datasheet, its listing, a measurement of it) or a comparable product's. When this product's own
figure is not published, a comparable product's is a valid answer — give it and name that product by
brand and model; it is never "high" for this product.`

export interface BomResult {
  product: string
  items: BomItem[]
  /** Components the research named but could not put a mass on, after the follow-up pass. */
  unresolved: UnresolvedComponent[]
  /** The one bounded follow-up for unresolved components: how many were asked again, how many landed. */
  follow_up?: { asked: number; resolved: number }
  /** Pages the search engine cited that the items' `source_url`s point to, with excerpts when the
   *  engine supplied them (Exa). The engine's record of what was read, not the model's. */
  evidence: Evidence[]
  /** The host allow list the legs ran under, when the caller set one. */
  domains?: string[]
  total_mass_kg?: number
  sum_kg: number
  /** [min, max] the parts can sum to inside their researched ranges — only when ranges came back. */
  sum_range_kg?: [number, number]
  balance_ok: boolean | null
  /** Stated total minus the parts found, signed. Present whenever a total was given. */
  residual_kg?: number
  /** Researched of requested. `researched < requested` is why `balance_ok` can be null. */
  coverage?: { requested: number; researched: number }
  sources: string[]
  note?: string
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
}): Promise<BomResult> {
  const cap = Math.max(1, Math.min(opts.maxComponents ?? 8, 8))
  const components = (opts.components ?? [])
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, cap)
  const domains = normalizeDomains(opts.domains)
  // Every page the engine cited across all legs and passes — the evidence the items can point to.
  const book = new CitationBook()

  type Leg = { items: BomItem[]; unresolved: UnresolvedComponent[] }
  const ask = async (question: string, label: string, brief = false): Promise<Leg> => {
    opts.onProgress?.(`researching ${label}`)
    // Two failure shapes, two remedies. An answer that will not parse gets a stricter instruction on
    // the same budget; a leg that runs out of TIME gets one shorter, narrower attempt. Without the
    // second, a timed-out leg was simply lost: measured, two of six legs died on the
    // 5-minute ceiling — the PVC profile and the edge spacer, the two heaviest non-glass parts — and
    // the parent then spent a separate 285-second research_web call asking the same two questions
    // again. A retry inside the call is the same work without the extra round.
    // The three attempts a leg gets, in order. The last one exists for the timeout case only: it asks
    // for a single number instead of a survey, on a fraction of the budget.
    const attempts: Array<{ q: string; budgetMs?: number }> = [
      { q: question },
      { q: `${question}\n\nReturn ONLY the JSON array, nothing else.` },
      {
        q:
          `${question}\n\nBE BRIEF: one JSON entry, the mass in kg and one source URL. ` +
          'Do not survey alternatives — the best-sourced typical value is enough.',
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
          `${label}: ${n} entr${n === 1 ? 'y' : 'ies'}` + (open ? `, ${open} without a mass` : '')
        )
        return leg
      } catch {
        /* try once more with a stricter instruction */
      }
    }
    opts.onProgress?.(`${label}: nothing usable`)
    return { items: [], unresolved: [] }
  }

  // Everything the leg needs to know, since it shares no history with the parent conversation.
  const brief =
    `Product: ${opts.product}.` +
    (opts.context?.trim() ? `\nKnown specifics: ${opts.context.trim()}` : '') +
    (opts.totalMassKg ? `\nTotal product mass: about ${opts.totalMassKg} kg.` : '')
  const legs = components.length
    ? components.map((c) =>
        ask(
          `${brief}\n\nResearch ONLY the component "${c}": its material and mass in kg. Return one JSON entry (a one-element array).`,
          c
        )
      )
    : [
        ask(
          `${brief}\n\nList every relevant component with its material and mass in kg (at most ${cap} entries). ` +
            'Include the small parts a teardown would find — coatings, adhesives, fasteners, labels, ' +
            'seals, additives — when the product has them; a part whose mass you cannot find is listed ' +
            'with "mass_kg": null, not left out and not guessed.',
          'the component list'
        )
      ]

  // Settled, not all: a leg that runs out of its time budget or loses its connection used to take every
  // other leg's findings with it, so eight researched components became an empty result because the
  // ninth timed out. What came back is kept, and how many did not is said out loud rather than left as
  // a suspiciously short list.
  const settled = await Promise.allSettled(legs)
  let items = settled
    .flatMap((r) => (r.status === 'fulfilled' ? r.value.items : []))
    .slice(0, Math.max(cap, 12))
  let unresolved = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value.unresolved : []))
  // A leg that came back EMPTY found nothing — after the retry it returns [] rather than throwing —
  // and counted as researched: coverage said 2 of 2 while one component had no figure at all, and
  // the balance still passed. It is lost for the balance like a failed leg. A leg
  // whose only answer is an unresolved entry is not lost: it is named below and asked once more.
  const lost = settled.filter(
    (r) =>
      r.status === 'rejected' ||
      (r.status === 'fulfilled' && r.value.items.length === 0 && r.value.unresolved.length === 0)
  ).length

  // ONE bounded follow-up pass for the components that came back without a mass:
  // the three most important of them, in parallel, on the 90-second narrow question.
  // Bounded like the upgrade pass of the web legs — never after a Stop, never more than once — so
  // this is a second look at named gaps, not free iteration. What it resolves joins the items; what
  // it does not stays named in `unresolved`, where the parent can see exactly what to ask the user.
  let follow_up: BomResult['follow_up']
  if (unresolved.length && !opts.signal?.aborted) {
    const targets = unresolved.slice(0, 3)
    opts.onProgress?.(`no mass for ${targets.map((u) => u.component).join(', ')} — one short follow-up pass`)
    const again = await Promise.allSettled(
      targets.map((u) =>
        ask(
          `${brief}\n\nResearch ONLY the component "${u.component}"` +
            (u.material ? ` (${u.material})` : '') +
            `: its mass in kg. Return one JSON entry (a one-element array).`,
          `${u.component} (follow-up)`,
          true
        )
      )
    )
    const found = again.flatMap((r) => (r.status === 'fulfilled' ? r.value.items : []))
    const resolvedNames = new Set(found.map((i) => i.component.toLowerCase()))
    // Match by name loosely: the follow-up may spell "label" where the first pass wrote "the label".
    const isResolved = (u: UnresolvedComponent): boolean =>
      [...resolvedNames].some(
        (n) => n.includes(u.component.toLowerCase()) || u.component.toLowerCase().includes(n)
      )
    const resolved = targets.filter(isResolved)
    items = items.concat(found).slice(0, Math.max(cap, 12))
    unresolved = unresolved.filter((u) => !resolved.includes(u))
    follow_up = { asked: targets.length, resolved: resolved.length }
    opts.onProgress?.(`follow-up: ${resolved.length} of ${targets.length} resolved`)
  }

  // `lost` and the unresolved names decide the balance verdict, not just the note: a list missing a
  // component cannot be balanced against a total, however close the survivors happen to land.
  const { sum_kg, sum_range_kg, balance_ok, residual_kg, note } = massBalance(
    items,
    opts.totalMassKg,
    undefined,
    { lost, unresolved: unresolved.map((u) => u.component) }
  )
  const sources = [...new Set(items.map((i) => i.source_url).filter((u): u is string => !!u))]
  // The engine's record against the model's: an item whose URL the search never returned is marked,
  // not dropped — the leg may have opened the page directly or written it from memory, and the
  // parent should know which figures rest on a citation the engine can vouch for.
  if (book.size) for (const i of items) if (i.source_url) i.cited_by_search = book.has(i.source_url)
  const evidence = book.evidenceFor(sources)
  const uncited = book.size ? items.filter((i) => i.source_url && !i.cited_by_search).length : 0
  const lostNote = lost
    ? `${lost} of ${settled.length} research legs failed, ran out of time or found nothing even after a retry — the ` +
      'list below is INCOMPLETE. Name the missing components and research them separately (or ask ' +
      'the user) before you build anything from this.'
    : ''
  const uncitedNote = uncited
    ? `${uncited} item${uncited === 1 ? "'s" : "s'"} source_url was NOT among the pages the search engine returned (cited_by_search: false) — the leg opened it directly or wrote it from memory; verify before relying on it.`
    : ''
  return {
    product: opts.product,
    items,
    unresolved,
    ...(follow_up ? { follow_up } : {}),
    total_mass_kg: opts.totalMassKg,
    sum_kg,
    sum_range_kg,
    balance_ok,
    residual_kg,
    coverage: { requested: settled.length, researched: settled.length - lost },
    sources,
    evidence,
    ...(domains.length ? { domains } : {}),
    note:
      [
        lostNote,
        items.length === 0 && !unresolved.length
          ? 'The research returned no usable figures — ask the user for the composition, or try a more specific product description.'
          : note,
        uncitedNote
      ]
        .filter(Boolean)
        .join(' ') || undefined
  }
}

// --- generic web research ---------------------------------------------------

const WEB_SYSTEM = `You research facts for life-cycle assessment practitioners.
Answer as a short list of findings. Rules:
- When the question or its context carries a URL, OPEN it and answer from that document. It was put
  there because somebody knows it holds the answer; a search result that merely resembles it is not a
  substitute. If the document does not contain what was asked, say so — do not quietly fall back.
- Search BROAD first, then narrow: short, general queries to see what the web holds, then refine
  toward the specific product, region and year. When results are thin, REPHRASE the question
  (synonyms, the other language, trade names) instead of narrowing a query that already found little.
- Write each finding down as soon as it is confirmed, one line at a time — never save the list for
  the end. A written finding survives a timeout; one still in your head does not.
- Every factual statement ends with its source as a bare URL in parentheses, e.g. "(https://…)".
- A statement you cannot source, you do not make. Say "not found" instead of estimating.
- Give numbers with units, and name the year or edition a figure refers to.
- Mark typical/industry-average values as such; prefer standards, EPDs, statistical offices,
  manufacturer data and peer-reviewed sources over blogs.
- After the URL, close every finding with a judgement tag in square brackets:
  [official|industry|media|community, high|medium|low: reason of a few words]. The first word is the
  best source's class — official (authority, statistical office, standard, EPD, peer review),
  industry (manufacturer, trade association), media (press, blogs, buying guides), community
  (forums, Q&A, reviews). The second is your confidence in the FINDING, and the reason must say why
  ("three independent sources give the same range", "single forum anecdote"). When unsure of the
  class, pick the LOWER one — an unclassifiable source is community, never official.
- If every finding rests on media or community sources, add ONE last line naming where an official
  or manufacturer confirmation would live, as bare hosts: "authoritative_domains: destatis.de,
  example-manufacturer.com" (up to 5). Name only hosts you have reason to believe hold such a
  document; when you cannot name any, leave the line out — a guessed host narrows the next search
  to nothing. Omit the line when you already cite an official or industry source.
- No preamble, no closing summary — findings only.`

/** A single sourced finding. `sources` is empty only for lines the model failed to source. */
export interface WebFinding {
  text: string
  sources: string[]
  /** Best source's class, as judged by the research leg: official | industry | media | community. */
  source_class?: string
  /** The leg's confidence in the finding: high | medium | low. Words, not numbers, on purpose —
   *  a 1–5 scale reads as measured precision where there is only a judgement, and models cluster
   *  on 3–4; a word plus its reason is what the caller can actually weigh. */
  confidence?: string
  /** The few words behind the confidence ("three independent sources agree", "single forum post"). */
  confidence_note?: string
  /** True when at least one of `sources` is a page the search engine returned to the leg; false when
   *  none is — the leg opened them directly or wrote them from memory. Absent when the provider
   *  annotates nothing. */
  cited_by_search?: boolean
}

/** The hosts a leg names at the end of a media/community-only answer, pulled off the text. */
const AUTHORITATIVE_RE = /^\s*(?:[-*•]\s*)?authoritative[_ ]domains?\s*:\s*(.+?)\s*$/im

/**
 * Take the `authoritative_domains:` line out of a leg's answer. It carries no URL, so left in place
 * it would count as an unsourced statement and be dropped — silently losing the one thing the
 * upgrade pass needs. Returns the hosts (normalised) and the text without the line.
 */
export function splitAuthoritativeDomains(text: string): { domains: string[]; text: string } {
  const m = text.match(AUTHORITATIVE_RE)
  if (!m) return { domains: [], text }
  const domains = normalizeDomains(m[1].split(/[,;\s]+/), 5)
  return { domains, text: text.replace(m[0], '').trim() }
}

const URL_RE = /https?:\/\/[^\s)<>"']+/g

/** The judgement tag WEB_SYSTEM asks for: `[class, confidence: reason]` at the end of a finding. */
// Tolerant at the edges on purpose — the first evaluation run (z-ai/glm-5.3) wrote all 22 of
// its tags as full sentences: "[…, high: reason]." with a trailing period, and once "[official,
// high; reason]" with a semicolon before the reason. The strict version parsed none of them, so
// every finding came back "untagged" and the class-gated upgrade pass could never fire.
const TAG_RE =
  /\[\s*(official|industry|media|community)\s*[,;·|]\s*(high|medium|low)\s*(?:[:;,]\s*([^\]]{1,200}))?\]\s*[.,;:!]*\s*$/i

/**
 * Split the research answer into findings and pull the URLs out of each. Lines without a source are
 * dropped: the whole point of routing this through a sub-agent is that the parent gets a condensed
 * answer it can trust, and an unsourced claim in a condensed answer is indistinguishable from a
 * sourced one once the raw text is gone.
 */
export function parseFindings(
  text: string,
  sourcesRequired = true
): { findings: WebFinding[]; dropped: number } {
  const findings: WebFinding[] = []
  let dropped = 0
  for (const raw of text.split('\n')) {
    let line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()
    if (line.length < 12) continue
    // The judgement tag comes off the text and into fields — downstream readers (the provenance
    // log, a report chapter) want to weigh it, not to quote it. A missing tag is a missing tag:
    // the fields stay absent rather than being guessed here.
    const tag = line.match(TAG_RE)
    if (tag) line = line.slice(0, tag.index).trim()
    // Strip sentence punctuation BEFORE de-duplicating: "…/a." and "…/a" are the same source.
    const sources = [...new Set((line.match(URL_RE) ?? []).map((u) => u.replace(/[.,;)]+$/, '')))]
    if (!sources.length && sourcesRequired) {
      dropped++
      continue
    }
    findings.push({
      text: line,
      sources,
      ...(tag
        ? {
            source_class: tag[1].toLowerCase(),
            confidence: tag[2].toLowerCase(),
            ...(tag[3] ? { confidence_note: tag[3].trim() } : {})
          }
        : {})
    })
  }
  return { findings, dropped }
}

/** Classes that can carry a figure on their own; media/community only corroborate. */
const STRONG_CLASSES = new Set(['official', 'industry'])

/**
 * Whether a finished web leg has earned one upgrade pass: it found something, the model demonstrably
 * uses the judgement tag, and nothing it found is stronger than media/community. The tag requirement
 * is deliberate — an answer with no tags at all gives no signal to act on, and spending a paid leg on
 * "maybe the sources are weak" would fire on every model that simply does not tag (the upgrade is bounded and
 * class-gated, never free iteration).
 */
export function needsUpgradePass(findings: WebFinding[]): boolean {
  const judged = findings.filter((f) => f.source_class)
  if (!judged.length) return false
  return !judged.some((f) => STRONG_CLASSES.has(f.source_class as string))
}

export interface WebResult {
  question: string
  findings: WebFinding[]
  sources: string[]
  /** How many statements were discarded for having no source. */
  unsourced_dropped: number
  /** Pages the search engine cited that the findings point to, with excerpts when the engine
   *  supplied them. The engine's record of what was read, not the model's. */
  evidence: Evidence[]
  /** Hosts the leg itself named as where an official/manufacturer confirmation would live. The
   *  upgrade pass searched them; the parent can hand them to a follow-up call as `domains`. */
  suggested_domains?: string[]
  /** The host allow list the leg ran under, when the caller set one. */
  domains?: string[]
  note?: string
}

/**
 * Research an arbitrary question on the web in an isolated context and return sourced findings.
 *
 * Same shape as the BOM researcher (a sub-agent is just a tool whose implementation is another
 * loop), but without its mass-balance anchor — so the only guard against a confident invention is
 * the source requirement, which is enforced here rather than merely requested in the prompt.
 */
export async function researchWeb(opts: {
  question: string
  /** What the parent conversation knows and the sub-agent cannot see (product, region, year, scope). */
  context?: string
  /** Allow unsourced statements through (default false). */
  allowUnsourced?: boolean
  model?: string
  signal?: AbortSignal
  onCost?: CostSink
  /**
   * One line about what this leg is doing, for the parent's trace — the same courtesy `researchBom`
   * has had all along. Without it a call that fans four questions out in parallel showed nothing but
   * a ticking clock. Measured: one `research_web` ran 285 seconds while the BOM call
   * beside it was naming each component as it landed. The information was equally available here.
   */
  onProgress?: (note: string) => void
  /** Which leg of a parallel fan this is, 1-based, and how many there are. */
  index?: number
  total?: number
  /** Restrict the leg's web search to these hosts (bare domains), for a caller that knows where the
   *  answer lives. Unset = open web; the leg may still name hosts for its own upgrade pass. */
  domains?: string[]
}): Promise<WebResult> {
  const question =
    opts.question.trim() +
    (opts.context?.trim() ? `\n\nContext you cannot see otherwise: ${opts.context.trim()}` : '')
  const domains = normalizeDomains(opts.domains)
  const book = new CitationBook()
  let suggested: string[] = []
  // Parallel legs share one progress line and each overwrites the last, so without this you see
  // whichever leg spoke most recently and never how many are still out. Measured: four
  // legs reporting into one row, no way to tell "one left" from "three left".
  const leg = opts.total && opts.total > 1 ? `[${opts.index ?? 1}/${opts.total}] ` : ''
  const sourcesRequired = !opts.allowUnsourced
  /** The question, shortened for a trace line — the full text can be a paragraph. */
  const label =
    opts.question.trim().length > 60
      ? `${opts.question.trim().slice(0, 57)}…`
      : opts.question.trim() || 'the question'
  let findings: WebFinding[] = []
  let dropped = 0
  opts.onProgress?.(`${leg}researching ${label}`)
  // Two retry shapes, mirrored from the BOM legs: an answer with nothing sourced gets one stricter
  // pass on the full budget, a leg that runs out of TIME gets one shorter, narrower attempt. The
  // web legs had only the first; a timed-out leg was simply lost, and the parent re-asked the same
  // question in a fresh call, paying the minutes twice (measured — the pattern the BOM
  // researcher was cured of).
  let timedOut = false
  let fullTries = 0
  for (;;) {
    const q = timedOut
      ? `${question}\n\nBE BRIEF: the three most decisive findings only, one line each, every line ` +
        'ending with its source URL and the [class, confidence] tag. Do not survey — the ' +
        'best-sourced figures are enough.'
      : fullTries === 0
        ? question
        : `${question}\n\nEvery statement MUST end with its source URL in parentheses. Statements without one are useless here.`
    let text = ''
    try {
      text = await runResearch({
        question: q,
        system: WEB_SYSTEM,
        model: opts.model,
        signal: opts.signal,
        onCost: opts.onCost,
        budgetMs: timedOut ? RETRY_BUDGET_MS : undefined,
        domains: domains.length ? domains : undefined,
        onCitations: (c) => book.add(c)
      })
    } catch (e) {
      // Out of time or a dead connection — worth one narrow retry. A Stop from the user is not.
      if (!timedOut && !opts.signal?.aborted) {
        timedOut = true
        opts.onProgress?.(`${leg}${label}: ran out of time — retrying with a narrower question`)
        continue
      }
      throw e
    }
    if (text) {
      const split = splitAuthoritativeDomains(text)
      if (split.domains.length) suggested = split.domains
      const parsed = parseFindings(split.text, sourcesRequired)
      findings = parsed.findings
      dropped = parsed.dropped
      if (findings.length) break // another pass only makes sense when everything was unsourced
    }
    fullTries++
    if (fullTries >= 2) break
  }
  // One bounded upgrade pass: a leg whose entire
  // evidence base is media/community — blogs, retailer guides, forums — gets exactly one short,
  // targeted follow-up asking for an official/industry confirmation of what it found. Bounded on
  // purpose: not after a timeout (that budget is spent), not when unsourced answers were allowed
  // (no class to upgrade towards), never more than once — a research fan quietly became half a
  // run's bill, so free iteration is exactly what this must not be. Only findings of the strong
  // classes are taken from the pass; a "not found" is kept as the note it is, because
  // "no official source exists" is a finding about the question, not a failure of the leg.
  let upgradeNote: string | undefined
  if (
    findings.length &&
    !timedOut &&
    sourcesRequired &&
    !opts.signal?.aborted &&
    needsUpgradePass(findings)
  ) {
    // Where to look is the leg's own call: the hosts it named at the end of
    // its first pass become the search engine's allow list for this one — mechanically, so the
    // engine cannot hand back the same blogs the prompt asks it to ignore. A caller-set allow list
    // stays in force underneath. Nothing named = the open pass as before.
    const upgradeDomains = normalizeDomains([...domains, ...suggested])
    opts.onProgress?.(
      `${leg}${label}: only media/community sources — one pass for a stronger one` +
        (suggested.length ? ` on ${suggested.join(', ')}` : '')
    )
    const figures = findings
      .slice(0, 3)
      .map((f) => `- ${f.text.slice(0, 200)}`)
      .join('\n')
    try {
      const text = await runResearch({
        question:
          `${question}\n\nA first pass answered this from media/community sources only (blogs, ` +
          'retailer guides, forums). Find OFFICIAL or INDUSTRY confirmation for the decisive figures ' +
          'below — statistical offices, standards, EPDs, peer-reviewed studies, or manufacturer ' +
          'documents. Do not re-cite blogs or forums. If no such source exists, reply with the ' +
          'single line "not found" — that answer is useful, an invented authority is not.' +
          (upgradeDomains.length
            ? `\nThe search is restricted to these hosts: ${upgradeDomains.join(', ')}. If they do not hold it, "not found" is the answer.`
            : '') +
          `\n\nFigures to confirm:\n${figures}`,
        system: WEB_SYSTEM,
        model: opts.model,
        signal: opts.signal,
        onCost: opts.onCost,
        budgetMs: RETRY_BUDGET_MS,
        domains: upgradeDomains.length ? upgradeDomains : undefined,
        onCitations: (c) => book.add(c)
      })
      const seen = new Set(findings.map((f) => f.text))
      const upgrades = parseFindings(splitAuthoritativeDomains(text).text, true).findings.filter(
        (f) => f.source_class && STRONG_CLASSES.has(f.source_class) && !seen.has(f.text)
      )
      const where = upgradeDomains.length ? ` (searched on ${upgradeDomains.join(', ')})` : ''
      if (upgrades.length) {
        findings = findings.concat(upgrades)
        upgradeNote = `${upgrades.length} official/industry finding(s) came from an upgrade pass${where} after the first pass returned only media/community sources.`
      } else {
        upgradeNote = `All findings rest on media/community sources; one upgrade pass${where} found no official or industry source.`
      }
      opts.onProgress?.(
        `${leg}${label}: ${upgrades.length ? `+${upgrades.length} official/industry` : 'no stronger source found'}`
      )
    } catch {
      // The upgrade is a bonus on top of a finished answer — running out of time must not cost it.
      upgradeNote = 'All findings rest on media/community sources; an upgrade pass ran out of time.'
    }
  }
  opts.onProgress?.(
    findings.length
      ? `${leg}${label}: ${findings.length} finding${findings.length === 1 ? '' : 's'}`
      : `${leg}${label}: nothing sourced`
  )
  const sources = [...new Set(findings.flatMap((f) => f.sources))]
  // The engine's record against the model's (see BomItem.cited_by_search): marked, never dropped.
  if (book.size)
    for (const f of findings) if (f.sources.length) f.cited_by_search = f.sources.some((u) => book.has(u))
  const uncited = book.size ? findings.filter((f) => f.sources.length && !f.cited_by_search).length : 0
  return {
    question: opts.question,
    findings,
    sources,
    unsourced_dropped: dropped,
    evidence: book.evidenceFor(sources),
    ...(suggested.length ? { suggested_domains: suggested } : {}),
    ...(domains.length ? { domains } : {}),
    note:
      [
        findings.length
          ? dropped
            ? `${dropped} statement(s) were discarded for having no source.`
            : ''
          : 'The research produced nothing with a usable source — ask the user, or narrow the question.',
        upgradeNote ?? '',
        uncited
          ? `${uncited} finding${uncited === 1 ? '' : 's'} cite${uncited === 1 ? 's' : ''} only URLs the search engine did not return (cited_by_search: false) — opened directly or written from memory; verify before relying on them.`
          : ''
      ]
        .filter(Boolean)
        .join(' ') || undefined
  }
}

// --- critic -----------------------------------------------------------------

/** Model for the review pass. Reasoning about numbers matters more here than breadth of knowledge. */
/**
 * Default reviewer, same override. Being a DIFFERENT model from the chat is a feature rather than a
 * cost saving: in a live run the reviewer caught a wrong background dataset that
 * the model which had chosen it kept overlooking.
 */
export const REVIEW_MODEL = providerDefaults('openrouter').review

const REVIEW_SYSTEM = `You are a critical LCA reviewer. You are given a DOSSIER about one product
system — the structural health check, the biggest contributors, the goal & scope on record, and the
background datasets used. You cannot look anything up: judge only what is in the dossier.

Report what a reviewer would challenge, grouped as "Blocking", "Should fix" and "Worth a look".
Rules:
- Every finding must quote the concrete number, process or dataset name from the dossier that
  prompted it. No quote, no finding — say "cannot judge from this dossier" instead.
- **A claim about a quantity must show its arithmetic.** If you say a count, a mass or a total is
  wrong, list the exchange amounts you added and the sum you got. Without that, put it under "Worth
  a look" and ask the question instead of asserting the error. "Blocking" is reserved for findings
  whose evidence you can quote in full. A wrong Blocking finding is expensive: on the 2026-08-13
  practice run a reviewer double-counted an initial battery, declared the bill of materials
  inconsistent (16 cells where the model books 8, which the exchange amounts show plainly), and cost
  a round to disprove — while its one correct point about a dataset was dismissed along with it,
  because the reason it gave for that one was also checkable and also wrong.
- If the dossier states that datasets carrying the result were never opened, that is a measured fact
  and belongs in your findings: a proxy defended by its name alone is not defended. Say what reading
  each one could still change.
- Where the dossier quotes what a dataset says about itself, read the sentence against the product
  under study and quote it back when it does not fit: a dataset that names another product class —
  a NiMH battery "for laptop applications" inside a garden lamp, a wiring board "for desktop and
  laptop computer" behind a 5-gram driver — is a finding even when the dataset's NAME looks generic,
  and it is the kind the assistant misses precisely because the name looked right.
- Check specifically: does the modelled system match the stated system boundaries and functional
  unit; are the background datasets plausible proxies for what they stand in for (geography,
  technology, reference year); is the impact method the right variant for the stated goal; do
  treatment/waste processes carry the sign you would expect; is a single hotspot so dominant that
  the whole result hinges on one assumption.
- If the goal & scope is empty, say so first: without it nothing else can be assessed properly.
- Be terse. No praise, no restating the dossier, no closing summary.`

/**
 * Judge a prepared dossier: ONE model pass, no tools, no web search.
 *
 * Deliberately not an agent with its own read-only tools. The dossier is gathered deterministically
 * by the caller, which keeps the cost of a review fixed and predictable, makes it impossible for the
 * critic to touch anything, and means every finding is anchored to a figure we know we handed over.
 * The price is that it only sees what the caller collected.
 */
/** What became of a review pass. `empty` is a failure of the reviewer, not a clean bill of health. */
export type ReviewOutcome = 'ok' | 'empty' | 'error'

export interface ReviewResult {
  text: string
  outcome: ReviewOutcome
  /** Why the model stopped, when the provider said so — `stop`, `length`, `error`, … */
  finish_reason?: string
  /** Characters of reasoning it produced. High with empty text = it thought and wrote nothing. */
  reasoning_chars: number
  attempts: number
  ms: number
  /** Set when the stream itself failed. */
  error?: string
}

/**
 * Judge a prepared dossier: one model pass, no tools, no web search — and now, when that pass comes
 * back empty, a second one.
 *
 * A live picture-frame run is the reason for every field above. `review_model` ran for
 * **113.976 seconds** — the longest tool call of that run, longer than either web research — and
 * returned `"The reviewer returned nothing."`, 94 characters, with an empty `gaps` list saying the
 * dossier had been complete. The model read that as "no findings" and shipped a study whose headline
 * was wrong by a factor of two. Three things were missing and all three are here now:
 *
 *  - **A retry.** Every sibling had one: `researchWeb` takes two attempts, `researchBom` three since
 *    V69, and the main loop has caught empty completions since V66. The reviewer, alone, had none.
 *  - **A reason.** Nothing recorded `finish_reason` or how much reasoning was produced, so afterwards
 *    it was impossible to tell a model that thought and wrote nothing from one cut off at `length`.
 *    That question is now answerable while it happens rather than never.
 *  - **A distinguishable answer.** "Returned nothing" reads like a verdict. `outcome` says which it is.
 */
export async function reviewDossier(opts: {
  dossier: string
  model?: string
  signal?: AbortSignal
  onCost?: CostSink
}): Promise<ReviewResult> {
  const model = opts.model ?? providerDefaults(getActiveProvider()).review
  const startedAt = Date.now()
  let reasoningChars = 0
  let finishReason: string | undefined
  let lastError: string | undefined

  // The second attempt says the quiet part out loud. A reasoning model that spends its whole budget
  // thinking and emits no visible token is the failure being guarded against, so the nudge asks for
  // plain text and gives it a first line to write.
  const NUDGE =
    '\n\nYour previous answer contained no text at all. Answer in PLAIN TEXT, starting with the ' +
    'line "Blocking:" — if you have nothing to raise, write "Blocking: none" and then the ' +
    '"Should fix" and "Worth a look" sections. Do not answer with an empty message.'

  for (let attempt = 0; attempt < 2; attempt++) {
    const messages: ChatMessage[] = [
      { role: 'system', content: REVIEW_SYSTEM },
      { role: 'user', content: attempt === 0 ? opts.dossier : opts.dossier + NUDGE }
    ]
    let text = ''
    try {
      for await (const ev of streamChat({ model, messages, temperature: null, signal: opts.signal })) {
        if (ev.type === 'delta') text += ev.text
        else if (ev.type === 'reasoning') reasoningChars += ev.chars
        else if (ev.type === 'finish') finishReason = ev.reason
        else if (ev.type === 'usage') opts.onCost?.(model, costOf(ev.usage))
      }
    } catch (e) {
      // A stop from the user must end everything at once; anything else is worth one more try.
      if (opts.signal?.aborted) throw e
      lastError = e instanceof Error ? e.message : String(e)
      console.log(`[prism-ai] review_model: stream failed (${lastError}) on attempt ${attempt + 1}`)
      continue
    }
    const trimmed = text.trim()
    if (trimmed) {
      return {
        text: trimmed,
        outcome: 'ok',
        finish_reason: finishReason,
        reasoning_chars: reasoningChars,
        attempts: attempt + 1,
        ms: Date.now() - startedAt
      }
    }
    console.log(
      `[prism-ai] review_model: empty answer on attempt ${attempt + 1} after ` +
        `${Math.round((Date.now() - startedAt) / 1000)} s, ${Math.round(reasoningChars / 1000)}k characters of ` +
        `reasoning, finish_reason=${finishReason ?? 'none'}, dossier ${opts.dossier.length} chars`
    )
  }

  return {
    text: '',
    outcome: lastError ? 'error' : 'empty',
    finish_reason: finishReason,
    reasoning_chars: reasoningChars,
    attempts: 2,
    ms: Date.now() - startedAt,
    error: lastError
  }
}

export { AiProviderError }
