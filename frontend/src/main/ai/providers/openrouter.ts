/**
 * The OpenRouter transport: request shape, routing preferences (zero data retention, preferred
 * throughput, the provider allowlist), the wire-to-StreamEvent translation, error wording and voice
 * transcription. The live listings (prices, the model catalogue, provider names) are in
 * openrouterListings.ts; they read the routing state through `providerAllowlist` and `zdrForModel`. Uses the raw OpenAI-compatible HTTP API over `fetch` (no SDK dependency). The
 * shared mechanics (retry, stall watchdog, SSE splitting) live in engine.ts; key resolution and
 * provider dispatch live in ../client.ts.
 */
import {
  clampMaxTokens,
  clampMinThroughput,
  DEFAULT_MIN_THROUGHPUT,
  DEFAULT_ZDR_EXCEPT_ANTHROPIC,
  DEFAULT_ZDR_EXCEPT_GOOGLE,
  DEFAULT_ZDR_EXCEPT_OPENAI,
  DEFAULT_ZERO_DATA_RETENTION
} from '../../../shared/aiDefaults'
import { DEFAULT_PROVIDER_ALLOWLIST } from '../../../shared/providerAllowlist'
import { TRANSCRIBE_TIMEOUT, withDeadline } from './engine'
import {
  AiProviderError,
  lastUserIndex,
  type AccumTool,
  type ChatMessage,
  type ChatTransport,
  type StreamChatOpts,
  type StreamEvent,
  type ToolSpec,
  type TranscribeOpts
} from './types'
import { contextOverflow } from './contextOverflow'

export const BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * Diagnostics only — never a setting: `PRISM_OPENROUTER_PROVIDER_ORDER="Amazon Bedrock,Google"` pins a
 * dev run to those endpoints (no fallback), so a usage figure that looks wrong can be compared across
 * routes with everything else equal. Measured (V398): the same chat reported 2–3× its
 * prompt tokens in single rounds, with the chunk naming "OpenAI" while the generation record said Google.
 */
const PINNED_PROVIDERS: string[] = (process.env['PRISM_OPENROUTER_PROVIDER_ORDER'] ?? '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean)
// Sent so OpenRouter can attribute traffic to the app (optional but recommended).
export const APP_HEADERS = {
  'HTTP-Referer': 'https://github.com/prismlca/prismlca',
  'X-Title': 'PrismLCA'
}

/**
 * Zero-data-retention routing for CHAT traffic (chat, sub-agents, report writer), owned here rather
 * than threaded through all seven `streamChat` call sites — several of them run deep inside an agent
 * turn with no path back to the renderer's settings.
 *
 * The renderer mirrors its Settings value here at startup and on every change; the default stands
 * until it does, so a call that somehow beats the sync is protected, not exposed.
 *
 * An OpenRouter ROUTING preference: it narrows which endpoints may serve a request. The OpenAI
 * transport has no equivalent (retention there is an account-level agreement, not a per-request
 * flag), which is why this state lives with this transport and the Settings UI says so.
 */
let _zdr = DEFAULT_ZERO_DATA_RETENTION
/** The vendors whose models may skip the zero-retention rule (Settings → AI → Limits → Privacy). */
export interface ZdrExceptions {
  anthropic: boolean
  openai: boolean
  google: boolean
}

let _zdrExcept: ZdrExceptions = {
  anthropic: DEFAULT_ZDR_EXCEPT_ANTHROPIC,
  openai: DEFAULT_ZDR_EXCEPT_OPENAI,
  google: DEFAULT_ZDR_EXCEPT_GOOGLE
}

/** Renderer → main mirror of Settings → AI → Limits → Privacy. */
export function setZeroDataRetention(on: boolean, except?: ZdrExceptions): void {
  _zdr = on
  if (except) _zdrExcept = except
}

export function getZeroDataRetention(): boolean {
  return _zdr
}

/**
 * Does THIS model's request carry `zdr: true`?
 *
 * OpenRouter's per-request flag is a single boolean — the per-model-group fields
 * (`enforce_zdr_anthropic` …) exist only account-wide and on guardrails — so the exception is made
 * here, by vendor prefix, which produces the same routing. Measured: without an
 * exception, `anthropic/claude-fable-5.2` and `qwen/qwen3.8-max` have no zero-retention endpoint at
 * all and would answer 404. Google followed: its Gemini endpoints (Vertex and AI Studio)
 * log prompts for abuse monitoring, and OpenRouter announced "Safety Retention" for all Google models
 * from 2026-10-18.
 *
 * `data_collection: 'deny'` is NOT exempted with it: that one is the training filter (OpenRouter's
 * own wording for the opposite value is "providers which store user data non-transiently and may
 * train on it"), and no exception here should let a prompt into a training set.
 */
export function zdrForModel(modelId: string): boolean {
  if (!_zdr) return false
  const vendor = modelId.split('/')[0]
  if (vendor === 'anthropic' && _zdrExcept.anthropic) return false
  if (vendor === 'openai' && _zdrExcept.openai) return false
  if (vendor === 'google' && _zdrExcept.google) return false
  return true
}

let _minThroughput = DEFAULT_MIN_THROUGHPUT

/** Renderer → main mirror of Settings → AI → Costs → preferred provider throughput. */
export function setMinThroughput(tokensPerSecond: number): void {
  _minThroughput = clampMinThroughput(tokensPerSecond)
}

/**
 * The hosts a chat request may go to (`provider.only`), or null for no restriction. Mirrored from
 * Settings → AI → Provider like the two above, and like them the default stands until the mirror
 * arrives: a call that beats the sync is held to our list, not let out to every host.
 *
 * `only` narrows within the account's own "Allowed Providers" — that list stays the ceiling — and it
 * does not switch Auto Exacto off (only `sort`, `:floor` and an account-wide sort do), so among the
 * hosts left OpenRouter still routes tool calls by quality. An empty list is sent as it is: every
 * request then fails with the 404 below, which names this setting, rather than quietly running on
 * every host while the switch says otherwise.
 */
let _only: string[] | null = [...DEFAULT_PROVIDER_ALLOWLIST]

export function setProviderAllowlist(list: string[] | null): void {
  _only = list ? [...list] : null
}

/** The allowlist in force, or null — for the price lookup, which prices what routing may use. */
export function providerAllowlist(): string[] | null {
  return _only ? [..._only] : null
}

/** Everything a request's routing restrictions depend on, as one string: the price cache is only
 *  valid for the settings it was filled under. */
export function routingSignature(): string {
  return JSON.stringify([_only, _zdr, _zdrExcept])
}

/** The two PrismLCA restrictions that can empty a model's endpoint list — as a request carried them. */
interface Restrictions {
  zdr: boolean
  only: boolean
}
const UNRESTRICTED: Restrictions = { zdr: false, only: false }

/** What each request carried, recorded when it was built: a setting changed while the request runs must
 *  not change what its failure says. Keyed by the request's options object, which the engine hands
 *  to `buildRequest`, `createState` and `translateStatus` alike, and which nothing else holds on to. */
const _sent = new WeakMap<StreamChatOpts, Restrictions>()

function translateStatus(status: number, body: string, sent: Restrictions = UNRESTRICTED): AiProviderError {
  let detail = ''
  try {
    detail = JSON.parse(body)?.error?.message ?? ''
  } catch {
    /* non-JSON error body */
  }
  if (status === 401) return new AiProviderError('OpenRouter API key invalid or missing.', 'auth')
  if (status === 402)
    return new AiProviderError(
      'OpenRouter credits exhausted — please top up (openrouter.ai/credits).',
      'credits'
    )
  if (status === 429)
    return new AiProviderError('OpenRouter rate limit reached — wait a moment and try again.', 'rate_limit')
  if (status === 400 && contextOverflow(detail))
    return new AiProviderError("Request too long for this model's context window.", 'context')
  // "No endpoints" / "all providers ignored" reads like PrismLCA filtered the model away. This
  // message once said categorically that no PrismLCA setting could cause it, and that was
  // true then — `data_collection` and the speed preference cannot. It stopped being true the day
  // PrismLCA began sending `zdr: true`: that one CAN empty the endpoint list, and some models have no
  // zero-retention endpoint at all. A message that rules out the actual cause is worse than none,
  // so it names the possibilities in the order worth checking — and only those the failed request
  // actually carried: a transcription sends neither restriction, an exempted vendor no `zdr`.
  if (status === 404 && /provider|endpoint/i.test(detail))
    return new AiProviderError(
      `${detail || 'No provider is available for this model.'} — ` +
        (sent.zdr || sent.only
          ? 'First, PrismLCA itself. ' +
            (sent.zdr
              ? '“Only use providers that keep nothing” restricts this model to zero-retention ' +
                'endpoints, and some models have none (Settings → AI → Limits → Privacy, where you can ' +
                'also exempt a vendor). '
              : '') +
            (sent.only
              ? '“Only use providers from the allowlist” restricts it to the hosts on that list, and ' +
                'none of them may serve it (Settings → AI → Provider → Edit list). '
              : '') +
            'Second, '
          : 'Check ') +
        "your OpenRouter ACCOUNT's own provider policy, which no request setting can " +
        'widen — allow the provider under openrouter.ai/settings/privacy. A model served by a ' +
        'single provider is unusable as soon as that one is excluded.',
      'no_endpoint'
    )
  return new AiProviderError(`OpenRouter error (HTTP ${status})${detail ? ` — ${detail}` : ''}.`, 'http')
}

/** Statuses worth a second attempt: rate limits and the provider's own bad days — among them 520–524,
 *  what Cloudflare in front of OpenRouter answers when the origin fails or times out. Everything else —
 *  a bad key, exhausted credits, a malformed request — fails the same way however often it is sent. */
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524])

interface OrState {
  model: string
  /** What this request carried, for the wording of a mid-stream "no endpoint" error. */
  restrictions: Restrictions
  sentProvider: boolean // the serving endpoint's name rides on every chunk; report it once
  sentFinish: boolean // likewise for finish_reason: stated once, on the chunk that carries it
  calls: Record<number, AccumTool>
  /** The reply's reasoning blocks (`reasoning_details`), in the order they arrived, assembled from
   *  their streamed pieces. */
  details: Array<Record<string, unknown>>
}

/** The string fields of a reasoning block that arrive in pieces; everything else (id, format, type, the
 *  signature that comes last) is taken whole from whichever piece carries it. */
const STREAMED_FIELDS = ['text', 'summary', 'data'] as const

/**
 * The reasoning formats whose blocks go back with their tool round — by measurement, not by default.
 * Same modelling task, three runs per side, with and without the blocks (2026-11-08): Gemini's
 * (`google-gemini-v1`) made the prompt cache hit more often (63 % → 75 % of prompt tokens) and the run
 * a fifth cheaper; OpenAI's (`openai-responses-v1`) added a third to every request for no gain; Anthropic's
 * showed nothing either way at this size. A format joins this list when a measurement says it pays.
 */
const REPLAYED_FORMATS = new Set(['google-gemini-v1'])

/**
 * Merge one streamed `reasoning_details` piece into the block it continues, or start a new one. A piece
 * continues only the LAST block, and only one of its own type, index and id — several blocks may share
 * an index (a summary and an encrypted block both at 0), and an encrypted block is never glued to
 * another unless both name the same id: two blobs joined are one invalid blob, and OpenRouter wants the
 * blocks back exactly as the model produced them.
 */
function addDetail(state: OrState, piece: Record<string, unknown>): void {
  const block = state.details.at(-1)
  const continues =
    !!block &&
    block.type === piece.type &&
    (block.index ?? null) === (piece.index ?? null) &&
    (piece.id == null || block.id == null || piece.id === block.id) &&
    (piece.type !== 'reasoning.encrypted' || (piece.id != null && piece.id === block.id))
  if (!block || !continues) {
    state.details.push({ ...piece })
    return
  }
  for (const [k, v] of Object.entries(piece)) {
    if ((STREAMED_FIELDS as readonly string[]).includes(k) && typeof v === 'string')
      block[k] = String(block[k] ?? '') + v
    else if (v != null) block[k] = v
  }
}

/** Our transcript as OpenRouter messages: another provider's replay stays out, and this provider's
 *  reasoning blocks go back on the assistant message of their tool round — unchanged and in order, as
 *  OpenRouter requires — when the request goes to the model that wrote them, and only for the rounds of
 *  the current turn (after the last user message): that is what the models continue from, and older
 *  blocks would only grow every request. */
function toOpenRouterMessages(messages: ChatMessage[], model: string): Array<Record<string, unknown>> {
  const turnStart = lastUserIndex(messages)
  return messages.map(({ replay, ...m }, i) =>
    i > turnStart &&
    m.role === 'assistant' &&
    replay?.provider === 'openrouter' &&
    replay.model === model &&
    replay.steps.length
      ? { ...m, reasoning_details: replay.steps }
      : m
  )
}

/**
 * Tool-call fragments arrive spread across chunks keyed by index, so we concatenate name/arguments
 * exactly like the OpenAI streaming spec.
 */
export const openrouterTransport: ChatTransport<OrState> = {
  name: 'openrouter',
  unreachable: 'OpenRouter unreachable — check your internet connection.',
  translateStatus: (status, body, opts) =>
    translateStatus(status, body, (opts && _sent.get(opts)) ?? UNRESTRICTED),
  retryable: (status) => RETRYABLE.has(status),

  buildRequest(opts: StreamChatOpts, key: string) {
    // OpenRouter "server tools" run on OpenRouter's side (the model decides if/when to use them);
    // they ride along in the same tools array as our function tools. The search fee is small; what
    // costs is that OpenRouter runs the model AGAIN with the whole conversation after every lookup and
    // sums the passes into one usage figure (V398: 375k prompt tokens billed for an 85k conversation).
    // `parameters.max_uses` bounds that per tool; 0/undefined sends no cap. The cap MUST sit under
    // `parameters`: on tool level the API accepts it silently and ignores it — measured
    // with three identical requests on the Exa engine (top level: 3 searches, 0.022 $; under
    // parameters: 1 search, 0.008 $; no cap: 3 searches).
    // `allowed_domains` sits beside it — the same nesting, documented for both tools (web_fetch spells
    // its block list `blocked_domains`, web_search `excluded_domains`; only the allow list is sent).
    const tools: Array<ToolSpec | { type: string; parameters?: Record<string, unknown> }> = [
      ...(opts.tools ?? [])
    ]
    if (opts.webSearch) {
      const params: Record<string, unknown> = {}
      if (opts.webLookupsCap && opts.webLookupsCap > 0) params.max_uses = opts.webLookupsCap
      if (opts.webDomains?.length) params.allowed_domains = opts.webDomains
      const cap = Object.keys(params).length ? { parameters: params } : {}
      tools.push({ type: 'openrouter:web_search', ...cap }, { type: 'openrouter:web_fetch', ...cap })
    }

    // An attached PDF rides in the messages as a `file` part. Models that read PDFs natively get it
    // as it is; for the rest OpenRouter parses it and passes the text on — but only if we say with
    // which engine. `cloudflare-ai` (PDF → Markdown) is free; the alternative, `mistral-ocr`, bills
    // $2 per 1000 pages, and nothing in the app would tell the user that a dropped file had just
    // cost money. Scans are covered from the other side anyway: a model that reads PDFs natively
    // sees the page images itself.
    const hasFile = opts.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => (p as { type?: string }).type === 'file')
    )

    // The two restrictions a "no endpoint" answer may be blamed on, taken once and kept with the request.
    const only = _only
    const sent: Restrictions = { zdr: zdrForModel(opts.model), only: only !== null }
    _sent.set(opts, sent)
    const body = JSON.stringify({
      model: opts.model,
      messages: toOpenRouterMessages(opts.messages, opts.model),
      ...(hasFile ? { plugins: [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }] } : {}),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      max_tokens: clampMaxTokens(opts.maxTokens),
      stream: true,
      ...(tools.length ? { tools } : {}),
      ...(opts.reasoningEffort ? { reasoning: { effort: opts.reasoningEffort } } : {}),
      ...(opts.cacheTail ? { cache_control: { type: 'ephemeral' } } : {}),
      ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
      // Routing preferences, in one object because OpenRouter takes them that way.
      //  - data_collection: only providers that do not collect data, i.e. cannot train on the
      //    prompt. OpenRouter's wording for the opposite value: "providers which store user data
      //    non-transiently and may train on it".
      //  - zdr: the stricter, separate rule — only endpoints that retain NOTHING. Per model,
      //    because a vendor can be exempted (see zdrForModel); the parameter itself is one boolean
      //    per request, and it ORs with the account setting, so it can only ever tighten.
      //  - preferred_min_throughput: express which endpoints we would RATHER have. Routing otherwise
      //    picks per request with no input from us, and the same model on the same prompt was measured
      //    at 4.5 and then 20 tokens/s minutes apart. Documented as unable to prevent a request from
      //    running — endpoints that clear the bar are favoured, and if none does the request goes out
      //    unchanged — so this can slow nothing down and block nothing. A bare number is the p50.
      //  - only: the allowlist (see setProviderAllowlist) — the hosts that may serve at all.
      ...(_zdr || _minThroughput || only || PINNED_PROVIDERS.length
        ? {
            provider: {
              ...(_zdr ? { data_collection: 'deny' } : {}),
              ...(sent.zdr ? { zdr: true } : {}),
              ...(_minThroughput ? { preferred_min_throughput: _minThroughput } : {}),
              ...(only ? { only } : {}),
              ...(PINNED_PROVIDERS.length ? { order: PINNED_PROVIDERS, allow_fallbacks: false } : {})
            }
          }
        : {}),
      usage: { include: true }
    })
    return {
      url: `${BASE_URL}/chat/completions`,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...APP_HEADERS
      },
      body
    }
  },

  createState: (opts) => ({
    model: opts.model,
    restrictions: _sent.get(opts) ?? UNRESTRICTED,
    sentProvider: false,
    sentFinish: false,
    calls: {},
    details: []
  }),

  interpret(raw: unknown, state: OrState): StreamEvent[] {
    const parsed = raw as any
    const events: StreamEvent[] = []
    // OpenRouter reports a failure that happens AFTER the 200 headers as an `error` object on the
    // event (with finish_reason "error"); read as an ordinary chunk it left the partial text standing
    // as the answer and a review with half a text counted as ok.
    if (parsed?.error && typeof parsed.error === 'object') {
      // Its `code` is the HTTP status the request would have failed with: classified and retried the same.
      const code = Number(parsed.error.code)
      const status = Number.isInteger(code) && code >= 400 && code < 600 ? code : 0
      const body = JSON.stringify({
        error: { message: String(parsed.error.message || 'OpenRouter reported an error mid-stream.') }
      })
      const e = status
        ? translateStatus(status, body, state.restrictions)
        : new AiProviderError(
            String(parsed.error.message || 'OpenRouter reported an error mid-stream.'),
            'http'
          )
      e.retryable = RETRYABLE.has(status)
      throw e
    }
    // Which endpoint actually served this request. OpenRouter puts it on every chunk; it used to
    // be dropped, and with it the only way to tell a slow provider from a slow model. Measured
    // In one case the same prompt ran at 4.5 tok/s and, two minutes later, at 20 tok/s, with
    // nothing in the app able to say that anything had changed. Emitted once per request.
    if (!state.sentProvider && typeof parsed.provider === 'string' && parsed.provider) {
      state.sentProvider = true
      events.push({ type: 'provider', name: parsed.provider })
    }
    if (parsed.usage)
      events.push({
        type: 'usage',
        usage: typeof parsed.id === 'string' ? { ...parsed.usage, generation_id: parsed.id } : parsed.usage
      })
    const choice = parsed.choices?.[0]
    if (!choice) return events
    // Said once, on the chunk that carries it. Callers that produce nothing need this to tell
    // "thought and wrote nothing" from "cut off" from "refused" — see StreamEvent.
    if (!state.sentFinish && typeof choice.finish_reason === 'string' && choice.finish_reason) {
      state.sentFinish = true
      events.push({ type: 'finish', reason: choice.finish_reason })
    }
    const delta = choice.delta
    if (delta?.content) events.push({ type: 'delta', text: delta.content })
    // What the server-side web search cited: `url_citation` annotations ride on the delta (and on
    // the message of a non-streamed reply). Passed on as they come; the research legs match them
    // against the URLs the model wrote, so a citation is the engine's word, not the model's.
    const annotations = delta?.annotations ?? choice.message?.annotations
    if (Array.isArray(annotations) && annotations.length) {
      const citations = annotations
        .map((a: any) => a?.url_citation ?? (a?.type === 'url_citation' ? a : null))
        .filter((c: any) => c && typeof c.url === 'string' && c.url)
        .map((c: any) => ({
          url: String(c.url),
          ...(typeof c.title === 'string' && c.title ? { title: c.title } : {}),
          ...(typeof c.content === 'string' && c.content ? { excerpt: c.content } : {})
        }))
      if (citations.length) events.push({ type: 'citations', citations })
    }
    // Providers spell this differently (`reasoning` on OpenRouter, `reasoning_content` on some
    // upstreams); count whichever arrives. Only the length travels on — see StreamEvent.
    const think = delta?.reasoning ?? delta?.reasoning_content
    if (typeof think === 'string' && think.length) events.push({ type: 'reasoning', chars: think.length })
    if (Array.isArray(delta?.reasoning_details))
      for (const piece of delta.reasoning_details)
        if (piece && typeof piece === 'object') addDetail(state, piece as Record<string, unknown>)
    for (const tc of delta?.tool_calls ?? []) {
      const slot = (state.calls[tc.index] ??= { id: '', name: '', arguments: '' })
      if (tc.id) slot.id = tc.id
      if (tc.function?.name) slot.name += tc.function.name
      if (tc.function?.arguments) slot.arguments += tc.function.arguments
    }
    return events
  },

  // The end of a reply is the `[DONE]` line; a stream cut before it that still stated a finish reason
  // also finished (the reason is on the reply's last chunk).
  completed: (state, sawDone) => sawDone || state.sentFinish,

  finish(state: OrState): StreamEvent[] {
    const assembled = Object.keys(state.calls)
      .map(Number)
      .sort((a, b) => a - b)
      .map((i) => state.calls[i])
      .filter((c) => c.name)
    if (!assembled.length) return []
    // Only formats measured to pay for themselves travel back (REPLAYED_FORMATS). A block may leave out
    // `format` (continuations do), so the reply's NAMED formats decide: all of them on the list, and at
    // least one named — otherwise the round keeps none, so a reply is never resent with half its reasoning.
    const formats = new Set(
      state.details
        .map((d) => d.format)
        .filter((f) => f != null)
        .map(String)
    )
    const steps = formats.size > 0 && [...formats].every((f) => REPLAYED_FORMATS.has(f)) ? state.details : []
    return [
      {
        type: 'tool_calls',
        calls: assembled,
        ...(steps.length ? { replay: { provider: 'openrouter' as const, model: state.model, steps } } : {})
      }
    ]
  }
}

/** Model used for voice-to-text via OpenRouter's dedicated transcription endpoint. NOT whisper-1:
 * its only provider conflicts with the account's data-collection=deny policy (404 "no endpoints"),
 * while whisper-large-v3 is served by ZDR providers (Groq) — and is cheaper and more accurate. */
export const STT_MODEL = 'openai/whisper-large-v3'

/**
 * Transcribe an audio recording via OpenRouter's /audio/transcriptions endpoint. The audio is
 * passed through as-is (base64) — no local decoding/conversion. Returns the transcript text and
 * the real request cost (USD) when OpenRouter reports one.
 */
export async function transcribeOpenRouter(
  opts: TranscribeOpts,
  key: string
): Promise<{ text: string; cost?: number; model: string }> {
  let res: Response
  try {
    res = await fetch(`${BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...APP_HEADERS
      },
      body: JSON.stringify({
        model: STT_MODEL,
        input_audio: { data: opts.data, format: opts.format },
        ...(opts.language ? { language: opts.language } : {}),
        // Always zero-data-retention, deliberately NOT following the chat setting: a recording is
        // raw voice, and the ZDR provider (Groq/whisper-large-v3) is the cheaper, better one anyway.
        // Nor the allowlist: it is about how hosts carry long tool-calling runs, and every host of
        // the speech model already passes the stricter zero-retention rule above.
        provider: { data_collection: 'deny' }
      }),
      signal: withDeadline(opts.signal)
    })
  } catch (e) {
    if ((e as Error)?.name === 'TimeoutError') throw new AiProviderError(TRANSCRIBE_TIMEOUT, 'stalled')
    if ((e as Error)?.name === 'AbortError') throw new AiProviderError('Canceled.', 'aborted')
    throw new AiProviderError('OpenRouter unreachable — check your internet connection.', 'network')
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw translateStatus(res.status, text)
  }
  const json = (await res.json()) as { text?: string; usage?: { cost?: number } }
  return { text: (json.text ?? '').trim(), cost: json.usage?.cost, model: STT_MODEL }
}
