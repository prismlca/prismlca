/**
 * The models PrismLCA reaches at the vendor directly — Anthropic, Google and OpenAI — with the list
 * prices we keep by hand for them.
 *
 * None of these vendors reports a cost per request or publishes prices over an API, so every row here
 * MUST carry `pricing` (models.test.ts enforces it), and the cost breaker, the ledger and the per-message
 * cost are computed from it by the transports (providers/anthropic.ts, openai.ts, google.ts). A stale
 * price is a silently mis-calibrated cost limit, which is why the prices sit together on one page with
 * the date they were checked (`OPENAI_PRICES_CHECKED` / `GOOGLE_PRICES_CHECKED` in shared/aiDefaults.ts,
 * printed by the settings table) and why a price change the vendor has ANNOUNCED is entered as a dated
 * `priceChanges` step rather than remembered: Google doubles Argon's prices on 2026-12-01 and Flash's on
 * 2027-01-01, and a cost limit that silently counts half after that date is worse than none.
 *
 * The OpenRouter half of the catalogue stays in models.ts; its prices arrive live.
 */
import type { AiModel } from './models'

/** The list price that applies on `day` (YYYY-MM-DD, default today): the latest `priceChanges` step
 *  that has begun, else `pricing`. Undefined for a row without hand-kept prices (OpenRouter's). */
export function priceOn(
  m: Pick<AiModel, 'pricing' | 'priceChanges'>,
  day: string = new Date().toISOString().slice(0, 10)
): AiModel['pricing'] {
  let price = m.pricing
  for (const step of m.priceChanges ?? []) {
    if (step.from <= day) price = { input: step.input, cachedInput: step.cachedInput, output: step.output }
  }
  return price
}

/** The price of one request whose prompt is `promptTokens` long — cache reads and writes counted in:
 *  the row's long-prompt prices above its threshold (they apply to the WHOLE request), else the day's
 *  list price. One rule for every transport that synthesizes a cost. */
export function priceFor(
  m: Pick<AiModel, 'pricing' | 'priceChanges' | 'longPrompt'>,
  promptTokens: number,
  day?: string
): AiModel['pricing'] {
  return m.longPrompt && promptTokens > m.longPrompt.above ? m.longPrompt : priceOn(m, day)
}

/**
 * Hand-maintained NON-TOKEN list prices (developers.openai.com pricing docs; the date of the last
 * check is `OPENAI_PRICES_CHECKED` in shared/aiDefaults.ts, which the settings table prints —
 * bump it here and there in the same commit),
 * kept beside the per-model `pricing` table so every hand-kept number lives on one page: OpenAI
 * publishes no pricing API, so whoever touches an OpenAI entry re-verifies these two as well.
 */
//: The web_search tool bills per CALL on top of the tokens: $10 per 1k calls.
export const OPENAI_WEB_SEARCH_USD_PER_CALL = 0.01
//: Per-minute list price of the transcription model (see OPENAI_STT_MODEL in providers/openai.ts).
export const OPENAI_STT_USD_PER_MINUTE = 0.0045

/**
 * Google's search grounding bills per QUERY the model runs, not per request: "a customer-submitted
 * request to Gemini may result in one or more queries to Google Search, and you will be charged for
 * each individual search query" — $14 per 1,000 for Gemini 3 and newer (aistudio.google.com/docs/pricing,
 * checked with GOOGLE_PRICES_CHECKED). The first 5,000 queries a month are free on a paid key; the
 * synthesis does not know where the month stands and books every query, so a figure is an upper bound.
 */
export const GOOGLE_SEARCH_USD_PER_QUERY = 0.014

/**
 * Anthropic's non-token list prices (platform.claude.com/docs/en/about-claude/pricing, checked with
 * ANTHROPIC_PRICES_CHECKED). The web_search server tool bills per search on top of the tokens — $10 per
 * 1,000, a failed search not at all — and its results then count as input tokens like any other text.
 */
export const ANTHROPIC_WEB_SEARCH_USD_PER_SEARCH = 0.01
/** Writing a prompt prefix into Anthropic's cache costs this multiple of the input price (the
 *  five-minute cache, the only one PrismLCA asks for); a later read costs the row's `cachedInput`. */
export const ANTHROPIC_CACHE_WRITE_FACTOR = 1.25

export const DIRECT_MODELS: AiModel[] = [
  // --- Direct-Anthropic catalogue (Settings → AI → provider 'Anthropic') --------------------------
  //
  // Verified on 2026-11-08 (Fable 5.2 on 2026-11-12) against Anthropic's Models API (ids, 1M context,
  // 128K output, effort low–max, web search, image and PDF input on all four) and its pricing page. Served through the Messages API
  // (providers/anthropic.ts). Thinking is adaptive and always on for these models, and the 2026-10-21 API
  // version rejects sampling parameters — so temperature stays null, as on their OpenRouter rows.
  //
  // Prices: standard tier, global inference. Cache reads differ by model (Fable 0.025×, Opus and Sonnet
  // 0.05×, Haiku 0.1× of input); cache writes cost ANTHROPIC_CACHE_WRITE_FACTOR × input. Haiku 5.5 is the
  // one row priced by prompt length (`longPrompt`). `intelligence`, `planTool` and the effort
  // levels are their OpenRouter rows' — the same models, the same readings; our effort vocabulary ends at
  // xhigh, so Anthropic's `max` is not offered.
  {
    id: 'claude-sonnet-5-5',
    provider: 'anthropic',
    pricing: { input: 2, cachedInput: 0.1, output: 10 },
    label: 'Claude Sonnet 5.5 (Anthropic)',
    descriptor: 'strong, mid price (default)',
    temperature: null,
    intelligence: 54.5,
    vision: true,
    planTool: false,
    contextTokens: 1000000,
    explicitCache: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh']
  },
  {
    id: 'claude-opus-5-5',
    provider: 'anthropic',
    pricing: { input: 4, cachedInput: 0.2, output: 20 },
    label: 'Claude Opus 5.5 (Anthropic)',
    descriptor: 'top tier, upper-mid price',
    temperature: null,
    intelligence: 59.1,
    vision: true,
    planTool: false,
    contextTokens: 1000000,
    explicitCache: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh']
  },
  {
    // Anthropic keeps every Fable 5.2 request for 30 days for safety review (a "Covered Model"); the
    // other three rows fall under its standard terms. PRIVACY.md says so. Replaces Fable 5.1, and is
    // cheaper than it was ($8/$40 against $10/$50; cache reads still 0.025× of input).
    id: 'claude-fable-5-2',
    provider: 'anthropic',
    pricing: { input: 8, cachedInput: 0.2, output: 40 },
    label: 'Claude Fable 5.2 (Anthropic)',
    descriptor: 'highest intelligence score, priciest',
    temperature: null,
    intelligence: 64.6,
    vision: true,
    planTool: false,
    contextTokens: 1000000,
    explicitCache: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh']
  },
  {
    id: 'claude-haiku-5-5',
    provider: 'anthropic',
    pricing: { input: 0.1, cachedInput: 0.01, output: 0.5 },
    longPrompt: { above: 100_000, input: 0.5, cachedInput: 0.05, output: 2.5 },
    label: 'Claude Haiku 5.5 (Anthropic)',
    descriptor: 'cheapest, strongest at that price',
    temperature: null,
    intelligence: 36.5,
    vision: true,
    planTool: true,
    contextTokens: 1000000,
    explicitCache: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh']
  },

  // --- Direct-OpenAI catalogue (Settings → AI → provider 'OpenAI') --------------------------------
  //
  // The GPT-6 family, verified against developers.openai.com/api/docs/models on 2026-10-01: Astra
  // (flagship), 6.1 Sol (the balance of cost and intelligence) and Luna (cheap, high volume). Unlike
  // GPT-5.6, whose flagship was the bare `gpt-5.6`, every GPT-6 API id carries its name. There is
  // no GPT-6 Terra. All three: 1,050,000-token context, text+image input, reasoning models — which
  // in this catalogue means temperature stays null (calibrated to their own defaults), like Kimi K3.
  //
  // `explicitCache` stays unset: OpenAI caches prompt prefixes automatically, and agent.test.ts
  // holds that only Anthropic entries mark cache breakpoints explicitly.
  //
  // Pricing checked against OpenAI's docs on 2026-11-08 (Standard tier). The page also lists a
  // "cache writes" price (1.25× input); it is not modelled here — the synthesis in providers/openai.ts
  // books cached reads and uncached input only, an under-estimate by the write surcharge on the first
  // turn of a prefix, said here so nobody reads the ledger as exact in that corner. A prompt above
  // 272K input tokens ("Long" on the page) is billed at the `longPrompt` prices for the whole request:
  // 2× input and cached input, 1.5× output. A chat under OpenAI is compacted only at about half of its
  // 1.05M window, so long sessions do cross it.
  //
  // The same models are also in the OpenRouter list above, under OpenRouter's ids — that is not a
  // duplicate, it is the other route to them, and the table only ever shows the active provider's
  // half.
  //
  // `intelligence` comes from the Artificial Analysis pull like every other row (see the
  // ratings block in the header), not from a separate reading.
  {
    id: 'gpt-6-astra',
    provider: 'openai',
    pricing: { input: 10, cachedInput: 1, output: 50 },
    longPrompt: { above: 272_000, input: 20, cachedInput: 2, output: 75 },
    label: 'GPT-6 Astra (OpenAI)',
    descriptor: 'strongest (OpenAI), priciest',
    temperature: null,
    intelligence: 56.9,
    vision: true,
    planTool: false,
    contextTokens: 1050000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh']
  },
  {
    id: 'gpt-6.1-sol',
    provider: 'openai',
    pricing: { input: 2, cachedInput: 0.1, output: 10 },
    longPrompt: { above: 272_000, input: 4, cachedInput: 0.2, output: 15 },
    label: 'GPT-6.1 Sol (OpenAI)',
    descriptor: 'strong, mid price (default)',
    temperature: null,
    intelligence: 54.6,
    vision: true,
    planTool: false,
    contextTokens: 1050000,
    reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
  },
  {
    id: 'gpt-6-luna',
    provider: 'openai',
    pricing: { input: 0.1, cachedInput: 0.01, output: 0.5 },
    longPrompt: { above: 272_000, input: 0.2, cachedInput: 0.02, output: 0.75 },
    label: 'GPT-6 Luna (OpenAI)',
    descriptor: 'cheapest',
    temperature: null,
    intelligence: 27.9,
    vision: true,
    planTool: true,
    contextTokens: 1050000,
    reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
  },

  // --- Direct-Google catalogue (Settings → AI → provider 'Google') ------------------------------
  //
  // Verified against aistudio.google.com/docs (models, thinking, pricing) on 2026-11-07. Served through
  // the Interactions API (providers/google.ts). Both chat rows are reasoning models whose sampling
  // parameters Google says to remove, and the Interactions API has no temperature field at all — so
  // temperature stays null, as on their OpenRouter rows. Thinking levels per Google's table: low,
  // medium, high on both; `minimal` is an error on 3.8 Flash and Argon (OpenRouter maps it, Google
  // direct does not), so it is not offered here.
  //
  // `intelligence` is the OpenRouter rows' figure: the same model, the same AA reading.
  // Prices: Google's paid tier, standard (not batch, not flex). Cached reads are implicit caching;
  // explicit context caching and its storage fee are not used. Both rows double on a date Google has
  // already published — hence `priceChanges`.
  {
    id: 'gemini-4-argon',
    provider: 'google',
    pricing: { input: 2, cachedInput: 0.1, output: 10 },
    priceChanges: [{ from: '2026-12-01', input: 4, cachedInput: 0.2, output: 20 }],
    label: 'Gemini 4 Argon (Google)',
    descriptor: 'strongest (Google), paid keys only',
    temperature: null,
    intelligence: 50.4,
    vision: true,
    planTool: false,
    contextTokens: 1048576,
    reasoningEfforts: ['low', 'medium', 'high']
  },
  {
    id: 'gemini-3.8-flash',
    provider: 'google',
    pricing: { input: 0.75, cachedInput: 0.075, output: 3.75 },
    priceChanges: [{ from: '2027-01-01', input: 1.5, cachedInput: 0.15, output: 7.5 }],
    label: 'Gemini 3.8 Flash (Google)',
    descriptor: 'fast, cheap (default)',
    temperature: null,
    intelligence: 30.8,
    vision: true,
    planTool: true,
    contextTokens: 1048576,
    reasoningEfforts: ['low', 'medium', 'high']
  },
  {
    // Speech-to-text only (voice input under the Google provider, see GOOGLE_STT_MODEL). Billed per
    // token like the chat rows — audio in at $2/1M (32 tokens a second, ≈ $0.004 a minute), text out
    // at $12/1M. Chosen over sending the audio to Flash: on the same German test recording it got the
    // sentence nearly right where Flash invented one.
    id: 'gemini-3.5-transcribe',
    provider: 'google',
    pricing: { input: 2, cachedInput: 2, output: 12 },
    label: 'Gemini 3.5 Transcribe (Google)',
    descriptor: 'voice transcription',
    temperature: null,
    intelligence: null,
    vision: false,
    selectable: false
  }
]
