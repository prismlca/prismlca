/**
 * The agent loop: stream from OpenRouter, run any tool calls, feed results back, repeat until the
 * model answers with no more tool calls (or the round budget is spent). Emits events to the
 * renderer for live streaming + tool-status pills.
 */
import { streamChat } from './client'
import { attachmentParts, attachmentStub, heading, stubForPartText } from './attachments'
import { AiProviderError, type ChatMessage } from './providers/types'
import type { AgentEvent, AttachmentMeta, ToolTrace } from '../../shared/ipc'
import { PARALLEL_SAFE_TOOLS, groupsForConversation, inspectedKey, toolSpecs } from './tools'
import { buildSystemPrompt, LANGUAGE_NAMES, type Skill } from './systemPrompt'
import { offeredSkills } from './skillRender'
import { findModel } from './models'
import { getActiveProvider } from './providers/state'
import type { ProviderId } from './providers/types'
import { researchBom, researchWeb, reviewDossier } from './subagent'
import { capToolResult } from './resultBudget'
import { createToolSession } from './execute'
import { NOT_IN_CHAT } from './modelScope'
import { loadTurnContext } from './turnContext'
import {
  APPROVAL_DECLINED,
  APPROVAL_UNANSWERED,
  approvalTarget,
  needsChatApproval,
  type ChatApprovalMode
} from './approval'
import { collectText, costOf } from './stream'

import { DEFAULT_MAX_ROUNDS, clampResearchQuestions, type ReasoningEffort } from '../../shared/aiDefaults'
import { formatPlanForModel, type ChatPlan, type RunOutcome } from '../../shared/plan'

/**
 * Turn a message's text into a single part carrying a cache breakpoint (Anthropic-style, passed
 * straight through by OpenRouter). A breakpoint caches everything up to and including that block, so
 * where it sits decides what is cached — see markCacheBreakpoints for the placement.
 * `ChatMessage.content` already allows an array of parts, so this needs no type change.
 *
 * NOTE: caching only pays off while the prefix before a breakpoint stays byte-identical. Two things
 * break it by design — toggling web search (it appends OpenRouter's server tools to the `tools`
 * array, see openrouter.ts) and compacting the history (see compactMessages). That is also why we do
 * NOT ship dynamic tool subsetting: a per-turn tool list would invalidate the cache every turn.
 */
export function withCacheBreakpoint(text: string): Array<Record<string, unknown>> {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]
}

/** Anthropic accepts at most 4 cache breakpoints per request; a fifth is an error, not a no-op. */
const MAX_CACHE_BREAKPOINTS = 4

/** Drop a breakpoint again and restore the original message shape where we can. */
function unmarkCache(m: ChatMessage): void {
  if (!Array.isArray(m.content)) return
  let had = false
  for (const part of m.content) {
    if ((part as Record<string, unknown>).cache_control) {
      delete (part as Record<string, unknown>).cache_control
      had = true
    }
  }
  if (!had) return
  // A single text part came from a plain string — collapse it back, so an unmarked message is
  // byte-identical to one that was never marked (anything else would churn the cache).
  const only = m.content.length === 1 ? (m.content[0] as { type?: string; text?: unknown }) : null
  if (only?.type === 'text' && typeof only.text === 'string') m.content = only.text
}

function markCache(m: ChatMessage): boolean {
  if (typeof m.content === 'string') {
    if (!m.content) return false
    m.content = withCacheBreakpoint(m.content)
    return true
  }
  if (Array.isArray(m.content) && m.content.length) {
    ;(m.content[m.content.length - 1] as Record<string, unknown>).cache_control = { type: 'ephemeral' }
    return true
  }
  return false // content null (an assistant turn that only called tools) — nothing to attach to
}

/**
 * Place the cache breakpoints for this request, in place. Idempotent: it clears the previous ones
 * first, so the rolling breakpoint can move forward without leaving stale ones behind (they would
 * count against the limit of 4 and split the prefix into fragments nobody reads again).
 *
 * Three breakpoints:
 *  1. the SYSTEM prompt — caches the constant block, i.e. the tool definitions plus the prompt;
 *  2. the FIRST user message — the task statement, stable for the whole run;
 *  3. the last ASSISTANT message with text — everything before it, *including every tool result so
 *     far*, becomes a cache read on the next round. That is the actual lever in a long run: with
 *     only the static breakpoint, each round paid full price for all the tool output it carried.
 *
 * Why the assistant message and not literally the last message: the last message of a round is a
 * `role:'tool'` result, and a tool message in the OpenAI shape carries a plain string — turning it
 * into a parts array to hang `cache_control` on is not a shape OpenRouter documents, and a malformed
 * cache block comes back as a generic 400 that would break every chat. An assistant turn that only
 * called tools has `content: null` and cannot be marked either; the breakpoint then simply stays
 * where it was, which is never worse than not having it.
 *
 * MUST be called AFTER compacting: compaction rewrites older messages, so a breakpoint placed before
 * it could end up pointing at content that no longer exists.
 */
export function markCacheBreakpoints(messages: ChatMessage[]): number {
  for (const m of messages) unmarkCache(m)

  const targets: ChatMessage[] = []
  const system = messages.find((m) => m.role === 'system')
  if (system) targets.push(system)
  const firstUser = messages.find((m) => m.role === 'user')
  if (firstUser && firstUser !== system) targets.push(firstUser)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim() && !targets.includes(m)) {
      targets.push(m)
      break
    }
  }

  let placed = 0
  for (const m of targets.slice(0, MAX_CACHE_BREAKPOINTS)) {
    if (markCache(m)) placed++
  }
  return placed
}

// softError / failedItems / withUnknownFields moved to execute.ts with the executor; re-exported
// because this module taught them to the codebase.
export { softError, failedItems } from './execute'

// validationDetail moved to shared/backendError.ts — it is one of the three unwrapper dialects
// that are now one function; re-exported because this module taught it to the codebase.
export { validationDetail } from '../../shared/backendError'

/** Fallback budget in characters (~4 chars/token, so ≈100k tokens) for models whose context window
 * we do not know for certain — deliberately conservative, since guessing too high brings back the
 * mid-task overflow. Below the threshold we never touch the history, so the cached prefix survives. */
const FALLBACK_COMPACT_CHARS = 400_000
/** Share of the context window we let the conversation fill before compacting; the rest is headroom
 * for the tool definitions, the next tool results and the model's own answer. */
const CONTEXT_BUDGET = 0.5

/** Character budget before compaction kicks in, derived from the model's context window if known. */
export function compactThreshold(contextTokens?: number): number {
  return contextTokens ? Math.round(contextTokens * CONTEXT_BUDGET * 4) : FALLBACK_COMPACT_CHARS
}
/** The same budget in TOKENS — what the projection below is compared against. */
export function contextBudgetTokens(contextTokens?: number): number {
  return contextTokens ? Math.round(contextTokens * CONTEXT_BUDGET) : Math.round(FALLBACK_COMPACT_CHARS / 4)
}

/**
 * How many tokens the next request will carry, as well as it can be known: the provider's own count
 * for the last request plus the four-characters-a-token guess for what has been appended since.
 *
 * The trigger used to be characters divided by four for the whole conversation, which is
 * off by a third either way — German prose runs to three characters a token, dense JSON tool
 * results to under three, and the tool definitions (tens of thousands of tokens, identical every
 * round) were not counted at all. Every round reports `prompt_tokens` for exactly the messages it was
 * sent, so most of the figure is a measurement and only the delta is a guess. The measurement is
 * dropped the moment the messages are rewritten (compaction), because it then describes a
 * conversation that no longer exists; the guess carries the round until the next count arrives.
 */
export function projectTokens(
  messages: ChatMessage[],
  measured: { promptTokens: number; chars: number } | null
): number {
  const chars = estimateChars(messages)
  if (!measured) return Math.round(chars / 4)
  return measured.promptTokens + Math.round(Math.max(0, chars - measured.chars) / 4)
}
/** Emit a reasoning-progress tick roughly every this many characters (~a line of thought). */
const REASONING_TICK_CHARS = 400

/** How many of the most recent tool-call rounds stay verbatim when compacting. */
const KEEP_ROUNDS = 3
/** Hard cap on 'context'-error rescues per run, so we can never loop on a hopeless request. */
const MAX_CONTEXT_RETRIES = 2
const OMITTED_TOOL = '[earlier tool result omitted to fit the context]'
const OMITTED_IMAGE = '[earlier canvas screenshot omitted to fit the context]'

/**
 * Tool results that are given up LAST when the context has to shrink.
 *
 * Age alone is the wrong criterion, because the biggest block and the least replaceable one are
 * often the same message. Measured in a live run: `get_skill` returned 49.364 characters —
 * the largest single tool output of the whole turn — and it carries the method rules the assistant
 * works from. Dropping it does not produce an error; it produces quietly worse decisions for the
 * rest of the run, which is the failure mode that costs the most to notice.
 *
 * The sub-agent tools are here for the opposite reason: their results were bought. A `research_web`
 * leg is a paid web search and `review_model` is a second model's opinion — $0.77 of one $2.38 run.
 * Nothing in the model can reproduce them, so freeing their context means paying for them again.
 *
 * Everything not listed is re-fetchable in one cheap call against the open model (`list_activities`,
 * `get_process_details`, a search), so it goes first. This is a PREFERENCE, never a guarantee —
 * see the escalation in {@link compactMessages}.
 */
const PROTECTED_TOOLS = new Set(['get_skill', 'research_web', 'research_bom', 'review_model'])

/**
 * Detect a reply that has collapsed into repeating itself, so the run can be cut off.
 *
 * The existing guard (see `repeats` further down) only watches for identical *tool calls*. Degenerate
 * *text* had nothing watching it: one model looped on the same short sentence several hundred times
 * and kept going, because the cost breaker only settles up between rounds and so cannot end a single
 * runaway reply.
 *
 * Looks at the tail only, and demands a long stretch of exact repetition (both a minimum number of
 * repeats and a minimum number of characters). A markdown table or a list can legitimately repeat a
 * short fragment; several hundred characters of byte-identical text at the end of a reply is not
 * something a working model produces.
 */
const REPEAT_TAIL = 4000
const REPEAT_MIN_REPEATS = 8
const REPEAT_MIN_CHARS = 400
const REPEAT_MAX_PERIOD = 200

/**
 * Rounds in a row whose every tool call came back rejected or failed, before the loop says so and
 * before it stops. The repeat guard catches the SAME call again; this catches a model that keeps
 * varying a call that cannot land — six `plan` rejections in one run (V364), five
 * differently-spelled `edit_exchange` refusals on a uid that did not exist — where every round is a
 * new attempt and none of them moves the model. Nudged once (reading the error is usually enough),
 * stopped after twice that, as the repetition detector stops a reply: a run that has been told the
 * same thing six times is not going to hear it the seventh.
 */
const STALL_NUDGE_AT = 3
const STALL_STOP_AT = 6

export function runawayRepetition(text: string): { unit: string; repeats: number } | null {
  if (text.length < REPEAT_MIN_CHARS) return null
  const tail = text.slice(-REPEAT_TAIL)
  for (let period = 2; period <= REPEAT_MAX_PERIOD; period++) {
    if (tail.length < period * REPEAT_MIN_REPEATS) break
    const unit = tail.slice(tail.length - period)
    if (!/\S/.test(unit)) continue // a run of blank lines is not a collapse
    let repeats = 1
    let pos = tail.length - period
    while (pos - period >= 0 && tail.startsWith(unit, pos - period)) {
      repeats++
      pos -= period
    }
    if (repeats >= REPEAT_MIN_REPEATS && repeats * period >= REPEAT_MIN_CHARS) return { unit, repeats }
  }
  return null
}

/**
 * True when a reply announces work it then did not do — "Let me batch all these:" with no tool call
 * following. The loop ends whenever a round produces no tool calls, which normally means "answered";
 * in this shape it means the opposite, and the run stops with the model half-applied and the user told
 * nothing. Deliberately narrow: only the trailing sentence counts, and only announcements of an
 * action about to be taken.
 */
export function announcesUnfinishedWork(text: string): boolean {
  const tail = text
    .trimEnd()
    .split('\n')
    .filter((l) => l.trim())
    .slice(-2)
    .join(' ')
    .trim()
  if (!tail) return false
  if (
    !/(?:^|[.!?:]\s|\s)(let me|let's|i'll|i will|now i|next,? i|i am going to|i'm going to)\b/i.test(tail)
  ) {
    return false
  }
  // "Let me know if …" and "let's talk about" hand back to the user; they are not abandoned work.
  if (/\blet me know\b|\blet's discuss\b|\blet me summarise\b|\blet me summarize\b/i.test(tail)) return false
  return true
}

/** Rough size of the conversation as sent to the model (JSON for multi-part content). */
export function estimateChars(messages: ChatMessage[]): number {
  let n = 0
  for (const m of messages) {
    n += typeof m.content === 'string' ? m.content.length : m.content ? JSON.stringify(m.content).length : 0
    if (m.tool_calls) n += JSON.stringify(m.tool_calls).length
  }
  return n
}

/**
 * Shrink the conversation in place: everything older than the last `keepRounds` tool-call rounds
 * loses its bulk — tool results and canvas screenshots become short stubs. A 40-round run with
 * 30k-char tool results would otherwise grow until the provider rejects the request outright.
 *
 * Roles and `tool_call_id`s are preserved: an assistant tool-call turn MUST keep a matching tool
 * message or the whole request becomes invalid. The system prompt and the user's messages are never
 * touched — only tool output and images, which is where the volume is.
 *
 * Within "older than keepRounds", replaceability decides the order: {@link PROTECTED_TOOLS} results
 * are given up only when a first pass over everything else freed nothing at all. That escalation is
 * what keeps this a preference — the caller at the 'context' rescue treats a return of 0 as "this
 * request is hopeless" and surfaces the error, so protection must never be able to produce a 0 while
 * anything is still shrinkable.
 *
 * No effect on prompt caching: this runs only once the conversation is already over the threshold,
 * and a compaction rewrites the prefix from its first stub onwards either way. Sparing an early,
 * bulky message moves that first stub LATER, so the prefix shared with the previous request gets
 * longer rather than shorter.
 *
 * Returns how many messages were shrunk (0 = nothing to do).
 */
/**
 * Shrink one user message's content parts, or return null if there was nothing bulky in them.
 *
 * A screenshot has nowhere to go, so it becomes a note. An attachment does: it is stored with the
 * project, so its caption becomes a stub that says which file it was and how to open it again
 * (attachments.ts). The prose the user actually typed is never touched — the whole point of the
 * exercise is that the question survives while the 80-page PDF behind it steps aside.
 */
function shrinkUserParts(
  parts: Array<Record<string, unknown>>
): Array<Record<string, unknown>> | string | null {
  const textOf = (p: Record<string, unknown>): string =>
    typeof p.text === 'string' ? (p.text as string) : ''
  const isAttachment = parts.some((p) => stubForPartText(textOf(p)))
  // A canvas screenshot is the whole message: its "Canvas screenshot:" label means nothing once the
  // picture is gone, so the message becomes the note and nothing else. This is the older of the two
  // cases and stays exactly as it was.
  if (!isAttachment) return parts.some((p) => p.type === 'image_url') ? OMITTED_IMAGE : null

  // An attached file sits next to the user's own question, which must survive. So the parts are
  // shrunk one by one: the bytes go, the caption becomes the stub that says how to get them back.
  let bulky = false
  const kept: Array<Record<string, unknown>> = []
  for (const p of parts) {
    if (p.type === 'image_url' || p.type === 'file') {
      bulky = true
      continue
    }
    const text = textOf(p)
    const stub = text ? stubForPartText(text) : null
    if (stub) {
      // An inline attachment (a converted spreadsheet, say) IS its own bulk; a caption beside a PDF
      // is not, but it must still become a stub, or it would promise a file that is no longer there.
      if (text.length > stub.length) bulky = true
      kept.push({ type: 'text', text: stub })
      continue
    }
    kept.push(p)
  }
  if (!bulky) return null
  // One text part left means the array shape has stopped earning itself.
  if (kept.length === 1 && kept[0].type === 'text') return String(kept[0].text ?? '')
  return kept
}

export function compactMessages(messages: ChatMessage[], keepRounds: number, dropped?: string[]): number {
  // Walk back to the start of the OLDEST round we want to keep; an assistant message carrying
  // tool_calls marks the start of a round. Everything before that index gets stubbed — which
  // includes the tool results of older rounds, since those follow their assistant message.
  let cut = keepRounds < 1 ? messages.length : 0
  let seen = 0
  for (let i = messages.length - 1; i >= 0 && keepRounds >= 1; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.tool_calls?.length) {
      seen++
      if (seen === keepRounds) {
        cut = i
        break
      }
    }
  }
  // A `role:'tool'` message carries only the id of the call it answers, so the name has to come
  // from the assistant turn that made it.
  const toolNames = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) toolNames.set(tc.id, tc.function.name)
    }
  }
  const isProtected = (m: ChatMessage): boolean =>
    m.role === 'tool' && PROTECTED_TOOLS.has(toolNames.get(m.tool_call_id ?? '') ?? '')
  // The newest `plan` result is the model's own checklist — a few hundred characters that say what
  // is done and what is not. It is never stubbed, in either sweep; OLDER plan results are superseded
  // lists and go with everything else.
  const latestPlan = latestPlanResult(messages, toolNames)

  const sweep = (sacrificeProtected: boolean): number => {
    let n = 0
    for (let i = 0; i < cut; i++) {
      const m = messages[i]
      if (m.role === 'tool' && typeof m.content === 'string' && m.content !== OMITTED_TOOL) {
        if (m === latestPlan) continue
        if (!sacrificeProtected && isProtected(m)) continue
        dropped?.push(m.content) // kept for the summariser, so the gist survives the truncation
        m.content = OMITTED_TOOL
        n++
      } else if (m.role === 'user' && Array.isArray(m.content)) {
        // The two kinds of bulk a user message can carry, both as base64 data URLs: canvas
        // screenshots and the files the user attached.
        const shrunkContent = shrinkUserParts(m.content)
        if (shrunkContent) {
          m.content = shrunkContent
          n++
        }
      }
    }
    return n
  }

  const shrunk = sweep(false)
  if (shrunk) return shrunk
  // Nothing replaceable was left. Keeping the expensive results now would mean returning 0, which
  // the rescue path reads as "hopeless" — a lost run is worse than a lost skill text.
  const forced = sweep(true)
  if (forced) console.log(`[prism-ai] context still over budget — gave up ${forced} protected tool result(s)`)
  return forced
}

/** The most recent `plan` tool result in a transcript, or null. */
function latestPlanResult(messages: ChatMessage[], toolNames: Map<string, string>): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'tool' && toolNames.get(m.tool_call_id ?? '') === 'plan') return m
  }
  return null
}

/** Don't bother summarising trivial amounts, and never feed the summariser more than this. */
const SUMMARY_MIN_CHARS = 4_000
const SUMMARY_MAX_INPUT = 60_000

/**
 * Condense the tool output we just dropped into a few lines the agent can keep working from.
 *
 * Summarising beats plain truncation measurably: OpenHands report ~2× lower API cost from their
 * summarising condenser with no drop in agent performance, because the agent stops re-fetching what
 * it already learned. Best-effort by design — on any failure the run continues with the stubs alone.
 *
 * Runs on the CHAT model (`summaryModel` is its id), not on a cheap one of its own. It had its own
 * setting and a cheap default for a while: the call is rare and capped at 60k
 * characters, so the cheap tier saved cents — while what it writes replaces what the agent read,
 * and a lost database name or a number without its unit costs a re-fetch worth more than those cents.
 */
async function summariseDropped(
  dropped: string[],
  summaryModel: string,
  /** The run's pinned provider: the chat model's id only means something there. Without it the
   *  dispatcher would use whichever provider is active at compaction time, substitute its default
   *  for an id it does not serve, and book the usage under the id it never used. */
  provider: ProviderId,
  signal?: AbortSignal,
  onCost?: (
    modelId: string,
    u: { cost?: number; prompt?: number; cached?: number; completion?: number }
  ) => void
): Promise<string | null> {
  const joined = dropped.join('\n---\n')
  if (joined.length < SUMMARY_MIN_CHARS) return null
  try {
    const out = await collectText({
      model: summaryModel,
      provider,
      signal,
      onCost,
      messages: [
        {
          role: 'system',
          content:
            'You compress tool output for an LCA agent whose context is full. Reply with at most 12 terse bullet points ' +
            'capturing ONLY facts the agent will still need: names, codes, database names, numbers with units, methods, ' +
            'and anything it already tried. No prose, no preamble, no advice.'
        },
        { role: 'user', content: joined.slice(0, SUMMARY_MAX_INPUT) }
      ]
    })
    return out.trim() || null
  } catch {
    return null // never let the summariser break the run
  }
}

// AgentEvent/ToolTrace live in shared/ipc.ts so main, preload and renderer read one definition;
// re-exported here because this module is where the events are produced and long-standing imports
// point at it.
export type { AgentEvent, ToolTrace } from '../../shared/ipc'

export interface AgentDeps {
  /** Raw backend request (status + body). */
  apiRaw: (
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ) => Promise<{ status: number; body: unknown }>
  /** Round-trip a UI action to the renderer. */
  callUiTool: (
    name: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal; chatId?: string; activeDb?: string | null }
  ) => Promise<any>
  /** Push an event to the renderer. */
  emit: (ev: AgentEvent) => void
  /** Enabled skills to offer the model. */
  getSkills: () => Promise<Skill[]>
  /** Record a real API cost sample (USD) for the ledger. Optional; must never throw. */
  /** Book one request's usage. Called for every model a turn touches, side runs included. */
  recordUsage?: (
    modelId: string,
    u: { cost?: number; prompt?: number; cached?: number; completion?: number }
  ) => void
  /** Measure transport legs (main/distance), bound by the chat IPC to the run's call budget and the
   *  user's keys. Absent when the feature is off for this chat — the tool is then not offered. */
  distances?: (mode: unknown, pairs: unknown) => Promise<unknown>
  /** Query Eurostat's waste statistics (main/eurostat). Absent when the feature is off for this
   *  chat — the tool is then not offered. */
  eurostat?: (args: unknown) => Promise<unknown>
  /**
   * Persist the chat's plan — the accepted revision, or null when the model withdrew it. The chat IPC
   * writes it to the store; the run only emits the `plan` event. Absent in tests and wherever no
   * store exists: the plan then lives for the run only.
   */
  persistPlan?: (plan: ChatPlan | null, explanation?: string) => Promise<void>
  /**
   * A tool of this run renamed the chat's own model. The backend has moved the stored chats already;
   * the chat IPC moves what it still writes (run state, plan, transcript, the answer) to the new name.
   */
  onModelRenamed?: (name: string) => void
  /**
   * The transcript on disk (chat IPC → backend `…/transcript`): read on a miss in the in-memory map,
   * written on EVERY exit of a run — the memory map alone lost the tool history on abort, error and
   * restart, which is V18.
   */
  transcriptStore?: {
    load: (chatId: string) => Promise<StoredTranscript | null>
    save: (chatId: string, t: StoredTranscript) => Promise<void>
  }
  /**
   * Messages the user typed while this run was working (ipc/chat.ts `ai:steer`), handed over and
   * emptied in one call. The loop asks at every round boundary — after the current tool batch, before
   * the next request — and again when the model is about to finish, so a late message starts another
   * round instead of being lost. Absent = no steering (tests, the report writer).
   */
  takeSteering?: () => string[]
}

export type HistoryTurn = { role: 'user' | 'assistant'; content: string; attachments?: AttachmentMeta[] }

/** What `keepTranscript` keeps — in memory and, through the store, on disk. */
export interface StoredTranscript {
  turnId: string
  historyAfter: HistoryTurn[]
  messages: ChatMessage[]
}

/** Upper bound of a transcript file; above it whole rounds are dropped, never bytes (see boundTranscript). */
export const TRANSCRIPT_MAX_BYTES = 6 * 1024 * 1024

/**
 * The last turn's real message array per chat — tool calls and tool results included.
 *
 * The renderer's `history` is prose only (that is what it displays and persists), so without this
 * the model starts every follow-up blind to what it just did. Rather than widen the IPC contract
 * and push tool payloads into renderer storage, main keeps the transcript and hands it back only
 * when the renderer's history is EXACTLY the history this transcript ended with. Any divergence —
 * app restart, a reloaded chat, an edited or deleted message, a different chat reusing an id —
 * misses and falls back to the prose history, which is always correct if larger.
 *
 * Bounded twice over: a handful of chats here, and the context window inside a turn (compaction).
 */
const transcripts = new Map<string, StoredTranscript>()
const MAX_TRANSCRIPTS = 8

/**
 * The prose that matters for matching: an assistant turn with NO text (a run stopped while it was
 * still calling tools) is dropped on both sides, because whether the renderer shows such a turn as
 * an empty bubble or not at all is its business, and a transcript must not be lost over it.
 */
const proseOf = (h: HistoryTurn[]): HistoryTurn[] => h.filter((m) => !(m.role === 'assistant' && !m.content))

export function sameHistory(a: HistoryTurn[], b: HistoryTurn[]): boolean {
  const x = proseOf(a)
  const y = proseOf(b)
  if (x.length !== y.length) return false
  return x.every((m, i) => m.role === y[i].role && m.content === y[i].content)
}

/**
 * Every tool call has its result and every result has its call — the shape a provider accepts. A
 * transcript that fails this is not repaired, it is dropped (and the turn rebuilt from prose).
 */
export function wellPaired(messages: ChatMessage[]): boolean {
  const open = new Set<string>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) open.add(tc.id)
    else if (m.role === 'tool') {
      if (!m.tool_call_id || !open.has(m.tool_call_id)) return false
      open.delete(m.tool_call_id)
    }
  }
  return open.size === 0
}

/**
 * Give every tool call that never got a result one that says so. The loop records a round's calls
 * before it runs them and stops between call groups on Stop or the cost breaker, so a transcript
 * saved at that moment would hold calls without answers — and the next request would be invalid.
 * Nothing here re-runs anything: a write whose outcome is unknown is for the model to check, which
 * the resume note tells it.
 */
export function closeOpenCalls(messages: ChatMessage[]): number {
  const answered = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id))
  let added = 0
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue
    const missing = m.tool_calls.filter((tc) => !answered.has(tc.id))
    if (!missing.length) continue
    // Right after the calls' existing results, so the pairs stay together.
    let at = i + 1
    while (at < messages.length && messages[at].role === 'tool') at++
    messages.splice(
      at,
      0,
      ...missing.map(
        (tc): ChatMessage => ({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({
            error:
              'not executed — the run stopped before this call ran, or while it was running; its outcome is unknown. Check before repeating it.'
          })
        })
      )
    )
    added += missing.length
    i = at + missing.length - 1
  }
  return added
}

/**
 * The carried transcript for this chat (system message excluded), or null to rebuild from prose:
 * first the in-memory map, then the store — a restart empties the map, the file survives it.
 */
/**
 * Does the stored transcript end where this history ends — or where it ended before the user typed
 * more? Returns the user turns that follow the stored end (none when the histories are equal), or
 * null when the stored history is not a prefix. The trailing case is a restart in the middle of a
 * follow-up: the renderer had already persisted the new user message, the run never answered it, and
 * the transcript of the turn before is still the right memory.
 */
export function historyTail(stored: HistoryTurn[], history: HistoryTurn[]): HistoryTurn[] | null {
  const x = proseOf(stored)
  const y = proseOf(history)
  if (y.length < x.length) return null
  if (!x.every((m, i) => m.role === y[i].role && m.content === y[i].content)) return null
  const tail = y.slice(x.length)
  return tail.every((m) => m.role === 'user') ? tail : null
}

async function takeTranscript(
  chatId: string,
  history: HistoryTurn[],
  store?: AgentDeps['transcriptStore']
): Promise<{ messages: ChatMessage[]; trailing: HistoryTurn[] } | null> {
  const hit = transcripts.get(chatId)
  const fromMap = hit ? historyTail(hit.historyAfter, history) : null
  if (hit && fromMap) return { messages: hit.messages, trailing: fromMap }
  if (!store) return null
  const disk = await store.load(chatId).catch(() => null)
  if (!disk || !Array.isArray(disk.messages) || !Array.isArray(disk.historyAfter)) return null
  const trailing = historyTail(disk.historyAfter, history)
  if (!trailing) return null
  if (!wellPaired(disk.messages)) {
    console.log(
      `[prism-ai] stored transcript of chat ${chatId} has unpaired tool calls — rebuilding from prose`
    )
    return null
  }
  transcripts.set(chatId, disk)
  return { messages: disk.messages, trailing }
}

/**
 * Fit a transcript under TRANSCRIPT_MAX_BYTES without ever cutting JSON: first the stubs compaction
 * already knows (old tool results, screenshots, attachments), then the OLDEST complete rounds — an
 * assistant call message with its results and whatever the loop interjected before the next round.
 * The task statement, the last round and the final answer stay. Returns null when even that does not
 * fit (a single round over the limit): then nothing is written and the old file stands.
 */
export function boundTranscript(
  messages: ChatMessage[],
  maxBytes: number,
  plan: ChatPlan | null
): ChatMessage[] | null {
  const bytes = (ms: ChatMessage[]): number => Buffer.byteLength(JSON.stringify(ms), 'utf8')
  const out = messages.map((m) => ({ ...m }))
  if (bytes(out) <= maxBytes) return out
  compactMessages(out, KEEP_ROUNDS)
  // Only tool-call GROUPS are evicted — the assistant's call message and its results. Prose stays:
  // a user instruction given between rounds is a constraint, not bulk, and so
  // do the loop's notes and every earlier answer.
  const groupStarts = (): number[] =>
    out.map((m, i) => (m.role === 'assistant' && m.tool_calls?.length ? i : -1)).filter((i) => i >= 0)
  let lostPlan = false
  while (bytes(out) > maxBytes) {
    const starts = groupStarts()
    if (starts.length < 2) return null // never drop the last group
    const from = starts[0]
    let to = from + 1
    while (to < out.length && out[to].role === 'tool') to++
    const names = new Map<string, string>()
    for (const m of out)
      if (m.role === 'assistant' && m.tool_calls)
        for (const tc of m.tool_calls) names.set(tc.id, tc.function.name)
    const latest = latestPlanResult(out, names)
    if (latest && out.indexOf(latest) >= from && out.indexOf(latest) < to) lostPlan = true
    out.splice(from, to - from)
  }
  if (lostPlan && plan) {
    // The checklist went with its round; put the accepted revision back where the model reads last.
    const lastAssistant = out.length - 1
    const note: ChatMessage = {
      role: 'user',
      content: `Current plan (carried over):\n${formatPlanForModel(plan)}`
    }
    if (out[lastAssistant]?.role === 'assistant' && !out[lastAssistant].tool_calls)
      out.splice(lastAssistant, 0, note)
    else out.push(note)
  }
  return out
}

async function keepTranscript(
  chatId: string,
  turnId: string,
  historyBefore: HistoryTurn[],
  userText: string,
  finalText: string,
  messages: ChatMessage[],
  plan: ChatPlan | null,
  store?: AgentDeps['transcriptStore']
): Promise<void> {
  // What the renderer's history will be on the next turn: main persists the assistant answer
  // (ipc/chat.ts) and the renderer the user's message, so the next `history` is this exactly —
  // `sameHistory` tolerates the empty assistant turn either way.
  // Only what matching reads (role, content): the renderer's history objects may carry traces and
  // attachment metadata, which would bloat the record and count against the backend's limit.
  const historyAfter: HistoryTurn[] = [
    ...historyBefore.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText },
    { role: 'assistant', content: finalText }
  ]
  // Drop the system message: it is rebuilt per turn (active model, skills, web-search state).
  const body = messages.filter((m) => m.role !== 'system')
  const record: StoredTranscript = { turnId, historyAfter, messages: body }
  transcripts.set(chatId, record)
  if (transcripts.size > MAX_TRANSCRIPTS) {
    const oldest = transcripts.keys().next().value
    if (oldest !== undefined) transcripts.delete(oldest)
  }
  if (!store) return
  // The backend measures the WHOLE record (turn id, history, messages, its own fields), so the
  // messages get what is left after the rest, with a margin for the wire format.
  const overhead =
    Buffer.byteLength(JSON.stringify({ turn_id: turnId, history_after: historyAfter }), 'utf8') + 4096
  const bounded = boundTranscript(body, Math.max(0, TRANSCRIPT_MAX_BYTES - overhead), plan)
  if (!bounded) {
    console.log(
      `[prism-ai] transcript of chat ${chatId} does not fit ${TRANSCRIPT_MAX_BYTES} bytes even as rounds — not written`
    )
    return
  }
  try {
    await store.save(chatId, { turnId, historyAfter, messages: bounded })
  } catch (e) {
    // Said, not swallowed — but never fatal: the memory map still has it for this process.
    console.log(
      `[prism-ai] transcript of chat ${chatId} could not be written: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}

/** Forget a chat's transcript (chat deleted, or the model/project it belonged to changed). */
export function forgetTranscript(chatId?: string): void {
  if (chatId === undefined) transcripts.clear()
  else transcripts.delete(chatId)
}

export interface AgentRequest {
  chatId: string
  model: string
  activeDb: string | null
  history: Array<{ role: 'user' | 'assistant'; content: string; attachments?: AttachmentMeta[] }>
  userText: string
  /** Files attached to THIS message, already stored in the project (main/ai/attachments.ts). Only
   *  the description crosses IPC; the content is fetched here, once, when the turn is built. */
  attachments?: AttachmentMeta[]
  maxRounds?: number // configurable tool-round budget (Settings); defaults high
  /** Circuit breaker: stop the run once this much USD was spent (Settings). 0/undefined = off. */
  maxCostUsd?: number
  /** Ceiling on each reply's length (Settings); clamped into the supported window before sending. */
  maxTokens?: number
  disabledTools?: string[] // tools switched off in Settings → AI-Tools; never offered to the model
  webSearch?: boolean // per-chat opt-in: attach OpenRouter's web_search/web_fetch server tools
  /** Ceiling on provider-side web lookups per reply (Settings → AI → Chat); 0/undefined = provider default. */
  webLookupsCap?: number
  /** App-wide web-search kill switch (Settings → AI → Chat). false = the research sub-agent refuses. */
  webSearchAllowed?: boolean
  /** The `distances` tool is offered and may run (per-chat toggle ∧ app setting ∧ a key). */
  distancesAvailable?: boolean
  /** The `eurostat_eol` tool is offered and may run (per-chat toggle ∧ app setting). */
  eurostatAvailable?: boolean
  /** Ceiling on parallel research legs per research_web call (Settings → AI → Limits). */
  maxResearchQuestions?: number
  /**
   * The read-only background databases installed, e.g. `ecoinvent-3.12-cutoff`, so the prompt can name
   * the data source instead of saying "ecoinvent". Sent from the renderer, which already has the list.
   * A model that only hears the generic word writes the version and the system model from memory: in
   * a live run the study metadata came out as "Cut-off (ecoinvent APOS)", two different system models
   * in one field, on a database plainly called `…-cutoff`.
   */
  backgroundDbs?: string[]
  /** Installed backgrounds switched off for this chat (see CanvasChat's "+" menu). */
  withheldBackgrounds?: string[]
  libraryDbs?: string[]
  /**
   * The models the active one is compared with (study metadata, symmetric) that this chat keeps
   * switched on. Their briefs are fetched per turn and appended to the system prompt.
   */
  comparisonModels?: string[]
  /** Settings → Modelling: the background to take when several released ones fit; '' = model decides. */
  preferredBackground?: string
  /**
   * Model for the isolated sub-agents — web research, BOM research and the critical review
   * (Settings → AI → Models). Empty = each keeps its own cheap default. It is deliberately its own
   * setting rather than "whatever the chat uses": the review is worth more when it is a second
   * opinion from a different model, and these legs bill under that model's name in the cost table,
   * which is confusing until it is stated somewhere the user can see.
   */
  researchModel?: string
  /** Reviewer for `review_model`; '' = the sub-agent's own default. Separate from the research
   *  model because a review is worth most as a SECOND opinion, which is a choice of its own. */
  reviewModel?: string
  /**
   * Experimental (Settings → AI → Limits): offer only the tool groups this conversation needs
   * instead of all of them. Smaller tool sets measurably improve selection accuracy, but the set is
   * part of the cached prompt prefix — see groupsForConversation for why it is picked per
   * CONVERSATION, not per turn.
   */
  focusTools?: boolean
  /**
   * The `plan` tool is offered to this model (models.ts `planTool`); false removes the tool, its
   * prompt paragraph AND its dispatch, in one place. Default true.
   */
  planTool?: boolean
  /** The chat's accepted plan at turn start (the store's), or null. */
  plan?: ChatPlan | null
  /**
   * The chat's previous run stopped with this outcome and the user is coming back to it: the model is
   * told so, and told to verify the model state before it continues — a step marked completed may have
   * been half applied, a call with an unknown outcome must be checked rather than repeated.
   */
  resumeFrom?: RunOutcome
  /**
   * The chat's confirmation card before irreversible tool actions (Settings → AI → Limits;
   * main/ai/approval.ts). Absent = 'irreversible': a caller that forgets the field gets the card,
   * never silently none.
   */
  approval?: ChatApprovalMode
  /** The reasoning effort chosen for this model (Settings → AI → Models); absent = the API's default. */
  reasoningEffort?: ReasoningEffort
  signal: AbortSignal
}

/** Storage cap for a traced result. Deliberately generous — a trace is only useful if it is readable.
 *  Raised from 2k once the batch tools landed: `search_background` with ten queries spent the whole
 *  old budget on the first one, so the trace showed a tenth of what the call actually did. */
export const TRACE_PREVIEW_CHARS = 6_000

/**
 * Storage cap for a traced call's arguments. The old 500 predates the batch parameters (V6/V7/V8):
 * a `research_web` with three questions was cut inside the first one, which is precisely the part
 * a reader needs to judge whether the call was the right one.
 *
 * Equal to {@link TRACE_PREVIEW_CHARS}, and equal to the backend's `_TRACE_ARG_CHARS`, on purpose.
 * The two ends had drifted apart in opposite directions — 2,500 live against 4,000 stored — so a
 * developer watching a run saw 62 % of what the record then kept, and both numbers were reached in
 * practice: an 18-parameter `edit_parameter` in a live run stored args cut at exactly 4,000.
 * The lesson is the same one the preview pair already learned: batching multiplied argument sizes, and
 * a cap that was generous for one item is not generous for eighteen.
 */
export const TRACE_ARGS_CHARS = 6_000

export interface AgentResult {
  text: string // everything the assistant said this turn (may be partial if aborted)
  aborted: boolean
  /** How the run ended — structured, for the run state and the Continue button; the italic note in
   *  `text` is for the reader. `aborted` stays for its long-standing callers (= outcome 'cancelled'). */
  outcome: RunOutcome
  /** The run's turn id — the audit group AND the key its transcript is stored under. */
  turnId: string
  /** Every tool call of this turn, in order. Empty when the model answered without tools. */
  trace: ToolTrace[]
  /** USD this turn cost, as OpenRouter billed it — stored with the message, since the cost limit is
   *  per run and a monthly per-model total cannot answer "what did that answer cost". */
  cost?: number
  /** What the turn consumed, stored with the message for the same reason the cost is: the monthly
   *  per-model ledger cannot tell two chats apart, so it can never answer "what has THIS conversation
   *  used". `promptTokens` INCLUDES `cachedTokens` — the cached ones are the share of the prompt the
   *  provider served from its prefix cache, not a separate bill. `completionTokens` includes
   *  reasoning tokens; no provider reports those reliably enough to split them out. */
  promptTokens?: number
  cachedTokens?: number
  completionTokens?: number
  /** The OpenRouter endpoint that served the turn, stored for the same reason: afterwards it is the
   *  only thing that separates a slow provider from a slow model. */
  provider?: string
  /** The prompt size of the turn's LAST round — how full the model's context was when it answered.
   *  Unlike `promptTokens` (a sum over rounds, the bill) this is a level, the context meter's figure. */
  contextTokens?: number
}

export { withUnknownFields } from './execute'

/** Trace-row name for the provider-side web lookups of a round. Not a tool: nothing dispatches on it. */
export const WEB_LOOKUPS_ROW = 'web_lookups'

/**
 * Put OpenRouter's `server_tool_use` counters into words. `web_search_requests` and
 * `web_fetch_requests` are the two known kinds; any other `*_requests` counter is named as it comes.
 * Returns null when nothing ran, so a round without lookups adds no row.
 */
export function describeWebLookups(
  use: Record<string, number> | undefined
): { short: string; preview: string; total: number } | null {
  if (!use || typeof use !== 'object') return null
  const parts: string[] = []
  let total = 0
  for (const [key, raw] of Object.entries(use)) {
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(n) || n <= 0) continue
    total += n
    const kind = key.replace(/_requests$/, '')
    const noun =
      kind === 'web_search'
        ? n === 1
          ? 'web search'
          : 'web searches'
        : kind === 'web_fetch'
          ? n === 1
            ? 'page fetched'
            : 'pages fetched'
          : `${kind.replace(/_/g, ' ')} ${n === 1 ? 'call' : 'calls'}`
    parts.push(`${n} ${noun}`)
  }
  if (!total) return null
  const short = parts.join(', ')
  const preview =
    `${short} — run by the provider inside this reply. Every lookup makes the model read the whole ` +
    `conversation again, so this round's input tokens and cost cover ${total + 1} passes, not one. ` +
    `Settings → AI → Chat caps how many lookups one reply may run.`
  return { short, preview, total }
}

export async function runAgent(req: AgentRequest, deps: AgentDeps): Promise<AgentResult> {
  // Provider-aware: an id belonging to the inactive provider (a stored choice after a switch)
  // resolves to the ACTIVE provider's default instead of travelling to the wrong API.
  const provider = getActiveProvider()
  const model = findModel(req.model, provider)
  // Web on for this chat: the app-wide kill switch and the chat's own "+" menu switch, both. One value
  // for the research helpers' refusal, for whether they and their skill are offered, and for the prompt.
  const webOn = req.webSearchAllowed !== false && req.webSearch !== false
  const skills = offeredSkills(await deps.getSkills().catch(() => []), { web: webOn })
  /** Switched off for this chat: not offered — and not executed either, whatever the model still
   *  remembers from earlier in the conversation. */
  const disabled = new Set(req.disabledTools ?? [])
  // One effective flag, enforced at the three places a tool can reach the model: the prompt
  // paragraph (buildSystemPrompt), the offered specs (toolSpecs) and dispatch (the executor's
  // disabled set) — a model that guesses the name anyway gets the same refusal as for a switched-off tool.
  const planTool = req.planTool !== false && !disabled.has('plan')
  if (!planTool) disabled.add('plan')

  // One id per run (= one chat turn). It rides as a header on every backend call of this run, the
  // bus stamps every executed command with it, and that is what groups a turn's changes in the
  // audit log and lets undo/redo take the whole turn back in one go.
  const turnId = `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

  // The study language (V291), the comparison models this chat may read and their briefs — fetched per
  // turn, so the prompt prefix changes only when one of them does (turnContext.ts).
  const turnContext = await loadTurnContext(deps.apiRaw, req.activeDb, req.comparisonModels)
  /** The chat's model as the run knows it now — a rename of it moves the chat (onModelRenamed). */
  let modelNow = req.activeDb

  // Every rule of running a tool — unknown, switched off, stop pressed, foreign tags in the
  // arguments, the repeat guard, the result shapes, the "did it mutate" verdict — lives in the
  // executor, shared with the MCP server (execute.ts). The chat only adds what is its own: the turn
  // header, the chat-bound UI round-trip, the model fence and the research closures with their cost meter.
  const session = createToolSession({
    apiRaw: deps.apiRaw,
    headers: () => ({ 'X-Prism-Turn': turnId }),
    // Bind the run's abort signal + chat so a pending ask_user question dies with the run and the
    // renderer can route the question card to the right chat.
    // The run's model travels too: a canvas tool must act on THIS model's canvas or not at all — with
    // two assistants working in parallel, the canvas on screen may well be another model's.
    // Read live: after a rename of the chat's model the canvas tools must name the new one.
    ui: (name, args) =>
      deps.callUiTool(name, args, { signal: req.signal, chatId: req.chatId, activeDb: session.ctx.activeDb }),
    activeDb: req.activeDb,
    // The chat works on its own model only (modelScope.ts); an MCP session has no fence.
    modelScope: turnContext.scope,
    disabledTools: disabled,
    // The chat model driving this run, for tools that record provenance — the study stamps which
    // LLM filled its goal & scope (V128), and only main knows the id.
    model: req.model,
    // Both switches, not just the app-wide one: a chat whose "+" menu says no web must get no web from
    // the research helpers either — they used to honour only the kill switch in Settings.
    webSearchAllowed: webOn,
    distancesAvailable: req.distancesAvailable === true,
    distances: deps.distances,
    eurostatAvailable: req.eurostatAvailable === true,
    eurostat: deps.eurostat,
    libraryDbs: req.libraryDbs,
    backgroundDbs: req.backgroundDbs,
    preferredBackground: req.preferredBackground,
    maxResearchQuestions: req.maxResearchQuestions,
    // The research sub-agent is injected (not imported by tools.ts) and inherits the run's abort
    // signal, so pressing Stop also kills any in-flight research legs.
    // Empty = each leg keeps its own default (see subagent.ts). Research and review are two
    // settings, not one: research wants cheap, web-capable and many parallel legs, while the
    // reviewer being a DIFFERENT model from the chat is the feature — in a live run it
    // was the reviewer that caught the chat model's own dataset mistake.
    // Both research closures meter what ONE invocation cost — legs, retries and the provider's
    // web-search fee ride in usage.cost, which the monthly ledger books per model where a research
    // fan is indistinguishable from chat traffic (the V244 confusion). The tally goes back on the
    // result so the tool answer can say what the fan it just ordered came to.
    research: async (o) => {
      const tally = { usd: 0, requests: 0 }
      const meter: typeof onCost = (m, u) => {
        tally.usd += u.cost ?? 0
        tally.requests += 1
        onCost(m, u)
      }
      const r = await researchBom({
        ...o,
        model: req.researchModel || undefined,
        signal: req.signal,
        onCost: meter,
        onProgress: (note) =>
          deps.emit({
            chatId: req.chatId,
            type: 'tool',
            name: 'research_bom',
            phase: 'progress',
            detail: note
          })
      })
      return { ...r, cost: { requests: tally.requests, usd: Number(tally.usd.toFixed(4)) } }
    },
    researchWeb: async (o) => {
      const tally = { usd: 0, requests: 0 }
      const meter: typeof onCost = (m, u) => {
        tally.usd += u.cost ?? 0
        tally.requests += 1
        onCost(m, u)
      }
      const r = await researchWeb({
        ...o,
        model: req.researchModel || undefined,
        signal: req.signal,
        onCost: meter,
        onProgress: (note) =>
          deps.emit({
            chatId: req.chatId,
            type: 'tool',
            name: 'research_web',
            phase: 'progress',
            detail: note
          })
      })
      return { ...r, cost: { requests: tally.requests, usd: Number(tally.usd.toFixed(4)) } }
    },
    review: (o) => reviewDossier({ ...o, model: req.reviewModel || undefined, signal: req.signal, onCost }),
    // The confirmation card before an irreversible action — the MCP sessions' card (approve_tool,
    // uiBridge), on the same effects table, with the chat's own rule (approval.ts). The answer sets
    // `preApproved`, so a tool with a question of its own (the custom-method deletes) asks once, not
    // twice; `runOne` clears it after the call.
    beforeRun: async (name, args, effect) => {
      session.ctx.preApproved = false
      if (!needsChatApproval(req.approval, name, effect)) return
      let r: unknown
      try {
        r = await deps.callUiTool(
          'approve_tool',
          // The card names what the call acts on (its own arguments), not the model on screen.
          {
            tool: name,
            effect,
            args,
            target: approvalTarget(name, args, req.activeDb),
            database: req.activeDb
          },
          { signal: req.signal, chatId: req.chatId, activeDb: req.activeDb }
        )
      } catch (e) {
        if (req.signal.aborted) throw e
        throw new Error(APPROVAL_UNANSWERED)
      }
      if (!(r && typeof r === 'object' && (r as { approved?: unknown }).approved === true))
        throw new Error(APPROVAL_DECLINED)
      session.ctx.preApproved = true
    }
  })
  const ctx = session.ctx

  // The chat's plan: the tool reads and writes it here, the IPC persists it, the renderer draws it.
  let currentPlan: ChatPlan | null = req.plan ?? null
  if (planTool) {
    ctx.plan = {
      current: () => currentPlan,
      update: async (next, explanation) => {
        currentPlan = next
        await deps.persistPlan?.(next, explanation)
        deps.emit({ chatId: req.chatId, type: 'plan', plan: next })
      }
    }
  }

  const { studyLanguage, comparisonBriefs } = turnContext

  const systemText = buildSystemPrompt({
    activeDb: req.activeDb,
    modelScope: true,
    skills,
    studyLanguage,
    comparisonBriefs,
    isNewChat: req.history.length === 0,
    webSearch: req.webSearch,
    distances: req.distancesAvailable === true && !!deps.distances,
    eurostat: req.eurostatAvailable === true && !!deps.eurostat,
    research: webOn,
    planTool,
    // With the card off, the prompt goes back to asking the model to confirm itself (approval.ts).
    approvalGate: (req.approval ?? 'irreversible') !== 'never',
    // Sent by the renderer, which has the database list on screen anyway — a lookup here would be a
    // backend round trip per turn for something that changes when ecoinvent is imported.
    backgroundDbs: req.backgroundDbs,
    preferredBackground: req.preferredBackground,
    withheldBackgrounds: req.withheldBackgrounds,
    libraryDbs: req.libraryDbs
  })
  // Continue the real transcript when this chat already has one — tool calls and their results
  // included. `req.history` carries only prose, so rebuilding from it throws away everything the
  // model did: measured in one run, a follow-up turn arrived with 16.5k prompt tokens (of which
  // ~13.2k are the tool schemas) after a build turn that had grown to ~123k, and the model then
  // answered questions about its own work from memory of its summaries — wrongly. It also had to
  // re-read parameters, scenarios, tags and goal & scope just to change ONE exchange.
  // Size is handled where it belongs: compactMessages/summariseDropped shrink under pressure and
  // keep the last rounds intact, so the transcript is bounded by the context window, not by turns.
  const taken = await takeTranscript(req.chatId, req.history, deps.transcriptStore)
  const carried = taken?.messages ?? null
  // User turns the transcript does not cover yet (a restart mid follow-up): appended as prose, in order.
  const trailingTurns: ChatMessage[] = (taken?.trailing ?? []).map(
    (m) => ({ role: m.role, content: historyContent(m) }) as ChatMessage
  )
  // Seed "already looked at" from the carried transcript: a dataset opened in an earlier turn is
  // still opened, and a reminder to go and read it again would be noise. Reading the assistant's own
  // tool CALLS (not their results) is enough — the arguments name the codes.
  for (const m of carried ?? []) {
    if (m.role !== 'assistant') continue
    for (const tc of (m as { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> })
      .tool_calls ?? []) {
      if (tc.function?.name !== 'get_process_details') continue
      try {
        const args = JSON.parse(tc.function.arguments || '{}')
        const db = args.database ?? req.activeDb
        const codes: unknown[] = Array.isArray(args.codes) ? args.codes : [args.code]
        for (const c of codes) if (db && c) ctx.inspected?.add(inspectedKey(String(db), String(c)))
      } catch {
        // Unparseable arguments only mean one fewer seed; the reminder erring towards "go and look"
        // is the harmless direction.
      }
    }
  }
  // Attached files ride WITH the user's turn as extra content parts — a PDF or an image as itself,
  // a spreadsheet as the Markdown the backend converted. `userText` stays the prose the user typed,
  // because that is what the renderer persists and what `keepTranscript` has to match next turn.
  const attached = req.attachments?.filter((a) => a.id && !a.error) ?? []
  // What changes from turn to turn rides on the USER turn, not in the system prompt (V418):
  // the study language (unset in turn 1, "de" by turn 2 of every build) and the
  // new-chat title instruction were the two lines that made the system block of turn 2 differ from
  // turn 1 — and a changed system block invalidates the entire cached prefix, so the first follow-up
  // question of a long chat paid the whole context uncached (0.82 $ / 263k tokens, twice measured).
  // Here it sits behind the cached prefix and costs a few tokens. The renderer shows `userText`.
  const langName = studyLanguage ? (LANGUAGE_NAMES[studyLanguage] ?? studyLanguage) : undefined
  const turnNote = [
    langName ? `[Study language: ${langName}]` : '[No study language recorded yet]',
    req.history.length === 0
      ? 'This is a NEW chat: your first action must be to call `set_chat_title` with a short, punchy title (3–6 words) for the conversation. Do not mention the title to the user.'
      : ''
  ]
    .filter(Boolean)
    .join('\n')
  const notedText = req.userText ? `${turnNote}\n\n${req.userText}` : turnNote
  const userContent: ChatMessage['content'] = attached.length
    ? [
        { type: 'text', text: notedText },
        ...(await attachmentParts(attached, deps.apiRaw, { vision: model.vision }).catch(() => [
          { type: 'text', text: '[the attached files could not be read]' }
        ]))
      ]
    : notedText
  // A cached transcript may hold image parts from a run on a vision model; the model chosen now may
  // not see, and the transport does not strip them — a 400 for the whole turn.
  const carriedForModel = carried && !model.vision ? withoutImages(carried) : carried
  // What the model is told before the user's new message: the plan it cannot see when the transcript
  // was rebuilt from prose (the carried transcript holds the `plan` result itself), and — after a
  // stopped run — that it has to look before it continues. One message, in the user role, like the
  // compaction summary; never the system prompt, which sits behind the cache breakpoint.
  const prefaceParts: string[] = []
  if (!carriedForModel && currentPlan)
    prefaceParts.push(`Current plan (from the previous run):\n${formatPlanForModel(currentPlan)}`)
  if (req.resumeFrom && req.resumeFrom !== 'answered')
    prefaceParts.push(
      `The previous run stopped (${RESUME_REASON[req.resumeFrom]}). Verify the model state before continuing — ` +
        `steps marked completed may have been applied only partly, and a tool call whose outcome is unknown ` +
        `must be checked, not repeated blindly.`
    )
  // Messages queued while the PREVIOUS run was working (Stop, or its last instant) belong before the
  // message that starts this one: they are older. Drained once here; appended after `userContent`
  // they read as the newest correction and reversed the user's chronology.
  const leftover = (deps.takeSteering?.() ?? []).map((t) => t.trim()).filter(Boolean)
  for (const t of leftover)
    prefaceParts.push(`(Sent while the previous run was working, before the message below.) ${t}`)
  const preface: ChatMessage[] = prefaceParts.length
    ? [{ role: 'user', content: prefaceParts.join('\n\n') }]
    : []
  const messages: ChatMessage[] = carriedForModel
    ? [
        { role: 'system', content: systemText },
        ...carriedForModel,
        ...trailingTurns,
        ...preface,
        { role: 'user', content: userContent }
      ]
    : [
        { role: 'system', content: systemText },
        // Rebuilt from prose (restart, or the transcript cache moved on): a stored message's
        // attachments come back as stubs naming their ids, so the model can still read them with
        // lookup kind="source" — before, the id was simply gone.
        ...req.history.map((m) => ({ role: m.role, content: historyContent(m) }) as ChatMessage),
        ...preface,
        { role: 'user', content: userContent }
      ]

  const groups = req.focusTools
    ? groupsForConversation([...req.history.map((m) => m.content), req.userText])
    : undefined
  const specs = toolSpecs(
    model.vision,
    // Not offered in the chat at all (the fence refuses them too, with its own reason).
    new Set([...disabled, ...NOT_IN_CHAT]),
    groups,
    clampResearchQuestions(req.maxResearchQuestions),
    req.distancesAvailable === true && !!deps.distances,
    req.eurostatAvailable === true && !!deps.eurostat,
    planTool,
    webOn
  )
  if (groups)
    console.log(
      `[prism-ai] focused tools: ${specs.length} of ${toolSpecs(model.vision).length} (${[...groups].join(', ')})`
    )
  let finalText = ''
  // The leftover lines stay visible where they took effect, as a delivered steer does.
  for (const t of leftover) {
    const shown = `> **You (earlier):** ${t.replace(/\n+/g, ' ')}\n\n`
    finalText += shown
    deps.emit({ chatId: req.chatId, type: 'delta', text: shown })
  }
  let totalCost = 0
  let totalPromptTokens = 0
  let totalCachedTokens = 0
  let totalCompletionTokens = 0
  let mutated = false
  let contextRetries = 0
  let costStopped = false
  /** Set when the stream collapsed into repeating itself; ends the run with a note. */
  let repetitionLoop: { unit: string; repeats: number } | null = null
  /** One nudge per run when a round announces work and then makes no tool call. */
  let nudged = false
  /** Rounds in a row without a single successful tool call (see STALL_NUDGE_AT). */
  let stalledRounds = 0
  /** The last request's size as the provider counted it, with the characters it was counted on
   *  (projectTokens). Null until the first count, and again after every compaction. */
  let measured: { promptTokens: number; chars: number } | null = null
  /** Characters of `messages` at the moment the current request went out. */
  let charsAtRequest = 0
  /** The prompt size of the most recent round — the context meter's figure, kept with the turn. */
  let contextTokens: number | undefined
  const budgetTokens = contextBudgetTokens(model.contextTokens)
  /** The effort sent with each round; dropped for the rest of the run if the API refuses it. */
  let reasoningEffort = req.reasoningEffort

  /**
   * Account spend for ANY model this turn used — the main loop plus the side runs it spawns (the
   * history summariser and the research sub-agent run on their own, cheaper models). Those used to
   * bypass this entirely, so the ledger understated a turn and, worse, the cost limit could not see
   * them: a research-heavy turn could blow through `maxCostUsd` unnoticed. Deliberately one shared
   * budget — a limit that only covers part of the spend is not a limit.
   */
  const onCost = (
    modelId: string,
    u: { cost?: number; prompt?: number; cached?: number; completion?: number }
  ): void => {
    // Record per round (not at the end) so aborted runs still account their spend.
    deps.recordUsage?.(modelId, u)
    // Counted HERE and not in `onUsage`, so the tokens cover exactly what the cost covers: the main
    // loop plus the side runs on their own models (the history summariser, the research sub-agent).
    // Booked against the main model would have been a lie; left out entirely, the chat header would
    // have said a research-heavy turn consumed less than it did.
    totalPromptTokens += u.prompt ?? 0
    totalCachedTokens += u.cached ?? 0
    totalCompletionTokens += u.completion ?? 0
    if (typeof u.cost === 'number') {
      totalCost += u.cost
      const limit = req.maxCostUsd ?? 0
      if (limit > 0 && totalCost >= limit) costStopped = true
    }
  }

  // Declared before `onUsage`: the usage handler appends the provider-side web lookups to it.
  const trace: ToolTrace[] = []

  /** Account a round's spend, trip the cost circuit breaker, and log prefix-cache effectiveness. */
  const onUsage = (usage: {
    cost?: number
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    cache_discount?: number
    generation_id?: string
    server_tool_use?: Record<string, number>
  }): void => {
    // Web lookups the provider ran INSIDE this reply (OpenRouter server tools). Nothing in the stream
    // shows them otherwise — the model's own account of them is unreliable (in one run it said
    // "never used the web" over rounds with three passes) — and each one re-ran the whole
    // conversation through the model, which is why the round's prompt count and cost are higher
    // (V398). One row in the trace, before the round's own calls, so the chat says what happened.
    const web = describeWebLookups(usage.server_tool_use)
    if (web) {
      deps.emit({ chatId: req.chatId, type: 'tool', name: WEB_LOOKUPS_ROW, phase: 'start' })
      deps.emit({
        chatId: req.chatId,
        type: 'tool',
        name: WEB_LOOKUPS_ROW,
        phase: 'done',
        preview: web.preview,
        resultChars: web.preview.length
      })
      trace.push({
        name: WEB_LOOKUPS_ROW,
        status: 'ok',
        preview: web.preview,
        resultChars: web.preview.length
      })
    }
    // costOf includes the output tokens, reasoning included. The report writer and the sub-agents
    // have booked these since V166; the chat loop never did, so the ledger held a model's prompts
    // and its price and nothing about what it produced. That is the wrong half to lose on a
    // reasoning model, where the output IS the work — and on a free one it left `ai-usage.json`
    // saying nothing at all about 26 calls (V229, measured on the 2026-08-25 Ox Alpha run).
    onCost(model.id, costOf(usage))
    // The provider's count of what it was just sent: the one exact figure the context meter and the
    // compaction trigger have (projectTokens). An empty usage report leaves the previous reading.
    if (typeof usage.prompt_tokens === 'number' && usage.prompt_tokens > 0) {
      measured = { promptTokens: usage.prompt_tokens, chars: charsAtRequest }
      contextTokens = usage.prompt_tokens
      deps.emit({
        chatId: req.chatId,
        type: 'context',
        tokens: usage.prompt_tokens,
        window: model.contextTokens,
        budget: budgetTokens
      })
    }
    // Prefix-cache telemetry: how much of the (large, constant) tool+system block came from cache.
    // Logged rather than surfaced in the UI for now — enough to verify the breakpoint works and to
    // see which providers cache without being asked.
    const cached = usage.prompt_tokens_details?.cached_tokens
    if (typeof cached === 'number' && cached > 0) {
      const prompt = usage.prompt_tokens ?? 0
      const pct = prompt ? Math.round((cached / prompt) * 100) : 0
      const saved = usage.cache_discount
      // The provider's own charge for THIS round beside the token counts: in one run the second
      // round of two identical runs reported 211k and 227k prompt tokens (181k "cached") where the
      // neighbouring rounds held 42k and 68k — reproducible, unexplained, on the route OpenRouter labels
      // "OpenAI" (V398). Whether such a round is also billed that way is what this figure answers.
      const cost = typeof usage.cost === 'number' ? `, $${usage.cost.toFixed(4)}` : ''
      // What WE sent, in characters, beside what the provider says it read — the two figures that tell
      // a real prompt from a misreported one — and the generation id to ask OpenRouter about the round.
      const sent = charsAtRequest ? `, sent ≈${Math.round(charsAtRequest / 1000)}k chars` : ''
      const gen = usage.generation_id ? `, gen ${usage.generation_id}` : ''
      const lookups = web ? `, web: ${web.short}` : ''
      console.log(
        `[prism-ai] cache: ${cached}/${prompt} prompt tokens (${pct}%)` +
          (typeof saved === 'number' ? `, saved $${saved.toFixed(5)}` : '') +
          `${cost}${sent}${gen}${lookups} — ${model.id}`
      )
    }
  }

  const maxRounds = Math.max(1, req.maxRounds ?? DEFAULT_MAX_ROUNDS)
  let answered = false // did the model finish with an answer, or did it run out of rounds mid-work?
  // A round that returns neither text nor a tool call is a provider-side failure, not an answer.
  // One retry, because it is usually transient; the second in a row ends the turn out loud.
  let emptyRounds = 0
  let emptyStopped = false
  const MAX_EMPTY_ROUNDS = 1
  /** The endpoint serving this turn (V22) — kept so the finished turn can record who answered. */
  let servedBy: string | undefined
  /** What the turn has consumed so far — on EVERY return, not only the finished one: a stopped or
   *  failed run was persisted without its cost and tokens although the ledger had them. */
  const usageSoFar = (): Pick<
    AgentResult,
    'cost' | 'promptTokens' | 'cachedTokens' | 'completionTokens' | 'provider' | 'contextTokens'
  > => ({
    cost: totalCost || undefined,
    promptTokens: totalPromptTokens || undefined,
    cachedTokens: totalCachedTokens || undefined,
    completionTokens: totalCompletionTokens || undefined,
    provider: servedBy,
    contextTokens
  })
  /**
   * Hand the model what the user typed while it was working — at a round boundary, never inside one.
   *
   * Claude Code, Cursor and Codex all queue a message typed mid-run and deliver it at the next safe
   * point; PrismLCA's only answers used to be Stop or wait. Each message goes to the model
   * as a user turn in its own words (with a note that it arrived mid-task, so a weaker model reads it
   * as a correction to fold in rather than a new task to start over on), and into the visible answer
   * as a quoted line, the way an ask_user exchange rides in the assistant's text: one assistant
   * message per turn stays the rule, so the stored history and the carried transcript keep matching.
   * Returns how many were delivered.
   */
  const deliverSteering = (): number => {
    const texts = deps.takeSteering?.() ?? []
    for (const text of texts) {
      const t = text.trim()
      if (!t) continue
      messages.push({
        role: 'user',
        content: `(Sent while you were working — take it into account from here on.) ${t}`
      })
      const shown = `\n\n> **You:** ${t.replace(/\n+/g, ' ')}\n\n`
      finalText += shown
      deps.emit({ chatId: req.chatId, type: 'delta', text: shown })
    }
    return texts.length
  }
  const costNote = (): void => {
    const note = `\n\n_Stopped: the cost limit of $${(req.maxCostUsd ?? 0).toFixed(2)} for this run was reached._`
    finalText += note
    deps.emit({ chatId: req.chatId, type: 'delta', text: note })
  }
  /** How the run ended; 'answered' until something says otherwise. */
  let outcome: RunOutcome = 'answered'
  /**
   * The ONE exit of a run, whichever way it ends: open tool calls get their "not executed" results,
   * the answer closes the transcript, and the transcript is kept — in memory and on disk — so the
   * next turn (a "continue" after a stop, a restart) finds what this one did. Before this, abort and
   * error returned early and kept nothing (V18 again, on every Stop).
   */
  const finish = async (out: RunOutcome, aborted: boolean): Promise<AgentResult> => {
    closeOpenCalls(messages)
    const last = messages[messages.length - 1]
    if (finalText && !(last?.role === 'assistant' && last.content === finalText))
      messages.push({ role: 'assistant', content: finalText })
    await keepTranscript(
      req.chatId,
      turnId,
      req.history,
      req.userText,
      finalText,
      messages,
      currentPlan,
      deps.transcriptStore
    )
    return { text: finalText, aborted, outcome: out, turnId, trace, ...usageSoFar() }
  }
  try {
    for (let round = 0; round < maxRounds; round++) {
      if (req.signal.aborted) return await finish('cancelled', true)
      if (costStopped) {
        // A sub-agent tripped the breaker inside the last round: no further model round starts on
        // a limit that is already exceeded.
        costNote()
        outcome = 'cost'
        break
      }
      // What the user typed since the last request, before anything else is sent.
      deliverSteering()
      /** How the provider ended the round — "length" is an answer cut off, not a finished one. */
      let finishReason = ''
      let roundText = ''
      let toolCalls: Array<{ id: string; name: string; arguments: string }> | null = null
      /** Reasoning of the round just streamed — read after it ends, to price an empty response. */
      let roundReasoningChars = 0

      // Proactive: keep the conversation inside the window before we even ask — judged on the
      // provider's own token count where there is one (projectTokens), not on characters alone.
      if (projectTokens(messages, measured) > budgetTokens) {
        const dropped: string[] = []
        const n = compactMessages(messages, KEEP_ROUNDS, dropped)
        if (n) {
          measured = null // the count described messages that no longer exist
          console.log(`[prism-ai] compacted ${n} older message(s) to stay inside the context window`)
          // Summarise what we dropped so the agent does not re-fetch what it already learned.
          const summary = await summariseDropped(dropped, model.id, provider, req.signal, onCost)
          if (summary) {
            messages.push({
              role: 'user',
              content: `Summary of earlier tool results dropped to fit the context:\n${summary}`
            })
          }
        }
      }

      // Breakpoints last, so they can never point at content compaction just rewrote. Only for
      // providers that need them explicitly; the others cache on their own (or not at all).
      if (model.explicitCache) markCacheBreakpoints(messages)

      // Reactive: a request rejected for length is recoverable — compact hard and try this round
      // once more. The 400 arrives before any streaming, so nothing was emitted twice.
      for (;;) {
        try {
          roundText = ''
          toolCalls = null
          let nextRepeatCheck = REPEAT_MIN_CHARS
          // Per round: the count answers "is this round still moving?", so it starts at zero with
          // the round rather than accumulating across a turn.
          let reasoningChars = 0
          let reasoningSent = 0
          charsAtRequest = estimateChars(messages)
          for await (const ev of streamChat({
            model: model.id,
            messages,
            tools: specs,
            temperature: model.temperature,
            maxTokens: req.maxTokens,
            webSearch: req.webSearch,
            webLookupsCap: req.webLookupsCap,
            reasoningEffort,
            signal: req.signal,
            provider
          })) {
            if (ev.type === 'finish') {
              finishReason = ev.reason
              continue
            }
            if (ev.type === 'delta') {
              roundText += ev.text
              finalText += ev.text
              deps.emit({ chatId: req.chatId, type: 'delta', text: ev.text })
              // Checked every few hundred characters rather than per delta: the scan is cheap but not
              // free, and a collapse takes far longer than that to become detectable anyway.
              if (roundText.length >= nextRepeatCheck) {
                nextRepeatCheck = roundText.length + REPEAT_MIN_CHARS / 2
                const loop = runawayRepetition(roundText)
                if (loop) {
                  repetitionLoop = loop
                  break // ends the generator, which releases the response stream
                }
              }
            } else if (ev.type === 'reasoning') {
              // Throttled: a reasoning stream arrives in hundreds of small frames, and the renderer
              // only needs a number that visibly moves. Emitting each one would spend IPC on
              // redrawing the same second.
              reasoningChars += ev.chars
              roundReasoningChars = reasoningChars
              if (reasoningChars - reasoningSent >= REASONING_TICK_CHARS) {
                reasoningSent = reasoningChars
                deps.emit({ chatId: req.chatId, type: 'reasoning', chars: reasoningChars })
              }
            } else if (ev.type === 'provider') {
              // Report a change, not every round: routing normally sticks to one endpoint for a
              // turn, and repeating the same name would just be noise in the trace.
              if (ev.name !== servedBy) {
                servedBy = ev.name
                console.log(`[prism-ai] served by ${ev.name} — ${model.id}`)
                deps.emit({ chatId: req.chatId, type: 'provider', name: ev.name })
              }
            } else if (ev.type === 'usage') {
              onUsage(ev.usage)
            } else if (ev.type === 'tool_calls') {
              toolCalls = ev.calls
            }
          }
          break
        } catch (e) {
          // A reasoning level this model's API does not take (a 400 naming it): once, drop the level
          // and send the round again on the default — a lost run is the wrong price for a setting.
          if (
            reasoningEffort &&
            e instanceof AiProviderError &&
            e.code === 'http' &&
            /reason|effort|thinking/i.test(e.message)
          ) {
            console.log(
              `[prism-ai] ${model.id} rejected reasoning effort "${reasoningEffort}" — retrying on the default`
            )
            const note = `\n\n_The model's API rejected the reasoning effort "${reasoningEffort}" — continuing on its default. Pick another level under Settings → AI → Models._`
            finalText += note
            deps.emit({ chatId: req.chatId, type: 'delta', text: note })
            reasoningEffort = undefined
            continue
          }
          const recoverable =
            e instanceof AiProviderError && e.code === 'context' && contextRetries < MAX_CONTEXT_RETRIES
          if (!recoverable) throw e
          contextRetries++
          const dropped: string[] = []
          let n = compactMessages(messages, 1, dropped)
          // The last round's results are kept by default; when they ARE the bulk (ten large reads in
          // one round on a small window), keeping them makes the rescue impossible.
          if (!n) n = compactMessages(messages, 0, dropped)
          console.log(`[prism-ai] context overflow — compacted ${n} message(s) and retrying the round`)
          if (!n) throw e // nothing left to shrink: the request is hopeless, surface the error
          measured = null
          const summary = await summariseDropped(dropped, model.id, provider, req.signal, onCost)
          if (summary) {
            messages.push({
              role: 'user',
              content: `Summary of earlier tool results dropped to fit the context:\n${summary}`
            })
          }
          // This path compacted again, so the breakpoints have to be re-placed before the retry.
          if (model.explicitCache) markCacheBreakpoints(messages)
        }
      }

      if (repetitionLoop) {
        const unit = repetitionLoop.unit.replace(/\s+/g, ' ').trim().slice(0, 40)
        const note =
          `\n\n_Stopped: the reply started repeating itself ("${unit}" ${repetitionLoop.repeats}× in a row) ` +
          `and was cut off. Nothing after that point was carried out — tell me to continue, and say ` +
          `what to pick up if you know._`
        finalText += note
        deps.emit({ chatId: req.chatId, type: 'delta', text: note })
        outcome = 'repetition'
        break
      }

      if (costStopped) {
        costNote()
        outcome = 'cost'
        break
      }

      // A mid-stream abort ends streamChat quietly — bail before emitting 'done', otherwise the
      // renderer (which already kept the partial on Stop) would receive and append it again.
      if (req.signal.aborted) return await finish('cancelled', true)

      if (!toolCalls || !toolCalls.length) {
        // A round with NO tool call and NO text is not an answer — it is a dead round, and it was
        // indistinguishable from a finished one: `answered = true` below, no note, no error, not a
        // line in the log. Measured: a run reasoned 19:43 min, returned an empty
        // completion, and the chat stayed empty while the turn was reported as done. The guard that
        // should have caught it (announcesUnfinishedWork) reads the round's last line and returns
        // false for the empty string — it can never see this case.
        if (!roundText.trim()) {
          if (emptyRounds < MAX_EMPTY_ROUNDS) {
            emptyRounds++
            // Recovering silently was its own problem. In a live run this branch fired for real and
            // saved the run — after the model had spent 5 min 53 s and 43,500 characters of reasoning
            // on the response it threw away, 23 % of all the thinking in that turn. Nothing said so:
            // no log line (unlike the compaction paths above), and in the UI the round timer simply
            // kept climbing, so twelve minutes looked like one long thought. Both halves are said now.
            console.log(
              `[prism-ai] empty response after ${Math.round(roundReasoningChars / 1000)}k characters ` +
                `of reasoning — nudging and retrying the round (${emptyRounds}/${MAX_EMPTY_ROUNDS})`
            )
            // Zero resets the renderer's counter, which is what makes the restart visible: the number
            // dropping to 0 and climbing again is the honest picture, where before it silently jumped
            // back mid-count under a timer that never restarted.
            deps.emit({ chatId: req.chatId, type: 'reasoning', chars: 0 })
            deps.emit({ chatId: req.chatId, type: 'round-restart', reason: 'empty' })
            messages.push({
              role: 'user',
              content:
                'Your last response was empty — no text and no tool call, so nothing happened. ' +
                'Carry on: make the next tool call, or say plainly where you stand.'
            })
            continue
          }
          emptyStopped = true
          outcome = 'empty'
          const note =
            `\n\n_Stopped: the model returned nothing — no text and no tool call — ` +
            `${MAX_EMPTY_ROUNDS + 1}× in a row. That is a provider-side failure, not a finished ` +
            `answer, and nothing was carried out. Send it again; if it repeats, pick another model ` +
            `under Settings → AI._`
          finalText += note
          deps.emit({ chatId: req.chatId, type: 'delta', text: note })
          break
        }
        // No tool calls normally means "answered". But a round whose closing sentence announces work
        // ("Let me execute everything now in parallel batches:") and then makes no call means the
        // opposite: the run is about to end mid-task, silently, with the model half-changed. Nudge
        // once — and only once, so a model that simply talks that way cannot spin here.
        if (!nudged && announcesUnfinishedWork(roundText)) {
          nudged = true
          messages.push({ role: 'assistant', content: roundText })
          messages.push({
            role: 'user',
            content:
              'You announced work but made no tool call, so nothing happened. Carry it out now with ' +
              'tool calls, or say plainly that you are done and what is left.'
          })
          continue
        }
        // The model is done — but the user said something meanwhile. Their words become the next
        // round instead of waiting for a turn that would start without the tool transcript in view.
        if (deps.takeSteering && finishReason !== 'length') {
          messages.push({ role: 'assistant', content: roundText })
          if (deliverSteering()) continue
          messages.pop()
        }
        if (finishReason === 'length') {
          // The provider stopped the output at its token limit; the text ends mid-sentence and used
          // to be stored as a finished answer.
          const note = `\n\n_The answer was cut off at the model's output limit — say "continue" to go on from here._`
          finalText += note
          deps.emit({ chatId: req.chatId, type: 'delta', text: note })
          outcome = 'output_limit'
        }
        answered = true
        break // model answered — done
      }
      if (roundText) {
        // Separate this round's text from the next round's — emitted as a delta too, so the
        // streamed view matches the final persisted text exactly.
        finalText += '\n\n'
        deps.emit({ chatId: req.chatId, type: 'delta', text: '\n\n' })
      }

      // Record the assistant's tool-call turn.
      messages.push({
        role: 'assistant',
        content: roundText || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments }
        }))
      })

      const imageParts: ChatMessage[] = []
      /** One call, executed and reported live; the ORDERED bookkeeping (trace, transcript message,
       *  mutation follow-up) happens at the caller, so a parallel group stays deterministic. The
       *  rules of running a tool live in execute.ts, shared with the MCP server. */
      const runOne = async (tc: {
        id: string
        name: string
        arguments: string
      }): Promise<{
        entry: ToolTrace
        capped: string
        mutated: boolean
        graph: boolean
        structure: boolean
      }> => {
        deps.emit({
          chatId: req.chatId,
          type: 'tool',
          name: tc.name,
          phase: 'start',
          args: (tc.arguments ?? '').slice(0, TRACE_ARGS_CHARS)
        })
        const oc = await session.run(tc.name, tc.arguments, { signal: req.signal })
        session.ctx.preApproved = false // one card, one call
        if (session.ctx.activeDb && session.ctx.activeDb !== modelNow) {
          modelNow = session.ctx.activeDb
          deps.onModelRenamed?.(modelNow)
        }
        let resultStr: string
        let entry: ToolTrace
        if (oc.ok) {
          resultStr = oc.result
          if (oc.image) {
            imageParts.push({
              role: 'user',
              content: [
                { type: 'text', text: 'Canvas screenshot:' },
                { type: 'image_url', image_url: { url: oc.image } }
              ]
            })
          }
          if (oc.transcript) {
            // ask_user: the Q + chosen answer become part of the assistant's visible text, so the
            // interaction survives in the persisted chat history and on reload. (ask_user is never
            // in a parallel group, so this append keeps its order.)
            finalText += oc.transcript
            deps.emit({ chatId: req.chatId, type: 'delta', text: oc.transcript })
          }
          deps.emit({
            chatId: req.chatId,
            type: 'tool',
            name: tc.name,
            phase: 'done',
            soft: oc.soft,
            itemsFailed: oc.itemsFailed,
            ms: oc.ms,
            preview: resultStr.slice(0, TRACE_PREVIEW_CHARS),
            resultChars: resultStr.length,
            notice: oc.notice
          })
          entry = {
            name: tc.name,
            args: tc.arguments || undefined,
            status: oc.soft ? 'rejected' : 'ok',
            detail: oc.soft,
            itemsFailed: oc.itemsFailed,
            preview: resultStr.slice(0, TRACE_PREVIEW_CHARS),
            resultChars: resultStr.length,
            ms: oc.ms,
            ...(oc.notice ? { notice: oc.notice } : {})
          }
        } else {
          resultStr = JSON.stringify({ error: oc.error })
          deps.emit({
            chatId: req.chatId,
            type: 'tool',
            name: tc.name,
            phase: 'error',
            detail: oc.error,
            args: (tc.arguments ?? '').slice(0, TRACE_ARGS_CHARS),
            ms: oc.ms
          })
          entry = {
            name: tc.name,
            args: tc.arguments || undefined,
            status: 'error',
            detail: oc.error,
            ms: oc.ms
          }
        }
        // Budgeted by what the call actually carries, and cut structurally rather than mid-object —
        // see resultBudget.ts for the two results this run lost silently. The third argument is the
        // conversation's character budget, NOT the reply limit: a tool result is prompt, and what it
        // competes for is the room the history has. Tying it to `maxTokens` cost a live
        // apple-sauce run a whole skill and a whole answered research question (resultBudget.ts).
        const capped = capToolResult(resultStr, undefined, compactThreshold(model.contextTokens))
        if (capped.truncated) {
          console.log(
            `[prism-ai] ${tc.name}: result trimmed — ${capped.truncated.dropped} ` +
              `${capped.truncated.kind} dropped of ${capped.truncated.of}`
          )
        }
        return {
          entry,
          capped: capped.text,
          mutated: oc.ok && oc.mutated,
          graph: oc.ok && oc.graph === true,
          structure: oc.ok && oc.structure === true
        }
      }

      // The round's calls run in GROUPS (V285): consecutive parallel-safe calls — search and
      // research, the reads that take minutes and share no channel, window or UI — run
      // concurrently, everything else is a barrier and runs alone, in order. The sequential
      // default stays the rule because for mutating tools the order IS the semantics; measured in
      // a live pavilion run, research_bom (181 s) and research_web (576 s) stood in one
      // round and ran back to back — 758 s where the slower alone would have been 576.
      const callGroups: Array<typeof toolCalls> = []
      for (const tc of toolCalls) {
        const last = callGroups[callGroups.length - 1]
        if (PARALLEL_SAFE_TOOLS.has(tc.name) && last && PARALLEL_SAFE_TOOLS.has(last[0].name)) {
          last.push(tc)
        } else {
          callGroups.push([tc])
        }
      }
      /** Did any call of this round land? Read by the stall guard below. */
      let roundOk = false
      for (const group of callGroups) {
        if (req.signal.aborted || costStopped) break
        if (group.length > 1)
          console.log(
            `[prism-ai] running ${group.length} read-only calls concurrently: ${group.map((c) => c.name).join(', ')}`
          )
        const outcomes = group.length === 1 ? [await runOne(group[0])] : await Promise.all(group.map(runOne))
        for (const [i, oc] of outcomes.entries()) {
          trace.push(oc.entry)
          if (oc.entry.status === 'ok') roundOk = true
          if (oc.mutated) {
            mutated = true
            // Reload after this edit — the canvas only when the graph changed, and only the one
            // showing this model, not any other.
            deps.emit({
              chatId: req.chatId,
              type: 'refresh',
              database: req.activeDb ?? undefined,
              graph: oc.graph,
              structure: oc.structure
            })
          }
          messages.push({ role: 'tool', tool_call_id: group[i].id, content: oc.capped })
        }
      }
      messages.push(...imageParts)

      // The stall guard: rounds that only ever hear "no". Reset by any call that lands, because a
      // model working through a batch of refusals one by one IS making progress.
      stalledRounds = roundOk || req.signal.aborted ? 0 : stalledRounds + 1
      if (stalledRounds === STALL_NUDGE_AT) {
        console.log(`[prism-ai] ${stalledRounds} rounds without a successful tool call — nudging`)
        messages.push({
          role: 'user',
          content:
            `Your last ${STALL_NUDGE_AT} rounds produced only rejected or failed tool calls, and nothing in the ` +
            'model changed. Read the error messages again and fix exactly what they name; if the same call ' +
            'keeps failing, take a different route or tell the user what is blocking you.'
        })
      } else if (stalledRounds >= STALL_STOP_AT) {
        const note =
          `\n\n_Stopped: ${STALL_STOP_AT} rounds in a row produced only rejected or failed tool calls. ` +
          `Nothing after that point was carried out — tell me to continue, and say what to change if you know._`
        finalText += note
        deps.emit({ chatId: req.chatId, type: 'delta', text: note })
        outcome = 'stalled'
        break
      }
    }

    // Running out of rounds used to end the turn silently: if the model spent every round on tool
    // calls without writing prose, the chat stayed empty and looked like a hang. Say so instead.
    if (!answered && !costStopped && !emptyStopped && outcome === 'answered') {
      const note = `\n\n_Stopped: the limit of ${maxRounds} tool rounds was reached before I finished. Tell me to continue, or raise the limit in Settings → AI._`
      finalText += note
      deps.emit({ chatId: req.chatId, type: 'delta', text: note })
      outcome = 'rounds'
    }

    // Close the transcript with the answer the user sees and keep it for the next turn (finish).
    const result = await finish(outcome, false)

    // Final reconcile after all edits.
    if (mutated) deps.emit({ chatId: req.chatId, type: 'refresh', database: req.activeDb ?? undefined })
    deps.emit({
      chatId: req.chatId,
      type: 'done',
      text: finalText,
      cost: totalCost || undefined,
      promptTokens: totalPromptTokens || undefined,
      cachedTokens: totalCachedTokens || undefined,
      completionTokens: totalCompletionTokens || undefined,
      provider: servedBy,
      contextTokens,
      trace: trace.length ? trace : undefined,
      outcome,
      turnId
    })
    return result
  } catch (e) {
    if (req.signal.aborted) return await finish('cancelled', true)
    const code = e instanceof AiProviderError ? e.code : undefined
    deps.emit({
      chatId: req.chatId,
      type: 'error',
      message: e instanceof Error ? e.message : String(e),
      code
    })
    return await finish('error', false)
  }
}

/** The stop reasons as the resume note says them; 'answered' never gets a note. */
const RESUME_REASON: Record<RunOutcome, string> = {
  answered: 'it had finished',
  rounds: 'the round limit was reached',
  cost: 'the cost limit was reached',
  repetition: 'the reply started repeating itself',
  stalled: 'several rounds in a row produced only rejected or failed tool calls',
  empty: 'the model returned empty responses',
  output_limit: 'the answer was cut off at the output limit',
  cancelled: 'the user pressed Stop',
  error: 'an error ended it',
  interrupted: 'PrismLCA was closed while it was running'
}

/** A stored turn's prose plus a stub per attachment it carried, so the ids survive a rebuild. */
function historyContent(m: HistoryTurn): string {
  const files = m.role === 'user' ? (m.attachments ?? []).filter((a) => a.id && !a.error) : []
  if (!files.length) return m.content
  return [m.content, ...files.map((a) => attachmentStub(heading(a), a.id))].filter(Boolean).join('\n')
}

/** The transcript with every image part replaced by a note — for a model that cannot see. */
function withoutImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg
    const parts = msg.content as Array<Record<string, unknown>>
    if (!parts.some((p) => p.type === 'image_url')) return msg
    return {
      ...msg,
      content: parts.map((p) =>
        p.type === 'image_url'
          ? { type: 'text', text: '[image omitted: the active model cannot see images]' }
          : p
      ) as ChatMessage['content']
    }
  })
}
