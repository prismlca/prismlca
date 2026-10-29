/**
 * The one way a stream's cost reaches a ledger, and the one loop for tool-less requests.
 *
 * Every consumer of `streamChat` used to write its own `for await` block with its own copy of the
 * usage→onCost mapping — eleven of them, byte-for-byte alike apart from the accumulator. Copies of a
 * billing block are exactly how V166 happened (four calls in the dialog, three in ai-usage.json):
 * one site forgets the mapping and the money is spent but never booked. With `costOf` as the only
 * spelling of the mapping and `collectText` as the loop for the plain "send, read the answer, bill"
 * case, forgetting is no longer a thing a call site can do.
 */
import { streamChat } from './client'
import type { ChatMessage, Citation, StreamChatOpts } from './providers/types'

/** The usage payload of a stream's `usage` event — see providers/types.ts. */
type StreamUsage = {
  cost?: number
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

/** What an onCost callback takes. One booking per request — the transport guarantees exactly one
 *  usage event, this is the one place its fields are picked out. */
export interface CostSample {
  cost?: number
  prompt?: number
  cached?: number
  completion?: number
}

export function costOf(usage: StreamUsage): CostSample {
  return {
    cost: usage.cost,
    prompt: usage.prompt_tokens,
    cached: usage.prompt_tokens_details?.cached_tokens,
    completion: usage.completion_tokens
  }
}

/**
 * Send one tool-less request and return the assembled text, billing on the way.
 *
 * Deliberately minimal: no tools, no phase ticks, no finish-reason bookkeeping — the call sites that
 * need those (the agent loop, the chapter writer's lookup rounds, the reviewer) keep their own loop
 * and share only `costOf`. `temperature: null` is what every one of these callers sent.
 */
export async function collectText(opts: {
  model: string
  messages: ChatMessage[]
  signal?: AbortSignal
  onCost?: (model: string, sample: CostSample) => void
  webSearch?: boolean
  /** Allow list for the provider's web tools; see StreamChatOpts.webDomains. */
  webDomains?: string[]
  /** Pages the provider's web search cited, as they arrive (research legs keep them as evidence). */
  onCitations?: (citations: Citation[]) => void
  reasoningEffort?: StreamChatOpts['reasoningEffort']
  /** The provider this call is pinned to; absent = whichever is active when it runs. */
  provider?: StreamChatOpts['provider']
  /** Settings → AI → Limits "Max tokens per reply"; absent = the default ceiling. */
  maxTokens?: number
  /** The provider's own end-of-answer signal. A stream cut short by an abort returns its partial
   *  text like a finished one and never sends this — the only way to tell the two apart. */
  onFinish?: (reason: string) => void
}): Promise<string> {
  let text = ''
  for await (const ev of streamChat({
    model: opts.model,
    provider: opts.provider,
    messages: opts.messages,
    temperature: null,
    signal: opts.signal,
    webSearch: opts.webSearch,
    webDomains: opts.webDomains,
    reasoningEffort: opts.reasoningEffort,
    maxTokens: opts.maxTokens
  })) {
    if (ev.type === 'delta') text += ev.text
    else if (ev.type === 'citations') opts.onCitations?.(ev.citations)
    else if (ev.type === 'usage') opts.onCost?.(opts.model, costOf(ev.usage))
    else if (ev.type === 'finish') opts.onFinish?.(ev.reason)
  }
  return text
}
