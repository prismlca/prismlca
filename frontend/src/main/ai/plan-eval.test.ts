import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import type { AgentEvent } from '../../shared/ipc'
import type { ChatPlan, RunOutcome } from '../../shared/plan'

/**
 * LIVE measurement of the `plan` tool: the same modelling
 * task three times — a cheap model with the plan tool, the same model without it, and a strong model
 * without it (as the catalogue ships it) — plus one deliberate abort-and-Continue in the first run,
 * which is the product's resume path driven through `runAgent` directly. **Opt-in** and PAID, like
 * practice-eval.test.ts: skipped unless PRISM_EVAL_LIVE=1.
 *
 *     PRISM_EVAL_LIVE=1 npx vitest run src/main/ai/plan-eval.test.ts
 *     PRISM_EVAL_LIVE=1 PRISM_EVAL_ONLY=a npx vitest run src/main/ai/plan-eval.test.ts
 *     PRISM_EVAL_BUDGET=20 — total USD across the runs (default 20; C gets what A and B left)
 *
 * Nothing here ASSERTS on the model: every run writes its trace, plan revisions, rejections, cost and
 * answer to `.eval-out/plan-<timestamp>.json`, and the findings are written by a person.
 *
 * Needs an OpenRouter key (env or .secrets/openrouter-key) and ecoinvent in the active project. Works
 * inside the ACTIVE project but only ever creates its own `zz-plan-<ts>-<run>` foreground models —
 * which it KEEPS, so the result can be inspected in the app. No PrismLCA instance may be running: the
 * harness boots the backend itself and the data directory is locked to one process.
 */

const LIVE = process.env.PRISM_EVAL_LIVE === '1'
const BUDGET = Number(process.env.PRISM_EVAL_BUDGET || 20)
const ONLY = (process.env.PRISM_EVAL_ONLY?.toLowerCase() ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const REPO = join(__dirname, '..', '..', '..', '..')
const REPORT_DIR = join(REPO, 'frontend', '.eval-out')

const userData = mkdtempSync(join(tmpdir(), 'prism-plan-eval-'))
vi.mock('electron', () => ({ app: { getPath: () => userData, getAppPath: () => userData } }))

/**
 * Forced compaction: a run may shrink the model's context window as the agent sees it, so the
 * compaction path (agent.ts compactThreshold) fires on a task that would otherwise fit. Set per run
 * through a global, because vi.mock factories are hoisted above every local binding.
 */
declare global {
  var __planEvalContextTokens: number | undefined
}
vi.mock('./models', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./models')>()
  return {
    ...mod,
    findModel: (id: string | undefined, provider?: Parameters<typeof mod.findModel>[1]) => {
      const m = mod.findModel(id, provider)
      const forced = globalThis.__planEvalContextTokens
      return forced ? { ...m, contextTokens: forced } : m
    }
  }
})

/** The task, identical for every run. The model name is filled in per run. */
const TASK = (db: string): string =>
  `In the model "${db}", build a cradle-to-gate model of a 500 ml PET bottle with cap (HDPE) and label ` +
  `(PP film) for the EU market: record goal and scope, create the processes, link the background ` +
  `datasets from ecoinvent, add transport to the filler (300 km road), run the health check, calculate ` +
  `GWP100 (IPCC 2021) and report the result with the three largest contributors.`

/** The exact text the plan card's Continue button sends (renderer/components/PlanCard.tsx). */
const CONTINUE_PLAN = 'Continue with the plan.'
const CONTINUE_FREE = 'Continue where you stopped.'
/** Tool calls after which run A is aborted — mid-task, so the resume has something to verify. */
const ABORT_AFTER_CALLS = 25

interface Backend {
  host: string
  port: number
  token: string
}
let backend: Backend | null = null
let child: ChildProcess | null = null

interface Segment {
  /** 'first' or 'continue' — the two runAgent calls of a Continue pair. */
  leg: 'first' | 'continue'
  userText: string
  resumeFrom?: RunOutcome
  text: string
  outcome: RunOutcome
  aborted: boolean
  rounds: number
  tools: string[]
  trace: string[]
  rejected: string[]
  errors: string[]
  asks: number
  planCalls: number
  planRejections: string[]
  planRevisions: Array<{
    revision: number
    steps: Array<{ step: string; status: string; note?: string }>
    explanation?: string
  }>
  cost: number
  ledgerCost: number
  promptTokens: number
  cachedTokens: number
  completionTokens: number
  provider?: string
  log: string[]
  ms: number
}

interface Row {
  key: string
  model: string
  planTool: boolean
  scratchDb: string
  maxCostUsd: number
  contextTokens?: number
  segments: Segment[]
  cost: number
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

const skip = (key: string): boolean => ONLY.length > 0 && !ONLY.some((o) => key.toLowerCase().startsWith(o))

const spent = (): number => rows.reduce((s, r) => s + r.cost, 0)

interface RunSpec {
  key: string
  model: string
  /** Offer the plan tool? `null` = as the catalogue says (models.ts `planTool`). */
  planTool: boolean | null
  /** Per-run cost limit; a function gets what the budget has left. */
  maxCostUsd: number | ((left: number) => number)
  /** Abort after this many tool calls, then Continue once. */
  abortAfterCalls?: number
  /** Pretend the model's context window is this small, so compaction fires mid-task. */
  contextTokens?: number
}

const RUNS: RunSpec[] = [
  {
    key: 'a-glm-plan',
    model: 'z-ai/glm-5.3-flash',
    planTool: true,
    maxCostUsd: 3,
    abortAfterCalls: ABORT_AFTER_CALLS
  },
  { key: 'b-glm-noplan', model: 'z-ai/glm-5.3-flash', planTool: false, maxCostUsd: 3 },
  {
    key: 'c-sonnet',
    model: 'anthropic/claude-sonnet-5.5',
    planTool: null,
    // Sonnet gets the rest of the budget, less one round's margin — the breaker checks AFTER a round.
    maxCostUsd: (left) => Math.max(0.5, Math.min(14, left - 1))
  },
  // GPT-6.1 Sol through OpenRouter, as the catalogue ships it (no plan tool) — measured
  // before it became the OpenRouter chat default, against C on the same task.
  { key: 'f-sol', model: 'openai/gpt-6.1-sol', planTool: null, maxCostUsd: 5 },
  // Compaction forced: the real GLM runs peaked at 75–105k prompt tokens per round, far below the
  // 1M window, so A and B never compacted. 100k as the window → threshold 50k tokens of history.
  {
    key: 'd-glm-plan-compact',
    model: 'z-ai/glm-5.3-flash',
    planTool: true,
    maxCostUsd: 3,
    contextTokens: 100_000
  },
  {
    key: 'e-glm-noplan-compact',
    model: 'z-ai/glm-5.3-flash',
    planTool: false,
    maxCostUsd: 3,
    contextTokens: 100_000
  }
]

describe.skipIf(!LIVE)('plan tool measurement', () => {
  let runAgent: typeof import('./agent').runAgent
  let findModel: typeof import('./models').findModel
  let backgroundDbs: string[] = []
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')

  beforeAll(async () => {
    const orKey = secret('OPENROUTER_API_KEY', 'openrouter-key')
    if (!orKey) throw new Error('No OpenRouter key (env OPENROUTER_API_KEY or .secrets/openrouter-key).')
    process.env.OPENROUTER_API_KEY = orKey
    backend = await startBackend()
    await waitHealthy()
    ;({ runAgent } = await import('./agent'))
    ;({ findModel } = await import('./models'))
    const dbs = await get<Array<{ name: string; read_only: boolean; kind: string }>>('/api/v1/databases')
    backgroundDbs = dbs.filter((d) => d.read_only && d.kind === 'background').map((d) => d.name)
    if (!backgroundDbs.length)
      throw new Error('The active project has no ecoinvent background — import one before a run.')
    console.log(`[plan-eval] budget=$${BUDGET} backgrounds=${backgroundDbs.join(', ')}`)
  }, 240_000)

  afterAll(() => {
    if (rows.length) {
      mkdirSync(REPORT_DIR, { recursive: true })
      const out = join(REPORT_DIR, `plan-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`)
      writeFileSync(out, JSON.stringify({ budget: BUDGET, task: TASK('<model>'), rows }, null, 2))
      console.log(`\n[plan-eval] ${rows.length} run(s), $${spent().toFixed(3)} spent — detail in ${out}`)
    }
    child?.kill()
  }, 60_000)

  for (const spec of RUNS) {
    it.skipIf(skip(spec.key))(
      spec.key,
      async () => {
        const left = BUDGET - spent()
        const limit =
          typeof spec.maxCostUsd === 'function' ? spec.maxCostUsd(left) : Math.min(spec.maxCostUsd, left)
        if (limit < 0.5) throw new Error(`budget exhausted before ${spec.key} ($${left.toFixed(2)} left)`)
        globalThis.__planEvalContextTokens = spec.contextTokens
        const planTool = spec.planTool ?? findModel(spec.model).planTool !== false
        const scratchDb = `zz-plan-${stamp}-${spec.key.slice(0, 1)}`
        const made = await api('POST', '/api/v1/databases/foreground', { name: scratchDb })
        if (made.status >= 400)
          throw new Error(`could not create scratch model: ${JSON.stringify(made.body)}`)
        const row: Row = {
          key: spec.key,
          model: spec.model,
          planTool,
          scratchDb,
          maxCostUsd: limit,
          segments: [],
          cost: 0
        }
        rows.push(row)
        console.log(
          `[plan-eval] ${spec.key}: model=${spec.model} plan=${planTool} limit=$${limit.toFixed(2)} scratch=${scratchDb}`
        )

        const chatId = `plan-eval-${stamp}-${spec.key}`
        let plan: ChatPlan | null = null
        const history: Array<{ role: 'user' | 'assistant'; content: string }> = []

        const leg = async (
          which: Segment['leg'],
          userText: string,
          resumeFrom: RunOutcome | undefined,
          abortAfterCalls: number | undefined,
          costLeft: number
        ): Promise<Segment> => {
          const seg: Segment = {
            leg: which,
            userText,
            resumeFrom,
            text: '',
            outcome: 'error',
            aborted: false,
            rounds: 0,
            tools: [],
            trace: [],
            rejected: [],
            errors: [],
            asks: 0,
            planCalls: 0,
            planRejections: [],
            planRevisions: [],
            cost: 0,
            ledgerCost: 0,
            promptTokens: 0,
            cachedTokens: 0,
            completionTokens: 0,
            log: [],
            ms: 0
          }
          const t0 = Date.now()
          const controller = new AbortController()
          let lastWasStart = false
          const origLog = console.log
          console.log = (...args: unknown[]) => {
            const line = args.map(String).join(' ')
            if (line.includes('[prism-ai]')) seg.log.push(line.slice(0, 400))
            origLog(...args)
          }
          try {
            const res = await runAgent(
              {
                chatId,
                model: spec.model,
                activeDb: scratchDb,
                history: [...history],
                userText,
                maxRounds: 150,
                maxCostUsd: costLeft,
                planTool,
                plan,
                resumeFrom,
                backgroundDbs,
                signal: controller.signal
              },
              {
                apiRaw: api,
                callUiTool: async (tool: string, args: Record<string, unknown>) => {
                  if (tool === 'ask_user') {
                    seg.asks++
                    const qs =
                      (args.questions as
                        | Array<{ options?: Array<{ label: string } | string> }>
                        | undefined) ?? []
                    // One array per question — canvas.ts reads a flat list as ONE question's answer.
                    const answers = qs.map((q) => {
                      const o = q.options?.[0]
                      return [typeof o === 'string' ? o : (o?.label ?? 'Yes')]
                    })
                    seg.trace.push(`ask_user → answered ${JSON.stringify(answers)}`)
                    return { answers }
                  }
                  if (tool === 'approve_tool') return { approved: true } // the eval user allows every card
                  return { ok: true }
                },
                emit: (ev: AgentEvent) => {
                  if (ev.type === 'tool' && ev.phase === 'start') {
                    if (!lastWasStart) seg.rounds++
                    lastWasStart = true
                    seg.tools.push(ev.name)
                    seg.trace.push(`${ev.name}(${(ev.args ?? '').slice(0, 1500)})`)
                    if (ev.name === 'plan') seg.planCalls++
                    if (
                      abortAfterCalls &&
                      seg.tools.length >= abortAfterCalls &&
                      !controller.signal.aborted
                    ) {
                      seg.trace.push(`<<abort after ${seg.tools.length} calls>>`)
                      controller.abort()
                    }
                    return
                  }
                  lastWasStart = false
                  if (ev.type === 'tool' && ev.phase === 'error')
                    seg.errors.push(`${ev.name}: ${(ev.detail ?? '').slice(0, 600)}`)
                  if (ev.type === 'tool' && ev.phase === 'done') {
                    if (ev.soft) {
                      seg.rejected.push(`${ev.name}: ${ev.soft.slice(0, 600)}`)
                      if (ev.name === 'plan') seg.planRejections.push(ev.soft.slice(0, 600))
                    }
                    seg.trace.push(
                      `  → ${ev.name} ${ev.soft ? 'REJECTED ' : ''}${(ev.preview ?? '').slice(0, 800).replace(/\n/g, ' ⏎ ')}`
                    )
                  }
                  if (ev.type === 'plan') {
                    plan = ev.plan
                    if (ev.plan)
                      seg.planRevisions.push({
                        revision: ev.plan.revision,
                        steps: ev.plan.steps.map((s) => ({ step: s.step, status: s.status, note: s.note }))
                      })
                    else seg.planRevisions.push({ revision: -1, steps: [] })
                  }
                  if (ev.type === 'error') seg.errors.push(`request failed: ${ev.message}`)
                  if (ev.type === 'provider') seg.provider = ev.name
                  if (ev.type === 'done') {
                    seg.promptTokens = ev.promptTokens ?? 0
                    seg.cachedTokens = ev.cachedTokens ?? 0
                    seg.completionTokens = ev.completionTokens ?? 0
                  }
                },
                getSkills: async () =>
                  (await get<{ skills: unknown[] }>('/api/v1/ai/skills?enabled=true')).skills as never[],
                recordUsage: (_model, u) => {
                  seg.ledgerCost += u.cost ?? 0
                },
                persistPlan: async (p, explanation) => {
                  plan = p
                  const last = seg.planRevisions[seg.planRevisions.length - 1]
                  if (last && explanation) last.explanation = explanation
                }
              }
            )
            seg.text = res.text
            seg.outcome = res.outcome
            seg.aborted = res.aborted
            seg.cost = res.cost ?? 0
            seg.provider = res.provider ?? seg.provider
          } finally {
            console.log = origLog
          }
          seg.ms = Date.now() - t0
          history.push({ role: 'user', content: userText }, { role: 'assistant', content: seg.text })
          origLog(
            `[plan-eval] ${spec.key}/${which}: outcome=${seg.outcome} rounds=${seg.rounds} calls=${seg.tools.length} ` +
              `rejected=${seg.rejected.length} errors=${seg.errors.length} plan=${seg.planCalls}/${seg.planRejections.length} ` +
              `$${seg.cost.toFixed(3)} (ledger $${seg.ledgerCost.toFixed(3)}) ${Math.round(seg.ms / 1000)} s`
          )
          return seg
        }

        const first = await leg('first', TASK(scratchDb), undefined, spec.abortAfterCalls, limit)
        row.segments.push(first)
        row.cost = Math.max(first.cost, first.ledgerCost)
        if (spec.abortAfterCalls && first.outcome === 'cancelled') {
          const second = await leg(
            'continue',
            plan ? CONTINUE_PLAN : CONTINUE_FREE,
            'cancelled',
            undefined,
            Math.max(0.5, limit - row.cost)
          )
          row.segments.push(second)
          row.cost += Math.max(second.cost, second.ledgerCost)
        }
      },
      3_600_000
    )
  }
})
