/**
 * The direct-Google transport, speaking the **Interactions API** (`POST /v1beta/interactions`) —
 * Google's default interface since June 2026. `generateContent` remains supported but is called legacy,
 * and the OpenAI-compatible endpoint has no Google Search at all, which would leave the research tools
 * without a web. One API surface for everything Google, like the Responses API is for OpenAI.
 *
 * The seams to know about, each measured against the live API (2026-11-07, free-tier key):
 *  - **Stateless by choice, and that has to be said**: the Interactions API STORES every interaction
 *    by default (55 days paid, 1 day free) so a later request can chain to it. We send the whole
 *    transcript every time with `store: false`, the counterpart of OpenAI's `store: false`.
 *  - **Thought steps must travel back.** A reasoning model's `thought` step carries a signature, and a
 *    function call answered without the thought step that led to it is rejected (HTTP 400 "invalid
 *    argument"). So every tool round hands its steps on as `replay` (types.ts, ProviderReplay) and
 *    they are resent verbatim. A tool round WITHOUT them — a transcript from another provider, or one
 *    older than this transport — gets Google's documented skip value as its signature instead, which
 *    the API accepted in the same test. Older rounds are not validated at all.
 *  - **Cost is synthesized**: the usage reports tokens only. Thinking is billed at the output price but
 *    reported apart from it, and the search tool's own prompt tokens apart from the input; all of them
 *    are priced here against the catalogue's list prices (directModels.ts), plus a fee per search
 *    QUERY, and the figure is marked `estimated`.
 *  - **Citations are redirects**: `url_citation` URLs point at vertexaisearch.cloud.google.com, the
 *    title is the bare domain, and the model does not write the URLs into its text. They are resolved
 *    to the real pages once the stream has ended (`finish`), because the research tools match an
 *    item's source against them.
 *  - **No domain filter** exists on Google Search here, so the research legs' allow list becomes a
 *    sentence in the instructions — a request to the model, not a filter, and said as such.
 *  - **No temperature**: the API has no sampling parameters; Google says to drop them for Gemini 3+.
 *  - **Errors come in three shapes** (JSON object, a JSON array for a bad key, SSE text mid-stream),
 *    a bad key is a 400 rather than a 401, and a model the key's tier does not include is a 429
 *    saying "limit: 0" — mapped to 'credits' and never retried.
 */
import { clampMaxTokens, type ReasoningEffort } from '../../../shared/aiDefaults'
import { GOOGLE_SEARCH_USD_PER_QUERY, priceOn } from '../directModels'
import { getModels } from '../models'
import { TRANSCRIBE_TIMEOUT, withDeadline } from './engine'
import {
  AiProviderError,
  type AccumTool,
  type ChatMessage,
  type ChatTransport,
  type Citation,
  type StreamChatOpts,
  type StreamEvent,
  type TranscribeOpts
} from './types'

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

/** The schema revision this transport was written and measured against. Pinned because the
 *  Interactions API changes shape by revision — the May 2026 one replaced `outputs` with `steps` —
 *  and an unannounced switch would arrive as a stream this file no longer understands. */
const API_REVISION = '2026-05-20'

/** A single streamed hop's output ceiling on Gemini 4 Argon (longer output needs background mode);
 *  thinking counts against it. A higher user setting is clamped rather than bounced. */
const MAX_OUTPUT_TOKENS = 65_536

/** Google's documented value for a function call whose real signature does not exist — history from
 *  another model. Accepted by the Interactions API in a live test although only the generateContent
 *  page names it. */
export const SKIP_SIGNATURE = 'skip_thought_signature_validator'

/** Recorded-audio transcription model: Google's dedicated speech-to-text model, which takes the audio
 *  inline in the same API. */
export const GOOGLE_STT_MODEL = 'gemini-3.5-transcribe'

const headers = (key: string): Record<string, string> => ({
  'x-goog-api-key': key,
  'Content-Type': 'application/json',
  'Api-Revision': API_REVISION
})

// --- errors ---------------------------------------------------------------------------------------

/** The error object out of any of the three body shapes the API answers with. */
function errorOf(body: string): { message: string; reason?: string } {
  const candidates = [
    body,
    ...body
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
  ]
  for (const c of candidates) {
    try {
      let parsed = JSON.parse(c)
      if (Array.isArray(parsed)) parsed = parsed[0]
      const err = parsed?.error
      if (err) {
        const reason = Array.isArray(err.details)
          ? err.details.find((d: { reason?: unknown }) => typeof d?.reason === 'string')?.reason
          : undefined
        return { message: String(err.message ?? ''), reason }
      }
    } catch {
      /* not this shape */
    }
  }
  return { message: '' }
}

/** A model or tool the key's tier does not include at all ("limit: 0 … on Free Tier"). Waiting does
 *  not change a zero, so this 429 is billing, not traffic. */
const notInTier = (body: string): boolean => /\blimit: 0\b/.test(body)

/** The key's DAILY quota for the model is used up ("requests per day limit exceeded", quota id
 *  `…PerDay…`, measured on a free-tier key). It resets at midnight Pacific time; retrying within the
 *  minute only repeats the refusal. */
const dailyQuota = (body: string): boolean => /per ?day/i.test(body)

function translateStatus(status: number, body: string): AiProviderError {
  const { message, reason } = errorOf(body)
  const detail = message.trim()
  if (status === 401 || reason === 'API_KEY_INVALID' || /api key not valid/i.test(detail))
    return new AiProviderError(
      'Google API key invalid or missing — check aistudio.google.com/apikey.',
      'auth'
    )
  if (status === 403)
    return new AiProviderError(`Google refused the request${detail ? ` — ${detail}` : ''}.`, 'auth')
  if (status === 429 && notInTier(body))
    return new AiProviderError(
      `${detail || 'Not available on this key.'} The key's Google tier does not include this model or ` +
        'tool — use a key from a Google Cloud project with billing, or pick Gemini 3.8 Flash.',
      'credits'
    )
  if (status === 429 && dailyQuota(body))
    return new AiProviderError(
      'Google’s daily request quota for this model is used up — it resets at midnight Pacific time. ' +
        'The key’s limits are listed at aistudio.google.com/rate-limit; another model has its own quota.',
      'rate_limit'
    )
  if (status === 429)
    return new AiProviderError(
      'Google rate limit or quota reached — wait a moment and try again. The key’s limits are listed at ' +
        'aistudio.google.com/rate-limit.',
      'rate_limit'
    )
  if (status === 400 && /context|too long|exceeds the maximum|token count/i.test(detail))
    return new AiProviderError("Request too long for this model's context window.", 'context')
  if (status === 404)
    return new AiProviderError(
      `${detail || 'Model not found on the Gemini API.'} — pick another model under Settings → AI.`,
      'http'
    )
  if (status === 503)
    return new AiProviderError(
      'Google reports high demand for this model right now — try again in a moment, or pick another model.',
      'http'
    )
  return new AiProviderError(`Google error (HTTP ${status})${detail ? ` — ${detail}` : ''}.`, 'http')
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])

// --- request --------------------------------------------------------------------------------------

/** Our effort vocabulary → Google's `thinking_level`. The catalogue offers only low/medium/high for
 *  the Google rows; the rest is mapped to the nearest level rather than sent and bounced, because the
 *  research legs ask every provider for 'low' and a future caller may ask for 'minimal'. */
export function thinkingLevel(e?: ReasoningEffort): 'low' | 'medium' | 'high' | undefined {
  if (!e) return undefined
  if (e === 'none' || e === 'minimal') return 'low'
  if (e === 'xhigh') return 'high'
  return e
}

function contentToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((p) =>
      (p as { type?: string }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : ''
    )
    .filter(Boolean)
    .join('\n')
}

function dataUrl(url: string): { mime: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  return m ? { mime: m[1], data: m[2] } : null
}

/** One chat-shape content part → an Interactions content block. Text, images (the screenshot tool)
 *  and files (attached PDFs) are what the app produces; an unknown part is dropped — so a new part type
 *  has to be added HERE as well as at its source, or it vanishes without an error. */
function partToContent(p: Record<string, unknown>): Record<string, unknown> | null {
  if (p.type === 'text') return { type: 'text', text: String(p.text ?? '') }
  if (p.type === 'image_url') {
    const url = (p.image_url as { url?: string } | undefined)?.url
    if (!url) return null
    const d = dataUrl(url)
    return d ? { type: 'image', data: d.data, mime_type: d.mime } : { type: 'image', uri: url }
  }
  if (p.type === 'file') {
    const file = p.file as { file_data?: string } | undefined
    const d = file?.file_data ? dataUrl(file.file_data) : null
    return d ? { type: 'document', data: d.data, mime_type: d.mime } : null
  }
  return null
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}')
    return isObj(v) && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

type ToolCall = NonNullable<ChatMessage['tool_calls']>[number]

const callStep = (c: ToolCall): Record<string, unknown> => ({
  type: 'function_call',
  id: c.id,
  name: c.function.name,
  arguments: parseArgs(c.function.arguments)
})

/** An assistant turn as Interactions steps: its own replay when Google produced it, otherwise rebuilt
 *  from the text and the calls — with the skip signature in front of the calls, so a transcript from
 *  another provider still validates. */
function assistantSteps(m: ChatMessage): unknown[] {
  const calls = m.tool_calls ?? []
  if (m.replay?.provider === 'google' && Array.isArray(m.replay.steps)) {
    // Verbatim — minus calls the loop no longer carries: a call without its result is a 400.
    const ids = new Set(calls.map((c) => c.id))
    const kept = m.replay.steps.filter(
      (s) => !(isObj(s) && s.type === 'function_call' && !ids.has(String(s.id)))
    )
    const replayed = new Set(
      kept
        .filter((s) => isObj(s) && s.type === 'function_call')
        .map((s) => String((s as { id?: unknown }).id))
    )
    return [...kept, ...calls.filter((c) => !replayed.has(c.id)).map(callStep)]
  }
  const steps: unknown[] = []
  if (calls.length) steps.push({ type: 'thought', signature: SKIP_SIGNATURE })
  const text = contentToText(m.content)
  if (text) steps.push({ type: 'model_output', content: [{ type: 'text', text }] })
  steps.push(...calls.map(callStep))
  return steps
}

/**
 * Our OpenAI-chat-shaped transcript → `system_instruction` + Interactions `input` steps. Tool results
 * become `function_result` steps keyed by the call's id, in the order the calls were made — the API
 * wants every call of a round before any of its results.
 */
export function toInteractionsInput(messages: ChatMessage[]): { system?: string; input: unknown[] } {
  let system: string | undefined
  const input: unknown[] = []
  const callNames = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'system') {
      const text = contentToText(m.content)
      if (text) system = system ? `${system}\n\n${text}` : text
      continue
    }
    if (m.role === 'assistant') {
      for (const tc of m.tool_calls ?? []) callNames.set(tc.id, tc.function.name)
      input.push(...assistantSteps(m))
      continue
    }
    if (m.role === 'tool') {
      const id = m.tool_call_id ?? ''
      input.push({
        type: 'function_result',
        call_id: id,
        name: m.name ?? callNames.get(id) ?? '',
        // An empty text block is refused; a tool that printed nothing still answered.
        result: [{ type: 'text', text: contentToText(m.content) || '(no output)' }]
      })
      continue
    }
    const content = Array.isArray(m.content)
      ? m.content.map(partToContent).filter((p): p is Record<string, unknown> => !!p)
      : m.content
        ? [{ type: 'text', text: m.content }]
        : []
    if (content.length) input.push({ type: 'user_input', content })
  }
  return { system, input }
}

/** The research legs' allow list, as words: Google Search on this API takes no domain filter. */
function withDomainHint(system: string | undefined, domains: string[] | undefined): string | undefined {
  if (!domains?.length) return system
  const hint =
    `Search only on these sites (use site: in your queries) and cite pages from them: ${domains.join(', ')}. ` +
    'If they do not hold the answer, say so instead of citing another site.'
  return system ? `${system}\n\n${hint}` : hint
}

// --- stream ---------------------------------------------------------------------------------------

interface GoogleState {
  model: string
  sentProvider: boolean
  /** Every step of this reply by index, as the API assembles it — the replay. */
  steps: Map<number, Record<string, unknown>>
  /** Function-call arguments and output text by step index, as they stream in. */
  args: Map<number, string>
  text: Map<number, string>
  calls: Map<number, AccumTool>
  /** Search queries the model ran — the unit Google bills search by. */
  queries: number
  annotations: Citation[]
  /** `interaction.completed` arrived. A stream that ends without it is a cut-off reply, not a short one. */
  completed: boolean
  /** The interaction ended as `failed`: raised from `finish`, AFTER its usage went to the ledger. */
  failure?: string
}

/** The url_citation annotations on one content part, wherever the API puts them. */
function citationsOf(annotations: unknown): Citation[] {
  if (!Array.isArray(annotations)) return []
  return annotations.flatMap((a) =>
    a?.type === 'url_citation' && typeof a.url === 'string' && a.url
      ? [{ url: a.url, ...(typeof a.title === 'string' && a.title ? { title: a.title } : {}) }]
      : []
  )
}

function usageEvent(state: GoogleState, usage: any): StreamEvent {
  const input: number | undefined = usage?.total_input_tokens
  const cached: number = usage?.total_cached_tokens ?? 0
  const toolUse: number = usage?.total_tool_use_tokens ?? 0
  const output: number = usage?.total_output_tokens ?? 0
  const thought: number = usage?.total_thought_tokens ?? 0
  const entry = getModels().find((m) => m.id === state.model && m.provider === 'google')
  const price = entry ? priceOn(entry) : undefined
  let cost: number | undefined
  if (price && typeof input === 'number') {
    cost =
      ((Math.max(0, input - cached) + toolUse) * price.input +
        cached * price.cachedInput +
        (output + thought) * price.output) /
        1e6 +
      state.queries * GOOGLE_SEARCH_USD_PER_QUERY
  }
  return {
    type: 'usage',
    usage: {
      ...(cost != null ? { cost, estimated: true } : {}),
      prompt_tokens: typeof input === 'number' ? input + toolUse : undefined,
      // Thinking is output as far as the bill goes, and the ledger's completion column is the bill's.
      completion_tokens: output + thought,
      prompt_tokens_details: { cached_tokens: cached },
      ...(state.queries ? { server_tool_use: { web_search_requests: state.queries } } : {})
    }
  }
}

/** How the interaction ended → our finish vocabulary. */
function finishReason(status: unknown): string {
  if (status === 'requires_action') return 'tool_calls'
  if (status === 'completed') return 'stop'
  if (status === 'incomplete') return 'length'
  return String(status || 'stop')
}

const REDIRECT_HOST = 'vertexaisearch.cloud.google.com'
/** A Google citation link written out in the answer text. */
const REDIRECT_IN_TEXT =
  /https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[A-Za-z0-9_\-=]+/g
const RESOLVE_TIMEOUT_MS = 5_000
const MAX_RESOLVED = 40

/** Google's citation link → the page it stands for, by reading the redirect without following it.
 *  Falls back to the link itself, which still works in a browser for a while. */
async function resolveCitationUrl(url: string): Promise<string> {
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    return url
  }
  if (host !== REDIRECT_HOST) return url
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS)
    })
    const location = res.headers.get('location')
    await res.body?.cancel().catch(() => {})
    return location && /^https?:\/\//.test(location) ? location : url
  } catch {
    return url
  }
}

/** Every citation link resolved to its page, one entry per page. The links stay on it as `via`: the
 *  model was shown the links, not the pages, and quotes them as its sources (measured on a research_bom
 *  run) — the research tools need them to match a quoted link to the page (citationBook.ts). Each
 *  annotation carries its own link token, so one page can have several. */
export async function resolveCitations(cites: Citation[]): Promise<Citation[]> {
  const unique = [...new Map(cites.map((c) => [c.url, c])).values()].slice(0, MAX_RESOLVED)
  const resolved = await Promise.all(
    unique.map(async (c) => ({ ...c, url: await resolveCitationUrl(c.url), link: c.url }))
  )
  const pages = new Map<string, Citation>()
  for (const { link, ...c } of resolved) {
    const page = pages.get(c.url) ?? { ...c }
    if (link !== c.url) page.via = [...(page.via ?? []), link]
    pages.set(c.url, page)
  }
  return [...pages.values()]
}

export const googleTransport: ChatTransport<GoogleState> = {
  name: 'google',
  unreachable: 'Google unreachable — check your internet connection.',
  translateStatus,
  retryable: (status, body) =>
    RETRYABLE.has(status) && !(status === 429 && (notInTier(body) || dailyQuota(body))),

  buildRequest(opts: StreamChatOpts, key: string) {
    const { system, input } = toInteractionsInput(opts.messages)
    const tools: unknown[] = (opts.tools ?? []).map((t) => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters
    }))
    // Google Search together with function tools is a preview on this API (and wants a different
    // tool-choice mode), so the chat runs without it under Google and searches through the research
    // tools; agent.ts turns it off there. This guard keeps any other caller from reaching it.
    const search = !!opts.webSearch && tools.length === 0
    if (opts.webSearch && !search)
      console.warn(
        '[google] web search with function tools is not used on this API — request sent without it'
      )
    if (search) tools.push({ type: 'google_search' })
    const instructions = withDomainHint(system, search ? opts.webDomains : undefined)
    const level = thinkingLevel(opts.reasoningEffort)
    const body = JSON.stringify({
      model: opts.model,
      input,
      stream: true,
      store: false,
      ...(instructions ? { system_instruction: instructions } : {}),
      generation_config: {
        max_output_tokens: Math.min(clampMaxTokens(opts.maxTokens), MAX_OUTPUT_TOKENS),
        // Summaries are what the "Thinking…" indicator counts; the text itself is never shown.
        thinking_summaries: 'auto',
        ...(level ? { thinking_level: level } : {})
      },
      ...(tools.length ? { tools } : {})
    })
    return { url: `${BASE_URL}/interactions`, headers: headers(key), body }
  },

  createState: (opts) => ({
    model: opts.model,
    sentProvider: false,
    steps: new Map(),
    args: new Map(),
    text: new Map(),
    calls: new Map(),
    queries: 0,
    annotations: [],
    completed: false
  }),

  interpret(raw: unknown, state: GoogleState): StreamEvent[] {
    const parsed = raw as any
    const events: StreamEvent[] = []
    const index: number = typeof parsed?.index === 'number' ? parsed.index : -1
    switch (parsed?.event_type) {
      case 'interaction.created':
        if (!state.sentProvider) {
          state.sentProvider = true
          events.push({ type: 'provider', name: 'Google' })
        }
        break
      case 'step.start': {
        if (!isObj(parsed.step)) break
        const step: Record<string, unknown> = { ...parsed.step }
        state.steps.set(index, step)
        // A step may open with content already in it — the first words of the answer, the first line of a
        // thought summary (Google's own stream examples show both). Dropped here, an answer would lose
        // its opening and a JSON reply its opening bracket.
        if (step.type === 'model_output' && Array.isArray(step.content)) {
          const text = step.content
            .map((c) => (isObj(c) && c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
            .join('')
          if (text) {
            state.text.set(index, text)
            events.push({ type: 'delta', text })
          }
          for (const c of step.content) if (isObj(c)) state.annotations.push(...citationsOf(c.annotations))
        } else if (step.type === 'thought' && Array.isArray(step.summary)) {
          const chars = step.summary
            .map((c) => (isObj(c) && typeof c.text === 'string' ? c.text.length : 0))
            .reduce((a, b) => a + b, 0)
          if (chars) events.push({ type: 'reasoning', chars })
        }
        break
      }
      case 'step.delta': {
        const d = parsed.delta
        if (!isObj(d)) break
        const step = state.steps.get(index) ?? {}
        state.steps.set(index, step)
        switch (d.type) {
          case 'text':
            if (typeof d.text === 'string' && d.text) {
              state.text.set(index, (state.text.get(index) ?? '') + d.text)
              events.push({ type: 'delta', text: d.text })
            }
            break
          case 'thought_summary': {
            const content = d.content as { text?: unknown } | undefined
            const chars = typeof content?.text === 'string' ? content.text.length : 0
            step.summary = [...((step.summary as unknown[]) ?? []), d.content]
            if (chars) events.push({ type: 'reasoning', chars })
            break
          }
          case 'thought_signature':
            step.signature = d.signature
            break
          case 'arguments_delta':
            if (typeof d.arguments === 'string')
              state.args.set(index, (state.args.get(index) ?? '') + d.arguments)
            break
          case 'text_annotation_delta':
            state.annotations.push(...citationsOf(d.annotations))
            break
          default: {
            // Server-side tool steps (google_search_call / _result) arrive as one delta named like the
            // step: merge it whole, signature included — it goes back verbatim.
            const { type: _type, ...rest } = d
            Object.assign(step, rest)
            const queries = (d.arguments as { queries?: unknown } | undefined)?.queries
            if (d.type === 'google_search_call' && Array.isArray(queries)) state.queries += queries.length
          }
        }
        break
      }
      case 'step.stop': {
        const step = state.steps.get(index)
        if (!step) break
        if (step.type === 'function_call') {
          const raw = state.args.get(index) ?? JSON.stringify(step.arguments ?? {})
          step.arguments = parseArgs(raw)
          state.calls.set(index, { id: String(step.id ?? ''), name: String(step.name ?? ''), arguments: raw })
        } else if (step.type === 'model_output') {
          const text = state.text.get(index)
          if (text) step.content = [{ type: 'text', text }]
        }
        break
      }
      case 'interaction.completed': {
        const interaction = parsed.interaction ?? {}
        state.completed = true
        if (interaction.status === 'failed') {
          // Billed all the same: the usage is booked first, the error raised from `finish`.
          state.failure = interaction.error?.message
            ? String(interaction.error.message)
            : 'Google reported the interaction as failed.'
          events.push(usageEvent(state, interaction.usage))
          break
        }
        events.push({ type: 'finish', reason: finishReason(interaction.status) })
        events.push(usageEvent(state, interaction.usage))
        break
      }
      case 'error': {
        const msg = parsed.error?.message
        throw new AiProviderError(
          typeof msg === 'string' && msg ? `Google: ${msg}` : 'Google stream error.',
          'http'
        )
      }
    }
    return events
  },

  // A cut-off reply never reaches `finish`: the engine raises it and releases none of its calls.
  completed: (state) => state.completed,

  async finish(state: GoogleState): Promise<StreamEvent[]> {
    if (state.failure) throw new AiProviderError(state.failure, 'http')
    const events: StreamEvent[] = []
    // The model also quotes search results Google did not annotate as citations (measured: a research_bom
    // leg wrote one as its source_url). Only Google's search mints such a link, so one that leads to a page
    // is that search's record too; one that leads nowhere is dropped rather than vouched for.
    const annotated = new Set(state.annotations.map((a) => a.url))
    const written = [...new Set([...state.text.values()].join('\n').match(REDIRECT_IN_TEXT) ?? [])].filter(
      (link) => !annotated.has(link)
    )
    if (state.annotations.length || written.length) {
      const unresolvedWritten = new Set(written)
      const citations = (
        await resolveCitations([...state.annotations, ...written.map((url) => ({ url }))])
      ).filter((c) => !unresolvedWritten.has(c.url))
      if (citations.length) events.push({ type: 'citations', citations })
    }
    const order = [...state.steps.keys()].sort((a, b) => a - b)
    const calls = order.map((i) => state.calls.get(i)).filter((c): c is AccumTool => !!c?.name)
    if (calls.length)
      events.push({
        type: 'tool_calls',
        calls,
        replay: { provider: 'google', steps: order.map((i) => state.steps.get(i)) }
      })
    return events
  }
}

// --- voice ----------------------------------------------------------------------------------------

/**
 * Transcribe a recording with Google's speech-to-text model, through the same Interactions API (one
 * non-streaming request, audio inline, nothing stored). Billed per token like a chat request — audio
 * in, text out — and priced the same way, against the catalogue row of GOOGLE_STT_MODEL.
 */
export async function transcribeGoogle(
  opts: TranscribeOpts,
  key: string
): Promise<{ text: string; cost?: number; model: string }> {
  const body = JSON.stringify({
    model: GOOGLE_STT_MODEL,
    store: false,
    input: [
      {
        type: 'user_input',
        content: [{ type: 'audio', data: opts.data, mime_type: `audio/${opts.format}` }]
      }
    ],
    ...(opts.language
      ? { generation_config: { transcription_config: { language_codes: [opts.language] } } }
      : {})
  })
  let res: Response
  try {
    res = await fetch(`${BASE_URL}/interactions`, {
      method: 'POST',
      headers: headers(key),
      body,
      signal: withDeadline(opts.signal)
    })
  } catch (e) {
    if ((e as Error)?.name === 'TimeoutError') throw new AiProviderError(TRANSCRIBE_TIMEOUT, 'stalled')
    if ((e as Error)?.name === 'AbortError') throw new AiProviderError('Canceled.', 'aborted')
    throw new AiProviderError('Google unreachable — check your internet connection.', 'network')
  }
  if (!res.ok) throw translateStatus(res.status, await res.text().catch(() => ''))
  const json = (await res.json()) as { steps?: unknown[]; usage?: unknown }
  const text = (json.steps ?? [])
    .filter((s): s is { type: string; content?: unknown[] } => isObj(s) && s.type === 'model_output')
    .flatMap((s) => (Array.isArray(s.content) ? s.content : []))
    .map((c) => (isObj(c) && c.type === 'text' ? String(c.text ?? '') : ''))
    .join('')
    .trim()
  const state = googleTransport.createState({ model: GOOGLE_STT_MODEL, messages: [], temperature: null })
  const usage = usageEvent(state, json.usage)
  const cost = usage.type === 'usage' ? usage.usage.cost : undefined
  return { text, cost, model: GOOGLE_STT_MODEL }
}
