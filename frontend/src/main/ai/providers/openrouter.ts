/**
 * The OpenRouter transport: request shape, routing preferences (zero data retention, preferred
 * throughput), the wire-to-StreamEvent translation, error wording, voice transcription and the live
 * pricing lookup. Uses the raw OpenAI-compatible HTTP API over `fetch` (no SDK dependency). The
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
import {
  AiProviderError,
  type AccumTool,
  type ChatTransport,
  type StreamChatOpts,
  type StreamEvent,
  type ToolSpec,
  type TranscribeOpts
} from './types'

const BASE_URL = 'https://openrouter.ai/api/v1'

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
const APP_HEADERS = {
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
 * exception, `anthropic/claude-fable-5.1` and `qwen/qwen3.8-max` have no zero-retention endpoint at
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

function translateStatus(status: number, body: string): AiProviderError {
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
  if (status === 400 && /context|token|length/i.test(detail))
    return new AiProviderError("Request too long for this model's context window.", 'context')
  // "No endpoints" / "all providers ignored" reads like PrismLCA filtered the model away. This
  // message once said categorically that no PrismLCA setting could cause it, and that was
  // true then — `data_collection` and the speed preference cannot. It stopped being true the day
  // PrismLCA began sending `zdr: true`: that one CAN empty the endpoint list, and some models have no
  // zero-retention endpoint at all. A message that rules out the actual cause is worse than none,
  // so it now names both possibilities in the order worth checking.
  if (status === 404 && /provider|endpoint/i.test(detail))
    return new AiProviderError(
      `${detail || 'No provider is available for this model.'} — two possible causes. ` +
        (getZeroDataRetention()
          ? 'First, PrismLCA itself: “Only use providers that keep nothing” restricts this model to ' +
            'zero-retention endpoints, and some models have none. Settings → AI → Limits → ' +
            'Privacy, where you can also exempt a vendor. '
          : '') +
        "Second, your OpenRouter ACCOUNT's own provider policy, which no request setting can " +
        'widen — allow the provider under openrouter.ai/settings/privacy. A model served by a ' +
        'single provider is unusable as soon as that one is excluded.',
      'no_endpoint'
    )
  return new AiProviderError(`OpenRouter error (HTTP ${status})${detail ? ` — ${detail}` : ''}.`, 'http')
}

/** Statuses worth a second attempt: rate limits and the provider's own bad days. Everything else —
 *  a bad key, exhausted credits, a malformed request — fails the same way however often it is sent. */
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504])

interface OrState {
  sentProvider: boolean // the serving endpoint's name rides on every chunk; report it once
  sentFinish: boolean // likewise for finish_reason: stated once, on the chunk that carries it
  calls: Record<number, AccumTool>
}

/**
 * Tool-call fragments arrive spread across chunks keyed by index, so we concatenate name/arguments
 * exactly like the OpenAI streaming spec.
 */
export const openrouterTransport: ChatTransport<OrState> = {
  name: 'openrouter',
  unreachable: 'OpenRouter unreachable — check your internet connection.',
  translateStatus,
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

    const body = JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      ...(hasFile ? { plugins: [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }] } : {}),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      max_tokens: clampMaxTokens(opts.maxTokens),
      stream: true,
      ...(tools.length ? { tools } : {}),
      ...(opts.reasoningEffort ? { reasoning: { effort: opts.reasoningEffort } } : {}),
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
      ...(_zdr || _minThroughput || PINNED_PROVIDERS.length
        ? {
            provider: {
              ...(_zdr ? { data_collection: 'deny' } : {}),
              ...(zdrForModel(opts.model) ? { zdr: true } : {}),
              ...(_minThroughput ? { preferred_min_throughput: _minThroughput } : {}),
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

  createState: (_opts) => ({ sentProvider: false, sentFinish: false, calls: {} }),

  interpret(raw: unknown, state: OrState): StreamEvent[] {
    const parsed = raw as any
    const events: StreamEvent[] = []
    // OpenRouter reports a failure that happens AFTER the 200 headers as an `error` object on the
    // event (with finish_reason "error"); read as an ordinary chunk it left the partial text standing
    // as the answer and a review with half a text counted as ok.
    if (parsed?.error && typeof parsed.error === 'object') {
      const code = Number(parsed.error.code)
      const message = String(parsed.error.message || 'OpenRouter reported an error mid-stream.')
      throw new AiProviderError(message, code === 402 ? 'credits' : code === 429 ? 'rate' : 'http')
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
    for (const tc of delta?.tool_calls ?? []) {
      const slot = (state.calls[tc.index] ??= { id: '', name: '', arguments: '' })
      if (tc.id) slot.id = tc.id
      if (tc.function?.name) slot.name += tc.function.name
      if (tc.function?.arguments) slot.arguments += tc.function.arguments
    }
    return events
  },

  finish(state: OrState): StreamEvent[] {
    const assembled = Object.keys(state.calls)
      .map(Number)
      .sort((a, b) => a - b)
      .map((i) => state.calls[i])
      .filter((c) => c.name)
    return assembled.length ? [{ type: 'tool_calls', calls: assembled }] : []
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
        provider: { data_collection: 'deny' }
      }),
      signal: opts.signal
    })
  } catch (e) {
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

/**
 * Live pricing ($/1M tokens) for the given model ids, from OpenRouter /models (1 h cache).
 *
 * `/models` is a listing, not the full set of ids OpenRouter serves: an id that is an ALIAS of a
 * dated snapshot answers on `/chat/completions` and on `/models/{id}/endpoints`, but never appears
 * in the listing — `qwen/qwen3.8-max` (served by Alibaba, listed only as `…-max-0902`) is one, and
 * it sat in the settings table with an empty price column while working perfectly. So anything the
 * listing does not cover is asked for directly, one call per unmatched id, behind the same hour of
 * cache. Cheapest endpoint wins, which is what routing picks by default.
 *
 * An id with genuinely NO endpoint (a promo that ended) still comes back without a price — that
 * dash is correct, and it is the visible half of a model that can no longer be called at all.
 *
 * Pass only token-billed chat ids. The speech model is billed per audio unit, and its "prompt"
 * figure would render as a token price in a column headed $/1M (the three endpoints quote
 * 0.0000075, 0.0015 and 0.111 per unit — not the same unit, and none of them tokens).
 */
let _priceCache: { ts: number; data: Record<string, { input: number; output: number }> } = {
  ts: 0,
  data: {}
}
/**
 * Drop the price cache. Called when the catalogue gains a model, because the cache is keyed by
 * nothing: it answers with whatever it fetched an hour ago, for whatever ids were asked for THEN.
 * A model added through the dialog would otherwise show "–" in the price column until the hour was
 * up — which is exactly what happened the first time the dialog was used against the running app.
 */
export function clearPriceCache(): void {
  _priceCache = { ts: 0, data: {} }
}

export async function fetchOpenRouterPricing(
  ids: string[],
  key: string | null
): Promise<Record<string, { input: number; output: number }>> {
  // Every requested id must be covered, not just "the cache is fresh": the entry set changes when
  // the user adds a model, and a hit on a stale key set is how a new row loses its price.
  const covered = ids.every((id) => id in _priceCache.data)
  if (covered && Date.now() - _priceCache.ts < 3_600_000 && Object.keys(_priceCache.data).length)
    return _priceCache.data
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: key ? { Authorization: `Bearer ${key}`, ...APP_HEADERS } : APP_HEADERS
    })
    if (!res.ok) return _priceCache.data
    const json = (await res.json()) as { data: Array<{ id: string; pricing?: Record<string, string> }> }
    const wanted = new Set(ids)
    const out: Record<string, { input: number; output: number }> = {}
    for (const m of json.data) {
      if (!wanted.has(m.id)) continue
      out[m.id] = {
        input: parseFloat(m.pricing?.prompt ?? '0') * 1_000_000,
        output: parseFloat(m.pricing?.completion ?? '0') * 1_000_000
      }
    }
    // Bounded and parallel. `ai:models` awaits this before it returns ANY row, and since the user
    // can now put fifty ids of their own in models.json, a serial loop of unmatched lookups would
    // hold the whole picker open on their typos. Beyond the cap a row simply shows no price, which
    // the table already renders as a dash.
    const missing = ids.filter((id) => !out[id]).slice(0, MAX_ENDPOINT_LOOKUPS)
    const extra = await Promise.all(missing.map((id) => fetchEndpointPricing(id, key)))
    missing.forEach((id, i) => {
      const p = extra[i]
      if (p) out[id] = p
    })
    _priceCache = { ts: Date.now(), data: out }
    return out
  } catch {
    return _priceCache.data
  }
}

/**
 * Everything the "Add model" dialog needs about one OpenRouter model, in the shape it is shown.
 *
 * Assembled from two endpoints, both cached for the hour: `/models` for the listing, and
 * `/endpoints/zdr` for the one column a user cannot guess — whether the model can be served at all
 * under PrismLCA's privacy rule. Measured: sixteen of the eighteen catalogue models have a
 * zero-retention endpoint and two have none, so this is not a nicety, it is the difference between
 * a model that works and a 404 on first use.
 */
export interface OrCatalogueEntry {
  id: string
  name: string
  contextTokens: number | null
  vision: boolean
  pricing: { input: number; output: number } | null
  /** Has at least one zero-retention endpoint. `false` = unusable while the privacy rule is on;
   *  `null` = the ZDR listing could not be fetched, so nothing is known either way. */
  zdr: boolean | null
}

let _cat: { ts: number; rows: OrCatalogueEntry[] } = { ts: 0, rows: [] }

/** The full OpenRouter model list, for the picker. One hour of cache, like the prices. */
export async function fetchOpenRouterCatalogue(key: string | null): Promise<OrCatalogueEntry[]> {
  if (Date.now() - _cat.ts < 3_600_000 && _cat.rows.length) return _cat.rows
  const headers = key ? { Authorization: `Bearer ${key}`, ...APP_HEADERS } : APP_HEADERS
  try {
    const [listRes, zdrRes] = await Promise.all([
      fetch(`${BASE_URL}/models`, { headers }),
      // Best effort: without it every row would claim "no ZDR", which is worse than saying nothing.
      fetch(`${BASE_URL}/endpoints/zdr`, { headers }).catch(() => null)
    ])
    if (!listRes.ok) return _cat.rows
    const list = (await listRes.json()) as {
      data: Array<{
        id: string
        name?: string
        context_length?: number
        top_provider?: { context_length?: number }
        architecture?: { input_modalities?: string[] }
        pricing?: Record<string, string>
      }>
    }
    const zdrIds = new Set<string>()
    let zdrKnown = false
    if (zdrRes?.ok) {
      const z = (await zdrRes.json()) as { data?: Array<{ model_id?: string }> }
      for (const e of z.data ?? []) if (e.model_id) zdrIds.add(e.model_id)
      zdrKnown = true
    }
    const rows = list.data.map((m) => {
      const input = parseFloat(m.pricing?.prompt ?? '') * 1_000_000
      const output = parseFloat(m.pricing?.completion ?? '') * 1_000_000
      return {
        id: m.id,
        name: m.name || m.id,
        // top_provider is the conservative figure — the catalogue's own convention (see the Kimi
        // entry in models.ts): the smallest window any serving endpoint offers.
        contextTokens: m.top_provider?.context_length ?? m.context_length ?? null,
        vision: (m.architecture?.input_modalities ?? []).includes('image'),
        pricing: Number.isFinite(input) && Number.isFinite(output) ? { input, output } : null,
        // Unknown stays unknown: a failed ZDR fetch used to mark every model "no ZDR" for an hour.
        zdr: zdrKnown ? zdrIds.has(m.id) : null
      }
    })
    rows.sort((a, b) => a.id.localeCompare(b.id))
    // Without the ZDR column the listing is served now but retried on the next call, not in an hour.
    _cat = { ts: zdrKnown ? Date.now() : Date.now() - 3_600_000 + 60_000, rows }
    return rows
  } catch {
    return _cat.rows
  }
}

/** How many ids the listing did not cover are looked up one by one. Small on purpose: it is a
 *  display nicety, and it sits in front of the settings table's first paint. */
const MAX_ENDPOINT_LOOKUPS = 8
/** Timeout for one such lookup. Without it a stalled connection holds the catalogue response. */
const ENDPOINT_TIMEOUT_MS = 4000

/** The cheapest endpoint's price for one model id, or null if nothing serves it. */
async function fetchEndpointPricing(
  id: string,
  key: string | null
): Promise<{ input: number; output: number } | null> {
  try {
    // Segment-encoded: this id can come from the user's own models.json. The loader's grammar
    // already refuses URL syntax, but a single door on a value that steers an authenticated
    // request is one door too few.
    const path = id.split('/').map(encodeURIComponent).join('/')
    const res = await fetch(`${BASE_URL}/models/${path}/endpoints`, {
      headers: key ? { Authorization: `Bearer ${key}`, ...APP_HEADERS } : APP_HEADERS,
      signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      data?: { endpoints?: Array<{ pricing?: Record<string, string> }> }
    }
    const priced = (json.data?.endpoints ?? [])
      .map((e) => ({
        input: parseFloat(e.pricing?.prompt ?? '') * 1_000_000,
        output: parseFloat(e.pricing?.completion ?? '') * 1_000_000
      }))
      .filter((p) => Number.isFinite(p.input) && Number.isFinite(p.output))
    if (!priced.length) return null
    return priced.reduce((a, b) => (a.input + a.output <= b.input + b.output ? a : b))
  } catch {
    return null
  }
}
