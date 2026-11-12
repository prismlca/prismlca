/**
 * The provider-neutral chat contract: message/tool shapes, the stream-event vocabulary, and the
 * error class every caller branches on. Everything here is what the agent loop, the report writers
 * and the sub-agents are written against — a transport (OpenRouter, Anthropic, Google, OpenAI) translates its own
 * wire format into these and nothing else, so the callers never learn which provider served them.
 */

import type { AiProviderId, ReasoningEffort } from '../../../shared/aiDefaults'

export type ProviderId = AiProviderId

/**
 * The error vocabulary every transport maps its own statuses onto — a type, so a transport that invents
 * a code of its own (OpenRouter's mid-stream 429 once said 'rate') no longer compiles.
 */
export type ProviderErrorCode =
  | 'auth'
  | 'credits'
  | 'rate_limit'
  | 'context'
  | 'no_endpoint'
  | 'http'
  | 'network'
  | 'stalled'
  | 'no_key'
  | 'aborted'

/**
 * One error class for every provider, told apart by `.code` — the codes are the contract
 * (`agent.ts` retries on 'context' and drops a rejected effort on 'http'; the chat passes the code on
 * with the message), so a new transport maps its own statuses onto the SAME vocabulary.
 *
 * Exported under its historical name `OpenRouterError` too (see ../openrouter.ts), so the call sites
 * and their tests did not have to move when the second provider arrived.
 */
export class AiProviderError extends Error {
  code: ProviderErrorCode
  /** A second request may clear it — an overload, a rate limit, a server fault, a connection that
   *  dropped. Only read for an error that arrives after the request was accepted (inside the stream,
   *  or a stream cut short): the engine re-sends while nothing of the reply has reached the caller
   *  (engine.ts). A refused request is judged by its HTTP status (`ChatTransport.retryable`) instead. */
  retryable: boolean
  constructor(message: string, code: ProviderErrorCode, retryable = false) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<Record<string, unknown>> | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
  /** On an assistant tool-call turn: what its provider needs back verbatim (see ProviderReplay). */
  replay?: ProviderReplay
}

/**
 * The part of an assistant turn that only its provider can read, kept so it can be sent back
 * unchanged. Google's stateless Interactions API requires the model's `thought` steps — opaque,
 * signed — to be resent with the function calls they led to; without them the next round is
 * rejected (measured: HTTP 400 "invalid argument"). It is DATA, not prose: it rides on the message
 * through the transcript on disk and through compaction untouched, every other transport ignores it,
 * and nothing displays it.
 */
export interface ProviderReplay {
  provider: ProviderId
  /** The model that produced them. OpenAI's and OpenRouter's reasoning blocks go back only to that model
   *  — another one cannot read them, and a block it cannot read is a rejected request, not a lost hint.
   *  Google says its backend copes with a switch, so its replay is resent regardless. */
  model?: string
  /** The provider's own steps for this turn, in the order it sent them. */
  steps: unknown[]
}

/**
 * Index of the message that opened the current turn — the last user message that is not a tool's
 * image (the agent hands a screenshot back as a user message right after the tool's result, inside the
 * same round). After it, a tool round's reasoning still matters to the model; -1 when there is none.
 */
export function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    // Several screenshots follow one another; what decides is the last message before the run of user
    // messages — a tool's result means they are its images.
    let j = i - 1
    while (j >= 0 && messages[j].role === 'user') j--
    if (messages[j]?.role !== 'tool') return i
    i = j + 1
  }
  return -1
}

/**
 * May compaction drop this round's replay? Google's can always go (a round without it gets the skip
 * signature, accepted live) and so can OpenAI's (resending reasoning is optional there). Anthropic's
 * signed thinking — direct, or carried by OpenRouter — must come back whole and unmodified for the tool
 * loop it belongs to, so inside the current turn it stays.
 */
export function replayDroppable(replay: ProviderReplay, inCurrentTurn: boolean): boolean {
  return (replay.provider !== 'openrouter' && replay.provider !== 'anthropic') || !inCurrentTurn
}

/** The assistant message of a tool-call round — one shape for the agent loop and both writers, so the
 *  replay a provider attached cannot be dropped by one of three hand-written copies. */
export function assistantToolTurn(
  text: string | null,
  calls: AccumTool[],
  replay?: ProviderReplay
): ChatMessage {
  return {
    role: 'assistant',
    content: text,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: 'function' as const,
      function: { name: c.name, arguments: c.arguments }
    })),
    ...(replay ? { replay } : {})
  }
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
  /** The provider's own links to this page, when it cites through redirects (Google): what the model
   *  was shown, and so what it may quote as its source. `url` is the page they lead to. */
  via?: string[]
}

/**
 * Why a request that failed before any of its reply arrived is sent again (retryPolicy.ts): `busy` — the
 * provider answered and said not now, or dropped the connection; `offline` — this computer has no path
 * to it at all. Each has its own window of patience.
 */
export type RetryCause = 'busy' | 'offline'

/** How long, in milliseconds from the first failure of each kind, a request may keep trying. */
export interface RetryWindows {
  busyMs: number
  offlineMs: number
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  /**
   * The request failed before any of its reply arrived and goes out again (engine.ts): `wait` before
   * the pause — why, which attempt comes next and how long until then — and `send` the moment that
   * attempt starts. Not part of the reply: a caller that only collects the answer ignores both. The chat
   * turns them into a countdown in its run bar; before, a provider's overload looked like a model thinking.
   */
  | { type: 'retry'; phase: 'wait'; cause: RetryCause; detail: string; attempt: number; waitMs: number }
  | { type: 'retry'; phase: 'send'; attempt: number }
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
  | { type: 'finish'; reason: string; detail?: string }
  /** Who actually served this request. On OpenRouter that is the routed endpoint ("Fireworks",
   *  "BaseTen", …) — routing picks it per request from whatever is healthy and allowed, so speed,
   *  price and cache behaviour change between two otherwise identical runs, and this is the only
   *  thing that says which one you got. A direct provider names itself once. */
  | { type: 'provider'; name: string }
  /** The round's function calls, assembled. `replay` is what the provider needs back with them (see
   *  ProviderReplay) — the caller stores it on the assistant message via `assistantToolTurn`. */
  | { type: 'tool_calls'; calls: AccumTool[]; replay?: ProviderReplay }
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
   *  web_fetch server tools; OpenAI: the Responses API web_search tool; Google: google_search). */
  webSearch?: boolean
  /** Ceiling on the provider-side web lookups per reply (`parameters.max_uses` on each OpenRouter server tool);
   *  undefined/0 = the provider's own default. Every lookup re-runs the whole conversation through the
   *  model, so this bounds the round's cost, not just a per-search fee (V398). */
  webLookupsCap?: number
  /** Restrict the provider-side web search (and fetch) to these domains — bare hosts, no scheme.
   *  OpenRouter: `parameters.allowed_domains` on both server tools (Exa and most native engines;
   *  Google-native has no filter and falls back to Exa); OpenAI: `filters.allowed_domains`; Google
   *  direct has no filter either, so its transport names the hosts in the instructions instead.
   *  Undefined/empty = unrestricted. Set by the research legs only: the model that saw the first
   *  pass names where the authoritative confirmation lives, and the upgrade pass searches there. */
  webDomains?: string[]
  /** Cap or raise the model's thinking. Research legs pass 'low': retrieval work needs searching and
   *  transcribing, not deliberation — measured: GLM 5.3 defaults to effort "max" and
   *  spent a full 5-minute leg budget reasoning without writing one visible line. The chat passes the
   *  per-model setting (Settings → AI → Models). Omit to leave the model on its own default. */
  reasoningEffort?: ReasoningEffort
  /** Anthropic's automatic caching: one breakpoint that moves to the last block of every request, so
   *  what a conversation added in one round (tool results, a draft) is read from the cache in the next.
   *  Only for models that need breakpoints (`AiModel.explicitCache`); it takes one of their four slots.
   *  OpenRouter only; the OpenAI transport carries no such model and ignores it. */
  cacheTail?: boolean
  /** The conversation's routing key (routingSession.ts): OpenRouter's `session_id`, which keeps its
   *  requests with one provider and so with that provider's prompt cache. The OpenAI transport has
   *  only one provider and ignores it. */
  sessionId?: string
  signal?: AbortSignal
  /** The caller's spend ceiling, apart from Stop: once it fires, a reply the provider paused (Anthropic's
   *  `pause_turn`) is not continued — a continuation is a request of its own (client.ts). The running
   *  request is left to finish, as the agent leaves its round to finish. */
  budget?: AbortSignal
  /** How long this request may keep trying after failures, per kind (retryPolicy.ts DEFAULT_WINDOWS
   *  when absent). A caller with a clock of its own passes less than that clock, so its deadline never
   *  fires in the middle of a pause and reads as "out of time" when the network was the trouble. */
  retry?: Partial<RetryWindows>
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
  /** Map an HTTP failure onto the shared error vocabulary (see AiProviderError). `opts` is the request
   *  that failed, for a transport whose wording depends on what that request carried. */
  translateStatus(status: number, body: string, opts?: StreamChatOpts): AiProviderError
  /** Is this failure worth a second attempt? Takes the body because the status alone can lie:
   *  OpenAI sends "out of credits" as a 429 (`insufficient_quota`), Google a model the key's tier
   *  does not include as a 429 with "limit: 0", and retrying either is a hang ending in the same
   *  error. */
  retryable(status: number, body: string): boolean
  /** Fresh per-request scratch (accumulating tool-call fragments, once-only flags, …). Gets the
   *  request opts because some transports need them at stream end — OpenAI's cost synthesis prices
   *  the usage against the requested model's catalogue entry. */
  createState(opts: StreamChatOpts): S
  /** Translate one parsed SSE data object into zero or more StreamEvents, in order. */
  interpret(parsed: unknown, state: S): StreamEvent[]
  /** Did the provider finish this reply — did its own end-of-reply event arrive? `sawDone` says whether
   *  the `[DONE]` sentinel line came (OpenRouter's end). A stream that closes without it is a cut-off
   *  reply: the engine raises an error and `finish` is not called, so its tool calls are never run. */
  completed(state: S, sawDone: boolean): boolean
  /** End-of-stream events of a COMPLETED reply: assembled tool calls, a synthesized usage, … May be
   *  async: Google's citation links are redirects that are resolved here, once the stream has ended. */
  finish(state: S): StreamEvent[] | Promise<StreamEvent[]>
  /** Error text for a fetch that never reached the service at all. */
  unreachable: string
}
