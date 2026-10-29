/**
 * The chat agent's IPC surface: run a turn, stream its events, answer the UI-tool round-trip
 * (main → renderer → main), transcribe a recording, and own the run registry that `ai:isRunning`
 * and `ai:cancel` answer from.
 */
import { ipcMain } from 'electron'

import { runAgent, type AgentEvent, type StoredTranscript } from '../ai/agent'
import { findModel } from '../ai/models'
import { getActiveProvider } from '../ai/providers/state'
import { RESUMABLE_OUTCOMES, type ChatPlan, type ChatRun, type RunOutcome } from '../../shared/plan'
import { addAttachments } from '../ai/attachments'
import { attachGrants } from '../attachGrants'
import { transcribeAudio } from '../ai/client'
import type { AttachmentMeta } from '../../shared/ipc'
import type { Skill } from '../ai/systemPrompt'
import { recordCost, recordUsage } from '../ai/usage'
import { clampCost, clampRounds, getSettings } from '../settings'
import { computeDistances, distancesAvailable } from '../distance/service'
import { TurnBudget } from '../distance/types'
import { distanceKeys } from './distance'
import { queryEurostatEol } from '../eurostat/service'
import { modelForActive, type AiIpcDeps, type RunControllers } from './shared'
import type { UiBridge, UiCallOpts } from './uiBridge'

// The ask timeout moved to uiBridge.ts with the round-trip; re-exported for its importers.
export { ASK_USER_TIMEOUT_MS } from './uiBridge'

export interface ChatIpcControl {
  /**
   * Once the backend is up: every chat whose run was still `running` when PrismLCA last closed is
   * marked `interrupted`, so its card shows the stop and offers Continue.
   * A run never survives the process; the record saying it
   * does is the one lie this corrects.
   */
  onBackendReady: () => Promise<void>
}

const enc = encodeURIComponent

export function registerChatIpc(
  deps: AiIpcDeps,
  controllers: RunControllers,
  bridge: UiBridge
): ChatIpcControl {
  // The UI round-trip and the record of open questions live in the bridge (uiBridge.ts), created by
  // registerAi and shared with the MCP server's sessions — one 'ai:ui-result' handler, one counter.
  const callUiTool = (name: string, args: Record<string, unknown>, opts?: UiCallOpts): Promise<any> =>
    bridge.call(name, args, opts)

  /**
   * The finalisation of the run on each chat — persisting its answer, its run record, its transcript.
   * `ai:cancel` and a superseding `ai:send` WAIT on it: cancel used to drop the controller and return
   * at once, the renderer freed the input, and the old run could still write its end after the new
   * run had started. One writer per chat, in order, is the whole rule.
   */
  const finals = new Map<string, Promise<unknown>>()

  /**
   * What the user typed into a chat while its run was working, per chat, until the loop takes it at
   * the next round boundary (agent.ts `deliverSteering`). Main keeps it, not the renderer: the run
   * outlives the window, and a message queued before a reload must still reach the model.
   */
  const steers = new Map<string, string[]>()
  const emitSteer = (chatId: string): void =>
    deps.getWindow()?.webContents.send('ai:event', {
      chatId,
      type: 'steer',
      queued: [...(steers.get(chatId) ?? [])]
    } satisfies AgentEvent)
  // Renderer → main: queue a message for the chat's turn. Queued whether or not a run is in flight
  // at this instant — a run that ended between the renderer's check and this call would otherwise
  // drop the words — and taken by the chat's next round or next run
  // (agent.ts `deliverSteering`). Only an empty text is refused.
  ipcMain.handle('ai:steer', (_e, chatId: string, text: string) => {
    const t = typeof text === 'string' ? text.trim() : ''
    if (!chatId || !t) return { queued: false }
    steers.set(chatId, [...(steers.get(chatId) ?? []), t])
    emitSteer(chatId)
    return { queued: true }
  })
  // Take one queued message back (the chip's ✕); without an index, the whole queue.
  ipcMain.handle('ai:unsteer', (_e, chatId: string, index?: number) => {
    const list = steers.get(chatId) ?? []
    const next = typeof index === 'number' ? list.filter((_, i) => i !== index) : []
    if (next.length) steers.set(chatId, next)
    else steers.delete(chatId)
    emitSteer(chatId)
    return { queued: next }
  })
  ipcMain.handle('ai:steerQueue', (_e, chatId: string) => [...(steers.get(chatId) ?? [])])

  const getSkills = async (): Promise<Skill[]> => {
    const { status, body } = await deps.apiRequest('GET', '/api/v1/ai/skills?enabled=true')
    if (status >= 400 || !body) return []
    const list = (body as any).skills
    return Array.isArray(list) ? list : []
  }

  // Renderer → main: take the files the user just attached. Paths in, descriptions out — the bytes
  // are read here and stored by the backend, so nothing large ever crosses this bridge (see
  // ai/attachments.ts). Called when the file is attached, not when the message is sent, because the
  // size warning has to be on the chip while the user is still typing.
  // Only paths the user handed over in this session are read — picked in a PrismLCA file dialog or
  // dropped onto the chat — and each pick or drop is good for one read (attachGrants.ts).
  // Anything else comes back as a refused chip, never as a read.
  ipcMain.handle('ai:attach', async (_e, paths: string[]) =>
    addAttachments(
      Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : [],
      deps.apiRequest,
      (p) => attachGrants.take(p)
    )
  )

  // Renderer → main: run one chat turn. Streams deltas/tool events on 'ai:event'; resolves at end.
  ipcMain.handle(
    'ai:send',
    async (
      _e,
      // `distancesAllowed`/`eurostatAllowed` are the per-chat toggles (the "+" menu); the store, the
      // keys and the app setting still decide.
      req: SendRequest
    ) => {
      controllers.get(req.chatId)?.abort() // supersede any prior run on this chat …
      // … but register THIS turn's handle synchronously, before waiting for the old one to finish
      // writing: a Stop that arrives during the wait must find something to stop, and two sends
      // waiting on the same run must not both start.
      const controller = new AbortController()
      controllers.set(req.chatId, controller)
      const emit = (ev: AgentEvent): void => {
        deps.getWindow()?.webContents.send('ai:event', ev)
      }
      const previous = finals.get(req.chatId)
      const work = (async (): Promise<{ ok: boolean; persisted: boolean }> => {
        await previous?.catch(() => undefined)
        // Stopped while queued: nothing starts, nothing is written.
        if (controller.signal.aborted) {
          if (controllers.get(req.chatId) === controller) controllers.delete(req.chatId)
          return { ok: false, persisted: false }
        }
        return runTurn(req, controller, emit)
      })()
      finals.set(req.chatId, work)
      try {
        return await work
      } finally {
        if (finals.get(req.chatId) === work) finals.delete(req.chatId)
      }
    }
  )

  /** One chat turn, start to finish, including everything it writes. Only ever one per chat in flight. */
  async function runTurn(
    req: SendRequest,
    controller: AbortController,
    emit: (ev: AgentEvent) => void
  ): Promise<{ ok: boolean; persisted: boolean }> {
    {
      // Mutable: a tool of this run may rename the chat's own model, and the backend moves the stored
      // chat with it — everything this turn still writes has to follow (onModelRenamed below).
      let model = req.activeDb
      const chatPath = (): string | null =>
        model ? `/api/v1/ai/chats/${enc(model)}/${enc(req.chatId)}` : null
      const chatBase = chatPath()
      const safe = (
        method: string,
        path: string,
        body?: unknown
      ): Promise<{ status: number; body: unknown }> =>
        deps.apiRequest(method, path, body).catch((e: unknown) => ({ status: 0, body: String(e) }))
      // The chat's stored plan and run: the plan goes to the model
      // when the transcript has to be rebuilt, a stopped run becomes the "verify before you continue"
      // note — whatever the user typed; nothing here matches on the word "continue".
      let storedPlan: ChatPlan | null = null
      let resumeFrom: RunOutcome | undefined
      if (chatBase) {
        const { status, body } = await safe('GET', chatBase)
        if (status > 0 && status < 400 && body && typeof body === 'object') {
          const chat = body as { plan?: ChatPlan | null; run?: ChatRun | null }
          storedPlan = chat.plan ?? null
          const run = chat.run
          if (
            run &&
            (run.state === 'stopped' || run.state === 'interrupted') &&
            run.outcome &&
            RESUMABLE_OUTCOMES.has(run.outcome)
          )
            resumeFrom = run.outcome
        }
      }
      // Per model (models.ts `planTool`): the run gets the tool, its prompt paragraph and its dispatch
      // together, or none of the three.
      const planTool = findModel(req.model, getActiveProvider()).planTool !== false
      const costLimit = clampCost(req.maxCostUsd)
      const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const startedAt = new Date().toISOString()
      const setRun = async (run: ChatRun): Promise<void> => {
        const base = chatPath()
        if (base) {
          const r = await safe('PUT', `${base}/run`, run)
          if (r.status === 0 || r.status >= 400)
            console.log(`[prism-ai] run state not saved (HTTP ${r.status})`)
        }
        emit({ chatId: req.chatId, type: 'run', run })
      }
      await setRun({ runId, state: 'running', startedAt, costLimitUsd: costLimit || undefined })
      const persistPlan = async (plan: ChatPlan | null): Promise<void> => {
        const base = chatPath()
        if (!base) return
        const r = await safe('PUT', `${base}/plan`, { plan })
        if (r.status === 0 || r.status >= 400) console.log(`[prism-ai] plan not saved (HTTP ${r.status})`)
      }
      // The transcript on disk, through the backend (snake_case on the wire, like every chat field).
      const transcriptStore = chatBase
        ? {
            load: async (): Promise<StoredTranscript | null> => {
              const { status, body } = await safe('GET', `${chatPath()}/transcript`)
              if (status === 0 || status >= 400 || !body || typeof body !== 'object') return null
              const t = body as { turn_id?: unknown; history_after?: unknown; messages?: unknown }
              if (!Array.isArray(t.history_after) || !Array.isArray(t.messages)) return null
              return {
                turnId: String(t.turn_id ?? ''),
                historyAfter: t.history_after as StoredTranscript['historyAfter'],
                messages: t.messages as StoredTranscript['messages']
              }
            },
            save: async (_id: string, t: StoredTranscript): Promise<void> => {
              const r = await safe('PUT', `${chatPath()}/transcript`, {
                turn_id: t.turnId,
                history_after: t.historyAfter,
                messages: t.messages
              })
              if (r.status === 0 || r.status >= 400) throw new Error(`HTTP ${r.status}`)
            }
          }
        : undefined
      // The distances tool exists for this run only when three things agree: the chat's toggle, the
      // app setting, and a geocoding key. Otherwise nothing is injected and the model is never told
      // (toolSpecs drops the spec, the system prompt drops the bullet). One call budget per run.
      const transport = getSettings().transport
      const keys = distanceKeys()
      const distancesOn =
        req.distancesAllowed !== false && transport.toolEnabled && distancesAvailable(transport, keys)
      const turn = new TurnBudget(transport.perTurnCalls)
      const distances = distancesOn
        ? (mode: unknown, pairs: unknown): Promise<unknown> =>
            computeDistances(mode, pairs, {
              settings: transport,
              keys,
              turn,
              backend: deps.apiRequest,
              // Stop reaches the geocoding and routing still queued in their gates.
              signal: controller.signal
            })
        : undefined
      // Same rule for Eurostat: chat toggle ∧ app setting, or the model never hears of the tool. No
      // key and no budget — the API is public and the client caches each slice for a day.
      const eurostatOn = req.eurostatAllowed !== false && getSettings().eurostatEnabled
      const eurostat = eurostatOn ? (args: unknown): Promise<unknown> => queryEurostatEol(args) : undefined
      let persisted = true
      try {
        // The guardrails are the store's, not the caller's: a request may ask for *less* than the
        // stored ceiling and never for more. Before this they were whatever the renderer sent, which
        // meant the side being limited set the limit.
        const result = await runAgent(
          {
            ...req,
            maxCostUsd: clampCost(req.maxCostUsd),
            maxRounds: clampRounds(req.maxRounds),
            disabledTools: req.disabledTools ?? getSettings().disabledTools,
            // Same rule as the tool list: the store is the truth, the caller may only echo it —
            // and a choice belonging to the inactive provider reads as '' (see modelForActive).
            researchModel: modelForActive(req.researchModel ?? getSettings().researchModel),
            reviewModel: modelForActive(req.reviewModel ?? getSettings().reviewModel),
            // Cost guardrail, so the store decides — the renderer may echo it, never raise it.
            maxResearchQuestions: getSettings().maxResearchQuestions,
            // Same: how many web lookups the provider may run inside one reply (V398).
            webLookupsCap: getSettings().webLookupsPerAnswer,
            distancesAvailable: distancesOn,
            // The store's, not the caller's: a preference is a modelling decision the user made once.
            preferredBackground: getSettings().preferredBackground,
            eurostatAvailable: eurostatOn,
            planTool,
            plan: storedPlan,
            resumeFrom,
            // The store's, never the caller's: whether the card is shown is a guardrail.
            approval: getSettings().chatApproval,
            // Per EFFECTIVE model id — the one runAgent resolves and sends (a stored id from the other
            // provider falls back to the active provider's default, and so must its effort).
            reasoningEffort:
              getSettings().reasoningEffort[findModel(req.model, getActiveProvider()).id] || undefined,
            signal: controller.signal
          },
          {
            apiRaw: deps.apiRequest,
            callUiTool,
            emit,
            getSkills,
            recordUsage,
            distances,
            eurostat,
            persistPlan,
            onModelRenamed: (name) => {
              model = name
            },
            transcriptStore,
            takeSteering: () => {
              const list = steers.get(req.chatId) ?? []
              if (!list.length) return []
              steers.delete(req.chatId)
              emitSteer(req.chatId)
              return list
            }
          }
        )
        // Persist the assistant's answer (or the partial text of a stopped run) from HERE, not the
        // renderer — so it survives even when the user switches views/models mid-run and the chat
        // component is unmounted when the run finishes. ALWAYS, even with no prose: a run stopped
        // while still calling tools used to leave no record at all — no trace, no cost, and a
        // history the carried transcript could not match.
        if (model) {
          const saved = await deps
            .apiRequest(
              'POST',
              `/api/v1/ai/chats/${encodeURIComponent(model)}/${encodeURIComponent(req.chatId)}/messages`,
              {
                // The tool trace rides along, so a reloaded chat can still explain HOW the answer
                // came about — otherwise diagnosing a bad call means reproducing it against a
                // live model.
                // Cost too: the limit is per RUN, so "what did that answer cost" is the question the
                // user has, and the per-model monthly total in Settings cannot answer it after a reload.
                messages: [
                  {
                    role: 'assistant',
                    content: result.text,
                    tools: result.trace.length ? result.trace : undefined,
                    cost: result.cost,
                    // And what it consumed. The chat header adds these up over the conversation;
                    // without them on the message the total would reset on every reload, because
                    // the monthly ledger in Settings is per model and cannot tell two chats apart.
                    // snake_case because this crosses into the backend, where the report and chat
                    // APIs are snake_case throughout. The agent's own event keeps camelCase.
                    prompt_tokens: result.promptTokens,
                    cached_tokens: result.cachedTokens,
                    completion_tokens: result.completionTokens,
                    // How full the context was at the end — the chat header's meter after a reload.
                    context_tokens: result.contextTokens,
                    // Which endpoint served it — the answer to "why was this run four times slower
                    // than the last one", which nothing else recorded can give after the fact.
                    provider: result.provider,
                    // The run's turn id — the key its transcript is stored under — and, when it did
                    // not finish, why (the renderer puts Continue next to that message).
                    turn_id: result.turnId,
                    outcome: result.outcome !== 'answered' ? result.outcome : undefined
                  }
                ]
              }
            )
            .catch((e: unknown) => ({ status: 0, body: e instanceof Error ? e.message : String(e) }))
          if (saved.status === 0 || saved.status >= 400) {
            // Said, not swallowed: the answer is on screen and gone after the next reload, and the
            // user has to hear that now. After 'done' the renderer holds no
            // partial text, so the error event adds no second message — only the notice.
            persisted = false
            const detail = (saved.body as { error?: { message?: string } } | null)?.error?.message
            emit({
              chatId: req.chatId,
              type: 'error',
              message:
                'The answer could not be saved to this chat' +
                (saved.status
                  ? ` (HTTP ${saved.status}${detail ? `: ${detail}` : ''})`
                  : ` (${String(saved.body)})`) +
                ' — it is shown here, but will be missing after a reload.'
            })
          }
        }
        // How it ended, as a record: 'idle' after an answer, 'stopped' after anything else — the
        // card and the Continue button read this, never the italic note in the text.
        await setRun({
          runId,
          state: result.outcome === 'answered' ? 'idle' : 'stopped',
          outcome: result.outcome,
          startedAt,
          endedAt: new Date().toISOString(),
          costUsd: result.cost,
          costLimitUsd: costLimit || undefined,
          turnId: result.turnId
        })
      } finally {
        // Only remove our own controller — a superseding send may already have replaced it, and
        // unconditionally deleting would strip the NEW run's abort handle (Stop would go dead).
        if (controllers.get(req.chatId) === controller) controllers.delete(req.chatId)
      }
      // A message queued in the instant between the loop's last check and its end — or while the
      // user pressed Stop — STAYS queued: the chip keeps showing it, and the next run on this chat
      // delivers it in its first round. Never resent on its own: a run that starts itself after Stop,
      // or against whatever model the panel shows by then, is the wrong kind of helpful.
      return { ok: true, persisted }
    }
  }

  // Renderer → main: transcribe a voice recording (the OpenRouter key stays in main). The whole
  // recording arrives as one buffer — deliberately no streaming, matching the record-then-send UX.
  ipcMain.handle(
    'ai:transcribe',
    async (_e, payload: { data: ArrayBuffer; format: string; language?: string }) => {
      const b64 = Buffer.from(payload.data).toString('base64')
      const { text, cost, model } = await transcribeAudio({
        data: b64,
        format: payload.format,
        language: payload.language
      })
      // Booked under the model the transport actually used — the two providers transcribe with
      // different models, and a ledger row naming the wrong one is worse than none.
      if (typeof cost === 'number') recordCost(model, cost)
      return { text }
    }
  )

  // Whether a chat has a run in flight. The renderer used to derive this from its OWN start — a
  // `useState` set when it sent the message — so a reload dropped it to false while the run carried
  // on in this process: no run bar, no thinking dots, and no Stop button, which means the run could
  // not be stopped and a question it asked had nobody to answer it. The transcript recovered on the
  // next event because it hangs off the chat id; these three did not, because they hung off the
  // start (V274). The truth lives here, in `controllers`.
  ipcMain.handle('ai:isRunning', (_e, chatId: string) => {
    if (!chatId) return false
    // A report writer registers its lanes under '<chatId>:<uuid>', so a lane counts as the chat
    // running — the same rule 'ai:cancel' below already applies in the other direction.
    return [...controllers.keys()].some((k) => k === chatId || k.startsWith(`${chatId}:`))
  })

  ipcMain.handle('ai:cancel', async (_e, chatId: string) => {
    controllers.get(chatId)?.abort()
    controllers.delete(chatId)
    // Report writers register per call under 'report:ai:<uuid>', so 'report:ai' cancels them all —
    // the Stop button means "stop the run", not "stop the newest lane".
    for (const [key, controller] of [...controllers]) {
      if (key.startsWith(`${chatId}:`)) {
        controller.abort()
        controllers.delete(key)
      }
    }
    // Resolve only once the stopped run has written its record and transcript, so the renderer's
    // re-enabled input cannot start a turn the old one then writes over.
    await finals.get(chatId)?.catch(() => undefined)
    return { ok: true }
  })

  return {
    onBackendReady: async () => {
      const { status, body } = await deps
        .apiRequest('POST', '/api/v1/ai/chats/mark-interrupted')
        .catch((e: unknown) => ({ status: 0, body: String(e) }))
      if (status === 0 || status >= 400) {
        console.log(`[prism-ai] interrupted-run sweep failed (HTTP ${status})`)
        return
      }
      const count = (body as { count?: number } | null)?.count ?? 0
      if (count) console.log(`[prism-ai] ${count} chat run(s) marked interrupted from the previous session`)
    }
  }
}

/** The renderer's `ai:send` payload — named so `runTurn` can take it whole. */
type SendRequest = {
  chatId: string
  model: string
  activeDb: string | null
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  userText: string
  attachments?: AttachmentMeta[]
  maxRounds?: number
  maxCostUsd?: number
  maxTokens?: number
  disabledTools?: string[]
  webSearch?: boolean
  webSearchAllowed?: boolean
  distancesAllowed?: boolean
  eurostatAllowed?: boolean
  focusTools?: boolean
  researchModel?: string
  reviewModel?: string
  maxResearchQuestions?: number
  backgroundDbs?: string[]
  libraryDbs?: string[]
}
