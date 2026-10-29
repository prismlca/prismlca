import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  RESEARCH_MODEL,
  extractJson,
  researchBom,
  researchWeb,
  type BomResult,
  type WebFinding
} from './subagent'
import { streamChat } from './client'
import type { ChatMessage } from './providers/types'

/**
 * LIVE evals for the research sub-agents — the gatekeeper to run BEFORE switching the research
 * model, not a CI resident. **Opt-in** — skipped
 * unless PRISM_EVAL_LIVE=1, so `npm test` stays offline, fast and free:
 *
 *     PRISM_EVAL_LIVE=1 npm run eval:research                          # all scenarios
 *     PRISM_EVAL_LIVE=1 PRISM_EVAL_ONLY=bom npm run eval:research
 *     PRISM_EVAL_LIVE=1 PRISM_EVAL_MODEL=z-ai/glm-5.3-flash npm run eval:research
 *
 * No backend and no Electron: the legs never touch the model, so this drives researchWeb /
 * researchBom directly. Three golden scenarios distilled from the practice runs, chosen so each
 * probes a different failure surface:
 *
 *   - `web-eol-steel`   — a question that IS answerable from official sources (Destatis/UBA/
 *                         Eurostat). A run that comes back without one has regressed on source
 *                         steering, whatever else it found.
 *   - `web-lifespan`    — a question that is NOT (no test institute covers folding gazebos; the
 *                         pavilion run measured that). What matters here is honest tagging and,
 *                         when everything is media/community, the upgrade pass saying so.
 *   - `bom-pet-bottle`  — masses with known target ranges and a mass balance to keep.
 *
 * What is measured, per the rubric the comparison section settled on: the citation LIVES (every
 * unique source URL is probed — bot walls count as alive, only 404/410/network-dead count as dead),
 * the citation CARRIES (a judge model reads the cited page for a sample of findings and says
 * whether it supports the claim), source classes, expected facts, and the cost of the fan. Judge
 * verdicts and the balance verdict are REPORTED rather than asserted — a live page moves, a judge
 * misreads, and a flaky hard failure would teach people to ignore the run; the asserts are the
 * floor (findings exist, expected facts present, key masses in range, not every source dead).
 *
 * Expect a run to take ~10–15 minutes (research legs are minutes each) and to cost a few cents
 * in model and web-search fees. Results land in frontend/.eval-out/research-last-run.json so two
 * models can be compared side by side.
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

interface UrlProbe {
  url: string
  alive: boolean
  status?: number
}

/**
 * Does the URL answer at all? 403/405/429 and friends count as ALIVE — a bot wall proves the server
 * and the path exist, which is all this probe can honestly claim. Dead is 404/410 or no answer.
 */
async function probeUrl(url: string): Promise<UrlProbe> {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(10_000) })
      if (res.status === 404 || res.status === 410) return { url, alive: false, status: res.status }
      // HEAD is often refused outright where GET works; only a 4xx/5xx on HEAD warrants the retry.
      if (method === 'HEAD' && res.status >= 400) continue
      return { url, alive: true, status: res.status }
    } catch {
      if (method === 'GET') return { url, alive: false }
    }
  }
  return { url, alive: false }
}

/** Fetch a cited page and reduce it to judgeable text. Best-effort — an unreadable page is a verdict. */
async function fetchPageText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    // A PDF (or image, or archive) read as text is byte noise, and on the first run the judge dutifully
    // ruled "not_on_page" against two claims whose cited PDF very likely carries them. Unreadable is
    // the honest verdict for anything this harness cannot actually read.
    const kind = res.headers.get('content-type') ?? ''
    if (kind && !/text|html|xml|json/i.test(kind)) return null
    const raw = await res.text()
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return text.length > 200 ? text.slice(0, 15_000) : null
  } catch {
    return null
  }
}

interface SupportCheck {
  claim: string
  url: string
  verdict: string
  quote?: string
}

/** Ask the judge whether the cited page actually carries the claim (the "trägt" axis). */
async function supportCheck(
  claim: string,
  url: string,
  onCost: (usd: number) => void
): Promise<SupportCheck> {
  const page = await fetchPageText(url)
  if (!page) return { claim, url, verdict: 'page_unreadable' }
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You verify citations. You are given a CLAIM from a research result and the TEXT of the web ' +
        'page it cites. Answer with JSON only: {"verdict": "supports" | "partly" | "contradicts" | ' +
        '"not_on_page", "quote": "<the shortest passage that decides it, or empty>"}. A page giving ' +
        'the same figure within rounding supports the claim; a page about something else entirely is ' +
        '"not_on_page".'
    },
    { role: 'user', content: `CLAIM: ${claim}\n\nPAGE TEXT (truncated): ${page}` }
  ]
  try {
    let text = ''
    for await (const ev of streamChat({ model: JUDGE, messages, temperature: null })) {
      if (ev.type === 'delta') text += ev.text
      else if (ev.type === 'usage') onCost(ev.usage.cost ?? 0)
    }
    const parsed = extractJson(text) as { verdict?: unknown; quote?: unknown }
    const verdict = String(parsed.verdict ?? '')
    if (!['supports', 'partly', 'contradicts', 'not_on_page'].includes(verdict))
      return { claim, url, verdict: 'judge_unparseable' }
    return { claim, url, verdict, ...(parsed.quote ? { quote: String(parsed.quote).slice(0, 300) } : {}) }
  } catch {
    return { claim, url, verdict: 'judge_failed' }
  }
}

interface Row {
  name: string
  ms: number
  usd: number
  requests: number
  judgeUsd: number
  findings: number
  classes: Record<string, number>
  deadUrls: string[]
  probed: number
  support: SupportCheck[]
  note?: string
  detail?: unknown
}
const report: Row[] = []

/** Probe every unique source once (capped), judge-check the first findings, tally the rest. */
async function assess(
  name: string,
  startedAt: number,
  tally: { usd: number; requests: number },
  findings: WebFinding[],
  sources: string[],
  note: string | undefined,
  detail?: unknown
): Promise<Row> {
  let judgeUsd = 0
  const probes = await Promise.all(sources.slice(0, 8).map(probeUrl))
  const support: SupportCheck[] = []
  for (const f of findings.slice(0, 2)) {
    if (f.sources[0]) support.push(await supportCheck(f.text, f.sources[0], (usd) => (judgeUsd += usd)))
  }
  const classes: Record<string, number> = {}
  for (const f of findings) {
    const k = f.source_class ?? 'untagged'
    classes[k] = (classes[k] ?? 0) + 1
  }
  const row: Row = {
    name,
    ms: Date.now() - startedAt,
    usd: Number(tally.usd.toFixed(4)),
    requests: tally.requests,
    judgeUsd: Number(judgeUsd.toFixed(4)),
    findings: findings.length,
    classes,
    deadUrls: probes.filter((p) => !p.alive).map((p) => p.url),
    probed: probes.length,
    support,
    note,
    detail
  }
  report.push(row)
  console.log(
    `[research-eval] ${name}: ${row.findings} finding(s), classes ${JSON.stringify(classes)}, ` +
      `${row.deadUrls.length}/${row.probed} probed URLs dead, ` +
      `support [${support.map((s) => s.verdict).join(', ') || 'none checked'}], ` +
      `$${row.usd} in ${row.requests} request(s), ${Math.round(row.ms / 1000)} s` +
      (note ? `\n                 note: ${note}` : '')
  )
  // The floor, not the rubric: sources so dead the whole answer is unverifiable is a hard failure.
  if (row.probed > 0) expect(row.deadUrls.length, 'every probed source URL is dead').toBeLessThan(row.probed)
  return row
}

const meterFor = (): {
  tally: { usd: number; requests: number }
  onCost: (m: string, u: { cost?: number }) => void
} => {
  const tally = { usd: 0, requests: 0 }
  return {
    tally,
    onCost: (_m, u) => {
      tally.usd += u.cost ?? 0
      tally.requests += 1
    }
  }
}

const skip = (name: string): boolean => ONLY.length > 0 && !ONLY.some((o) => name.toLowerCase().includes(o))

describe.skipIf(!LIVE)('research evals', () => {
  it('has a key', () => {
    expect(ensureKey(), 'No OpenRouter key (env OPENROUTER_API_KEY or .secrets/openrouter-key).').toBe(true)
  })

  afterAll(() => {
    if (!report.length) return
    const usd = report.reduce((s, r) => s + r.usd + r.judgeUsd, 0)
    console.log(
      `\n[research-eval] model=${MODEL} judge=${JUDGE} — ${report.length} scenario(s), $${usd.toFixed(4)}`
    )
    mkdirSync(REPORT_DIR, { recursive: true })
    const out = join(REPORT_DIR, 'research-last-run.json')
    writeFileSync(
      out,
      JSON.stringify({ model: MODEL, judge: JUDGE, at: new Date().toISOString(), scenarios: report }, null, 2)
    )
    console.log(`[research-eval] detail written to ${out}`)
  })

  it.skipIf(skip('web-eol-steel'))(
    'answers an officially answerable question with an official source',
    async () => {
      const startedAt = Date.now()
      const { tally, onCost } = meterFor()
      const r = await researchWeb({
        question:
          'How is bulky-waste steel (e.g. discarded garden furniture frames) treated at end of life in ' +
          'Germany? Shares for material recycling vs energy recovery vs landfill, most recent statistics.',
        context:
          'Screening LCA, end-of-life modelling in Germany; official figures (Destatis, UBA, Eurostat) ' +
          'with their reference year preferred.',
        model: MODEL,
        onCost,
        onProgress: (n) => console.log(`[research-eval]   ${n}`)
      })
      await assess('web-eol-steel', startedAt, tally, r.findings, r.sources, r.note, {
        evidence: r.evidence.length,
        cited_by_search: r.findings.map((f) => f.cited_by_search)
      })
      expect(r.findings.length).toBeGreaterThan(0)
      const all = r.findings.map((f) => f.text).join('\n')
      expect(all).toMatch(/recycl/i)
      expect(all).toMatch(/\d/)
      // The question IS answerable from official sources — the pavilion run proved it (Destatis, UBA,
      // EEA). Coming back without a single official/industry finding or known official domain is the
      // regression this scenario exists to catch.
      const strong =
        r.findings.some((f) => f.source_class === 'official' || f.source_class === 'industry') ||
        r.sources.some((u) => /destatis|umweltbundesamt|eurostat|europa\.eu|bmuv/.test(u))
      expect(strong, 'no official/industry source for an officially answerable question').toBe(true)
    },
    900_000
  )

  it.skipIf(skip('web-lifespan'))(
    'tags honestly on a question with no official answer',
    async () => {
      const startedAt = Date.now()
      const { tally, onCost } = meterFor()
      const r = await researchWeb({
        question:
          'What is the typical service life in years of a budget 3x3 m pop-up folding gazebo ' +
          '(powder-coated steel frame, polyester roof) used occasionally as private sun protection?',
        context:
          'Cradle-to-grave screening LCA of a 79 € budget folding gazebo sold in Germany; the service ' +
          'life drives the annualised result.',
        model: MODEL,
        onCost,
        onProgress: (n) => console.log(`[research-eval]   ${n}`)
      })
      await assess('web-lifespan', startedAt, tally, r.findings, r.sources, r.note, {
        suggested_domains: r.suggested_domains,
        evidence: r.evidence.length,
        cited_by_search: r.findings.map((f) => f.cited_by_search)
      })
      expect(r.findings.length).toBeGreaterThan(0)
      const all = r.findings.map((f) => f.text).join('\n')
      expect(all).toMatch(/\d/)
      expect(all).toMatch(/year|jahr|season|saison/i)
      // The tagging itself must work — the class VALUES are the finding, not the assertion: no test
      // institute covers these, so media/community plus an upgrade-pass note is the honest outcome.
      expect(
        r.findings.some((f) => f.source_class),
        'no finding carries a source_class — the judgement tag is not being used'
      ).toBe(true)
    },
    900_000
  )

  it.skipIf(skip('bom-pet-bottle'))(
    'finds the known masses of a PET bottle and keeps the balance',
    async () => {
      const startedAt = Date.now()
      const { tally, onCost } = meterFor()
      const r: BomResult = await researchBom({
        product: '0.5 l PET single-use still water bottle (standard PCO 1881 neck), Germany',
        context:
          'Retail bottled water sold in Germany (one-way deposit system); research the bottle body, ' +
          'the closure and the label.',
        totalMassKg: 0.022,
        components: ['bottle body', 'cap (PCO 1881 closure)', 'label'],
        model: MODEL,
        onCost,
        onProgress: (n) => console.log(`[research-eval]   ${n}`)
      })
      const findings: WebFinding[] = r.items.map((i) => ({
        text: `${i.component} (${i.material}): ${i.mass_kg} kg`,
        sources: i.source_url ? [i.source_url] : [],
        ...(i.source_class ? { source_class: i.source_class } : {})
      }))
      await assess('bom-pet-bottle', startedAt, tally, findings, r.sources, r.note, {
        sum_kg: r.sum_kg,
        sum_range_kg: r.sum_range_kg,
        balance_ok: r.balance_ok,
        coverage: r.coverage,
        unresolved: r.unresolved,
        follow_up: r.follow_up,
        evidence: r.evidence.length,
        cited_by_search: r.items.map((i) => i.cited_by_search)
      })
      expect(r.coverage?.researched ?? 0).toBeGreaterThanOrEqual(2)
      for (const i of r.items) expect(i.source_url, `${i.component} has no source`).toBeTruthy()
      // The target ranges are wide on purpose — they catch an order-of-magnitude or unit slip, not
      // a lightweighting debate. Preforms for 0.5 l run ~12–28 g, PCO 1881 caps ~1–3 g.
      const body = r.items.find((i) => /body|bottle/i.test(i.component))
      expect(body, 'no bottle-body item came back').toBeDefined()
      expect(body!.mass_kg).toBeGreaterThanOrEqual(0.01)
      expect(body!.mass_kg).toBeLessThanOrEqual(0.035)
      const cap = r.items.find((i) => /cap|closure/i.test(i.component))
      if (cap) {
        expect(cap.mass_kg).toBeGreaterThanOrEqual(0.0008)
        expect(cap.mass_kg).toBeLessThanOrEqual(0.005)
      }
      expect(r.sum_kg).toBeGreaterThanOrEqual(0.012)
      expect(r.sum_kg).toBeLessThanOrEqual(0.045)
    },
    900_000
  )

  // --- Domains named by the caller, engine citations, evidence from the engine -------------------

  // The caller names the hosts. Every source must then sit on them, and the
  // engine's citations must arrive, because this scenario runs on an engine that
  // annotates (OpenRouter → Exa for the research default, native for the big vendors).
  it.skipIf(skip('web-domains-set'))(
    'keeps a caller-set domain list and comes back with engine citations',
    async () => {
      const startedAt = Date.now()
      const { tally, onCost } = meterFor()
      const r = await researchWeb({
        question:
          'How much municipal bulky waste (Sperrmüll) was collected in Germany in the most recent year ' +
          'with published statistics, in tonnes and kg per inhabitant?',
        context: 'Screening LCA; official statistics with their reference year.',
        domains: ['destatis.de', 'umweltbundesamt.de'],
        model: MODEL,
        onCost,
        onProgress: (n) => console.log(`[research-eval]   ${n}`)
      })
      await assess('web-domains-set', startedAt, tally, r.findings, r.sources, r.note, {
        domains: r.domains,
        evidence: r.evidence.length,
        cited_by_search: r.findings.map((f) => f.cited_by_search),
        excerpts: r.evidence.filter((e) => e.excerpt).length
      })
      expect(r.domains).toEqual(['destatis.de', 'umweltbundesamt.de'])
      // The allow list is mechanical: a source off the list means the provider ignored it.
      const offList = r.sources.filter((u) => !/destatis\.de|umweltbundesamt\.de/.test(u))
      expect(offList, `sources outside the allow list: ${offList.join(', ')}`).toEqual([])
      expect(r.findings.length).toBeGreaterThan(0)
      // Proposal 1: the engine's own record of what it returned.
      expect(
        r.evidence.length,
        'no url_citation annotations arrived — the provider does not annotate on this route'
      ).toBeGreaterThan(0)
    },
    900_000
  )

  // Proposal 4: the enumerating leg must name the small parts and leave an unknown mass as null; the
  // follow-up pass then gets one short try per gap. What matters is REPORTED: unresolved parts,
  // the follow-up tally, and that no zero-mass ghost survives.
  it.skipIf(skip('bom-enumerate'))(
    'enumerates a product with its small parts, names what has no mass and follows up once',
    async () => {
      const startedAt = Date.now()
      const { tally, onCost } = meterFor()
      const r: BomResult = await researchBom({
        product: '0.5 l PET single-use still water bottle (standard PCO 1881 neck), Germany',
        context: 'Retail bottled water sold in Germany (one-way deposit system).',
        totalMassKg: 0.022,
        model: MODEL,
        onCost,
        onProgress: (n) => console.log(`[research-eval]   ${n}`)
      })
      const findings: WebFinding[] = r.items.map((i) => ({
        text: `${i.component} (${i.material}): ${i.mass_kg} kg`,
        sources: i.source_url ? [i.source_url] : [],
        ...(i.source_class ? { source_class: i.source_class } : {})
      }))
      await assess('bom-enumerate', startedAt, tally, findings, r.sources, r.note, {
        items: r.items.map((i) => `${i.component}: ${i.mass_kg}`),
        unresolved: r.unresolved,
        follow_up: r.follow_up,
        balance_ok: r.balance_ok,
        sum_kg: r.sum_kg,
        evidence: r.evidence.length,
        cited_by_search: r.items.map((i) => i.cited_by_search)
      })
      expect(r.items.length).toBeGreaterThan(0)
      for (const i of r.items) expect(i.mass_kg, `${i.component} is a zero-mass ghost`).toBeGreaterThan(0)
      // A list with open parts must not pass as balanced.
      if (r.unresolved.length) expect(r.balance_ok).toBeNull()
    },
    900_000
  )

  // Proposal 4 on a named gap: a part whose mass is genuinely hard to source. Either the follow-up
  // finds it (and says so) or it stays named under `unresolved` — never silently gone, never 0.
  it.skipIf(skip('bom-hard-part'))(
    'names a component it cannot put a mass on instead of dropping or guessing it',
    async () => {
      const startedAt = Date.now()
      const { tally, onCost } = meterFor()
      const r: BomResult = await researchBom({
        product: '0.5 l PET single-use still water bottle (standard PCO 1881 neck), Germany',
        context: 'Retail bottled water sold in Germany (one-way deposit system).',
        totalMassKg: 0.022,
        components: ['bottle body', 'label adhesive (hot-melt)'],
        model: MODEL,
        onCost,
        onProgress: (n) => console.log(`[research-eval]   ${n}`)
      })
      const findings: WebFinding[] = r.items.map((i) => ({
        text: `${i.component} (${i.material}): ${i.mass_kg} kg`,
        sources: i.source_url ? [i.source_url] : [],
        ...(i.source_class ? { source_class: i.source_class } : {})
      }))
      await assess('bom-hard-part', startedAt, tally, findings, r.sources, r.note, {
        items: r.items.map((i) => `${i.component}: ${i.mass_kg}`),
        unresolved: r.unresolved,
        follow_up: r.follow_up,
        coverage: r.coverage,
        balance_ok: r.balance_ok
      })
      const body = r.items.find((i) => /body|bottle/i.test(i.component))
      expect(body, 'no bottle-body item came back').toBeDefined()
      for (const i of r.items) expect(i.mass_kg).toBeGreaterThan(0)
      const adhesive = r.items.find((i) => /adhesive|glue|hot-?melt/i.test(i.component))
      const open = r.unresolved.find((u) => /adhesive|glue|hot-?melt/i.test(u.component))
      // One of the two, by construction: found with a source, or named as open. Lost (neither)
      // is the pre-08.10 behaviour this scenario exists to catch — unless the leg itself died.
      expect(
        !!adhesive || !!open || (r.coverage?.researched ?? 0) < 2,
        'the adhesive vanished: neither an item nor an unresolved entry'
      ).toBe(true)
    },
    900_000
  )
})
