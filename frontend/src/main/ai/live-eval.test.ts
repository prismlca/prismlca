import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * LIVE end-to-end evals against a real model. **Opt-in** — skipped unless PRISM_EVAL_LIVE=1, so
 * `npm test` (and the CI pipeline, which has no secrets) stays offline, fast and free:
 *
 *     PRISM_EVAL_LIVE=1 npm run eval:live                     # all scenarios
 *     PRISM_EVAL_LIVE=1 PRISM_EVAL_ONLY=parameter npm run eval:live
 *     PRISM_EVAL_LIVE=1 PRISM_EVAL_MODEL=google/gemini-3.8-flash npm run eval:live
 *     PRISM_EVAL_LIVE=1 PRISM_EVAL_MODEL=z-ai/glm-5.3 npm run eval:live   # the stress case
 *
 * It boots the real Python backend (same handshake as Electron does), works inside the ACTIVE
 * project but only ever creates and deletes its own `zz-eval-<ts>` foreground model, and drives
 * `runAgent` directly — no window, no Electron. Deterministic tests for the loop itself live in
 * loop.test.ts; this one measures whether a real model actually picks the right tools.
 *
 * Most scenarios are deliberately tiny (≲5 tool calls) to keep token spend low; two are larger
 * end-to-end builds.
 *
 * CAVEAT on ask_user: headless, the stub below answers every question with its FIRST option. That is
 * as arbitrary as any other fixed rule, and it has already cost a model a scenario — MiniMax M3 asked
 * whether to reuse an existing tag group, was answered "reuse", and therefore never created the one
 * the task named. Asking was correct behaviour. So `asks` is reported per scenario: when a run fails
 * and asks > 0, suspect the stub before blaming the model.
 *
 * Default model is **Hunyuan Hy3**: a sweep of all built-in models over the same scenarios showed it
 * solving all of them for ~$0.01 — the cheapest of
 * the eight that got them right. Two worth overriding to on purpose: an `anthropic/*` model is the
 * only kind that exercises the explicit `cache_control` path, and GLM 5.3 is the known stress case
 * (46 calls, 14 rejections for the same three tasks).
 */

const LIVE = process.env.PRISM_EVAL_LIVE === '1'
const MODEL = process.env.PRISM_EVAL_MODEL || 'deepseek/deepseek-v4.1-flash'
/**
 * Allow logging providers for this run only (`PRISM_EVAL_ALLOW_DATA_COLLECTION=1`).
 *
 * Zero data retention is on by default and is what makes a free endpoint answer
 * "No endpoints found matching your data policy". Some models cannot be evaluated at all without
 * lifting it, so the harness offers an explicit, loud opt-out rather than a quietly different default —
 * and it prints a warning, because an eval prompt is a real LCA model.
 */
const ALLOW_DATA_COLLECTION = process.env.PRISM_EVAL_ALLOW_DATA_COLLECTION === '1'
/** Comma-separated substrings, so a re-run can target exactly the scenarios that failed. */
const ONLY = (process.env.PRISM_EVAL_ONLY?.toLowerCase() ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const REPO = join(__dirname, '..', '..', '..', '..') // frontend/src/main/ai → repo root

interface Backend {
  host: string
  port: number
  token: string
}
let backend: Backend | null = null
let child: ChildProcess | null = null
let scratchDb = ''
/** Project-scoped names the evals create must be unique per run and removed afterwards. */
let tagGroup = ''
let runAgent: typeof import('./agent').runAgent
/** Metrics Anthropic's tool-evaluation guidance asks for: accuracy, tool calls, tokens, errors. */
interface Row {
  name: string
  calls: number
  errors: number
  cost: number
  cached: number
  prompt: number
  tools: string[]
  trace: string[] // every call with its arguments, in order
  asks: number // ask_user round-trips the stub answered blind (see the caveat at the top)
  errorDetail: string[]
  chars: number // length of the model's answer — 0 means it never wrote prose (a finding in itself)
}
const report: Row[] = []
/** Vitest only surfaces console output of FAILING tests, so the per-scenario detail — which is
 *  exactly what you need to diagnose a bad tool call — goes to a file as well. */
const REPORT_DIR = join(REPO, 'frontend', '.eval-out')

/** Resolve the OpenRouter key the same way the app does, then hand it to the agent via env. */
function ensureKey(): boolean {
  if (process.env.OPENROUTER_API_KEY?.trim()) return true
  const p = join(REPO, '.secrets', 'openrouter-key')
  if (existsSync(p)) {
    const v = readFileSync(p, 'utf-8').trim()
    if (v) {
      process.env.OPENROUTER_API_KEY = v // getApiKey() returns early on env, so no Electron needed
      return true
    }
  }
  return false
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

/** Start the bundled-from-source backend and wait for its stdout handshake. */
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
    setTimeout(() => reject(new Error('backend did not report readiness within 120 s')), 120_000)
  })
}

/** Run one chat turn through the real agent and report what it did. */
async function turn(
  name: string,
  userText: string,
  opts: { maxRounds?: number } = {}
): Promise<{ text: string; tools: string[]; cost: number; errors: string[] }> {
  const tools: string[] = []
  const trace: string[] = []
  let asks = 0
  const errors: string[] = []
  let cost = 0
  let cached = 0
  let prompt = 0
  const res = await runAgent(
    {
      chatId: `eval-${name}`,
      model: MODEL,
      activeDb: scratchDb,
      history: [],
      userText,
      maxRounds: opts.maxRounds ?? 12,
      maxCostUsd: 0.5, // per-scenario circuit breaker so a confused model cannot burn budget
      signal: new AbortController().signal
    },
    {
      apiRaw: api,
      // Headless: answer any confirmation with the first option and acknowledge UI actions.
      callUiTool: async (tool: string, args: Record<string, unknown>) => {
        if (tool === 'ask_user') {
          asks++
          const first = (args.options as Array<{ label: string }> | undefined)?.[0]?.label ?? 'Yes'
          return { answers: [first] }
        }
        if (tool === 'approve_tool') return { approved: true } // the eval user allows every card
        return { ok: true }
      },
      emit: (ev) => {
        if (ev.type === 'tool' && ev.phase === 'start') {
          tools.push(ev.name)
          trace.push(`${ev.name}(${ev.args ?? ''})`) // the full call log is what makes a repeat loop readable
        }
        // Both kinds of rejection count: a thrown error and a returned `{"error": …}` tell the model
        // the same thing, and either one repeated is the cheapest signal that a schema confuses it.
        if (ev.type === 'tool' && ev.phase === 'error')
          errors.push(`${ev.name}(${ev.args ?? ''}): ${ev.detail ?? ''}`)
        if (ev.type === 'tool' && ev.phase === 'done' && ev.soft)
          errors.push(`${ev.name}: rejected — ${ev.soft}`)
        // A failed request emits 'error' and nothing else. Without capturing it, a model that never
        // got a reply is indistinguishable from one that chose to do nothing ("0 calls, $0.00").
        if (ev.type === 'error') errors.push(`request failed${ev.code ? ` [${ev.code}]` : ''}: ${ev.message}`)
        if (ev.type === 'done') {
          if (typeof ev.cost === 'number') cost = ev.cost
          if (typeof ev.promptTokens === 'number') prompt = ev.promptTokens
          if (typeof ev.cachedTokens === 'number') cached = ev.cachedTokens
        }
      },
      getSkills: async () =>
        (await get<{ skills: unknown[] }>('/api/v1/ai/skills?enabled=true')).skills as never[]
    }
  )
  report.push({
    name,
    calls: tools.length,
    errors: errors.length,
    cost,
    cached,
    prompt,
    tools,
    trace,
    asks,
    errorDetail: errors,
    chars: res.text.length
  })
  const cachePct = prompt ? Math.round((cached / prompt) * 100) : 0
  console.log(
    `[eval] ${name}: ${tools.length} call(s), ${errors.length} error(s), $${cost.toFixed(4)}, ` +
      `${prompt} prompt tokens (${cachePct}% cached) — ${tools.join(', ')}` +
      (errors.length ? `\n        errors: ${errors.join(' | ')}` : '')
  )
  return { text: res.text, tools, cost, errors }
}

const skip = (name: string): boolean => ONLY.length > 0 && !ONLY.some((o) => name.toLowerCase().includes(o))

describe.skipIf(!LIVE)('live evals', () => {
  beforeAll(async () => {
    if (!ensureKey())
      throw new Error('No OpenRouter key (env OPENROUTER_API_KEY or .secrets/openrouter-key).')
    backend = await startBackend()
    ;({ runAgent } = await import('./agent'))
    if (ALLOW_DATA_COLLECTION) {
      const { setZeroDataRetention } = await import('./providers/openrouter')
      setZeroDataRetention(false)
      console.warn(
        '[eval] zero data retention DISABLED for this run (PRISM_EVAL_ALLOW_DATA_COLLECTION=1) — ' +
          'providers may log these prompts. It applies to this process only; the app keeps its own setting.'
      )
    }

    const dbs = await get<Array<{ name: string; read_only: boolean; kind: string }>>('/api/v1/databases')
    if (!dbs.some((d) => d.read_only && d.kind === 'background')) {
      throw new Error(
        'The active project has no ecoinvent background — import one before running live evals.'
      )
    }
    scratchDb = `zz-eval-${Date.now()}`
    tagGroup = `zz-eval phase ${Date.now()}`
    const made = await api('POST', '/api/v1/databases/foreground', { name: scratchDb })
    if (made.status >= 400) throw new Error(`could not create scratch model: ${JSON.stringify(made.body)}`)
    console.log(`[eval] model=${MODEL} scratch=${scratchDb}`)
  }, 180_000)

  afterAll(async () => {
    if (backend && scratchDb)
      await api('POST', '/api/v1/databases/foreground/delete', { database: scratchDb })
    // Tag groups live in the project, so they outlive the scratch model and have to go explicitly.
    if (backend && tagGroup) await api('POST', '/api/v1/model/tag-groups/delete', { name: tagGroup })
    if (report.length) {
      const sum = (f: (r: Row) => number): number => report.reduce((s, r) => s + f(r), 0)
      const prompt = sum((r) => r.prompt)
      console.log(
        `\n[eval] ${report.length} scenario(s) — ${sum((r) => r.calls)} tool call(s), ` +
          `${sum((r) => r.errors)} error(s), $${sum((r) => r.cost).toFixed(4)}, ` +
          `${prompt} prompt tokens (${prompt ? Math.round((sum((r) => r.cached) / prompt) * 100) : 0}% cached)`
      )
      for (const r of report) {
        console.log(`       ${r.name.padEnd(14)} calls=${r.calls} err=${r.errors} $${r.cost.toFixed(4)}`)
      }
      mkdirSync(REPORT_DIR, { recursive: true })
      const out = join(REPORT_DIR, 'last-run.json')
      writeFileSync(out, JSON.stringify({ model: MODEL, scratchDb, scenarios: report }, null, 2))
      console.log(`[eval] per-scenario detail written to ${out}`)
    }
    child?.kill()
  }, 60_000)

  // ---- small scenarios (≲5 tool calls each) ------------------------------
  it.skipIf(skip('models'))(
    'lists the models in the project',
    async () => {
      const r = await turn(
        'models',
        'Which models and background databases does this project have? Keep it to one sentence.'
      )
      expect(r.tools).toContain('list_models')
      expect(r.text.length).toBeGreaterThan(10)
    },
    240_000
  )

  it.skipIf(skip('process'))(
    'creates a process on request',
    async () => {
      const r = await turn(
        'process',
        `Create a process called "eval widget" with unit kg in the model ${scratchDb}. Nothing else.`
      )
      expect(r.tools).toContain('create_process')
      const acts = await get<Array<{ name: string }>>(
        `/api/v1/model/activities/${encodeURIComponent(scratchDb)}`
      )
      expect(acts.some((a) => a.name.toLowerCase().includes('widget'))).toBe(true)
    },
    240_000
  )

  it.skipIf(skip('parameter'))(
    'adds a parameter',
    async () => {
      const r = await turn(
        'parameter',
        'Add a parameter named mass with value 2.5 and unit kg to this model. Nothing else.'
      )
      expect(r.tools).toContain('edit_parameter')
      const params = await get<Array<{ name: string; amount: number | null }>>(
        `/api/v1/params?database=${encodeURIComponent(scratchDb)}`
      )
      expect(params.find((p) => p.name === 'mass')?.amount).toBeCloseTo(2.5, 5)
    },
    240_000
  )

  it.skipIf(skip('scenario'))(
    'creates a scenario that overrides a parameter',
    async () => {
      const r = await turn(
        'scenario',
        'Create a scenario called "high mass" that overrides mass with 5. Nothing else.'
      )
      expect(r.tools).toContain('edit_scenario')
      const scen = await get<Array<{ name: string; overrides: Record<string, number> }>>(
        `/api/v1/scenarios?database=${encodeURIComponent(scratchDb)}`
      )
      const made = scen.find((s) => s.name.toLowerCase().includes('high'))
      expect(made?.overrides.mass).toBeCloseTo(5, 5)
    },
    240_000
  )

  it.skipIf(skip('factors'))(
    'looks up a characterization factor',
    async () => {
      const r = await turn(
        'factors',
        'Pick a climate-change indicator with list_methods, then tell me its characterization factor for methane. Just the number and the indicator name.'
      )
      expect(r.tools).toContain('get_characterization_factors')
      expect(r.text).toMatch(/\d/)
    },
    300_000
  )

  it.skipIf(skip('health'))(
    'runs the model health check',
    async () => {
      const r = await turn(
        'health',
        'Check this model for structural problems and summarise the result in two sentences.'
      )
      expect(r.tools).toContain('check_model_health')
    },
    240_000
  )

  it.skipIf(skip('goalscope'))(
    'records goal & scope via model_info',
    async () => {
      const r = await turn(
        'goalscope',
        'Set this model\'s functional unit to "1 kg of widget, at factory gate" and note that the scope is cradle-to-gate. Nothing else.'
      )
      expect(r.tools).toContain('model_info')
      const study = await get<Record<string, string>>(
        `/api/v1/study?database=${encodeURIComponent(scratchDb)}`
      )
      expect(JSON.stringify(study).toLowerCase()).toContain('widget')
    },
    240_000
  )

  it.skipIf(skip('tags'))(
    'creates a tag group and assigns it',
    async () => {
      // The process normally comes from the 'process' scenario; a targeted re-run has to bring its own,
      // otherwise the model burns its rounds searching for something that was never created.
      const acts = await get<Array<{ name: string }>>(
        `/api/v1/model/activities/${encodeURIComponent(scratchDb)}`
      )
      if (!acts.some((a) => a.name === 'eval widget')) {
        await api('POST', '/api/v1/model/activities', {
          database: scratchDb,
          name: 'eval widget',
          unit: 'kg'
        })
      }
      // Tag groups are PROJECT-scoped, not model-scoped, so this scenario needs a name that cannot
      // collide with the user's own groups: asserting on something like "…phase" matched a group that
      // already existed, which made the check pass no matter what the model did — and appended the
      // model's value to real user data.
      const r = await turn(
        'tags',
        `Create a tag group "${tagGroup}" with the value "Production", then tag the process "eval widget" with it.`
      )
      expect(r.tools).toContain('edit_tags')
      const { groups } = await get<{ groups: Array<{ name: string; values: string[] }> }>(
        '/api/v1/model/tag-groups'
      )
      const made = groups.find((g) => g.name === tagGroup)
      expect(made, `the model did not create the tag group "${tagGroup}"`).toBeDefined()
      expect(made?.values).toContain('Production')
    },
    300_000
  )

  it.skipIf(skip('lookup'))(
    'looks up a controlled vocabulary',
    async () => {
      const r = await turn('lookup', 'Which ISIC sections exist? Name three of them.')
      expect(r.tools).toContain('lookup')
      expect(r.errors).toEqual([])
    },
    240_000
  )

  it.skipIf(skip('methodfamily'))(
    'creates its own LCIA method family',
    async () => {
      const r = await turn(
        'methodfamily',
        'Create an LCIA method family called "Eval family" with the description "scratch family for testing". Nothing else.'
      )
      expect(r.tools).toContain('manage_method_family')
      const fams = await get<{ families: Array<{ family: string }> }>('/api/v1/lcia/families')
      expect(fams.families.some((f) => f.family === 'Eval family')).toBe(true)
      // clean up after ourselves — this one lives in the project, not in the scratch model
      await api('POST', '/api/v1/lcia/family/delete', { family: 'Eval family' })
    },
    300_000
  )

  // ---- larger scenarios --------------------------------------------------
  it.skipIf(skip('build'))(
    'builds a small tagged model and calculates it',
    async () => {
      const r = await turn(
        'build',
        `In the model ${scratchDb}, build a minimal product system: a process "eval bottle" (unit: unit) that consumes ` +
          '0.02 kg of a granulate/plastic dataset from ecoinvent and 0.1 kWh of electricity from ecoinvent. ' +
          'Tag both inputs with a life-cycle phase if a tag group exists, then calculate the climate-change score ' +
          'of "eval bottle" with a recommended GWP100 indicator and report the number with its unit.',
        { maxRounds: 25 }
      )
      const acts = await get<Array<{ name: string }>>(
        `/api/v1/model/activities/${encodeURIComponent(scratchDb)}`
      )
      expect(acts.some((a) => a.name.toLowerCase().includes('bottle'))).toBe(true)
      expect(r.tools).toContain('search_background')
      expect(r.tools.some((t) => t === 'calculate' || t === 'calculate_in_canvas')).toBe(true)
      expect(r.text).toMatch(/\d/)
    },
    600_000
  )

  it.skipIf(skip('bom'))(
    'researches a bill of materials from the web',
    async () => {
      const r = await turn(
        'bom',
        'Research the bill of materials of a standard 0.5 l PET water bottle (bottle, cap, label) with a total mass ' +
          'of about 0.022 kg. Use the BOM research tool and report the components with masses and sources.',
        { maxRounds: 10 }
      )
      expect(r.tools).toContain('research_bom')
      expect(r.text.toLowerCase()).toMatch(/pet|polyethylene/)
    },
    600_000
  )
})
