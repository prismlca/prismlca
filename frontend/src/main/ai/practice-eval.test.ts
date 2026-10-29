import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it, vi } from 'vitest'

/**
 * LIVE practice runs for the two tools that reach outside the app — `distances` (openrouteservice,
 * searoute) and `eurostat_eol` — driven through the real agent against the real backend. **Opt-in**,
 * like live-eval.test.ts: skipped unless PRISM_EVAL_LIVE=1.
 *
 *     PRISM_EVAL_LIVE=1 npx vitest run src/main/ai/practice-eval.test.ts
 *     PRISM_EVAL_LIVE=1 PRISM_EVAL_ONLY=d2,e3 PRISM_EVAL_MODEL=z-ai/glm-5.3 npx vitest run …
 *
 * Grown out of an early scratchpad script, the scenarios are the ones that found V315–V326, kept so a later
 * model or a later version of the
 * tools can be measured against the same tasks. Unlike live-eval, nothing here ASSERTS on the model's
 * behaviour — a practice run is read, not passed: every scenario writes its trace, the tool results
 * and the answer to `.eval-out/practice-<timestamp>.json`, and the findings are written by a person.
 *
 * Needs: an OpenRouter key (env or .secrets/openrouter-key), an openrouteservice key (env ORS_API_KEY
 * or .secrets/ors-key), ecoinvent in the active project. Works inside the ACTIVE project but only
 * ever creates its own `zz-practice-<ts>` foreground model — which it KEEPS, so the result can be
 * inspected in the app. Delete it from the Overview when done.
 */

const LIVE = process.env.PRISM_EVAL_LIVE === '1'
// Was the :free MiniMax endpoint, which cost nothing. That promotion ended and the endpoint
// now serves no provider at all, so the default moved to the paid sibling — the
// same weights and the same model card, at $0.30/$1.20 per 1M. This whole file is opt-in and
// bills either way; what changed is that it no longer bills zero.
const MODEL = process.env.PRISM_EVAL_MODEL || 'minimax/minimax-m3'
const ONLY = (process.env.PRISM_EVAL_ONLY?.toLowerCase() ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const REPO = join(__dirname, '..', '..', '..', '..')
const REPORT_DIR = join(REPO, 'frontend', '.eval-out')

// The distance ledger and the geocoder cache live behind Electron's userData; here they get a
// throwaway directory so a practice run never books into the app's own ledger.
const userData = mkdtempSync(join(tmpdir(), 'prism-practice-'))
vi.mock('electron', () => ({ app: { getPath: () => userData, getAppPath: () => userData } }))

interface Backend {
  host: string
  port: number
  token: string
}
let backend: Backend | null = null
let child: ChildProcess | null = null
let scratchDb = ''

interface Row {
  name: string
  prompt: string
  text: string
  tools: string[]
  trace: string[]
  errors: string[]
  asks: number
  promptTokens: number
  cached: number
  ms: number
  notices: string[]
  /** The raw answers of the two tools under test, so a wrong figure can be traced to its source. */
  results: string[]
}
const rows: Row[] = []

function secret(envVar: string, file: string): string | null {
  const env = process.env[envVar]?.trim()
  if (env) return env
  const p = join(REPO, '.secrets', file)
  return existsSync(p) ? readFileSync(p, 'utf-8').trim() || null : null
}

function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    if (!backend) return reject(new Error('backend not ready'))
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      {
        host: backend.host,
        port: backend.port,
        path,
        method,
        headers: {
          'X-Prism-Token': backend.token,
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {})
        }
      },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null })
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw })
          }
        })
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function get<T>(path: string): Promise<T> {
  const r = await api('GET', path)
  if (r.status >= 400) throw new Error(`GET ${path} → ${r.status}: ${JSON.stringify(r.body)}`)
  return r.body as T
}

function startBackend(): Promise<Backend> {
  return new Promise((resolve, reject) => {
    child = spawn('uv', ['run', 'prism-lca-backend'], {
      cwd: join(REPO, 'backend'),
      env: { ...process.env, PYTHONUTF8: '1', PRISM_PARENT_PID: String(process.pid) }
    })
    let buf = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('{')) continue
        try {
          const msg = JSON.parse(line)
          if (msg.event === 'prism-backend-ready')
            resolve({ host: msg.host, port: msg.port, token: msg.token })
        } catch {
          /* not the handshake line */
        }
      }
    })
    child.on('error', reject)
    setTimeout(() => reject(new Error('backend did not report readiness within 180 s')), 180_000)
  })
}

/** The handshake precedes uvicorn's "startup complete": poll health until the socket answers. */
async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await api('GET', '/api/v1/system/health')).status === 200) return
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('backend never answered /health')
}

const skip = (name: string): boolean => ONLY.length > 0 && !ONLY.some((o) => name.toLowerCase().startsWith(o))

/** The scenarios, in the order they were first run. `${db}` is the scratch model. */
const SCENARIOS: Array<{ key: string; prompt: (db: string) => string }> = [
  // ---- transport distances ----------------------------------------------------------------
  {
    key: 't1-road',
    prompt: (db) =>
      `In the model "${db}", create a process "Steel plate delivered" (unit: kg, 1 kg of steel plate at the Heidelberg plant). The plate is hot-rolled steel bought as a 12 t lot from Salzgitter (Germany) and trucked to Heidelberg. Add two inputs to the process, both from ecoinvent: the steel itself (market for hot rolled steel, low-alloyed, or the closest match) per kg, and the road transport for that steel in tonne-kilometres — look the distance up, and write in the process comment where the figure comes from, including any adjustment. Report the km you used.`
  },
  {
    key: 't2-sea-rail',
    prompt: (db) =>
      `In the model "${db}", create a process "Cotton delivered to Prague" (unit: kg). 1 kg of raw cotton is shipped by container ship from Mumbai (India) to Hamburg, and then goes by rail from Hamburg to Prague. The study assumes the ship sails around the Cape of Good Hope, not through Suez. Add the two transport exchanges from ecoinvent (sea: transport, freight, sea, container ship; rail: transport, freight train) in tkm for 1 kg, plus the cotton itself (market for cotton fibre or closest). Record in the process comment how each distance was obtained. Report the two km figures and what you told the user about the rail figure.`
  },
  {
    key: 't3-air',
    prompt: (db) =>
      `In the model "${db}", create a process "Sensor module delivered by air" (unit: unit). One module weighs 0.2 kg and is flown as air freight from Shenzhen (China) to Frankfurt. Add the air freight exchange from ecoinvent (transport, freight, aircraft, long haul or closest) in tkm for one module, and put the distance and its source into the process comment. Report the km.`
  },
  {
    key: 't4-given',
    prompt: (db) =>
      `In the model "${db}", create a process "Pallets delivered" (unit: unit). The supplier ships one pallet (0.5 t) by road from Rotterdam to Hamburg and has told us the trip is 520 km. Add the road transport exchange from ecoinvent (lorry 16-32 t, EURO6 or closest) in tkm for one pallet. Keep it short.`
  },
  {
    key: 'd1-coffee-truck-ship-truck',
    prompt: (db) =>
      `In the model "${db}", create a process "Green coffee at roaster" (unit: kg). 1 kg of green coffee is trucked from a farm near Varginha (Minas Gerais, Brazil) to the port of Santos, shipped by container ship from Santos to Hamburg, and trucked from the port of Hamburg to a roaster in Bremen. Book the three transport legs as ecoinvent exchanges in tkm for 1 kg (lorry for road, container ship for sea) plus the coffee itself (market for coffee, green bean or closest). Look every distance up, document distance, source and any adjustment per leg in the process comment, run the model health check, and report the three km figures.`
  },
  {
    key: 'd2-chair-vietnam-cape',
    prompt: (db) =>
      `In the model "${db}", create a process "Wooden chair delivered" (unit: unit). One chair weighs 6.5 kg. It is trucked from a factory in Binh Duong (Vietnam) to Cat Lai port in Ho Chi Minh City, shipped by container ship to Rotterdam, and trucked from Rotterdam to a warehouse in Cologne. The study assumes the ship goes around the Cape of Good Hope; also tell me what the Suez routing would be so I can make it a scenario later. Book the three legs from ecoinvent in tkm per chair (mind the chair's mass in tonnes), add the chair material as "market for sawnwood, hardwood" or closest at 6.5 kg, document sources and assumptions in the comment, and report the km per leg.`
  },
  {
    key: 'd3-olive-oil-short-sea',
    prompt: (db) =>
      `In the model "${db}", create a process "Olive oil bottle delivered" (unit: unit). One bottle holds 1 L of olive oil, 0.92 kg of oil plus a 0.4 kg glass bottle. It is trucked from a mill near Jaén (Spain) to the port of Valencia, shipped by short-sea container service from Valencia to Rotterdam, and trucked from Rotterdam to Utrecht. Book the three transport legs from ecoinvent in tkm for one bottle (total mass 1.32 kg), plus the oil (market for olive oil or closest) and the glass (packaging glass, white or closest). Look the distances up, document them with sources, run the health check, and report the km per leg and the tkm you booked.`
  },
  {
    key: 'd4-steel-rail-road',
    prompt: (db) =>
      `In the model "${db}", create a process "Steel beam at site" (unit: kg). 1 kg of structural steel goes by rail from Salzgitter (Germany) to Vienna and then by truck from Vienna to a building site in Graz. Book the two transport legs from ecoinvent (freight train, lorry) in tkm for 1 kg, plus the steel (market for steel, low-alloyed, hot rolled or closest). Look the distances up; tell the user plainly what the rail figure is and is not, document per leg in the comment, and report the km.`
  },
  {
    key: 'd5-electronics-air-road',
    prompt: (db) =>
      `In the model "${db}", create a process "Controller board delivered" (unit: unit). One board weighs 0.35 kg and is flown as air freight from Taipei (Taiwan) to Frankfurt, then trucked from Frankfurt Airport to Stuttgart. Book the two legs from ecoinvent (aircraft long haul, lorry) in tkm for one board, plus the board itself as "market for printed wiring board, surface mounted" or closest at 0.35 kg. Look the distances up, note the adjustments applied, and report the km and tkm per leg.`
  },
  // ---- Eurostat end of life -------------------------------------------------------------
  {
    key: 'e1-eol-plastic-de',
    prompt: (db) =>
      `For a study on plastic packaging sold in Germany, I need the end-of-life split: which shares go to recycling, energy recovery / incineration and landfill? Use official Eurostat statistics for Germany, latest available year, and set the result up in the model "${db}" as three parameters (eol_recycling, eol_incineration, eol_landfill) that sum to 1, each with a comment naming the Eurostat table, year and any data flags. Report the shares and the source.`
  },
  {
    key: 'e2-eol-glass-eu',
    prompt: () =>
      `Compare the recycling rate of glass packaging in Italy, France and Poland (latest Eurostat year) and tell me which one to use for an EU-average scenario and why. Numbers with their year and flags, no model changes.`
  },
  {
    key: 'e3-pet-de-structure',
    prompt: (db) =>
      `In the model "${db}", model the end of life of a PET bottle sold in Germany. Create a process "PET bottle, end of life" (unit: kg, 1 kg of PET bottle waste). Derive the end-of-life split (recycling / energy recovery or incineration / landfill) from official Eurostat statistics for Germany, latest year, and set it up as three parameters (eol_recycling, eol_incineration, eol_landfill) whose values sum to 1, each with a comment naming the Eurostat table, waste code, year and any flags. Then add one ecoinvent end-of-life exchange per route with a formula "1 * eol_x" (treatment of waste polyethylene terephthalate / recycling / incineration / landfill datasets, closest matches), mind ecoinvent's sign convention for treatment activities, run the model health check and fix what it reports. Report the shares, the source and the datasets.`
  },
  {
    key: 'e4-glass-eu-scenarios',
    prompt: (db) =>
      `In the model "${db}", I model glass packaging for a product sold across the EU. Set up the recycling rate of glass packaging as a parameter "glass_recycling_rate" with the EU-27 aggregate from Eurostat (latest year) as the baseline value, and create two scenarios, "Italy" and "Poland", that override it with the national rates. Fetch all three figures in as few tool calls as possible, quote year and flags for each, and tell me whether France's rate could serve as a scenario too. No exchanges needed.`
  },
  {
    key: 'e5-plastic-de-trend',
    prompt: (db) =>
      `Using Eurostat, give me the recycling rate of plastic packaging in Germany for every year from 2016 to 2022 and set up a scenario "trend" in the model "${db}" that overrides a parameter "eol_recycling" (create it with the latest value if it does not exist) with the 2016 value. Point out any break in the series and what caused it. Numbers with years and flags.`
  },
  {
    key: 'e6-wood-packaging-fr',
    prompt: () =>
      `How is wooden packaging treated at end of life in France according to Eurostat? I need the recycling share for a wooden crate sold in France. Give the figure with table, year and flags, and explain in one sentence why the general "wood waste" statistics would be the wrong table for this. No model changes.`
  },
  {
    key: 'e7-municipal-malta',
    prompt: () =>
      `What is the municipal waste treatment mix in Malta according to Eurostat (latest year): shares to landfill, incineration, recycling and composting? Where Eurostat has no value, say so explicitly rather than assuming zero. No model changes.`
  },
  {
    key: 'e8-textiles-europe',
    prompt: () =>
      `For a T-shirt sold on the European market I need the end-of-life treatment split of textile waste from Eurostat: recycling, energy recovery, landfill, other. Give the EU figures with table, year and flags, and say what the figures do and do not cover. No model changes.`
  },
  {
    key: 'e9-user-given-split',
    prompt: (db) =>
      `Our take-back system for the product in the model "${db}" achieves 92 % recycling and 8 % incineration — please create the two end-of-life parameters eol_recycling and eol_incineration with these values and a comment stating the source. Keep it short.`
  },
  {
    key: 'e10-usa-not-eurostat',
    prompt: () =>
      `Give me the end-of-life split for plastic packaging in the USA from Eurostat, latest year, as three shares. No model changes.`
  }
]

describe.skipIf(!LIVE)('practice runs (distances, eurostat_eol)', () => {
  let runAgent: typeof import('./agent').runAgent
  let computeDistances: typeof import('../distance/service').computeDistances
  let TurnBudget: typeof import('../distance/types').TurnBudget
  let queryEurostatEol: typeof import('../eurostat/service').queryEurostatEol
  let DEFAULT_TRANSPORT: typeof import('../../shared/distanceDefaults').DEFAULT_TRANSPORT
  let orsKey: string | null = null

  beforeAll(async () => {
    const orKey = secret('OPENROUTER_API_KEY', 'openrouter-key')
    if (!orKey) throw new Error('No OpenRouter key (env OPENROUTER_API_KEY or .secrets/openrouter-key).')
    process.env.OPENROUTER_API_KEY = orKey // getApiKey() returns early on env, so no Electron needed
    orsKey = secret('ORS_API_KEY', 'ors-key')
    if (!orsKey) console.warn('[practice] no openrouteservice key — the distances tool will be off')
    backend = await startBackend()
    await waitHealthy()
    ;({ runAgent } = await import('./agent'))
    ;({ computeDistances } = await import('../distance/service'))
    ;({ TurnBudget } = await import('../distance/types'))
    ;({ queryEurostatEol } = await import('../eurostat/service'))
    ;({ DEFAULT_TRANSPORT } = await import('../../shared/distanceDefaults'))
    const dbs = await get<Array<{ name: string; read_only: boolean; kind: string }>>('/api/v1/databases')
    if (!dbs.some((d) => d.read_only && d.kind === 'background'))
      throw new Error('The active project has no ecoinvent background — import one before a practice run.')
    scratchDb = `zz-practice-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`
    const made = await api('POST', '/api/v1/databases/foreground', { name: scratchDb })
    if (made.status >= 400) throw new Error(`could not create scratch model: ${JSON.stringify(made.body)}`)
    console.log(`[practice] model=${MODEL} scratch=${scratchDb} (kept for inspection)`)
  }, 240_000)

  afterAll(() => {
    if (rows.length) {
      mkdirSync(REPORT_DIR, { recursive: true })
      const out = join(
        REPORT_DIR,
        `practice-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
      )
      writeFileSync(out, JSON.stringify({ model: MODEL, scratchDb, rows }, null, 2))
      const calls = rows.reduce((s, r) => s + r.tools.length, 0)
      const errors = rows.reduce((s, r) => s + r.errors.length, 0)
      console.log(
        `\n[practice] ${rows.length} scenario(s), ${calls} call(s), ${errors} error(s) — detail in ${out}`
      )
    }
    child?.kill()
  }, 60_000)

  for (const sc of SCENARIOS) {
    it.skipIf(skip(sc.key))(
      sc.key,
      async () => {
        const tools: string[] = []
        const trace: string[] = []
        const errors: string[] = []
        const notices: string[] = []
        const results: string[] = []
        let asks = 0
        let promptTokens = 0
        let cached = 0
        const t0 = Date.now()
        const turn = new TurnBudget(DEFAULT_TRANSPORT.perTurnCalls)
        const keys = { ors: orsKey, mapbox: null }
        const res = await runAgent(
          {
            chatId: `practice-${sc.key}`,
            model: MODEL,
            activeDb: scratchDb,
            history: [],
            userText: sc.prompt(scratchDb),
            maxRounds: 30,
            maxCostUsd: 1,
            distancesAvailable: !!orsKey,
            eurostatAvailable: true,
            signal: new AbortController().signal
          },
          {
            apiRaw: api,
            // Headless: the first option of every question — read `asks` before blaming the model.
            callUiTool: async (tool: string, args: Record<string, unknown>) => {
              if (tool === 'ask_user') {
                asks++
                const qs = (args.questions as
                  | Array<{ options?: Array<{ label: string } | string> }>
                  | undefined) ?? [{ options: args.options as Array<{ label: string } | string> | undefined }]
                // One array per question — canvas.ts reads a flat list as ONE question's answer (V360).
                const answers = qs.map((q) => {
                  const o = q.options?.[0]
                  return [typeof o === 'string' ? o : (o?.label ?? 'Yes')]
                })
                trace.push(`ask_user → answered ${JSON.stringify(answers)}`)
                return { answers }
              }
              if (tool === 'approve_tool') return { approved: true } // the eval user allows every card
              return { ok: true }
            },
            emit: (ev) => {
              if (ev.type === 'tool' && ev.phase === 'start') {
                tools.push(ev.name)
                trace.push(`${ev.name}(${ev.args ?? ''})`)
              }
              if (ev.type === 'tool' && ev.phase === 'error') errors.push(`${ev.name}: ${ev.detail ?? ''}`)
              if (ev.type === 'tool' && ev.phase === 'done') {
                if (ev.soft) errors.push(`${ev.name}: rejected — ${ev.soft}`)
                if (ev.notice) notices.push(ev.notice)
                if (ev.name === 'distances' || ev.name === 'eurostat_eol')
                  results.push(`${ev.name} → ${(ev.preview ?? '').slice(0, 4000)}`)
              }
              if (ev.type === 'error') errors.push(`request failed: ${ev.message}`)
              if (ev.type === 'done') {
                promptTokens = ev.promptTokens ?? 0
                cached = ev.cachedTokens ?? 0
              }
            },
            getSkills: async () =>
              (await get<{ skills: unknown[] }>('/api/v1/ai/skills?enabled=true')).skills as never[],
            distances: orsKey
              ? (mode, pairs) =>
                  computeDistances(mode, pairs, { settings: DEFAULT_TRANSPORT, keys, turn, backend: api })
              : undefined,
            eurostat: (args) => queryEurostatEol(args)
          }
        )
        rows.push({
          name: sc.key,
          prompt: sc.prompt(scratchDb),
          text: res.text,
          tools,
          trace,
          errors,
          asks,
          promptTokens,
          cached,
          ms: Date.now() - t0,
          notices,
          results
        })
        console.log(
          `[practice] ${sc.key}: ${tools.length} call(s), ${errors.length} error(s), ${Math.round((Date.now() - t0) / 1000)} s, ` +
            `${promptTokens} prompt tokens — ${tools.join(', ')}`
        )
      },
      900_000
    )
  }
})
