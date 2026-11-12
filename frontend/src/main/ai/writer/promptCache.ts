/**
 * Keeping a chapter's two conversations — the writer's and the second reader's — cacheable.
 *
 * A provider caches a prompt PREFIX, and the tool definitions head that prefix. A request that offers
 * a different tool list than the one before it is billed in full: brief, lookups and draft. The
 * revisions used to go out without the writer's tools, so the first revision of every chapter paid its
 * whole conversation again, on every provider. So each call of a chapter offers the list the writer
 * started with, and a lookup asked for where none is allowed is refused in a tool answer instead of
 * being prevented by withdrawing the list.
 *
 * Anthropic caches only where a breakpoint says so (`AiModel.explicitCache`). The two large fixed
 * blocks, system prompt and brief, carry one each. On top, the request asks for automatic caching
 * (`StreamChatOpts.cacheTail`), whose breakpoint moves to the last block, so the lookup results, the
 * draft and the findings of one round are read from the cache by the next. That is three of the four
 * breakpoints Anthropic allows.
 */
import { aiLog } from '../aiLog'
import { findModel } from '../models'
import { getActiveProvider } from '../providers/state'
import {
  assistantToolTurn,
  type ChatMessage,
  type ProviderReplay,
  type StreamChatOpts,
  type ToolSpec
} from '../providers/types'
import { routingSession } from '../routingSession'
import { collectText, type CostSample } from '../stream'
import type { CostSink } from '../subagent'

/** How every call of one conversation is sent. The same for each call; that sameness is the point. */
export interface CallShape {
  /** The tools each call offers; undefined = none, either never offered or withdrawn for good. */
  tools?: ToolSpec[]
  /** Ask for the moving breakpoint at the end of the conversation (Anthropic). */
  cacheTail?: boolean
  /** The conversation's name for its routing key ('writer:<chapter>', 'reader:<chapter>'), so its requests
   *  stay with one provider and that provider's cache. Never sent; the key is (routingSession.ts). */
  conversation?: string
}

/** What each request of a conversation carries for the cache: its tools, the moving breakpoint and the
 *  routing key. */
export function inShape(shape: CallShape): Pick<StreamChatOpts, 'tools' | 'cacheTail' | 'sessionId'> {
  return {
    tools: shape.tools,
    cacheTail: shape.cacheTail,
    sessionId: shape.conversation ? routingSession(shape.conversation) : undefined
  }
}

/** Whether this model caches only where a breakpoint is placed. */
export const explicitCache = (model: string): boolean =>
  findModel(model, getActiveProvider()).explicitCache === true

/** A message that carries a breakpoint where the model needs one, and is plain text otherwise. */
export function cacheable(role: 'system' | 'user', text: string, explicit: boolean): ChatMessage {
  return { role, content: explicit ? [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] : text }
}

/** One line per call with the share of the prompt the cache served, so a run can be judged from its log. */
export function logCache(label: string, model: string, usage: CostSample): void {
  const { cached, prompt } = usage
  if (typeof cached !== 'number' || !prompt) return
  const cost = typeof usage.cost === 'number' ? `, $${usage.cost.toFixed(4)}` : ''
  aiLog(
    `${label} cache: ${cached}/${prompt} prompt tokens (${Math.round((cached / prompt) * 100)}%)${cost} — ${model}`
  )
}

/** The tool answer to a lookup asked for where none can be made: in a revision, an update's retry or a
 *  continuation. The tools are still offered there only to keep the prefix cached. */
export const NO_LOOKUP_NOW =
  'No lookups at this point. Answer in the form asked for, from what you already have.'

/** The finish reported for an answer that still ended in a lookup after the refusal. Not one of the
 *  complete finishes (writer/answers.ts), so a continuation that ends this way leaves a draft. */
export const LOOKUP_INSTEAD_OF_ANSWER = 'lookup_instead_of_answer'

/**
 * Send one call that wants text back (a revision, an update's retry, a continuation, a reading) in the
 * shape of its conversation, and log what the cache served.
 *
 * A model that answers with a lookup gets each call refused in a tool answer and is asked once more.
 * Withdrawing the tools would have the same effect and re-bill the conversation. Text beside the calls
 * goes into the history with them and is not taken as the answer: it announces a lookup ("I will check
 * the process first") more often than it is one. An answer that again ends in a lookup is returned as it
 * stands and reported with `LOOKUP_INSTEAD_OF_ANSWER`. It is the last try, so its text is judged like any
 * other answer: a revision's parser, the gate and the reader decide on it, and a continuation that ends
 * this way stays a draft.
 */
export async function askInShape(opts: {
  model: string
  messages: ChatMessage[]
  shape: CallShape
  /** Log label: 'writer' or 'reader'. */
  label: string
  signal?: AbortSignal
  onCost?: CostSink
  maxTokens?: number
  onDelta?: (text: string) => void
  /** The finish of the answer returned; not called when the provider sent none. */
  onFinish?: (reason: string) => void
}): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const seen: {
      calls: Array<{ id: string; name: string; arguments: string }>
      replay?: ProviderReplay
      finish: string | null
    } = { calls: [], finish: null }
    const text = await collectText({
      model: opts.model,
      messages: opts.messages,
      ...inShape(opts.shape),
      signal: opts.signal,
      maxTokens: opts.maxTokens,
      onDelta: opts.onDelta,
      onFinish: (reason) => {
        seen.finish = reason
      },
      onToolCalls: (calls, replay) => {
        seen.calls = calls
        seen.replay = replay
      },
      onCost: (model, sample) => {
        logCache(opts.label, model, sample)
        opts.onCost?.(model, sample)
      }
    })
    if (!seen.calls.length || opts.signal?.aborted) {
      if (seen.finish) opts.onFinish?.(seen.finish)
      return text
    }
    if (attempt > 0) {
      opts.onFinish?.(LOOKUP_INSTEAD_OF_ANSWER)
      return text
    }
    opts.messages.push(assistantToolTurn(text.trim() ? text : null, seen.calls, seen.replay))
    for (const c of seen.calls)
      opts.messages.push({ role: 'tool', tool_call_id: c.id, content: NO_LOOKUP_NOW })
  }
}
