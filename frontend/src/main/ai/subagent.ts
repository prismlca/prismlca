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
import { CitationBook, isProviderLink, urlKey, type Evidence } from './citationBook'
import { AiProviderError, type ChatMessage, type Citation } from './providers/types'
import { providerDefaults } from './models'
import { getActiveProvider } from './providers/state'
import { collectText } from './stream'

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
export const RETRY_BUDGET_MS = 90_000

/** How long a leg's request may keep trying after the provider failed: below both budgets above. */
const LEG_RETRY = { busyMs: 60_000, offlineMs: 60_000 }

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
  /** The tool this leg works for, as its requests are named in the app log (requestLog.ts). */
  logAs: string
  /** Ceiling on the provider's web lookups inside one request of this leg (Settings → AI → Limits). */
  webLookups?: number
  /** Told when the budget ran out after the leg had written something. That text is still returned and
   *  read like a finished answer, but the leg's time is spent: no further pass on the same budget. */
  onTimeout?: () => void
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
    // (OpenRouter and Anthropic: web search + page fetch; Google: google_search + url_context; OpenAI:
    // the Responses API web_search).
    // Reasoning effort LOW: a research leg's job is retrieval, and the thinking dial is the budget
    // that actually runs out — GLM 5.3 defaults to effort "max" (per OpenRouter's model listing) and
    // spent an entire eval leg reasoning without writing a line.
    roundText = await collectText({
      model: legModel,
      messages,
      webSearch: true,
      webDomains: opts.domains,
      webLookupsCap: opts.webLookups,
      onCitations: opts.onCitations,
      reasoningEffort: 'low',
      signal,
      // Well inside the leg's own clock, so a provider that refuses or a network that is gone ends the
      // leg with that error, not with "ran past its budget" from a clock that fired in a pause.
      retry: LEG_RETRY,
      onCost: opts.onCost,
      logAs: opts.logAs
    })
    text = roundText.trim()
    // Without function tools there is nothing to feed back — one pass is the whole leg.
    if (text) break
  }
  // Out of time, not out of answers. Said as an error rather than returned as "" so the caller can tell
  // the user which of the two happened; a silent empty leg reads as "the web knows nothing about this".
  if (clock.signal.aborted && !text)
    throw new ResearchTimeout(
      `The research ran past its ${Math.round((opts.budgetMs ?? LEG_BUDGET_MS) / 60_000)}-minute budget and was stopped. ` +
        'Ask again with a narrower question, or supply the figures yourself.'
    )
  // Out of time WITH an answer: the partial text is kept and returned, and the caller is told the clock
  // ended it — otherwise a leg cut off mid-answer looks like one that finished with time to spare.
  if (clock.signal.aborted) opts.onTimeout?.()
  return text
}

/** A leg that ran past its wall-clock budget — the one failure the narrower retry is made for. */
export class ResearchTimeout extends Error {}

/**
 * Whether a failed leg is worth the one narrower retry. Not when the provider refused the key, the account
 * or the model: asking a smaller question fails the same way, and the retry only doubled the wait — with
 * expired keys, five legs reported "ran out of time" after 0 s and failed again.
 */
export function retryCanHelp(e: unknown): boolean {
  return !(e instanceof AiProviderError && ['auth', 'no_key', 'credits', 'no_endpoint'].includes(e.code))
}

/** What a failed leg's trace line says happened: out of time only when it was, else the error itself. */
export function legFailure(e: unknown): string {
  if (e instanceof ResearchTimeout) return 'ran out of time'
  const message = (e instanceof Error ? e.message : String(e)).trim().replace(/\.$/, '')
  return message.length > 90 ? `${message.slice(0, 87)}…` : message || 'the request failed'
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

/** Whether `host` is `domain` or one of its subdomains — how the providers' allow lists match. */
function isWithin(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

/**
 * The allow list for a pass that should search where a leg suggested, under the caller's own list. The
 * suggestion can only narrow a caller's list, never widen it: the hosts both admit (a suggested host on a
 * caller's domain, or a caller's host on a suggested domain), and the caller's list unchanged when they
 * share none. Without a caller's list the suggestion is the list.
 */
export function narrowDomains(caller: string[], suggested: string[]): string[] {
  if (!caller.length) return suggested
  const both = normalizeDomains([
    ...suggested.filter((s) => caller.some((c) => isWithin(s, c))),
    ...caller.filter((c) => suggested.some((s) => isWithin(c, s)))
  ])
  return both.length ? both : caller
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

/** Longest statement a figure carries into the upgrade pass. */
const FIGURE_CHARS = 400

/**
 * A finding as the upgrade pass is asked to confirm it: whole when it is short, otherwise its statement cut
 * and its sources after it in full. The URL is what tells the pass which source it is to replace, and it
 * stands at the end of the line, where a plain cut takes it off first.
 */
export function figureLine(f: WebFinding): string {
  if (f.text.length <= FIGURE_CHARS || !f.sources.length) return f.text.slice(0, FIGURE_CHARS)
  const statement = f.text
    .replace(URL_RE, '')
    .replace(/\([\s,;]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const cut = statement.length > FIGURE_CHARS ? `${statement.slice(0, FIGURE_CHARS).trimEnd()}…` : statement
  return `${cut} (${f.sources.join(', ')})`
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
  /** Ceiling on the provider's web lookups inside one request of this leg (Settings → AI → Limits). */
  webLookups?: number
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
        logAs: 'research_web',
        webLookups: opts.webLookups,
        question: q,
        system: WEB_SYSTEM,
        model: opts.model,
        signal: opts.signal,
        onCost: opts.onCost,
        budgetMs: timedOut ? RETRY_BUDGET_MS : undefined,
        domains: domains.length ? domains : undefined,
        onCitations: (c) => book.add(c),
        // Ran out of time with part of an answer: the budget is spent all the same, so what follows is
        // the short retry (when nothing usable came) and never the upgrade pass.
        onTimeout: () => (timedOut = true)
      })
    } catch (e) {
      // Out of time or a dead connection — worth one narrow retry. A Stop from the user is not, and neither
      // is a refused key or account: the trace names the error and the leg fails at once.
      if (!timedOut && !opts.signal?.aborted && retryCanHelp(e)) {
        timedOut = true
        opts.onProgress?.(`${leg}${label}: ${legFailure(e)} — retrying with a narrower question`)
        continue
      }
      if (!opts.signal?.aborted) opts.onProgress?.(`${leg}${label}: ${legFailure(e)}`)
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
    // engine cannot hand back the same blogs the prompt asks it to ignore. A caller's allow list is a
    // limit the suggestion may narrow but never widen. Nothing named and no caller's list = the open pass.
    const upgradeDomains = narrowDomains(domains, suggested)
    opts.onProgress?.(
      `${leg}${label}: only media/community sources — one pass for a stronger one` +
        (upgradeDomains.length ? ` on ${upgradeDomains.join(', ')}` : '')
    )
    const figures = findings
      .slice(0, 3)
      .map((f) => `- ${figureLine(f)}`)
      .join('\n')
    try {
      const text = await runResearch({
        logAs: 'research_web',
        webLookups: opts.webLookups,
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
      // A stronger source is a page the first pass did not cite: the same blog in other words, tagged
      // "industry" this time, is no upgrade. Pages are compared after the book resolved the provider's
      // links, and never by host — a manufacturer's PDF on the domain of its shop page is what was asked for.
      // A provider's link the book could not resolve is no page: it may lead to the very blog of the first
      // pass, so it cannot make a finding new.
      const page = (u: string): string | null => {
        const p = book.canonical(u)
        return isProviderLink(p) ? null : urlKey(p)
      }
      const cited = new Set(findings.flatMap((f) => f.sources.map(page)))
      const upgrades = parseFindings(splitAuthoritativeDomains(text).text, true).findings.filter(
        (f) =>
          f.source_class &&
          STRONG_CLASSES.has(f.source_class) &&
          f.sources.some((u) => {
            const key = page(u)
            return key !== null && !cited.has(key)
          })
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
    } catch (e) {
      // The upgrade is a bonus on top of a finished answer — its failure must not cost it, and the note says
      // why it failed rather than assuming the clock.
      upgradeNote = `All findings rest on media/community sources; an upgrade pass failed (${legFailure(e)}).`
    }
  }
  opts.onProgress?.(
    findings.length
      ? `${leg}${label}: ${findings.length} finding${findings.length === 1 ? '' : 's'}`
      : `${leg}${label}: nothing sourced`
  )
  // As for the BOM items: a provider's link becomes its page, and one that leads nowhere is no source.
  for (const f of findings)
    f.sources = f.sources.map((u) => book.canonical(u)).filter((u) => !(isProviderLink(u) && !book.has(u)))
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

export { AiProviderError }
