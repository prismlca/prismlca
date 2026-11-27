import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RESEARCH_WEB_LOOKUPS, clampResearchWebLookups } from '../../shared/aiDefaults'
import type { BomItem } from './bomAnswer'
import { researchBom, type BomResult } from './researchBom'
import { probeUrl, supportCheck, type SupportCheck, type UrlProbe } from './researchEval/citations'
import { REFERENCE_PRODUCTS, type ReferenceProduct } from './researchEval/reference'
import {
  accuracy,
  balanceJudged,
  bomIntegrity,
  carryingByMass,
  carryingFindings,
  carryingFromParts,
  citationGate,
  partValues,
  referenceGates,
  SKIPPED_FOR_BUDGET,
  summarise,
  type GateKind,
  type GateResult,
  type PartScore,
  type RunRecord,
  type WebRequest
} from './researchEval/score'
import { RESEARCH_MODEL, researchWeb, retryCanHelp, type WebFinding } from './subagent'

/**
 * LIVE evals for the research sub-agents — the instrument to run BEFORE switching the research model or the
 * lookup cap, not a CI resident. **Opt-in** — skipped unless PRISM_EVAL_LIVE=1, so `npm test` stays offline,
 * fast and free:
 *
 *     PRISM_EVAL_LIVE=1 npm run eval:research                                    # every scenario, the app's cap
 *     PRISM_EVAL_LIVE=1 PRISM_EVAL_ONLY=ref npm run eval:research                # the three reference products
 *     PRISM_EVAL_LIVE=1 PRISM_EVAL_ONLY=ref PRISM_EVAL_LOOKUPS=4,8 PRISM_EVAL_REPEAT=3 npm run eval:research
 *     PRISM_EVAL_LIVE=1 PRISM_EVAL_MODEL=z-ai/glm-5.3-flash npm run eval:research
 *
 * Switches:
 *   PRISM_EVAL_LOOKUPS      the lookup caps to compare (Settings → AI → Limits), comma-separated, clamped as the
 *                           app clamps them; default the app's default. Every scenario runs once per cap, and the
 *                           cap is saved with the run — the legs get it exactly as the app passes it (agent.ts).
 *   PRISM_EVAL_REPEAT       runs per scenario and cap (default 1). One run says what CAN happen; three are a
 *                           pilot that shows the spread, not proof of a regression.
 *   PRISM_EVAL_BUDGET_USD   the whole run's spend ceiling (default 6): no scenario starts once it is spent.
 *   PRISM_EVAL_RUN_USD      one run's ceiling (default 1): its research is stopped there, and the run is
 *                           reported as stopped, not scored.
 *   PRISM_EVAL_ONLY         scenario names (or parts of them), comma-separated.
 *   PRISM_EVAL_MODEL, PRISM_EVAL_JUDGE_MODEL   the research model and the citation judge.
 * The key comes from OPENROUTER_API_KEY, else the checkout's .secrets/openrouter-key. The keys stored in the app
 * cannot serve here: the app decrypts them only for itself.
 *
 * No backend and no Electron: the legs never touch the model, so this drives researchWeb / researchBom
 * directly. The scenarios, each probing a different failure surface:
 *
 *   - `ref-wheelbarrow`, `ref-shelf`, `ref-soap` — three real products (researchEval/reference.ts) with what is
 *     public about them kept apart from what is not: a published tub weight against a frame nobody publishes,
 *     two versions of a shelf (5-mm boards and 14.1 kg against 4-mm boards and 13 kg), a soap whose printed
 *     ingredient list is public and whose shares are not. The calls are those a user's chat made.
 *   - `web-eol-steel`   — a question that IS answerable from official sources (Destatis/UBA/Eurostat). A run
 *                         that comes back without one has regressed on source steering, whatever else it found.
 *   - `web-lifespan`    — a question that is NOT (no test institute covers folding gazebos). What matters
 *                         here is honest tagging and the figure check of its weak figures.
 *   - `web-domains-set` — the caller names the hosts; every source must sit on them.
 *   - `bom-pet-bottle`, `bom-enumerate`, `bom-hard-part` — known mass ranges, the enumerating leg, and a part
 *                         that is hard to put a mass on.
 *
 * How a run is scored (researchEval/score.ts): by gates — each met, missed, or not applicable to what came back
 * — and the result is each gate's hit rate per scenario and cap. Integrity gates fail the run: the code's own
 * promises (a figure names its page or says it has none, an open list stays unjudged, the hosts named are the
 * hosts searched, a requested part is never silently gone) and the floor that not every source is dead. Every
 * other gate is counted, not asserted: a live page moves, a model varies, and one miss among three runs is the
 * spread, not a verdict. The reference products add an accuracy weighted by the share of the climate result
 * each part carries. The citation judge reads the findings a result rests on — the parts that carry the most,
 * the findings with a figure — and its verdicts are a gate as well. Per run, too: cost, time and the provider's
 * lookups per request and tool (the cap holds for each tool on its own; OpenRouter reports searches only); a cap
 * that no request reaches cannot make a difference. A run whose research the provider refused (the key, the
 * account's limit, the model's routing) is reported, not scored, and fails; the runs after it do not start. So
 * is a run in which no request got a reply, without ending the series. Requests that failed beside others that
 * answered are listed with their run, which is scored as the app would have answered.
 *
 * A run takes minutes per scenario and costs cents to a few dimes in model and web-search fees. Everything lands
 * in frontend/.eval-out/research-last-run.json — every run, and the summary per scenario and cap.
 */

const LIVE = process.env.PRISM_EVAL_LIVE === '1'
const MODEL = process.env.PRISM_EVAL_MODEL || RESEARCH_MODEL
/** The judge only reads and compares — cheap, but it must read well. Override to taste. */
const JUDGE = process.env.PRISM_EVAL_JUDGE_MODEL || 'google/gemini-3.8-flash'
const ONLY = (process.env.PRISM_EVAL_ONLY?.toLowerCase() ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const REPO = join(__dirname, '..', '..', '..', '..')
const REPORT_DIR = join(REPO, 'frontend', '.eval-out')

/** The caps as Settings would store them, each once; the app's default when none is given. */
function lookupCaps(raw: string | undefined): number[] {
  const caps = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (!Number.isFinite(Number(s))) throw new Error(`PRISM_EVAL_LOOKUPS: "${s}" is not a number`)
      return clampResearchWebLookups(Number(s))
    })
  return caps.length ? [...new Set(caps)] : [DEFAULT_RESEARCH_WEB_LOOKUPS]
}

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const LOOKUPS = lookupCaps(process.env.PRISM_EVAL_LOOKUPS)
const REPEAT = Math.min(10, Math.round(positive(process.env.PRISM_EVAL_REPEAT, 1)))
const BUDGET_USD = positive(process.env.PRISM_EVAL_BUDGET_USD, 6)
const RUN_USD = positive(process.env.PRISM_EVAL_RUN_USD, 1)

/**
 * The provider's lookups per request, read off the usage report of every web-searching request while a run is
 * on, every request of the run's research that failed, and how many came to the end of their reply. Wrapped
 * around the real client, so the requests themselves are untouched. A usage report alone proves no reply: the
 * engine books a stream that failed after it began with an empty one, before the error.
 */
const tap = vi.hoisted(() => ({
  requests: null as Array<{ search: number; fetch: number }> | null,
  failures: null as unknown[] | null,
  answered: null as { n: number } | null
}))
vi.mock('./client', async (importOriginal) => {
  const real = await importOriginal<typeof import('./client')>()
  const { lookupsIn } = await import('./researchEval/score')
  return {
    ...real,
    streamChat: async function* (opts: Parameters<typeof real.streamChat>[0]) {
      try {
        for await (const ev of real.streamChat(opts)) {
          const booked = ev.type === 'usage' && Object.keys(ev.usage).length > 0
          if (booked && opts.webSearch && tap.requests)
            tap.requests.push(lookupsIn(ev.usage as Record<string, unknown>) ?? { search: 0, fetch: 0 })
          yield ev
        }
        if (tap.answered) tap.answered.n += 1
      } catch (e) {
        // A request we stopped ourselves (a ceiling, a leg's clock) is not the provider's failure.
        if (tap.failures && (e as { code?: unknown })?.code !== 'aborted' && !opts.signal?.aborted)
          tap.failures.push(e)
        throw e
      }
    }
  }
})

/**
 * The provider turned the request away for good — the key, the account's credit or limit, the model's routing —
 * rather than failing it on the way (a dropped connection, a rate limit, a server fault). Every later request of
 * the series would meet the same answer. The research's own rule for when a narrower retry cannot help, plus
 * the statuses a key or account limit answers with.
 */
const refusal = (e: unknown): boolean =>
  !retryCanHelp(e) || [401, 402, 403].includes(Number((e as { status?: unknown })?.status))
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Resolve the OpenRouter key the same way the app (and live-eval.test.ts) does. */
function ensureKey(): boolean {
  if (process.env.OPENROUTER_API_KEY?.trim()) return true
  const p = join(REPO, '.secrets', 'openrouter-key')
  if (existsSync(p)) {
    const v = readFileSync(p, 'utf-8').trim()
    if (v) {
      process.env.OPENROUTER_API_KEY = v
      return true
    }
  }
  return false
}

// --- One run --------------------------------------------------------------------------------------------------

/** What a scenario's run gets: the cap under test and the run's own stop and meter. */
interface Run {
  lookups: number
  signal: AbortSignal
  onCost: (model: string, u: { cost?: number }) => void
  onProgress: (note: string) => void
}

/** What a scenario hands back to be judged and recorded. */
interface Scored {
  gates: GateResult[]
  /** Every finding, for the tally of source classes. */
  findings: WebFinding[]
  /** The findings the result rests on: what the citation judge reads. */
  carrying: WebFinding[]
  sources: string[]
  accuracy?: { score: number; parts: PartScore[] }
  note?: string
  detail?: unknown
}

interface Scenario {
  name: string
  title: string
  run: (run: Run) => Promise<Scored>
}

interface RunRow extends RunRecord {
  requests: number
  findings?: number
  classes?: Record<string, number>
  probed?: number
  deadUrls?: string[]
  support?: SupportCheck[]
  accuracyParts?: PartScore[]
  note?: string
  detail?: unknown
  /** Requests of the research the provider failed on the way, the run scored all the same (as the app answers). */
  providerErrors?: string[]
}

const rows: RunRow[] = []
/** Research and judge, over every run so far. */
let spent = 0
/** Set once the provider refused the research: every later run would fail the same way, so none starts. */
let halted = ''

const gate = (kind: GateKind, id: string, label: string, ok: boolean | null): GateResult => ({
  id,
  kind,
  label,
  ok
})
const usd4 = (n: number): number => Number(n.toFixed(4))

/**
 * Probe every unique source once (capped), let the judge read the carrying findings, tally the classes. The judge's
 * spend goes into the budget as it is billed; once the budget is spent, the findings not yet read are marked so,
 * and the citation gate of that run is not scored. A carrying finding without any page is listed as such.
 */
async function assess(sc: Scored): Promise<{
  judgeUsd: number
  support: SupportCheck[]
  probes: UrlProbe[]
  classes: Record<string, number>
}> {
  let judgeUsd = 0
  const probes = await Promise.all(sc.sources.slice(0, 8).map(probeUrl))
  const support: SupportCheck[] = []
  for (const f of sc.carrying) {
    if (!f.sources[0]) support.push({ claim: f.text, url: '', verdict: 'no_source' })
    else if (spent >= BUDGET_USD)
      support.push({ claim: f.text, url: f.sources[0], verdict: SKIPPED_FOR_BUDGET })
    else
      support.push(
        await supportCheck(f.text, f.sources[0], JUDGE, (usd) => {
          judgeUsd += usd
          spent += usd
        })
      )
  }
  const classes: Record<string, number> = {}
  for (const f of sc.findings) {
    const k = f.source_class ?? 'untagged'
    classes[k] = (classes[k] ?? 0) + 1
  }
  return { judgeUsd, support, probes, classes }
}

async function execute(s: Scenario, lookups: number, repeat: number): Promise<void> {
  const label = `${s.name} · cap ${lookups}${REPEAT > 1 ? ` · run ${repeat}/${REPEAT}` : ''}`
  const startedAt = Date.now()
  const stop = new AbortController()
  const tally = { usd: 0, requests: 0 }
  let stopped = ''
  const onCost = (_m: string, u: { cost?: number }): void => {
    tally.usd += u.cost ?? 0
    tally.requests += 1
    if (stopped) return
    if (tally.usd >= RUN_USD) stopped = `stopped at the run ceiling ($${RUN_USD})`
    else if (spent + tally.usd >= BUDGET_USD) stopped = `stopped at the budget ($${BUDGET_USD})`
    if (stopped) stop.abort()
  }
  const webRequests: WebRequest[] = []
  const failures: unknown[] = []
  const answered = { n: 0 }
  tap.requests = webRequests
  tap.failures = failures
  tap.answered = answered
  let scored: Scored | undefined
  let failure: unknown
  try {
    scored = await s.run({
      lookups,
      signal: stop.signal,
      onCost,
      onProgress: (n) => console.log(`[research-eval]   ${n}`)
    })
  } catch (e) {
    failure = e
  } finally {
    tap.requests = null
    tap.failures = null
    tap.answered = null
  }
  spent += tally.usd
  const base = {
    scenario: s.name,
    lookups,
    repeat,
    usd: usd4(tally.usd),
    requests: tally.requests,
    webRequests
  }
  // A run cut short by our own ceiling, turned away by the provider, or without a single reply is neither a
  // pass nor a miss of any gate: reported, not scored. The research answers a failed request with honest
  // "research failed" parts, and scoring those would put the key's limit or the outage into the hit rates as
  // zeros. Only our own ceiling passes quietly; the rest fail the run, and a refusal ends the series.
  const refused = failures.find(refusal)
  const unanswered = !refused && failures.length > 0 && answered.n === 0
  if (stopped || refused || unanswered || !scored) {
    const error =
      stopped ||
      (refused
        ? `the provider refused: ${messageOf(refused)}`
        : unanswered
          ? `no request got a reply (${failures.length} failed): ${messageOf(failures[0])}`
          : `failed: ${messageOf(failure)}`)
    rows.push({ ...base, ms: Date.now() - startedAt, judgeUsd: 0, gates: [], error })
    console.log(`[research-eval] ${label}: ${error} after $${base.usd}`)
    if (refused) {
      halted = error
      throw new Error(`${error} — the runs after this one are skipped`)
    }
    if (unanswered) throw new Error(error)
    if (!stopped) throw failure
    return
  }
  const a = await assess(scored)
  const dead = a.probes.filter((p) => !p.alive).map((p) => p.url)
  const gates = [
    ...scored.gates,
    gate(
      'integrity',
      'alive',
      'not every probed source is dead',
      a.probes.length ? dead.length < a.probes.length : null
    ),
    citationGate(a.support.map((x) => x.verdict))
  ]
  const row: RunRow = {
    ...base,
    ms: Date.now() - startedAt,
    judgeUsd: usd4(a.judgeUsd),
    gates,
    ...(scored.accuracy ? { accuracy: scored.accuracy.score, accuracyParts: scored.accuracy.parts } : {}),
    findings: scored.findings.length,
    classes: a.classes,
    probed: a.probes.length,
    deadUrls: dead,
    support: a.support,
    note: scored.note,
    detail: scored.detail,
    ...(failures.length ? { providerErrors: failures.slice(0, 5).map(messageOf) } : {})
  }
  rows.push(row)
  const missed = gates.filter((g) => g.ok === false).map((g) => g.id)
  const judged = gates.filter((g) => g.ok !== null).length
  console.log(
    `[research-eval] ${label}: ` +
      (row.accuracy !== undefined ? `accuracy ${row.accuracy} · ` : '') +
      `gates ${judged - missed.length}/${judged} met${missed.length ? ` (missed: ${missed.join(', ')})` : ''} · ` +
      `${row.findings} finding(s), classes ${JSON.stringify(a.classes)}, ${dead.length}/${a.probes.length} probed URLs dead · ` +
      `support [${a.support.map((x) => x.verdict).join(', ') || 'none checked'}] · ` +
      `$${row.usd} in ${row.requests} request(s), lookups per tool and request ≤ ${Math.max(0, ...webRequests.map((w) => Math.max(w.search, w.fetch)))}, ` +
      `${Math.round(row.ms / 1000)} s` +
      (failures.length
        ? `\n                 ${failures.length} request(s) failed: ${messageOf(failures[0])}`
        : '') +
      (scored.note ? `\n                 note: ${scored.note}` : '')
  )
  const broken = gates
    .filter((g) => g.kind === 'integrity' && g.ok === false)
    .map((g) => `${g.id}: ${g.label}`)
  expect(broken, 'integrity gates missed').toEqual([])
}

// --- The scenarios --------------------------------------------------------------------------------------------

/** A BOM's entries as findings: for the source-class tally and, without a reference, for the judge. */
const asFindings = (items: BomItem[]): WebFinding[] =>
  items.map((i) => ({
    text: `${i.component} (${i.material}): ${i.mass_kg} kg`,
    sources: i.source_url ? [i.source_url] : [],
    ...(i.source_class ? { source_class: i.source_class } : {})
  }))

const bomDetail = (r: BomResult): Record<string, unknown> => ({
  summary: r.summary,
  items: r.items.map((i) => `${i.component}: ${i.mass_kg} kg (${i.confidence ?? '–'})`),
  unresolved: r.unresolved,
  sum_kg: r.sum_kg,
  balance_ok: r.balance_ok,
  totals_found: r.totals_found,
  total_used: r.total_used,
  versions: r.versions,
  follow_up: r.follow_up,
  coverage: r.coverage,
  evidence: r.evidence.length,
  cited_by_search: r.items.map((i) => i.cited_by_search)
})

function referenceScenario(p: ReferenceProduct): Scenario {
  return {
    name: p.name,
    title: p.title,
    run: async (run) => {
      const r = await researchBom({
        ...p.call,
        model: MODEL,
        webLookups: run.lookups,
        signal: run.signal,
        onCost: run.onCost,
        onProgress: run.onProgress
      })
      const values = partValues(p.parts, r)
      return {
        gates: referenceGates(p.gates, r, values),
        findings: asFindings(r.items),
        carrying: carryingFromParts(values, r),
        sources: r.sources,
        accuracy: accuracy(values),
        note: r.note,
        detail: {
          ...bomDetail(r),
          ...(r.recipe
            ? {
                recipe: {
                  formulation: r.recipe.formulation,
                  closes: r.recipe.closes,
                  lines: r.recipe.lines.map((l) => `${l.inci ?? l.name}: ${l.share_pct ?? '–'} %`),
                  missing_ingredients: r.recipe.missing_ingredients
                }
              }
            : {})
        }
      }
    }
  }
}

const PET_BOTTLE = '0.5 l PET single-use still water bottle (standard PCO 1881 neck), Germany'

const SCENARIOS: Scenario[] = [
  ...REFERENCE_PRODUCTS.map(referenceScenario),
  {
    name: 'web-eol-steel',
    title: 'answers an officially answerable question with an official source',
    run: async (run) => {
      const r = await researchWeb({
        question:
          'How is bulky-waste steel (e.g. discarded garden furniture frames) treated at end of life in ' +
          'Germany? Shares for material recycling vs energy recovery vs landfill, most recent statistics.',
        context:
          'Screening LCA, end-of-life modelling in Germany; official figures (Destatis, UBA, Eurostat) ' +
          'with their reference year preferred.',
        model: MODEL,
        webLookups: run.lookups,
        signal: run.signal,
        onCost: run.onCost,
        onProgress: run.onProgress
      })
      const all = r.findings.map((f) => f.text).join('\n')
      // The question IS answerable from official sources (Destatis, UBA, EEA). Coming back without a single
      // official/industry finding or known official domain is the regression this scenario exists to catch.
      const strong =
        r.findings.some((f) => f.source_class === 'official' || f.source_class === 'industry') ||
        r.sources.some((u) => /destatis|umweltbundesamt|eurostat|europa\.eu|bmuv/.test(u))
      return {
        gates: [
          gate('fact', 'findings', 'came back with findings', r.findings.length > 0),
          gate('fact', 'recycling-share', 'names a recycling figure', /recycl/i.test(all) && /\d/.test(all)),
          gate(
            'fact',
            'official-source',
            'an official or industry source for an officially answerable question',
            strong
          )
        ],
        findings: r.findings,
        carrying: carryingFindings(r.findings),
        sources: r.sources,
        note: r.note,
        detail: { evidence: r.evidence.length, cited_by_search: r.findings.map((f) => f.cited_by_search) }
      }
    }
  },
  {
    name: 'web-lifespan',
    title: 'tags honestly on a question with no official answer',
    run: async (run) => {
      const r = await researchWeb({
        question:
          'What is the typical service life in years of a budget 3x3 m pop-up folding gazebo ' +
          '(powder-coated steel frame, polyester roof) used occasionally as private sun protection?',
        context:
          'Cradle-to-grave screening LCA of a 79 € budget folding gazebo sold in Germany; the service ' +
          'life drives the annualised result.',
        model: MODEL,
        webLookups: run.lookups,
        signal: run.signal,
        onCost: run.onCost,
        onProgress: run.onProgress
      })
      const all = r.findings.map((f) => f.text).join('\n')
      return {
        // The class VALUES are the finding, not a gate: no test institute covers these, so media/community
        // plus a figure check that finds no stronger source is the honest outcome. That the tag is used at all
        // is the gate.
        gates: [
          gate('fact', 'findings', 'came back with findings', r.findings.length > 0),
          gate(
            'fact',
            'service-life',
            'names a service life in years or seasons',
            /\d/.test(all) && /year|jahr|season|saison/i.test(all)
          ),
          gate(
            'uncertainty',
            'classes-used',
            'findings carry a source class',
            r.findings.some((f) => f.source_class)
          )
        ],
        findings: r.findings,
        carrying: carryingFindings(r.findings),
        sources: r.sources,
        note: r.note,
        detail: {
          suggested_domains: r.suggested_domains,
          evidence: r.evidence.length,
          cited_by_search: r.findings.map((f) => f.cited_by_search),
          web_check: r.web_check
        }
      }
    }
  },
  // The caller names the hosts. Every source must then sit on them, and the engine's citations must arrive,
  // because this scenario runs on an engine that annotates (OpenRouter → Exa for the research default).
  {
    name: 'web-domains-set',
    title: 'keeps a caller-set domain list and comes back with engine citations',
    run: async (run) => {
      const r = await researchWeb({
        question:
          'How much municipal bulky waste (Sperrmüll) was collected in Germany in the most recent year ' +
          'with published statistics, in tonnes and kg per inhabitant?',
        context: 'Screening LCA; official statistics with their reference year.',
        domains: ['destatis.de', 'umweltbundesamt.de'],
        model: MODEL,
        webLookups: run.lookups,
        signal: run.signal,
        onCost: run.onCost,
        onProgress: run.onProgress
      })
      // The allow list is mechanical: a source off the list means the provider ignored it.
      const offList = r.sources.filter((u) => !/destatis\.de|umweltbundesamt\.de/.test(u))
      return {
        gates: [
          gate(
            'integrity',
            'allow-list',
            'the hosts named are the hosts searched, and every source sits on them',
            JSON.stringify(r.domains) === JSON.stringify(['destatis.de', 'umweltbundesamt.de']) &&
              !offList.length
          ),
          gate('fact', 'findings', 'came back with findings', r.findings.length > 0),
          gate(
            'consistency',
            'engine-citations',
            'the engine’s url_citation annotations arrived',
            r.evidence.length > 0
          )
        ],
        findings: r.findings,
        carrying: carryingFindings(r.findings),
        sources: r.sources,
        note: r.note,
        detail: {
          domains: r.domains,
          off_list: offList,
          evidence: r.evidence.length,
          excerpts: r.evidence.filter((e) => e.excerpt).length
        }
      }
    }
  },
  {
    name: 'bom-pet-bottle',
    title: 'finds the known masses of a PET bottle and keeps the balance',
    run: async (run) => {
      const r = await researchBom({
        product: PET_BOTTLE,
        context:
          'Retail bottled water sold in Germany (one-way deposit system); research the bottle body, ' +
          'the closure and the label.',
        totalMassKg: 0.022,
        components: ['bottle body', 'cap (PCO 1881 closure)', 'label'],
        model: MODEL,
        webLookups: run.lookups,
        signal: run.signal,
        onCost: run.onCost,
        onProgress: run.onProgress
      })
      // The ranges are wide on purpose — they catch an order-of-magnitude or unit slip, not a lightweighting
      // debate. Preforms for 0.5 l run ~12–28 g, PCO 1881 caps ~1–3 g.
      const body = r.items.find((i) => /body|bottle/i.test(i.component))
      const cap = r.items.find((i) => /cap|closure/i.test(i.component))
      return {
        gates: [
          ...bomIntegrity(r),
          gate('fact', 'masses', 'at least two parts with a mass', r.coverage.with_mass >= 2),
          gate(
            'fact',
            'all-sourced',
            'every figure names its page',
            r.items.every((i) => i.source_url && !i.unsourced)
          ),
          gate(
            'fact',
            'body',
            'a bottle body of 10–35 g',
            !!body && body.mass_kg >= 0.01 && body.mass_kg <= 0.035
          ),
          gate('fact', 'cap', 'a cap of 0.8–5 g', cap ? cap.mass_kg >= 0.0008 && cap.mass_kg <= 0.005 : null),
          gate('consistency', 'sum', 'the parts add up to 12–45 g', r.sum_kg >= 0.012 && r.sum_kg <= 0.045),
          balanceJudged(r)
        ],
        findings: asFindings(r.items),
        carrying: carryingByMass(r.items),
        sources: r.sources,
        note: r.note,
        detail: bomDetail(r)
      }
    }
  },
  // The enumerating leg must name the small parts and leave an unknown mass as null; the follow-up pass then
  // gets one short try per gap.
  {
    name: 'bom-enumerate',
    title: 'enumerates a product with its small parts, names what has no mass and follows up once',
    run: async (run) => {
      const r = await researchBom({
        product: PET_BOTTLE,
        context: 'Retail bottled water sold in Germany (one-way deposit system).',
        totalMassKg: 0.022,
        model: MODEL,
        webLookups: run.lookups,
        signal: run.signal,
        onCost: run.onCost,
        onProgress: run.onProgress
      })
      return {
        gates: [
          ...bomIntegrity(r),
          gate('fact', 'parts', 'came back with parts', r.items.length > 0),
          gate('fact', 'small-parts', 'names more than one part', r.items.length + r.unresolved.length > 1),
          balanceJudged(r)
        ],
        findings: asFindings(r.items),
        carrying: carryingByMass(r.items),
        sources: r.sources,
        note: r.note,
        detail: bomDetail(r)
      }
    }
  },
  // A part whose mass is genuinely hard to source: either the follow-up finds it (and says so) or it stays
  // named under `unresolved` — never silently gone, never 0.
  {
    name: 'bom-hard-part',
    title: 'names a component it cannot put a mass on instead of dropping or guessing it',
    run: async (run) => {
      const r = await researchBom({
        product: PET_BOTTLE,
        context: 'Retail bottled water sold in Germany (one-way deposit system).',
        totalMassKg: 0.022,
        components: ['bottle body', 'label adhesive (hot-melt)'],
        model: MODEL,
        webLookups: run.lookups,
        signal: run.signal,
        onCost: run.onCost,
        onProgress: run.onProgress
      })
      const adhesive = /adhesive|glue|hot-?melt/i
      return {
        gates: [
          ...bomIntegrity(r),
          // One of the two by construction: found with a source, or named as open — a leg that died is named
          // too, under its request.
          gate(
            'integrity',
            'named-not-dropped',
            'the adhesive is an entry or named as open',
            r.items.some((i) => adhesive.test(i.component)) ||
              r.unresolved.some((u) => adhesive.test(u.component))
          ),
          gate(
            'fact',
            'body',
            'a bottle-body entry came back',
            r.items.some((i) => /body|bottle/i.test(i.component))
          ),
          balanceJudged(r)
        ],
        findings: asFindings(r.items),
        carrying: carryingByMass(r.items),
        sources: r.sources,
        note: r.note,
        detail: bomDetail(r)
      }
    }
  }
]

const selected = (name: string): boolean => !ONLY.length || ONLY.some((o) => name.toLowerCase().includes(o))

describe.skipIf(!LIVE)('research evals', () => {
  it('has a key', () => {
    expect(ensureKey(), 'No OpenRouter key (env OPENROUTER_API_KEY or .secrets/openrouter-key).').toBe(true)
  })

  afterAll(() => {
    if (!rows.length) return
    const summary = summarise(rows)
    console.log(
      `\n[research-eval] model=${MODEL} judge=${JUDGE} caps ${LOOKUPS.join(', ')} × ${REPEAT} — ` +
        `${rows.length} run(s), $${spent.toFixed(4)} of the $${BUDGET_USD} budget`
    )
    for (const s of summary) {
      console.log(
        `[research-eval] ${s.scenario} · cap ${s.lookups}: ${s.runs} run(s)` +
          (s.errors ? `, ${s.errors} not scored` : '') +
          (s.accuracy ? `, accuracy ${s.accuracy.mean} (${s.accuracy.min}–${s.accuracy.max})` : '') +
          `, $${s.usdMean}/run, ${Math.round(s.msMedian / 1000)} s, lookups per tool and request ≤ ${s.lookupsMax}` +
          (s.lookups > 0 ? `, at the cap ${s.atCap.requests}/${s.atCap.of}` : '')
      )
      console.log(
        '                 ' +
          s.gates.map((g) => `${g.kind} ${g.id} ${g.of ? `${g.hits}/${g.of}` : 'n/a'}`).join(' · ')
      )
    }
    mkdirSync(REPORT_DIR, { recursive: true })
    const out = join(REPORT_DIR, 'research-last-run.json')
    writeFileSync(
      out,
      JSON.stringify(
        {
          model: MODEL,
          judge: JUDGE,
          lookups: LOOKUPS,
          repeat: REPEAT,
          budgetUsd: BUDGET_USD,
          spentUsd: usd4(spent),
          at: new Date().toISOString(),
          summary,
          runs: rows
        },
        null,
        2
      )
    )
    console.log(`[research-eval] detail written to ${out}`)
  })

  // Repeat outermost, the caps innermost: runs of the variants under comparison sit next to each other in time,
  // and a budget that runs out leaves every cap with nearly as many runs as the others, not one cap without any.
  for (let repeat = 1; repeat <= REPEAT; repeat++)
    for (const s of SCENARIOS.filter((x) => selected(x.name)))
      for (const cap of LOOKUPS)
        it(`${s.name} · cap ${cap}${REPEAT > 1 ? ` · run ${repeat}/${REPEAT}` : ''} — ${s.title}`, async (ctx) => {
          if (halted) ctx.skip(halted)
          if (spent >= BUDGET_USD) ctx.skip(`the budget of $${BUDGET_USD} is spent`)
          await execute(s, cap, repeat)
        }, 900_000)
})
