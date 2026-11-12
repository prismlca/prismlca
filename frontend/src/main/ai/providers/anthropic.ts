/**
 * The direct-Anthropic transport, speaking the **Messages API** (`POST /v1/messages`, API version
 * 2026-10-21) over plain HTTP + SSE — like the other transports, so retry, stall watchdog and the
 * one-usage-per-request guarantee stay shared in engine.ts.
 *
 * The seams to know about, each checked against the live API on 2026-11-08:
 *  - **Thinking is always on and bound to its conversation.** Adaptive thinking is the only mode the
 *    current models accept, and every thinking block carries a signature over the prefix that produced
 *    it (system prompt, tools, every earlier message). A tool round has to go back verbatim — so every
 *    tool round hands its content blocks on as `replay` (types.ts) and they are resent unchanged inside
 *    the turn (measured: accepted, nothing dropped). Earlier turns go back as plain text and calls: their
 *    blocks were made under an older system prompt or tool list and would no longer validate, and
 *    dropping a LEADING run of thinking is allowed where a gap in the middle is not.
 *  - **An edited history degrades instead of failing.** Accounts created after 2026-08-31 get a 400 when
 *    a replayed block's prefix changed — and compaction does exactly that. Every request therefore asks
 *    for `drop_block` (beta `thinking-binding-controls-2026-08-01`): the API drops the invalidated
 *    reasoning and answers; the response lists what it dropped, which is logged.
 *  - **Caching is explicit.** Nothing is cached unless a breakpoint says so: the agent marks the system
 *    prompt and the task (`explicitCache`), and a tool loop adds Anthropic's automatic breakpoint, which
 *    moves to the last block every round — so last round's tool results are read from the cache, at a
 *    tenth of the input price or less, instead of written again. Writes cost 1.25× input.
 *  - **Cost is synthesized** from the reported tokens against the catalogue's list prices
 *    (directModels.ts): uncached input, cache writes, cache reads and output (thinking included) are
 *    priced apart, Haiku's longer-prompt tier is applied per request, and each web search adds $0.01.
 *  - **Web search is the basic server tool** (`web_search_20250305`): available on every model and
 *    eligible for zero retention, where the dynamic-filtering version runs code on Anthropic's side and is
 *    not. Its results come back as content blocks that must travel with the round; every returned page is
 *    handed on as a citation, with the passage the model cited where it cited one.
 *  - **`pause_turn`**: a long server-tool turn may pause; the transport hands the paused content back as
 *    a replay with no calls, and the dispatcher (client.ts) sends it back to continue.
 *  - **No sampling parameters** (rejected on this API version), **no forced tool choice** (rejected on
 *    the current models) — neither is ever sent.
 */
import { clampMaxTokens, type ReasoningEffort } from '../../../shared/aiDefaults'
import { ANTHROPIC_CACHE_WRITE_FACTOR, ANTHROPIC_WEB_SEARCH_USD_PER_SEARCH, priceFor } from '../directModels'
import { getModels } from '../models'
import { contextOverflow } from './contextOverflow'
import {
  AiProviderError,
  lastUserIndex,
  type AccumTool,
  type ChatMessage,
  type ChatTransport,
  type Citation,
  type StreamChatOpts,
  type StreamEvent
} from './types'

const BASE_URL = 'https://api.anthropic.com/v1'

/** The API version this transport was written and measured against. Pinned: a version moves request
 *  and response shapes (2026-10-21 removed the sampling parameters). */
export const API_VERSION = '2026-10-21'

/** Lets a request say what happens to a thinking block whose conversation changed (`drop_block`). */
export const BETA_THINKING_BINDING = 'thinking-binding-controls-2026-08-01'

/** Output ceiling of every current Claude model (Models API, 2026-11-08); thinking counts against it. */
const MAX_OUTPUT_TOKENS = 128_000

/** Anthropic allows four cache breakpoints per request; a fifth is a 400. */
const MAX_BREAKPOINTS = 4

const headers = (key: string): Record<string, string> => ({
  'x-api-key': key,
  'anthropic-version': API_VERSION,
  'anthropic-beta': BETA_THINKING_BINDING,
  'content-type': 'application/json'
})

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

// --- errors ---------------------------------------------------------------------------------------

function errorOf(body: string): { type: string; message: string } {
  const candidates = [
    body,
    ...body
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
  ]
  for (const c of candidates) {
    try {
      const err = JSON.parse(c)?.error
      if (isObj(err)) return { type: String(err.type ?? ''), message: String(err.message ?? '') }
    } catch {
      /* not this shape */
    }
  }
  return { type: '', message: '' }
}

/** An empty prepaid balance arrives as a 400, not as a 402 — billing, never worth a retry. */
const noCredit = (body: string): boolean => /credit balance/i.test(body)

function errorFor(status: number, type: string, message: string): AiProviderError {
  const detail = message.trim()
  if (status === 401 || type === 'authentication_error')
    return new AiProviderError(
      'Anthropic API key invalid or missing — check platform.claude.com under API keys.',
      'auth'
    )
  if (status === 403 || type === 'permission_error')
    return new AiProviderError(`Anthropic refused the request${detail ? ` — ${detail}` : ''}.`, 'auth')
  if (/credit balance/i.test(detail) || type === 'billing_error')
    return new AiProviderError(
      'Your Anthropic credit balance is too low — add credits at platform.claude.com under Billing.',
      'credits'
    )
  if (status === 429 || type === 'rate_limit_error')
    return new AiProviderError(
      'Anthropic rate limit reached — wait a moment and try again. The key’s limits are listed at ' +
        'platform.claude.com under Limits.',
      'rate_limit'
    )
  if (status === 413 || type === 'request_too_large')
    return new AiProviderError(
      'Request too large for the Anthropic API — fewer or smaller attachments.',
      'context'
    )
  if (status === 400 && contextOverflow(detail))
    return new AiProviderError("Request too long for this model's context window.", 'context')
  if (status === 404 || type === 'not_found_error')
    return new AiProviderError(
      `${detail || 'Model not found on the Anthropic API.'} — pick another model under Settings → AI.`,
      'http'
    )
  if (status === 529 || type === 'overloaded_error')
    return new AiProviderError(
      'Anthropic is overloaded right now — try again in a moment, or pick another model.',
      'http'
    )
  return new AiProviderError(
    `Anthropic error${status ? ` (HTTP ${status})` : ''}${detail ? ` — ${detail}` : ''}.`,
    'http'
  )
}

function translateStatus(status: number, body: string): AiProviderError {
  const { type, message } = errorOf(body)
  return errorFor(status, type, message)
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529])

/** The HTTP status each error type stands for (Anthropic's error docs), for an error that arrives as a
 *  stream event after a 200 — classified and retried like the refused request it would otherwise be. */
const STATUS_OF: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529
}

/** An `error` event inside the stream, as the shared error with its retry verdict. Anthropic documents
 *  the overload as such an event: the request was accepted and then not served. */
function streamError(type: string, message: string): AiProviderError {
  const status = STATUS_OF[type] ?? 0
  const e = errorFor(status, type, message)
  e.retryable = RETRYABLE.has(status) && !/credit balance/i.test(message)
  return e
}

// --- request --------------------------------------------------------------------------------------

/** Our effort vocabulary → Anthropic's (`output_config.effort`). Below `low` there is nothing: the
 *  thinking of the current models cannot be switched off, and the research legs' 'low' maps as is.
 *  `max` is Anthropic's own top level and passes through. */
export function effortFor(e?: ReasoningEffort): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  if (!e) return undefined
  if (e === 'none' || e === 'minimal') return 'low'
  return e
}

function dataUrl(url: string): { mime: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  return m ? { mime: m[1], data: m[2] } : null
}

/** A tool-call id as Anthropic accepts it (letters, digits, `_`, `-`). Ids from another provider's
 *  rounds are made to fit — the same function on the call and on its result, so the pair still meets. */
const toolId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_') || 'call'

/** One chat-shape content part → a Messages content block. Text, images (the screenshot tool) and files
 *  (attached PDFs) are what the app produces; a `cache_control` marker the agent placed travels along. An
 *  unknown part is dropped — so a new part type has to be added HERE as well as at its source. */
function partToBlock(p: Record<string, unknown>): Record<string, unknown> | null {
  let block: Record<string, unknown> | null = null
  if (p.type === 'text') {
    const text = String(p.text ?? '')
    block = blankText(text) ? null : { type: 'text', text }
  } else if (p.type === 'image_url') {
    const url = (p.image_url as { url?: string } | undefined)?.url
    const d = url ? dataUrl(url) : null
    block = d
      ? { type: 'image', source: { type: 'base64', media_type: d.mime, data: d.data } }
      : url
        ? { type: 'image', source: { type: 'url', url } }
        : null
  } else if (p.type === 'file') {
    const file = p.file as { file_data?: string } | undefined
    const d = file?.file_data ? dataUrl(file.file_data) : null
    block = d ? { type: 'document', source: { type: 'base64', media_type: d.mime, data: d.data } } : null
  }
  if (block && isObj(p.cache_control)) block.cache_control = p.cache_control
  return block
}

/** Text the API refuses as a block of its own: empty, or nothing but whitespace (measured: an assistant
 *  turn holding "\n\n" is a 400 "text content blocks must contain non-whitespace text"). A tool round's
 *  text can be exactly that, and a stored transcript would then fail every later request of the chat. */
const blankText = (text: string): boolean => !text.trim()

function blocksOf(content: ChatMessage['content']): Record<string, unknown>[] {
  if (typeof content === 'string') return blankText(content) ? [] : [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content.map(partToBlock).filter((b): b is Record<string, unknown> => !!b)
}

/** The agent's breakpoint on an assistant message (agent.ts, markCacheBreakpoints). */
const markedForCache = (content: ChatMessage['content']): boolean =>
  Array.isArray(content) && content.some((p) => isObj(p) && isObj(p.cache_control))

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}')
    return isObj(v) ? v : {}
  } catch {
    return {}
  }
}

/** Blocks that may carry a cache breakpoint — a thinking block may not. */
const CACHEABLE = new Set(['text', 'image', 'document', 'tool_use', 'tool_result', 'server_tool_use'])

function markLast(blocks: Record<string, unknown>[]): void {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (!CACHEABLE.has(String(blocks[i].type))) continue
    blocks[i] = { ...blocks[i], cache_control: { type: 'ephemeral' } }
    return
  }
}

/** An assistant turn as content blocks. Inside the current turn, a round Anthropic produced goes back
 *  verbatim (its replay), minus calls the loop no longer carries; anything else is rebuilt from the text
 *  and the calls — without reasoning, which belongs to the conversation that made it. */
function assistantBlocks(m: ChatMessage, inCurrentTurn: boolean): Record<string, unknown>[] {
  const calls = m.tool_calls ?? []
  let blocks: Record<string, unknown>[]
  if (inCurrentTurn && m.replay?.provider === 'anthropic' && Array.isArray(m.replay.steps)) {
    const ids = new Set(calls.map((c) => c.id))
    blocks = m.replay.steps
      .filter(isObj)
      .filter((b) => !(b.type === 'tool_use' && !ids.has(String(b.id))))
      // Dropped the same way in every request, so the reasoning that follows was made on what is sent.
      .filter((b) => !(b.type === 'text' && typeof b.text === 'string' && blankText(b.text)))
      .map((b) => {
        const { cache_control: _old, ...rest } = b
        return rest
      })
    const replayed = new Set(blocks.filter((b) => b.type === 'tool_use').map((b) => String(b.id)))
    for (const c of calls)
      if (!replayed.has(c.id))
        blocks.push({
          type: 'tool_use',
          id: toolId(c.id),
          name: c.function.name,
          input: parseArgs(c.function.arguments)
        })
  } else {
    blocks = blocksOf(m.content).filter((b) => b.type === 'text')
    for (const b of blocks) delete b.cache_control
    for (const c of calls)
      blocks.push({
        type: 'tool_use',
        id: toolId(c.id),
        name: c.function.name,
        input: parseArgs(c.function.arguments)
      })
  }
  if (markedForCache(m.content)) markLast(blocks)
  return blocks
}

/**
 * Our OpenAI-chat-shaped transcript → `system` blocks + Messages `messages`. Tool results become
 * `tool_result` blocks in the user turn after the call, ahead of anything else in it (a screenshot the
 * tool produced, a message typed during the run); turns of one role that follow each other are merged,
 * because the API wants user and assistant to alternate.
 */
export function toMessages(messages: ChatMessage[]): {
  system: Record<string, unknown>[]
  messages: Array<{ role: 'user' | 'assistant'; content: Record<string, unknown>[] }>
} {
  const system: Record<string, unknown>[] = []
  const out: Array<{ role: 'user' | 'assistant'; content: Record<string, unknown>[] }> = []
  const turnStart = lastUserIndex(messages)
  const push = (role: 'user' | 'assistant', blocks: Record<string, unknown>[]): void => {
    if (!blocks.length) return
    const last = out.at(-1)
    if (last?.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  messages.forEach((m, i) => {
    if (m.role === 'system') {
      system.push(...blocksOf(m.content).filter((b) => b.type === 'text'))
      return
    }
    if (m.role === 'assistant') {
      push('assistant', assistantBlocks(m, i > turnStart))
      return
    }
    if (m.role === 'tool') {
      const content = blocksOf(m.content).filter((b) => b.type === 'text' || b.type === 'image')
      const result: Record<string, unknown> = {
        type: 'tool_result',
        tool_use_id: toolId(m.tool_call_id ?? ''),
        // A tool that printed nothing still answered; an empty result is refused.
        content: content.length ? content.map(({ cache_control: _c, ...b }) => b) : '(no output)'
      }
      if (markedForCache(m.content)) result.cache_control = { type: 'ephemeral' }
      push('user', [result])
      return
    }
    push('user', blocksOf(m.content))
  })
  foldIntoOpenTurn(out)
  return { system, messages: out }
}

/** A server-tool call (Claude's web search) in this assistant turn that has no result yet: Claude called
 *  it beside one of our tools, and the API runs it once our results are in. */
function pendingServerCall(blocks: Record<string, unknown>[]): boolean {
  const answered = new Set(
    blocks
      .filter((b) => typeof b.tool_use_id === 'string' && String(b.type).endsWith('_tool_result'))
      .map((b) => String(b.tool_use_id))
  )
  return blocks.some((b) => b.type === 'server_tool_use' && !answered.has(String(b.id)))
}

/** Content a tool result may carry inside it. */
const IN_RESULT = new Set(['text', 'image', 'document'])

/**
 * While a server-tool call of the assistant turn before it is still open, the user turn after it may hold
 * nothing but tool results: anything after them ends the turn, and the API then refuses the open search
 * (HTTP 400, documented under stop reasons). What the agent appends there — a screenshot, a message typed
 * during the run, a compaction note — goes inside the last result instead, where the model still reads it.
 */
function foldIntoOpenTurn(
  out: Array<{ role: 'user' | 'assistant'; content: Record<string, unknown>[] }>
): void {
  for (let i = 0; i + 1 < out.length; i++) {
    if (out[i].role !== 'assistant' || out[i + 1].role !== 'user' || !pendingServerCall(out[i].content))
      continue
    const results = out[i + 1].content.filter((b) => b.type === 'tool_result')
    const extra = out[i + 1].content.filter((b) => b.type !== 'tool_result' && IN_RESULT.has(String(b.type)))
    if (!results.length || !extra.length) continue
    const last = results[results.length - 1]
    const inner = Array.isArray(last.content)
      ? last.content
      : [{ type: 'text', text: String(last.content ?? '') }]
    results[results.length - 1] = {
      ...last,
      content: [...inner, ...extra.map(({ cache_control: _c, ...b }) => b)]
    }
    out[i + 1].content = results
  }
}

/** Breakpoints the request already carries — the automatic one may only take a free slot. */
function countBreakpoints(...lists: Array<Array<Record<string, unknown>>>): number {
  let n = 0
  for (const list of lists)
    for (const b of list) {
      if (isObj(b.cache_control)) n++
      if (Array.isArray(b.content))
        for (const inner of b.content) if (isObj(inner) && isObj(inner.cache_control)) n++
    }
  return n
}

// --- stream ---------------------------------------------------------------------------------------

interface AnthropicState {
  model: string
  sentProvider: boolean
  /** Every content block of this reply by index, as the API assembles it — the replay. */
  blocks: Map<number, Record<string, unknown>>
  /** Tool-call input JSON by block index, as it streams in. */
  json: Map<number, string>
  usage: Record<string, unknown>
  /** The first pass's prompt, from `message_start` — see usageEvent. */
  firstPrompt?: number
  sentUsage: boolean
  stopReason?: string
  /** `message_stop` arrived. A stream that ends without it is a cut-off reply, not a short one. */
  stopped: boolean
  /** An `error` event mid-stream: raised from `finish`, AFTER its usage went to the ledger. */
  failure?: AiProviderError
}

/** A refusal's reason as Anthropic states it (`stop_details`: a category such as "bio" or "cyber", and
 *  an explanation where it gives one) — for the note the chat shows (stopNotes.ts). */
function refusalDetail(details: unknown): string | undefined {
  if (!isObj(details)) return undefined
  const category = typeof details.category === 'string' && details.category ? details.category : ''
  const explanation = typeof details.explanation === 'string' ? details.explanation.trim() : ''
  return [category && `category: ${category}`, explanation].filter(Boolean).join(' — ') || undefined
}

/** How the reply ended → our finish vocabulary. */
function finishReason(stop: string | undefined): string {
  if (stop === 'tool_use') return 'tool_calls'
  if (stop === 'max_tokens' || stop === 'model_context_window_exceeded') return 'length'
  if (stop === 'refusal') return 'content_filter'
  if (stop === 'pause_turn') return 'pause_turn'
  return 'stop'
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Price the reported tokens against the catalogue's list prices. The prompt is everything the model
 *  was sent — uncached input, cache writes and cache reads — and also decides Haiku's price tier.
 *
 *  `firstPrompt` is the prompt of the reply's first pass (`message_start`). With web search the reply
 *  runs several passes and the final report SUMS them, while the tier belongs to one request's prompt —
 *  measured: 2,867 tokens in the first pass, 21,944 reported for two searches. Deciding the tier on the
 *  sum would book a long search reply at five times its price, so a reply that searched is placed by
 *  its first pass, the one the conversation sets; later passes add only the results. An estimate, like
 *  every figure here, not checked against an invoice. */
export function usageEvent(model: string, usage: Record<string, unknown>, firstPrompt?: number): StreamEvent {
  const input = num(usage.input_tokens)
  const written = num(usage.cache_creation_input_tokens)
  const read = num(usage.cache_read_input_tokens)
  const output = num(usage.output_tokens)
  const prompt = input + written + read
  const searches = num((usage.server_tool_use as Record<string, unknown> | undefined)?.web_search_requests)
  // The cache write is priced by its lifetime; only five-minute entries are requested, a one-hour
  // entry (2×) would come from an account setting and is priced as what it is.
  const byTtl = isObj(usage.cache_creation) ? usage.cache_creation : null
  const hour = byTtl ? num(byTtl.ephemeral_1h_input_tokens) : 0
  const entry = getModels().find((m) => m.id === model && m.provider === 'anthropic')
  const tierPrompt = searches && firstPrompt ? firstPrompt : prompt
  const price = entry ? priceFor(entry, tierPrompt) : undefined
  const reported = typeof usage.input_tokens === 'number'
  const cost =
    price && reported
      ? (input * price.input +
          (written - hour) * price.input * ANTHROPIC_CACHE_WRITE_FACTOR +
          hour * price.input * 2 +
          read * price.cachedInput +
          output * price.output) /
          1e6 +
        searches * ANTHROPIC_WEB_SEARCH_USD_PER_SEARCH
      : undefined
  return {
    type: 'usage',
    usage: {
      ...(cost != null ? { cost, estimated: true } : {}),
      prompt_tokens: reported ? prompt : undefined,
      // Thinking is output as far as the bill goes, and Anthropic counts it there already.
      completion_tokens: output,
      prompt_tokens_details: { cached_tokens: read },
      ...(searches ? { server_tool_use: { web_search_requests: searches } } : {})
    }
  }
}

function sendUsage(state: AnthropicState): StreamEvent[] {
  if (state.sentUsage) return []
  state.sentUsage = true
  return [usageEvent(state.model, state.usage, state.firstPrompt)]
}

/** Every page the search returned, cited ones first with the passage the model cited. */
function citationsOf(blocks: Record<string, unknown>[]): Citation[] {
  const pages = new Map<string, Citation>()
  for (const b of blocks)
    if (b.type === 'text' && Array.isArray(b.citations))
      for (const c of b.citations)
        if (isObj(c) && c.type === 'web_search_result_location' && typeof c.url === 'string' && c.url) {
          const page = pages.get(c.url) ?? { url: c.url }
          if (typeof c.title === 'string' && c.title) page.title = c.title
          if (!page.excerpt && typeof c.cited_text === 'string' && c.cited_text) page.excerpt = c.cited_text
          pages.set(c.url, page)
        }
  for (const b of blocks)
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content))
      for (const r of b.content)
        if (
          isObj(r) &&
          r.type === 'web_search_result' &&
          typeof r.url === 'string' &&
          r.url &&
          !pages.has(r.url)
        )
          pages.set(r.url, {
            url: r.url,
            ...(typeof r.title === 'string' && r.title ? { title: r.title } : {})
          })
  return [...pages.values()]
}

export const anthropicTransport: ChatTransport<AnthropicState> = {
  name: 'anthropic',
  unreachable: 'Anthropic unreachable — check your internet connection.',
  translateStatus,
  retryable: (status, body) => RETRYABLE.has(status) && !noCredit(body),

  buildRequest(opts: StreamChatOpts, key: string) {
    const { system, messages } = toMessages(opts.messages)
    const tools: Record<string, unknown>[] = (opts.tools ?? []).map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters
    }))
    if (opts.webSearch)
      tools.push({
        type: 'web_search_20250305',
        name: 'web_search',
        ...(opts.webLookupsCap ? { max_uses: opts.webLookupsCap } : {}),
        ...(opts.webDomains?.length ? { allowed_domains: opts.webDomains } : {})
      })
    // The automatic breakpoint pays where a conversation goes on: a tool loop, or a caller that asks for
    // it (the writers' lookup rounds). On a one-shot request it would only add the write surcharge.
    const tail =
      (opts.cacheTail || (opts.tools?.length ?? 0) > 0) &&
      countBreakpoints(system, ...messages.map((m) => m.content)) < MAX_BREAKPOINTS
    const effort = effortFor(opts.reasoningEffort)
    const body = JSON.stringify({
      model: opts.model,
      max_tokens: Math.min(clampMaxTokens(opts.maxTokens), MAX_OUTPUT_TOKENS),
      stream: true,
      ...(system.length ? { system } : {}),
      messages,
      ...(tools.length ? { tools } : {}),
      // Summaries are what the "Thinking…" indicator counts; the text itself is never shown, and the
      // reasoning is billed the same either way. `drop_block`: see the file header.
      thinking: {
        type: 'adaptive',
        display: 'summarized',
        block_binding: { prefix_mismatch_behavior: 'drop_block' }
      },
      ...(effort ? { output_config: { effort } } : {}),
      ...(tail ? { cache_control: { type: 'ephemeral' } } : {})
    })
    return { url: `${BASE_URL}/messages`, headers: headers(key), body }
  },

  createState: (opts) => ({
    model: opts.model,
    sentProvider: false,
    blocks: new Map(),
    json: new Map(),
    usage: {},
    sentUsage: false,
    stopped: false
  }),

  interpret(raw: unknown, state: AnthropicState): StreamEvent[] {
    const parsed = raw as Record<string, any>
    const events: StreamEvent[] = []
    const index: number = typeof parsed?.index === 'number' ? parsed.index : -1
    switch (parsed?.type) {
      case 'message_start': {
        const message = isObj(parsed.message) ? parsed.message : {}
        if (isObj(message.usage)) {
          Object.assign(state.usage, message.usage)
          state.firstPrompt =
            num(message.usage.input_tokens) +
            num(message.usage.cache_creation_input_tokens) +
            num(message.usage.cache_read_input_tokens)
        }
        if (!state.sentProvider) {
          state.sentProvider = true
          events.push({ type: 'provider', name: 'Anthropic' })
        }
        // Reasoning the API dropped because the conversation changed under it (compaction) or the model
        // did: the request still ran, so this is a note for the log, not an error.
        const dropped = Array.isArray(message.input_transformations)
          ? message.input_transformations.filter((t: unknown) => isObj(t) && t.type === 'thinking_dropped')
          : []
        if (dropped.length)
          console.warn(
            `[anthropic] ${dropped.length} thinking block(s) dropped on ${state.model}: ` +
              [...new Set(dropped.map((t: Record<string, unknown>) => String(t.reason)))].join(', ')
          )
        break
      }
      case 'content_block_start': {
        if (!isObj(parsed.content_block)) break
        const block: Record<string, unknown> = { ...parsed.content_block }
        state.blocks.set(index, block)
        if (block.type === 'text' && typeof block.text === 'string' && block.text)
          events.push({ type: 'delta', text: block.text })
        if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking)
          events.push({ type: 'reasoning', chars: block.thinking.length })
        if (block.type === 'tool_use' || block.type === 'server_tool_use') state.json.set(index, '')
        break
      }
      case 'content_block_delta': {
        const d = parsed.delta
        const block = state.blocks.get(index)
        if (!isObj(d) || !block) break
        switch (d.type) {
          case 'text_delta':
            if (typeof d.text === 'string' && d.text) {
              block.text = String(block.text ?? '') + d.text
              events.push({ type: 'delta', text: d.text })
            }
            break
          case 'thinking_delta':
            if (typeof d.thinking === 'string' && d.thinking) {
              block.thinking = String(block.thinking ?? '') + d.thinking
              events.push({ type: 'reasoning', chars: d.thinking.length })
            }
            break
          case 'signature_delta':
            if (typeof d.signature === 'string') block.signature = String(block.signature ?? '') + d.signature
            break
          case 'input_json_delta':
            if (typeof d.partial_json === 'string')
              state.json.set(index, (state.json.get(index) ?? '') + d.partial_json)
            break
          case 'citations_delta':
            if (isObj(d.citation))
              block.citations = [...(Array.isArray(block.citations) ? block.citations : []), d.citation]
            break
        }
        break
      }
      case 'content_block_stop': {
        const block = state.blocks.get(index)
        if (block && state.json.has(index)) block.input = parseArgs(state.json.get(index) ?? '')
        break
      }
      case 'message_delta': {
        if (isObj(parsed.delta) && typeof parsed.delta.stop_reason === 'string')
          state.stopReason = parsed.delta.stop_reason
        // Cumulative counts: the last report holds the request's totals.
        if (isObj(parsed.usage)) Object.assign(state.usage, parsed.usage)
        events.push({
          type: 'finish',
          reason: finishReason(state.stopReason),
          ...(state.stopReason === 'refusal' ? { detail: refusalDetail(parsed.delta?.stop_details) } : {})
        })
        events.push(...sendUsage(state))
        break
      }
      case 'message_stop':
        state.stopped = true
        break
      case 'error': {
        const err = isObj(parsed.error) ? parsed.error : {}
        // Billed all the same: the usage so far is booked first, the error raised from `finish`.
        state.failure = streamError(String(err.type ?? ''), String(err.message ?? ''))
        events.push(...sendUsage(state))
        break
      }
    }
    return events
  },

  // A cut-off reply never reaches `finish`: the engine raises it and releases none of its calls.
  completed: (state) => state.stopped || !!state.failure,

  finish(state: AnthropicState): StreamEvent[] {
    if (state.failure) throw state.failure
    const events: StreamEvent[] = [...sendUsage(state)]
    const order = [...state.blocks.keys()].sort((a, b) => a - b)
    const blocks = order.map((i) => state.blocks.get(i)!)
    const citations = citationsOf(blocks)
    if (citations.length) events.push({ type: 'citations', citations })
    const calls: AccumTool[] = order
      .filter((i) => state.blocks.get(i)?.type === 'tool_use')
      .map((i) => {
        const b = state.blocks.get(i)!
        return { id: String(b.id ?? ''), name: String(b.name ?? ''), arguments: state.json.get(i) || '{}' }
      })
      .filter((c) => c.name)
    // A refused reply's output is to be discarded (Anthropic's refusal docs): calls it streamed before the
    // stop are not handed out to be run.
    if (state.stopReason === 'refusal') return events
    // A tool round, or a paused one: either way the blocks have to go back as they came.
    if (calls.length || state.stopReason === 'pause_turn')
      events.push({
        type: 'tool_calls',
        calls,
        replay: { provider: 'anthropic', model: state.model, steps: blocks }
      })
    return events
  }
}
