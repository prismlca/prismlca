/**
 * AI defaults shared by the main process and the renderer.
 *
 * These were duplicated in three places each (models.ts / CanvasChat.tsx / Settings.tsx for the
 * model, agent.ts / CanvasChat.tsx / Settings.tsx for the round budget), so changing one silently
 * left the Settings dialog and the actual behaviour disagreeing.
 *
 * Constraints for anything added here: plain values only — no imports, no Node APIs, no DOM APIs.
 * This is the one module compiled into BOTH bundles (electron-vite builds main, preload and renderer
 * separately), and it is listed in both tsconfigs; a dependency that exists on only one side would
 * break the other's build rather than fail loudly here.
 */

/** Model a fresh install chats with on OpenRouter — the same one as under the direct-OpenAI provider
 *  (it used to be GLM 5.3 Flash). Measured first, on the plan-eval task
 *  (PET bottle, cradle-to-gate) against earlier runs: GPT-6.1 Sol finished in 37 rounds
 *  with no rejected call and no error, 0.098 kg CO₂e, $0.64 and 6:40 min — GLM 5.3 Flash 57 rounds,
 *  3 failed calls, 19 min, $0.28; Sonnet 5.5 24 rounds, $1.59. Twice the cheap default's cost
 *  bought a third fewer rounds, a clean run and a third of the time; the cost limit per run stays
 *  the guard. OpenAI models are exempt from the zero-retention request by default
 *  (DEFAULT_ZDR_EXCEPT_OPENAI), so this default sends chats to OpenAI under its own retention
 *  terms — PRIVACY.md says so. Existing installs keep the model stored on their first start. */
export const DEFAULT_MODEL_ID = 'openai/gpt-6.1-sol'

/** Chat default under the direct-OpenAI provider — the balanced tier of the current family (GPT-6
 *  has no Terra; 6.1 Sol is the middle of Astra / Sol / Luna). Ids verified against
 *  developers.openai.com on 2026-10-01. */
export const DEFAULT_OPENAI_MODEL_ID = 'gpt-6.1-sol'

/**
 * Default tool-round budget per turn (a round may fire several tool calls). Deliberately high: the
 * assistant is meant to carry out larger multi-step tasks. Overridable in Settings → AI.
 *
 * Raised from 40 after a cradle-to-grave model with all transports needed roughly 500 tool calls and
 * hit the ceiling three times — each stop leaving a half-applied model behind, which is worse than a
 * long run. The batch arguments on the edit tools cut the call count sharply, so this is headroom
 * rather than an invitation to spend it.
 */
/**
 * The day the hand-maintained OpenAI list prices were last checked against OpenAI's pricing docs.
 *
 * Here rather than in `main/ai/models.ts`, where the prices themselves live, for the one reason that
 * matters: the settings table PRINTS it, and the renderer cannot import from main. A date the reader
 * can see is also the pressure that keeps it honest — "checked when the catalogue changes" is a
 * promise, "as of 30 August 2026" is a fact the reader can weigh.
 *
 * **Bump this in the same commit as any OpenAI price.** `models.test.ts` cannot tell a stale date
 * from a fresh one, so nothing but the habit protects it.
 */
export const OPENAI_PRICES_CHECKED = '2026-10-01'

/**
 * The Artificial Analysis pull behind the `intelligence`/`agentic` columns: the day it was fetched,
 * and the Intelligence Index version those scores belong to.
 *
 * Here for the same reason as the date above — the settings table prints both, and the renderer
 * cannot import from main. The version is not decoration: AA scores compare within one version
 * only, so "43.8" without "v4.3" beside it is a number the reader cannot place, and v4.1.1 → v4.3
 * moved every model in the catalogue by double digits without any model changing.
 *
 * **Bump both in the same commit as the columns in `main/ai/models.ts`**, and move the whole column
 * at once — `backend/local/aa_ratings/` (local, gitignored) pulls it and prints the drift.
 */
export const AA_RATINGS_PULLED = '2026-10-01'
export const AA_INDEX_VERSION = '4.3'

export const DEFAULT_MAX_ROUNDS = 150

/**
 * Default spend ceiling per run in USD; 0 disables the circuit breaker.
 *
 * Raised from 2. Two is where the brake stops being a backstop and becomes the
 * thing that ends normal work: on the models actually used for a study, the ledger puts a call at
 * 0.07-0.12 $, so two dollars is under thirty calls — well inside a single chapter run, and each
 * stop leaves a half-written document behind. The same argument that took `DEFAULT_MAX_ROUNDS` from
 * 40 to 150.
 *
 * Fifteen rather than the ceiling: the brake only settles up BETWEEN rounds, so it cannot end a
 * single runaway reply (that is what `DEFAULT_MAX_TOKENS` is for) — which means the number is what a
 * mistake costs before anything notices. For the default chat model the figure is academic either
 * way: GLM 5.3 Flash measured 0.006 $/call, so 150 rounds cannot reach even the old two dollars. It
 * bites only once someone moves to a frontier model, and that is exactly the user it should let
 * finish.
 */
export const DEFAULT_MAX_COST_USD = 15

/**
 * Preferred minimum provider throughput in tokens/second, as OpenRouter's `preferred_min_throughput`.
 *
 * Routing picks an endpoint per request, and the spread is not academic: the same model on the same
 * prompt was measured at ~4.5 tokens/s once and, two minutes later, at ~20 — the first run
 * spent nineteen minutes reasoning and returned nothing. Nothing in the request expressed a
 * preference either way.
 *
 * This is deliberately a PREFERENCE, not a filter. OpenRouter documents it as never able to prevent
 * a request from running: endpoints that meet the threshold are favoured, and if none does, the
 * request goes out exactly as it does today. That asymmetry decides the default. Setting it too high
 * costs nothing — the preference simply matches nothing and routing behaves as before; setting it
 * too low leaves the degraded endpoints eligible. So 20 rather than 15: the good run measured ~20
 * tokens/s END TO END, and a provider's own p50 is the generation rate without the thinking pauses
 * and first-token wait folded in, so its real figure sits comfortably above that. 15 would still
 * admit an endpoint only three times better than the one that wasted twenty minutes.
 *
 * A bare number applies to the p50 (median) of the provider's last five minutes. 0 switches it off.
 */
export const DEFAULT_MIN_THROUGHPUT = 20
export const MAX_MIN_THROUGHPUT = 500

/**
 * Web lookups the provider may run INSIDE one reply (OpenRouter's `openrouter:web_search` /
 * `openrouter:web_fetch` server tools, `max_uses` on each).
 *
 * Why a cap at all: a server tool is not a cheap side call. OpenRouter runs the model again with the
 * whole conversation after every lookup, and the round's usage sums those passes — in one
 * measured run a single round reported 375k prompt tokens for an 85k conversation (three passes,
 * 0.24 $ instead of 0.06 $). The most any round was seen to use is two lookups; eight per tool leaves
 * room for a real search-and-open sequence without letting one answer run to thirty passes
 * (OpenRouter's own default). 0 = send no cap and take the provider's default.
 */
export const DEFAULT_WEB_LOOKUPS_PER_ANSWER = 8
export const MAX_WEB_LOOKUPS_PER_ANSWER = 30

/** Whole number 0…MAX; anything unreadable reads as the default (0 means "no cap"). */
export function clampWebLookups(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_WEB_LOOKUPS_PER_ANSWER
  return Math.min(MAX_WEB_LOOKUPS_PER_ANSWER, Math.max(0, Math.round(n)))
}

/** Clamp the throughput preference; 0 (or anything unreadable) means "express no preference". */
export function clampMinThroughput(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(MAX_MIN_THROUGHPUT, Math.round(n))
}

/**
 * How many questions one `research_web` call may fan out in parallel.
 *
 * Letting the tool take a list of questions cut a research phase from minutes-in-sequence down to
 * the length of its slowest leg — but every leg is a separate sub-agent with its own paid web
 * search, and each may retry once, so the bill scales with the WIDTH of the fan rather than with the
 * number of calls. Measured on one run: two `research_web` calls became eight
 * sub-agent calls and 930k prompt tokens, and research went from 18 % of a run's cost to 50 %.
 *
 * Six, raised from four after a picture-frame run asked five questions in one call: the
 * fifth was reported back as `not_researched` (correctly — the ceiling is never silent) and then cost
 * a second `research_web` call of 50.8 s minutes later for that one question. The legs run in
 * parallel, so a wider fan is wall-clock free; what it costs is one paid web search per leg, which is
 * why there is a ceiling at all. Six fits "these five facts are still missing" with room to spare and
 * keeps the worst case near a dozen sub-calls. Raise it in Settings → AI when a study needs a wider
 * sweep and the cost ceiling has the headroom; questions beyond the limit are still not dropped
 * silently, the tool says which ones it did not run.
 */
export const DEFAULT_MAX_RESEARCH_QUESTIONS = 6
export const MIN_RESEARCH_QUESTIONS = 1
export const MAX_RESEARCH_QUESTIONS = 10

/** Clamp the parallel-research width into the supported window. */
export function clampResearchQuestions(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_MAX_RESEARCH_QUESTIONS
  return Math.min(MAX_RESEARCH_QUESTIONS, Math.max(MIN_RESEARCH_QUESTIONS, Math.round(n)))
}

/**
 * Ceiling on the tokens one model reply may produce (`max_tokens`).
 *
 * Sending nothing at all leaves the length entirely to the provider default, which is how a model
 * that fell into a repetition loop ("Let me go." several hundred times) could keep generating: the
 * per-turn cost breaker only settles up between rounds, so it cannot end a single runaway reply. The
 * stream-side repetition detector is the sharp instrument; this is the backstop.
 *
 * The bounds are not decoration. Below the minimum, legitimate long answers get truncated — the
 * closing summaries of a real model build measured ~7k tokens, and a report chapter can exceed that;
 * above the maximum, a runaway reply gets expensive before anything notices.
 */
export const DEFAULT_MAX_TOKENS = 50_000
export const MIN_MAX_TOKENS = 20_000
export const MAX_MAX_TOKENS = 250_000

/**
 * The same ceiling for the report writer, which gets its own: a chapter is the
 * longest single answer the app asks for, and it is written by reasoning models.
 *
 * Derived from the runs on record, since no ledger keeps single replies: one report run wrote
 * nine chapters in 115 184 output tokens (≈ 13 000 each, ~100 tokens/s), Qwen 3.8 Max averaged
 * 7 200 per call over 576 writer calls and spent up to 250 s on one chapter (≈ 25 000 tokens at that
 * rate), GLM 5.3 Flash averaged 9 900. Twice the chat ceiling is four times the largest chapter
 * seen — room for a long annex on a model that thinks at length, while a runaway still stops. A
 * reply that does hit it is continued, not cut (reportWriter, MAX_CONTINUATIONS).
 */
export const DEFAULT_WRITER_MAX_TOKENS = 100_000

/** Clamp a user-entered value into the supported window; non-numbers fall back to `fallback`. */
export function clampMaxTokens(value: unknown, fallback: number = DEFAULT_MAX_TOKENS): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.round(n)))
}

/**
 * Route chat/agent traffic only to OpenRouter providers that keep no data (`data_collection: deny`).
 * On by default — LCA models carry client data. Switching it off widens the provider pool (some
 * models are served ONLY by logging providers and fail with "no endpoints" while this is on).
 *
 * Applies to chat, sub-agents and the report writer. Voice transcription and embeddings enforce
 * zero data retention unconditionally and ignore this setting.
 */
export const DEFAULT_ZERO_DATA_RETENTION = true

/**
 * Exceptions to the switch above, per vendor — the same shape OpenRouter's own privacy settings
 * use, and for the same reason they document: "you may want to enforce ZDR for all other models
 * while keeping first-party Anthropic, OpenAI and Google endpoints available".
 *
 * ON by default, because OFF is not free: measured against `/api/v1/endpoints/zdr` on 2026-09-10,
 * `anthropic/claude-fable-5.1` has **no** zero-retention endpoint at all, so strict ZDR would take
 * the strongest model in the catalogue out of the picker on first launch. The Anthropic and OpenAI
 * models PrismLCA offers are first-party or Azure/Bedrock/Vertex — vendors with contractual retention
 * terms, not the long tail these settings exist to guard against.
 *
 * OpenRouter's per-request `zdr` is a single boolean: the per-model-group fields
 * (`enforce_zdr_anthropic` …) exist only account-wide and on guardrails. So the exception is made
 * HERE, by omitting the flag for those vendors — same effect, and it stays visible in PrismLCA.
 * Note the request flag ORs with the account setting: if ZDR is enforced on the OpenRouter account,
 * no exception here can loosen it.
 */
export const DEFAULT_ZDR_EXCEPT_ANTHROPIC = true
export const DEFAULT_ZDR_EXCEPT_OPENAI = true
/**
 * Google (Gemini) joined the two above for the same measured reason taken one step
 * further: Google now logs prompts for abuse monitoring on the Gemini API (ai.google.dev/gemini-api/docs/zdr,
 * updated 2026-09-14: "for guaranteed zero data retention … use Vertex AI"), and Vertex warns that
 * "zero data retention may not be possible" for its Advanced AI models (Advanced AI Safety Addendum).
 * OpenRouter announced it in a banner on its site: from 2026-10-18 every Google model requires "Safety
 * Retention", so its Google endpoints leave the ZDR list. Strict ZDR would
 * then answer 404 for every Gemini row. Vertex and AI Studio are Google's own first-party endpoints,
 * paid, with contractual terms and no training on paid traffic — the class this exception is for.
 * The rule is by MODEL vendor (`google/…`), so it also covers Gemma rows a user adds, whoever serves them.
 */
export const DEFAULT_ZDR_EXCEPT_GOOGLE = true

/**
 * The reasoning-effort levels a request may ask for — OpenRouter's unified `reasoning.effort` and
 * OpenAI's Responses `reasoning.effort` share this vocabulary (checked 03.10.2026). Which of them a
 * MODEL accepts is per catalogue row (`reasoningEfforts` in main/ai/models.ts): Anthropic answers 400
 * to `none`, GPT-6 Astra has no `none`, GLM maps anything above `high` to its own `max`, and so on.
 * The setting stores one choice per model id; absent or '' = send nothing, the API's own default —
 * which for several models is well below the top row the catalogue's ratings were measured at.
 */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: 'None — answer without thinking',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high'
}

/** The same levels as one word each — the tick labels of the effort scale, where seven of them share
 *  one row. */
export const REASONING_EFFORT_SHORT: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-high'
}

/** The stored per-model choices, cleaned: only known levels, keyed by a non-empty model id. */
export function sanitiseReasoningEfforts(value: unknown): Record<string, ReasoningEffort> {
  const out: Record<string, ReasoningEffort> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [id, v] of Object.entries(value as Record<string, unknown>)) {
    if (id && typeof v === 'string' && (REASONING_EFFORTS as readonly string[]).includes(v))
      out[id] = v as ReasoningEffort
  }
  return out
}
