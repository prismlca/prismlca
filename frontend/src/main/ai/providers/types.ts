/**
 * The provider-neutral chat contract: message/tool shapes, the stream-event vocabulary, and the
 * error class every caller branches on. Everything here is what the agent loop, the report writers
 * and the sub-agents are written against — a transport (OpenRouter, OpenAI) translates its own wire
 * format into these and nothing else, so the callers never learn which provider served them.
 */

import type { ReasoningEffort } from '../../../shared/aiDefaults'

export type ProviderId = 'openrouter' | 'openai'

/**
 * One error class for every provider, told apart by `.code` — the codes are the contract
 * (`agent.ts` retries on 'context', the renderer words its banner by code), so a new transport maps
 * its own statuses onto the SAME vocabulary instead of inventing one:
 * `auth | credits | rate_limit | context | no_endpoint | http | network | stalled | no_key | aborted`.
 *
 * Exported under its historical name `OpenRouterError` too (see ../openrouter.ts), so the call sites
 * and their tests did not have to move when the second provider arrived.
 */
export class AiProviderError extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<Record<string, unknown>> | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
}

export interface ToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface AccumTool {
  id: string
  name: string
  arguments: string
}

/**
 * A page the provider's web search actually returned to the model (`url_citation` annotation).
 * Mechanical, not model-written: the URL comes from the engine, and on the Exa engine so does an
 * `excerpt` (the highlight the model read, ~1 000 characters). A direct OpenAI `web_search` names
 * URL and title only. Measured on three GLM 5.3 Flash requests via OpenRouter.
 */
export interface Citation {
  url: string
  title?: string
  excerpt?: string
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  /** Pages the provider-side web search cited in this reply, as they arrive (deduplicated by the
   *  consumer, not here). Only sent when the provider annotates; absent otherwise. */
  | { type: 'citations'; citations: Citation[] }
  // A reasoning model sends its chain of thought before it writes a single visible token. We
  // deliberately do NOT surface the text — it is long, it is not an answer, and showing it invites
  // reading it as one. What we pass on is that it is happening and roughly how far along: enough to
  // tell thinking from hanging, which is all "Thinking" alone could not say through a six-minute
  // round in a live run.
  | { type: 'reasoning'; chars: number }
  /**
   * Why the model stopped: `stop`, `length`, `tool_calls`, `content_filter`, `error`, …
   *
   * Emitted once, when the provider states it. It was once not captured, and that
   * made an empty answer undiagnosable: a `review_model` call spent 114 seconds and came
   * back with no text at all, and afterwards there was no way to tell a model that thought and then
   * wrote nothing from one that was cut off at `length` or refused. "Returned nothing" is not a
   * diagnosis; the reason it stopped is.
   */
  | { type: 'finish'; reason: string }
  /** Who actually served this request. On OpenRouter that is the routed endpoint ("Fireworks",
   *  "BaseTen", …) — routing picks it per request from whatever is healthy and allowed, so speed,
   *  price and cache behaviour change between two otherwise identical runs, and this is the only
   *  thing that says which one you got. A direct provider names itself once. */
  | { type: 'provider'; name: string }
  | { type: 'tool_calls'; calls: AccumTool[] }
  | {
      type: 'usage'
      usage: {
        /** USD for this request. OpenRouter reports it; a direct provider only reports tokens, and
         *  its transport synthesizes this figure from the catalogue's list prices (then sets
         *  `estimated`). Everything downstream — the cost breaker, the ledger, the per-message cost
         *  — reads only this field and works the same either way. */
        cost?: number
        prompt_tokens?: number
        completion_tokens?: number
        /** Prefix-cache hits (present when the provider caches; see AiModel.explicitCache). */
        prompt_tokens_details?: { cached_tokens?: number }
        /** USD saved by the cache on this request, as reported by OpenRouter. */
        cache_discount?: number
        /** True when `cost` was computed locally from list prices rather than reported by the
         *  provider — the UI renders such a figure as "≈". */
        estimated?: boolean
        /** OpenRouter's generation id (`id` on the chunk that carried the usage): the handle for
         *  `GET /api/v1/generation?id=` when a usage figure looks wrong (V398). */
        generation_id?: string
        /** OpenRouter: how many server-tool lookups ran inside this reply, by kind
         *  (`web_search_requests`, `web_fetch_requests`, …). Absent when none did. */
        server_tool_use?: Record<string, number>
      }
    }

export interface StreamChatOpts {
  /** Pin the provider for the whole run — the agent fixes its model at the start, and a settings
   *  switch mid-run must not move the next round to another transport. */
  provider?: ProviderId
  model: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  /** null = do NOT send the parameter at all (frontier vendors removed the knob; e.g. Anthropic
   * returns 400 for non-default sampling params on Sonnet 5 / Opus 5 and their successors). */
  temperature: number | null
  /** Hard ceiling on this reply's length; see DEFAULT_MAX_TOKENS for why it is always sent. */
  maxTokens?: number
  /** Attach the provider's server-side web search to this request (OpenRouter: web_search +
   *  web_fetch server tools; OpenAI: the Responses API web_search tool). */
  webSearch?: boolean
  /** Ceiling on the provider-side web lookups per reply (`parameters.max_uses` on each OpenRouter server tool);
   *  undefined/0 = the provider's own default. Every lookup re-runs the whole conversation through the
   *  model, so this bounds the round's cost, not just a per-search fee (V398). */
  webLookupsCap?: number
  /** Restrict the provider-side web search (and fetch) to these domains — bare hosts, no scheme.
   *  OpenRouter: `parameters.allowed_domains` on both server tools (Exa and most native engines;
   *  Google-native has no filter and falls back to Exa); OpenAI: `filters.allowed_domains`.
   *  Undefined/empty = unrestricted. Set by the research legs only: the model that saw the first
   *  pass names where the authoritative confirmation lives, and the upgrade pass searches there. */
  webDomains?: string[]
  /** Cap or raise the model's thinking. Research legs pass 'low': retrieval work needs searching and
   *  transcribing, not deliberation — measured: GLM 5.3 defaults to effort "max" and
   *  spent a full 5-minute leg budget reasoning without writing one visible line. The chat passes the
   *  per-model setting (Settings → AI → Models). Omit to leave the model on its own default. */
  reasoningEffort?: ReasoningEffort
  signal?: AbortSignal
}

export interface TranscribeOpts {
  data: string // base64-encoded audio bytes
  format: string // e.g. "webm", "wav", "mp3"
  /** ISO-639-1 hint (e.g. "de"). Without it the model auto-detects — and sometimes returns an
   * English TRANSLATION of non-English speech instead of a transcript, so pass it when known. */
  language?: string
  signal?: AbortSignal
}

/**
 * What a concrete provider contributes to a streamed chat request. The mechanics around it —
 * retry-with-backoff, the stall watchdog, SSE line splitting — are shared (see engine.ts); the
 * transport owns the request shape and how its own wire events translate into StreamEvents.
 */
export interface ChatTransport<S> {
  /** Short name for log lines ("[openrouter] 429 on …"). */
  name: ProviderId
  buildRequest(
    opts: StreamChatOpts,
    key: string
  ): { url: string; headers: Record<string, string>; body: string }
  /** Map an HTTP failure onto the shared error vocabulary (see AiProviderError). */
  translateStatus(status: number, body: string): AiProviderError
  /** Is this failure worth a second attempt? Takes the body because the status alone can lie:
   *  OpenAI sends "out of credits" as a 429 (`insufficient_quota`), and retrying THAT is a
   *  ten-second hang ending in the same error. */
  retryable(status: number, body: string): boolean
  /** Fresh per-request scratch (accumulating tool-call fragments, once-only flags, …). Gets the
   *  request opts because some transports need them at stream end — OpenAI's cost synthesis prices
   *  the usage against the requested model's catalogue entry. */
  createState(opts: StreamChatOpts): S
  /** Translate one parsed SSE data object into zero or more StreamEvents, in order. */
  interpret(parsed: unknown, state: S): StreamEvent[]
  /** End-of-stream events: assembled tool calls, a synthesized usage, … */
  finish(state: S): StreamEvent[]
  /** Error text for a fetch that never reached the service at all. */
  unreachable: string
}
