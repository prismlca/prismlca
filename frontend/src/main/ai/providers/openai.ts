/**
 * The direct-OpenAI transport, speaking the **Responses API** (`POST /v1/responses`) — deliberately
 * not Chat Completions: OpenAI concentrates its capabilities there, and it is the only surface with
 * the native `web_search` tool, which is what keeps PrismLCA's web research working when OpenRouter's
 * server tools are out of reach. One API surface for everything OpenAI.
 *
 * The seams to know about, all consequences of leaving OpenRouter's conveniences behind:
 *  - **Stateless by choice**: every request sends the full transcript with `store: false` — OpenAI
 *    keeps no response object (the 30-day abuse retention window still applies; per-request ZDR does
 *    not exist here, which is why the Settings privacy switch is inert under this provider).
 *  - **Cost is synthesized, not reported**: the API returns token counts only, and there is no
 *    pricing endpoint. `finishUsage` prices the tokens against the catalogue's hand-maintained list
 *    prices (models.ts) plus the per-call web-search fee, and marks the figure `estimated`. The cost
 *    breaker, the ledger and the per-message cost all keep working off that one field.
 *  - **429 is two different things**: `insufficient_quota` arrives as HTTP 429 but is a hard
 *    out-of-credits condition — mapped to 'credits' and never retried; a plain 429 stays 'rate_limit'.
 *  - Reasoning summaries are NOT requested (they need per-org verification on some models and would
 *    400 for everyone else), so the 'reasoning' StreamEvent is rare here — the renderer treats it as
 *    optional. Revisit when a safe probe exists.
 *
 * Verified against developers.openai.com on 2026-08-30 (model ids, prices, parameter names). The
 * live smoke before release re-checks them — this file is where stale training knowledge would hide.
 */
import { clampMaxTokens } from '../../../shared/aiDefaults'
import { getModels, OPENAI_STT_USD_PER_MINUTE, OPENAI_WEB_SEARCH_USD_PER_CALL } from '../models'
import {
  AiProviderError,
  type AccumTool,
  type ChatMessage,
  type ChatTransport,
  type StreamChatOpts,
  type StreamEvent,
  type TranscribeOpts
} from './types'

const BASE_URL = 'https://api.openai.com/v1'

/** Responses API `max_output_tokens` ceiling of the GPT-5.6 family — a higher user setting is
 *  clamped here rather than bounced by the API. */
const MAX_OUTPUT_TOKENS = 128_000

// The per-call web-search fee lives with the other hand-maintained prices in models.ts.
// Counted per `web_search_call` output item and added to the synthesized cost.

function isQuota(body: string): boolean {
  return /insufficient_quota|exceeded your current quota/i.test(body)
}

function translateStatus(status: number, body: string): AiProviderError {
  let detail = ''
  try {
    const err = JSON.parse(body)?.error
    detail = err?.message ?? ''
  } catch {
    /* non-JSON error body */
  }
  if (status === 401)
    return new AiProviderError(
      'OpenAI API key invalid or missing — check platform.openai.com/api-keys.',
      'auth'
    )
  if (status === 429 && isQuota(body))
    return new AiProviderError(
      'OpenAI quota exhausted — add credits under platform.openai.com → Settings → Billing.',
      'credits'
    )
  if (status === 429)
    return new AiProviderError('OpenAI rate limit reached — wait a moment and try again.', 'rate_limit')
  if (status === 400 && /context|token|length/i.test(detail))
    return new AiProviderError("Request too long for this model's context window.", 'context')
  if (status === 404)
    return new AiProviderError(
      `${detail || 'Model not found on the OpenAI API.'} — pick another model under Settings → AI.`,
      'http'
    )
  return new AiProviderError(`OpenAI error (HTTP ${status})${detail ? ` — ${detail}` : ''}.`, 'http')
}

/** Rate limits and server trouble are worth a retry — EXCEPT the quota-429, which is "out of
 *  credits" wearing a rate-limit status: three backoffs against that wall is a ten-second hang
 *  ending in the same error. */
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504])

/** Flatten message content to plain text (drops non-text parts; used for roles that carry prose). */
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

/** One chat-shape content part → Responses input part. Text, images (the screenshot tool) and files
 *  (attached PDFs) are the parts the app produces; `cache_control` markers never appear here because
 *  no OpenAI entry sets `explicitCache`. Anything unknown returns null and is dropped — which is why
 *  a new part type has to be added HERE as well as at its source, or it vanishes without an error. */
function partToResponses(p: Record<string, unknown>): Record<string, unknown> | null {
  if (p.type === 'text') return { type: 'input_text', text: String(p.text ?? '') }
  if (p.type === 'image_url') {
    const url = (p.image_url as { url?: string } | undefined)?.url
    return url ? { type: 'input_image', image_url: url } : null
  }
  if (p.type === 'file') {
    // The Responses API takes an attached document as a base64 data URL plus its name; the chat
    // shape we carry internally nests both under `file` (see ai/attachments.ts).
    const file = p.file as { filename?: string; file_data?: string } | undefined
    return file?.file_data
      ? { type: 'input_file', filename: file.filename ?? 'attachment.pdf', file_data: file.file_data }
      : null
  }
  return null
}

/**
 * Our OpenAI-chat-shaped transcript → Responses `instructions` + `input` items.
 *
 * The mapping is mechanical but load-bearing: assistant tool calls become `function_call` items and
 * tool results `function_call_output` items keyed by the SAME call_id, or the model loses the thread
 * of its own work on the very next round.
 */
export function toResponsesInput(messages: ChatMessage[]): {
  instructions?: string
  input: unknown[]
} {
  let instructions: string | undefined
  const input: unknown[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      const text = contentToText(m.content)
      if (text) instructions = instructions ? `${instructions}\n\n${text}` : text
      continue
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id ?? '',
        output: contentToText(m.content)
      })
      continue
    }
    if (m.role === 'assistant') {
      const text = contentToText(m.content)
      if (text) input.push({ role: 'assistant', content: text })
      for (const tc of m.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments
        })
      }
      continue
    }
    // user — parts arrays carry vision input (the canvas screenshot), everything else is a string.
    if (Array.isArray(m.content)) {
      const parts = m.content.map(partToResponses).filter((p): p is Record<string, unknown> => !!p)
      input.push({ role: 'user', content: parts })
    } else {
      input.push({ role: 'user', content: m.content ?? '' })
    }
  }
  return { instructions, input }
}

interface OaiState {
  model: string
  sentProvider: boolean
  finishReason?: string
  /** Function calls in progress, keyed by output_index (arguments stream as deltas). */
  calls: Record<number, AccumTool>
  /** Paid web_search invocations, counted into the synthesized cost. */
  webSearches: number
}

/** Price the reported tokens against the catalogue's list prices (see models.ts `pricing`). */
function finishUsage(state: OaiState, response: any): StreamEvent {
  const u = response?.usage ?? {}
  const prompt: number | undefined = u.input_tokens
  const cached: number = u.input_tokens_details?.cached_tokens ?? 0
  const completion: number | undefined = u.output_tokens
  const pricing = getModels().find((m) => m.id === state.model && m.provider === 'openai')?.pricing
  let cost: number | undefined
  if (pricing && typeof prompt === 'number' && typeof completion === 'number') {
    cost =
      (Math.max(0, prompt - cached) * pricing.input +
        cached * pricing.cachedInput +
        completion * pricing.output) /
        1e6 +
      state.webSearches * OPENAI_WEB_SEARCH_USD_PER_CALL
  }
  return {
    type: 'usage',
    usage: {
      ...(cost != null ? { cost, estimated: true } : {}),
      prompt_tokens: prompt,
      completion_tokens: completion,
      prompt_tokens_details: { cached_tokens: cached }
    }
  }
}

export const openaiTransport: ChatTransport<OaiState> = {
  name: 'openai',
  unreachable: 'OpenAI unreachable — check your internet connection.',
  translateStatus,
  retryable: (status, body) => RETRYABLE.has(status) && !(status === 429 && isQuota(body)),

  buildRequest(opts: StreamChatOpts, key: string) {
    const { instructions, input } = toResponsesInput(opts.messages)
    // Responses tool specs are FLAT (name/description/parameters at the top level), unlike the
    // chat-completions nesting our ToolSpec mirrors. web_search is a server-side tool like
    // OpenRouter's — the model decides, the provider executes, the answer arrives in the same turn.
    const tools: unknown[] = (opts.tools ?? []).map((t) => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters
    }))
    if (opts.webSearch)
      tools.push({
        type: 'web_search',
        // The Responses tool filters by allow list only (up to 100 hosts); no block list exists.
        ...(opts.webDomains?.length ? { filters: { allowed_domains: opts.webDomains } } : {})
      })

    const body = JSON.stringify({
      model: opts.model,
      ...(instructions ? { instructions } : {}),
      input,
      stream: true,
      store: false,
      max_output_tokens: Math.min(clampMaxTokens(opts.maxTokens), MAX_OUTPUT_TOKENS),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      ...(opts.reasoningEffort ? { reasoning: { effort: opts.reasoningEffort } } : {}),
      ...(tools.length ? { tools } : {})
    })
    return {
      url: `${BASE_URL}/responses`,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body
    }
  },

  createState: (opts) => ({
    model: opts.model,
    sentProvider: false,
    calls: {},
    webSearches: 0
  }),

  interpret(raw: unknown, state: OaiState): StreamEvent[] {
    const parsed = raw as any
    const events: StreamEvent[] = []
    switch (parsed?.type) {
      case 'response.created':
        // No routing here — but the chat trace and the stored message still say who answered.
        if (!state.sentProvider) {
          state.sentProvider = true
          events.push({ type: 'provider', name: 'OpenAI' })
        }
        break
      case 'response.output_text.delta':
        if (typeof parsed.delta === 'string' && parsed.delta)
          events.push({ type: 'delta', text: parsed.delta })
        break
      // A page the server-side web_search cited, one event per citation. URL and title only — the
      // Responses API carries no excerpt, unlike OpenRouter's Exa engine.
      case 'response.output_text.annotation.added': {
        const a = parsed.annotation
        if (a?.type === 'url_citation' && typeof a.url === 'string' && a.url)
          events.push({
            type: 'citations',
            citations: [{ url: a.url, ...(typeof a.title === 'string' && a.title ? { title: a.title } : {}) }]
          })
        break
      }
      // Only present when reasoning summaries are requested (they are not, see the header) — handled
      // anyway so a future opt-in starts ticking without touching the interpreter.
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (typeof parsed.delta === 'string' && parsed.delta.length)
          events.push({ type: 'reasoning', chars: parsed.delta.length })
        break
      case 'response.output_item.added': {
        const item = parsed.item
        if (item?.type === 'function_call') {
          state.calls[parsed.output_index ?? Object.keys(state.calls).length] = {
            id: String(item.call_id ?? ''),
            name: String(item.name ?? ''),
            arguments: String(item.arguments ?? '')
          }
        } else if (item?.type === 'web_search_call') {
          state.webSearches += 1
        }
        break
      }
      case 'response.function_call_arguments.delta': {
        const slot = state.calls[parsed.output_index]
        if (slot && typeof parsed.delta === 'string') slot.arguments += parsed.delta
        break
      }
      case 'response.output_item.done': {
        // The done item is authoritative — overwrite whatever the deltas assembled.
        const item = parsed.item
        if (item?.type === 'function_call' && typeof parsed.output_index === 'number') {
          state.calls[parsed.output_index] = {
            id: String(item.call_id ?? ''),
            name: String(item.name ?? ''),
            arguments: String(item.arguments ?? '')
          }
        }
        break
      }
      case 'response.completed': {
        state.finishReason = Object.values(state.calls).some((c) => c.name) ? 'tool_calls' : 'stop'
        events.push({ type: 'finish', reason: state.finishReason })
        events.push(finishUsage(state, parsed.response))
        break
      }
      case 'response.incomplete': {
        const why = parsed.response?.incomplete_details?.reason
        state.finishReason = why === 'max_output_tokens' ? 'length' : String(why || 'incomplete')
        events.push({ type: 'finish', reason: state.finishReason })
        events.push(finishUsage(state, parsed.response))
        break
      }
      case 'response.failed': {
        const msg = parsed.response?.error?.message
        throw new AiProviderError(msg ? String(msg) : 'OpenAI reported the response as failed.', 'http')
      }
      case 'error': {
        throw new AiProviderError(
          typeof parsed.message === 'string' && parsed.message ? parsed.message : 'OpenAI stream error.',
          'http'
        )
      }
    }
    return events
  },

  finish(state: OaiState): StreamEvent[] {
    const assembled = Object.keys(state.calls)
      .map(Number)
      .sort((a, b) => a - b)
      .map((i) => state.calls[i])
      .filter((c) => c.name)
    return assembled.length ? [{ type: 'tool_calls', calls: assembled }] : []
  }
}

/** Recorded-audio transcription model (developers.openai.com/api/docs/models, 2026-08-30: the
 *  recommended file-transcription model; whisper-1 and the gpt-4o pair are legacy for new builds). */
export const OPENAI_STT_MODEL = 'gpt-transcribe'

/**
 * Transcribe an audio recording via OpenAI's /audio/transcriptions — a genuinely different wire
 * format from OpenRouter's: multipart with a named file (the extension is how the format is
 * detected), not JSON+base64. Cost: the model bills per MINUTE of audio; the response's usage
 * reports the duration in seconds when it reports anything, and without it the call is booked
 * without a cost figure rather than with an invented one.
 */
export async function transcribeOpenAi(
  opts: TranscribeOpts,
  key: string
): Promise<{ text: string; cost?: number; model: string }> {
  const fd = new FormData()
  fd.append('file', new Blob([Buffer.from(opts.data, 'base64')]), `audio.${opts.format}`)
  fd.append('model', OPENAI_STT_MODEL)
  if (opts.language) fd.append('language', opts.language)
  let res: Response
  try {
    // No Content-Type header: fetch writes the multipart boundary itself.
    res = await fetch(`${BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
      signal: opts.signal
    })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw new AiProviderError('Canceled.', 'aborted')
    throw new AiProviderError('OpenAI unreachable — check your internet connection.', 'network')
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw translateStatus(res.status, text)
  }
  const json = (await res.json()) as {
    text?: string
    usage?: { type?: string; seconds?: number }
  }
  const seconds = json.usage?.type === 'duration' ? json.usage.seconds : undefined
  const cost = typeof seconds === 'number' ? (seconds / 60) * OPENAI_STT_USD_PER_MINUTE : undefined
  return { text: (json.text ?? '').trim(), cost, model: OPENAI_STT_MODEL }
}
