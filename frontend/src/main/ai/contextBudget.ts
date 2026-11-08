/**
 * The context budget of a run and what keeps a conversation inside it: the threshold and the token
 * projection that decide WHEN to compact, the size estimate they rest on, and the compaction itself —
 * which messages lose their bulk first (replaceable tool results, screenshots and attachments, older
 * rounds' reasoning replay) and which only last (the tool results money or method rules went into).
 * The agent loop decides when to call it and what to tell the model; this module decides what goes.
 */
import { stubForPartText } from './attachments'
import { lastUserIndex, replayDroppable, type ChatMessage } from './providers/types'

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

/** Rough size of the conversation as sent to the model (JSON for multi-part content). */
export function estimateChars(messages: ChatMessage[]): number {
  let n = 0
  for (const m of messages) {
    n += typeof m.content === 'string' ? m.content.length : m.content ? JSON.stringify(m.content).length : 0
    if (m.tool_calls) n += JSON.stringify(m.tool_calls).length
    // A provider's reasoning blocks travel with their round and count against the window like text.
    if (m.replay) n += JSON.stringify(m.replay).length
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

/** A tool result compaction replaced with a stub, with the call that produced it — what the summariser
 *  reads (compactionSummary.ts), so a result arrives with its origin instead of as JSON from nowhere. */
export interface DroppedResult {
  tool: string
  /** The call's arguments as the model sent them (a JSON string). */
  args: string
  text: string
}

export function compactMessages(
  messages: ChatMessage[],
  keepRounds: number,
  dropped?: DroppedResult[]
): number {
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
  const toolArgs = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        toolNames.set(tc.id, tc.function.name)
        toolArgs.set(tc.id, tc.function.arguments)
      }
    }
  }
  const isProtected = (m: ChatMessage): boolean =>
    m.role === 'tool' && PROTECTED_TOOLS.has(toolNames.get(m.tool_call_id ?? '') ?? '')
  // The newest `plan` result is the model's own checklist — a few hundred characters that say what
  // is done and what is not. It is never stubbed, in either sweep; OLDER plan results are superseded
  // lists and go with everything else.
  const latestPlan = latestPlanResult(messages, toolNames)

  const turnStart = lastUserIndex(messages)
  const sweep = (sacrificeProtected: boolean): number => {
    let n = 0
    for (let i = 0; i < cut; i++) {
      const m = messages[i]
      if (m.role === 'tool' && typeof m.content === 'string' && m.content !== OMITTED_TOOL) {
        if (m === latestPlan) continue
        if (!sacrificeProtected && isProtected(m)) continue
        // Kept for the summariser, so the gist survives the truncation.
        const id = m.tool_call_id ?? ''
        dropped?.push({ tool: toolNames.get(id) ?? 'tool', args: toolArgs.get(id) ?? '', text: m.content })
        m.content = OMITTED_TOOL
        n++
      } else if (m.role === 'assistant' && m.replay && replayDroppable(m.replay, i > turnStart)) {
        // An older round's reasoning blocks go first: only the provider reads them, and it needs only
        // the recent rounds' (Google gets its skip signature for the rest, the others rebuild the round).
        delete m.replay
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
export function latestPlanResult(
  messages: ChatMessage[],
  toolNames: Map<string, string>
): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'tool' && toolNames.get(m.tool_call_id ?? '') === 'plan') return m
  }
  return null
}
