/**
 * The models PrismLCA reaches at the vendor directly — OpenAI and Google — with the list prices we
 * keep by hand for them.
 *
 * Neither vendor reports a cost per request or publishes prices over an API, so every row here MUST
 * carry `pricing` (models.test.ts enforces it), and the cost breaker, the ledger and the per-message
 * cost are computed from it by the transports (providers/openai.ts, providers/google.ts). A stale
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

export const DIRECT_MODELS: AiModel[] = [
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
  // Pricing checked against OpenAI's docs on 2026-10-01 (Standard tier, short context). The page
  // now also lists a "cache writes" price (1.25× input); it is not modelled here — the synthesis in
  // providers/openai.ts books cached reads and uncached input only, an under-estimate by the write
  // surcharge on the first turn of a prefix. Prompts in the long-context band are billed at 2× input
  // / 1.5× output for the whole request; the synthesis deliberately ignores that too (contexts that
  // large are rare here and compaction starts far below it). Said here so nobody reads the ledger
  // as exact in those corners.
  //
  // The same models are also in the OpenRouter list above, under OpenRouter's ids — that is not a
  // duplicate, it is the other route to them, and the table only ever shows the active provider's
  // half.
  //
  // `intelligence`/`agentic` come from the Artificial Analysis pull like every other row (see the
  // ratings block in the header), not from a separate reading.
  {
    id: 'gpt-6-astra',
    provider: 'openai',
    pricing: { input: 10, cachedInput: 1, output: 50 },
    label: 'GPT-6 Astra (OpenAI)',
    descriptor: 'strongest (OpenAI), priciest',
    temperature: null,
    intelligence: 52.7,
    agentic: 51,
    vision: true,
    planTool: false,
    contextTokens: 1050000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh']
  },
  {
    id: 'gpt-6.1-sol',
    provider: 'openai',
    pricing: { input: 2, cachedInput: 0.1, output: 10 },
    label: 'GPT-6.1 Sol (OpenAI)',
    descriptor: 'strong, mid price (default)',
    temperature: null,
    intelligence: 51.8,
    agentic: null,
    vision: true,
    planTool: false,
    contextTokens: 1050000,
    reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
  },
  {
    id: 'gpt-6-luna',
    provider: 'openai',
    pricing: { input: 0.1, cachedInput: 0.01, output: 0.5 },
    label: 'GPT-6 Luna (OpenAI)',
    descriptor: 'cheapest',
    temperature: null,
    intelligence: 38.1,
    agentic: null,
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
  // `intelligence`/`agentic` are the OpenRouter rows' figures: the same model, the same AA reading.
  // Prices: Google's paid tier, standard (not batch, not flex). Cached reads are implicit caching;
  // explicit context caching and its storage fee are not used. Both rows double on a date Google has
  // already published — hence `priceChanges`.
  {
    id: 'gemini-4-argon',
    provider: 'google',
    pricing: { input: 2, cachedInput: 0.1, output: 10 },
    priceChanges: [{ from: '2026-12-01', input: 4, cachedInput: 0.2, output: 20 }],
    label: 'Gemini 4 Argon (Google)',
    descriptor: 'top tier (Google), paid keys only',
    temperature: null,
    intelligence: 52.6,
    agentic: null,
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
    intelligence: 40.9,
    agentic: 40.2,
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
    agentic: null,
    vision: false,
    selectable: false
  }
]
