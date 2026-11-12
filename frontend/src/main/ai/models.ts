/**
 * AI model catalog — the OpenRouter chat models offered in PrismLCA, mirrored 1:1 from the
 * a sibling app (same model IDs + Artificial-Analysis ratings), plus a per-model
 * recommended `temperature`.
 *
 * Temperatures were researched per concrete model version (July 2026, new rows October 2026), per the vendors' own
 * docs/model cards. The modern pattern: reasoning-tuned models are calibrated to their DEFAULT
 * sampling values, and the frontier vendors removed the knob entirely — `null` means "do not send
 * the parameter at all":
 *   - Claude Sonnet 5.5 / Opus 5.5 / Fable 5.2 / Haiku 5.5: Anthropic REMOVED temperature/top_p/top_k from the
 *     API (non-default values → HTTP 400, since Opus 4.7) → null (omit).
 *   - Gemini 3.8 Flash: Google explicitly recommends REMOVING sampling params on Gemini 3.x —
 *     reasoning is optimised for the defaults → null (omit).
 *   - Gemini 4 Argon / Carbon: reasoning is mandatory and Google states no value for the 4 generation;
 *     the Gemini 3.x advice and the catalogue's reasoning-model rule agree → null (omit).
 *   - DeepSeek V4.1 Flash: default 1.0; the V4 docs warn that LOWERING temperature collapses the
 *     reasoning chain → 1.0.
 *   - Kimi K3: sampling is FIXED server-side (temperature locked at 1.0, top_p 0.95) — Moonshot
 *     says to omit the parameters entirely → null (omit).
 *   - MiniMax M3.1 Flash: model card recommends 1.0 (top_p 0.95) → 1.0.
 *   - GLM 5.3: Z.AI default/benchmarks at 1.0; never tune temperature and top_p together → 1.0.
 *   - Qwen3.8 2.4T A95B: model card recommends 1.0 (top_p 0.95, top_k 20) → 1.0.
 *   - GPT-6 Astra / 6.1 Sol / Luna, MiMo-V2.6-Pro, GLM 5.3 Flash, Hy4: reasoning models without a
 *     stated vendor value → null (omit).
 *
 * Pricing ($/1M tokens) is NOT hard-coded here — it is fetched live from OpenRouter's /models
 * endpoint (see openrouter.ts) and merged with these ratings for the settings info table.
 *
 * RATINGS: every `intelligence` value was pulled from the Artificial Analysis Data API on
 * **2026-11-12**, in one pass. The whole column moves together or not at all: scores compare only
 * within one index version, and a single row patched from a newer index makes a column that is only
 * ever read as a ranking quietly meaningless.
 *
 *   - `intelligence` = AA Intelligence Index **v5**, field `artificial_analysis_intelligence_index`,
 *     from `GET /api/v2/language/models/free`. Via the API it comes to one decimal, not as the
 *     integer the public chart shows.
 *
 * There is no agentic column any more. AA's Agentic Index came with v4.3; under v5 the API returns
 * it for no model at all, and a second column that is empty in every row says nothing.
 *
 * Do not re-read the scores off the website by hand: `backend/local/aa_ratings/` (local, gitignored)
 * pulls them, joins them to these ids by slug, and prints the drift. Adding a model means adding it
 * to that folder's `model_map.json` too, and then the next pull covers it like the rest.
 *
 * Index versions move numbers without any model changing: v4.1.1 → v4.3 cost every model roughly
 * 14 points, and v4.3 → v5 reshuffled the field instead (Astra +4, Opus 5.5 +1.5, GLM 5.3 −13,
 * MiMo-V2.6-Pro −16). A v4.3 figure of ~53 for Fable 5.1 was once rejected as "implausible, below
 * Sonnet 5's 55" when 55 was a v4.1.1 number. It was right. A figure that looks wrong against this
 * column is first of all a figure from a different index.
 *
 * Where a model is rated per reasoning effort, the HIGHEST variant is taken, consistently — on AA
 * that is the bare slug (`gpt-6-sol` = "GPT-6 Sol (Max)"; the lower efforts carry their own
 * `-high`/`-medium`/… slugs). It is the only choice that compares like with like, but note that
 * without a choice under Settings → AI → Models PrismLCA sends no `reasoning_effort`, so what you
 * get is the provider default, which for several models is far below the max row (GPT-6 Luna: 27.9
 * at max, 18.5 at medium, 9.4 non-reasoning). `reasoningEfforts` per row lists what the setting may
 * offer — the levels the model's API documents (OpenRouter's reasoning-tokens guide and
 * the vendors' pages); a row without it offers only the default, because an unsupported level is a
 * 400 that costs a run. The loop falls back to the default once if the API rejects a level.
 * Gemini 3.8 Flash is AA's "(high)" row — its top effort there, and also its best score; Gemini 4
 * Argon's and Carbon's "(High)" rows are their top effort too.
 *
 * `null` means AA does not rate it, not that it scored zero, and the table renders it as "–". The
 * speech model carries it for good (AA rates it on its speech leaderboard instead). Since the v5
 * pull three chat rows carry it as well — DeepSeek V4.1 Flash, Kimi K3 and Qwen3.8 2.4T A95B: AA
 * lists them but had not yet run them on v5. The next pull fills them; until then they sort last in
 * their lab. (Kimi K2.6 was removed from the catalogue rather than kept as a row with nothing to
 * say — an unrated row is worth keeping only where the model itself is still worth offering.)
 *
 * Artificial Analysis requires attribution wherever these numbers are shown. The Settings table
 * carries it under the column; `docs/DATENHERKUNFT.md` carries the source row.
 */
import {
  DEFAULT_ANTHROPIC_MODEL_ID,
  DEFAULT_MODEL_ID,
  DEFAULT_GOOGLE_MODEL_ID,
  DEFAULT_OPENAI_MODEL_ID,
  defaultChatModelFor,
  type AiProviderId,
  type ReasoningEffort
} from '../../shared/aiDefaults'
import { labKey } from '../../shared/labKey'
import { DIRECT_MODELS } from './directModels'
import { loadUserModelsFromUserData } from './userModels'

export interface AiModel {
  id: string // the provider's model id (OpenRouter: 'vendor/model'; direct: bare, e.g. 'gpt-6.1-sol')
  /** Which API serves this model. Absent = 'openrouter', so the original catalogue reads unchanged. */
  provider?: AiProviderId
  /**
   * Hand-maintained LIST prices in $/1M tokens — REQUIRED on every direct-vendor entry (OpenAI,
   * Google; models.test.ts enforces it) and absent on OpenRouter entries, whose prices are fetched
   * live. Neither direct vendor reports a cost, so this table is what the cost breaker, the ledger and
   * the per-message cost are computed from. The rows and the rules for keeping them live in
   * directModels.ts.
   */
  pricing?: { input: number; cachedInput: number; output: number }
  /** A price change the vendor has already announced, from the given day (YYYY-MM-DD) on. Read through
   *  `priceOn` (directModels.ts), never directly — the transports and the table must agree on the day. */
  priceChanges?: Array<{ from: string; input: number; cachedInput: number; output: number }>
  /** Prices for a request whose prompt is LONGER than `above` tokens, cache reads and writes counted in —
   *  the whole request is then billed at these (Claude Haiku 5.5: five times the short-prompt price above
   *  100,000 tokens). Read by the transport per request; the table shows the short-prompt price. */
  longPrompt?: { above: number; input: number; cachedInput: number; output: number }
  label: string // human name
  /** Short quality/cost hint, shown in the pickers. Strength first, price second, "open weight"
   *  where the weights are published. Every one was re-checked against the v5 ratings below and the
   *  OpenRouter prices of 2026-11-12, and a superlative is re-checked whenever either moves. "Top
   *  tier" is the four rows from 56.9 up, "strong" the three from 50 to 55. Rankings among the open
   *  and cheap rows say "highest-rated"/"lowest-rated": three open rows are unrated under v5, so GLM
   *  5.3 (31.7) holds its end only among the rated ones until the next pull. On a direct vendor's
   *  list a superlative is about that list, the only one the table shows. A price word is a class,
   *  not a number: "cheapest" ≈ $0.10/$0.50, "very cheap" under $0.50 in, "cheap" under $1 in,
   *  "mid" ≈ $2/$10, "upper-mid" ≈ $4/$20, "premium" ≈ $8/$40, "priciest" the top row; "lowest
   *  price here" is the one row below all of them. */
  descriptor: string
  temperature: number | null // researched per-model value; null = omit the parameter (vendor default)
  intelligence: number | null // Artificial Analysis Intelligence Index
  vision: boolean // accepts image input (gates the canvas-screenshot tool)
  /** false = shown in the cost/info table but NOT offered as a chat model (e.g. the STT model). */
  selectable?: boolean
  /**
   * true = the provider only caches the prompt prefix when we mark it explicitly with a
   * `cache_control` breakpoint (Anthropic). Everyone else either caches automatically (OpenAI,
   * DeepSeek, Google) or not at all, and would reject/ignore the marker — so we only send it here.
   * The breakpoint sits on the system prompt, which caches everything before it: the tool
   * definitions (all of them — see `docs/ai-tool-manifest.json` for the current count) plus the
   * system prompt itself, i.e. the whole constant block that we would otherwise pay for on every
   * single turn. A figure was written out here once and was wrong within a fortnight; what matters
   * is that it is the whole block, not how many it happens to be today.
   */
  explicitCache?: boolean
  /**
   * true = this row came from the user's own `models.json`, not from the catalogue below. Shown as
   * such (a mark in the table, a suffix in the pickers) and never rated: see `userModels.ts`.
   */
  userAdded?: true
  /**
   * Whether this model is offered the `plan` tool — the checklist it keeps beside the chat.
   * Hand-set per row, never derived from the ratings columns (those move with every index version). `false`
   * removes the tool AND its prompt paragraph
   * for the run, and `execute.ts` refuses the name if the model guesses it anyway; a plan an earlier
   * model left behind stays readable but frozen. Absent = true (user-added rows and the default).
   *
   * The split follows the vendors' own judgement about their top models, not a measurement of ours:
   * Anthropic turned its task tools off for newer Claude models ("Claude keeps track of multi-step
   * work without a written checklist, and the tools' definitions and reminders take up context"), and
   * Codex made `update_plan` opt-in for everyone (CLI 0.152.0, 31.08.2026). MEASURED: GLM 5.3 Flash finished
   * the same task in fewer rounds and at lower cost with the list in both measured pairs (38 vs 57, 50 vs 62
   * rounds), while Sonnet 5.5 finished in 24 rounds without it and never lost the thread. The other rows of each
   * class are set by class, not by their own run — whoever measures one, records it there.
   */
  planTool?: boolean
  /**
   * Usable context in tokens, used to size history compaction. Only set where the figure is known
   * with confidence — an unset value falls back to a deliberately conservative default, because
   * guessing too HIGH re-introduces the mid-task context overflow this is meant to prevent.
   */
  contextTokens?: number
  /**
   * The reasoning-effort levels this model's API accepts (shared/aiDefaults.ts), in ascending order;
   * what the "Reasoning effort" setting offers beside "Default". Absent = the setting offers only the
   * default. Hand-set per row from the vendors' docs, see the ratings block above for the sources.
   */
  reasoningEfforts?: ReasoningEffort[]
}

/**
 * What OpenRouter's **Stealth Program** costs you, measured on Ox Alpha (2026-08-25/26) and kept
 * here because the next cloaked model will raise the same two questions. Its own entry is gone — the
 * endpoint began answering 404 mid-run on 2026-08-26 with "This model was ZAI's GLM-5.3 Flash", and
 * a dead id in the picker costs a paid run to discover.
 *
 * 1. **The provider keeps your prompts, and the ZDR switch does not stop it.** The per-model page
 *    said "retained by the provider and are not used for training" — retained, by a company whose
 *    identity is withheld. Unlike the `:free` endpoints that `data_collection: 'deny'` blocks
 *    outright (see Nemotron), a probe with that setting answered **200**. So Settings → AI offers no
 *    cover on a stealth endpoint, and a PrismLCA prompt can carry licensed ecoinvent data. The generic
 *    Stealth EULA (openrouter.ai/terms/stealth §1) describes collection "for use in Stealth Model
 *    training" while the per-model page was narrower — they are not the same document, and the next
 *    one has to be read again.
 * 2. **Web search works, and it is what you pay for.** PrismLCA's web tools are OpenRouter's own server
 *    tools and need nothing from the model but `tools` support. A probe answered from a live search
 *    with citations at **$0.007 for one web_search request — the search, not the inference, which
 *    was free.** That measurement is the whole of V244: a modelling run on the free endpoint billed
 *    0.217 $ while its report-writing calls billed nothing, and the difference was six
 *    `research_web` legs, booked against the model's name in `ai-usage.json`.
 */
/**
 * The catalogue as it is maintained — new entries go wherever they read best next to their
 * neighbours' comments. Nothing displays this order: {@link getModels} returns the sorted view,
 * and that is the only one exported.
 */
const CATALOGUE: AiModel[] = [
  {
    // Replaces Sonnet 5, at the same price.
    id: 'anthropic/claude-sonnet-5.5',
    label: 'Sonnet 5.5 (Claude)',
    descriptor: 'strong, mid price',
    temperature: null,
    intelligence: 54.5,
    vision: true,
    planTool: false,
    // A megatoken on all eight OpenRouter endpoints. It matters beyond display: `compactThreshold`
    // and the tool-result budget are both derived from this number, so an understated window
    // silently shortens every answer.
    contextTokens: 1000000,
    explicitCache: true,
    // Anthropic's effort levels through OpenRouter; `none` is answered with 400 and `minimal` is sent as low.
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh']
  },
  {
    // Replaces Opus 5, and is cheaper than it was ($4/$20 against $5/$25).
    id: 'anthropic/claude-opus-5.5',
    label: 'Opus 5.5 (Claude)',
    descriptor: 'top tier, upper-mid price',
    temperature: null,
    intelligence: 59.1,
    vision: true,
    planTool: false,
    contextTokens: 1000000,
    explicitCache: true,
    // Anthropic's effort levels through OpenRouter; `none` is answered with 400 and `minimal` is sent as low.
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh']
  },
  {
    // Replaces Fable 5.1: 64.6 against its 49.2, the highest score in the catalogue, and cheaper
    // than it was ($8/$40 against $10/$50). Four endpoints at that price — Anthropic, Azure, Bedrock,
    // Vertex — plus Anthropic's priority tier ("fast") at twice it, all paid (checked 2026-11-12).
    // None of them is zero-retention: Anthropic lists Fable 5.2 as a "Covered Model", whose prompts
    // are kept for 30 days on every surface it is offered on. So it answers only under the Anthropic
    // exception to the ZDR switch, as Fable 5.1 did (shared/aiDefaults.ts).
    id: 'anthropic/claude-fable-5.2',
    label: 'Fable 5.2 (Claude)',
    descriptor: 'highest intelligence score, premium price',
    temperature: null,
    intelligence: 64.6,
    vision: true,
    planTool: false,
    contextTokens: 1000000,
    explicitCache: true,
    // Anthropic's effort levels through OpenRouter; `none` is answered with 400 and `minimal` is sent as low.
    // OpenRouter also lists `max`, which our effort vocabulary does not have.
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh']
  },
  {
    // The cheapest price class ($0.10/$0.50, the same as GPT-6 Luna) at 36.5 — nine points
    // above Luna. Privacy as for the other Claude rows: Anthropic, Google, Azure and Bedrock
    // endpoints, all paid.
    id: 'anthropic/claude-haiku-5.5',
    label: 'Haiku 5.5 (Claude)',
    descriptor: 'cheapest, strongest at that price',
    // No `temperature` among its supported parameters, like the other 5.x Claude rows.
    temperature: null,
    intelligence: 36.5,
    vision: true,
    // On by class, not by vendor: Anthropic's "no checklist" judgement was about its top models, and
    // this row sits in the cheap tier with GPT-6 Luna and DeepSeek V4.1 Flash. Unmeasured, like its class.
    planTool: true,
    contextTokens: 1000000,
    explicitCache: true,
    // Anthropic's effort levels through OpenRouter; `none` is answered with 400 and `minimal` is sent as low.
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh']
  },
  {
    // OpenRouter, not the direct provider: the price arrives live there, and a `provider: 'openai'`
    // entry would have to carry it hand-maintained (see the block at the very top).
    id: 'openai/gpt-6-astra',
    label: 'GPT-6 Astra (OpenAI)',
    descriptor: 'top tier, priciest',
    temperature: null,
    // Above Sonnet 5.5, below Opus 5.5, Fable 5.2 and Gemini 4 Carbon — and still the priciest
    // row, at $10/$50.
    intelligence: 56.9,
    vision: true,
    planTool: false,
    contextTokens: 1050000,
    // The GPT-6 vocabulary minus `none`: Astra has no non-reasoning mode (requests asking for it are
    // moved to `low` by OpenRouter; the direct API answers 400).
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh']
    // No `explicitCache`: that applies only to Anthropic, OpenAI caches the prefix itself
    // (agent.test.ts checks exactly this — the entry had inherited it from its template).
  },
  {
    // Replaces Gemini 3.5 Flash. $0.825/$4.125 on OpenRouter (Google's own list price, which the
    // direct row carries, is $0.75/$3.75; checked 2026-11-12). Re-checked when Carbon went in:
    // still Google's newest Flash (released 2026-09-02; OpenRouter lists nothing later), so the row
    // stays. Privacy for all Google rows: only Google's own endpoints (Vertex, AI Studio), which log
    // prompts for abuse monitoring — hence the Google exception to the ZDR rule (shared/aiDefaults.ts).
    id: 'google/gemini-3.8-flash',
    label: 'Gemini 3.8 Flash (Google)',
    descriptor: 'fast, cheap',
    temperature: null,
    // AA's "(high)" row — its top effort for this model, and here also the best-scoring one.
    intelligence: 30.8,
    vision: true,
    planTool: true,
    // All six OpenRouter endpoints report 1,048,576.
    contextTokens: 1048576,
    // Gemini 3.x `thinking_level`; a level the model lacks is moved to the nearest one it has.
    reasoningEfforts: ['minimal', 'low', 'medium', 'high']
  },
  {
    // Google's previous flagship, at Sol's and Sonnet 5.5's price ($2/$10). Six OpenRouter endpoints,
    // all Google's own (Vertex, AI Studio, each also as flex/priority tier), all paid. Gemini 4 Carbon
    // below scores ten points more at the same price.
    id: 'google/gemini-4-argon',
    label: 'Gemini 4 Argon (Google)',
    descriptor: 'strong, mid price · Carbon scores higher',
    temperature: null,
    intelligence: 50.4,
    vision: true,
    // Off by class: the strong tier, with Sol and Sonnet 5.5. Unmeasured.
    planTool: false,
    // All six endpoints report 1,048,576.
    contextTokens: 1048576,
    // Reasoning is mandatory (no `none`/`minimal`); OpenRouter lists low | medium | high, default medium.
    reasoningEfforts: ['low', 'medium', 'high']
  },
  {
    // Google's newest flagship: 60 — above Opus 5.5, second only to Fable 5.2 — at Argon's price
    // ($2/$10). Seven endpoints, all Google's own and paid: Vertex (global, EU, US, global
    // priority) and AI Studio (standard, flex, priority). Privacy as for
    // the other Google rows.
    id: 'google/gemini-4-carbon',
    label: 'Gemini 4 Carbon (Google)',
    descriptor: 'top tier at mid price',
    temperature: null,
    // AA's "(High)" row, its top effort.
    intelligence: 60,
    vision: true,
    // Off by class: the top tier, with Fable 5.2, Opus 5.5 and Astra. Unmeasured.
    planTool: false,
    // All seven endpoints report 1,048,576.
    contextTokens: 1048576,
    // Same API as Argon: reasoning is mandatory, OpenRouter lists low | medium | high, default medium.
    reasoningEfforts: ['low', 'medium', 'high']
  },
  {
    // Replaces DeepSeek V4 Pro: under v4.3 the newer Flash out-scored the old Pro by three points
    // at a fraction of the price ($0.03/$0.50), and it takes images. Temperature follows DeepSeek's
    // V4 guidance (default 1.0; lowering it collapses the reasoning chain) — the V4.1 docs say
    // nothing new about it. It is also the writer's cheap fallback, the role Hy3 had.
    id: 'deepseek/deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    descriptor: 'very cheap · open weight',
    temperature: 1.0,
    // Not yet run on v5 (see the ratings block above).
    intelligence: null,
    vision: true,
    planTool: true,
    // Thirty-two OpenRouter endpoints, 1,000,000 to 1,048,576; the smallest is taken so the figure
    // holds whichever one routing picks (the convention the Kimi entry below states).
    contextTokens: 1000000,
    // DeepSeek V4 knows two levels; `low`/`medium` are quietly treated as high, so they are not offered.
    reasoningEfforts: ['high', 'xhigh']
  },
  {
    // Replaces GLM 5.2, which it beat on both counts. It is also the model behind the
    // review default below (research moved to GLM 5.3 Flash, with the chat
    // default) — so a swap moves it with it: a default naming a model the catalogue no
    // longer offers is a reference nobody can follow.
    id: 'z-ai/glm-5.3',
    label: 'GLM 5.3 (Z.AI)',
    descriptor: 'highest-rated open weight · very cheap',
    temperature: 1.0,
    intelligence: 31.7,
    vision: false,
    planTool: true,
    // 20 of 28 OpenRouter endpoints report 1,048,576; three fringe ones serve 262,144 and one
    // 1,310,720. The smallest would be a fivefold understatement here, so this follows the modal
    // value — the same figure the Flash sibling below already carries, for the same distribution.
    contextTokens: 1048576,
    // Z.AI: low | high | max, reasoning always on (`none` is an error); OpenRouter sends `xhigh` as max.
    reasoningEfforts: ['low', 'high', 'xhigh']
  },
  {
    id: 'moonshotai/kimi-k3',
    label: 'Kimi K3 (Moonshot)',
    descriptor: 'open weight · pricier output',
    temperature: null,
    // Not yet run on v5 (see the ratings block above).
    intelligence: null,
    vision: true,
    planTool: true,
    // Every one of OpenRouter's K3 endpoints reports 1,048,576 (a couple serve 1,000,000 / 974,842);
    // the smallest is taken so the figure holds whichever one routing picks. Without it the
    // conservative fallback applied — compaction at ~100k tokens for a model that holds ten times
    // that, which on a long study cuts the history in the middle of the work.
    contextTokens: 974842
  },
  {
    // MiniMax's newest, in place of M3: 29.1 against M3's 18.9, at a quarter of its price ($0.075/$0.30
    // against $0.30/$1.20), the same size (about 428B parameters, 23B active) and the same community
    // licence. Reads images: every endpoint takes multipart input. Eight of its eleven OpenRouter
    // endpoints are zero-retention — all but MiniMax's own, GMICloud and StreamLake (checked 2026-11-12).
    id: 'minimax/minimax-m3.1-flash',
    label: 'MiniMax M3.1 Flash',
    descriptor: 'very cheap · open weight',
    temperature: 1.0,
    intelligence: 29.1,
    vision: true,
    planTool: true,
    // Most endpoints report 1,048,576; StreamLake and inference.net serve 1,000,000, which is also
    // what the card states, so that is the figure taken.
    contextTokens: 1000000,
    // The card: low | medium | high | xhigh | max, reasoning always on. OpenRouter's default is max,
    // which "Default" keeps; our scale stops at xhigh.
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh']
  },
  {
    // The open weights of Qwen3.8 Max, in place of the Max row. `qwen/qwen3.8-max` is served by
    // Alibaba alone, and no Alibaba endpoint is zero-retention, so under the default privacy rule
    // that row answered 404 on every call. This id has four endpoints at the same price, $2/$6 —
    // Novita, Alibaba, SiliconFlow, Venice — three of them zero-retention (all but Alibaba; checked
    // 2026-11-12).
    //
    // What it gives up, per the model card: no image input, so no canvas screenshots, and no
    // non-thinking mode. Under v4.3 AA rated it level with the FIRST Max snapshot (39.9 against
    // 40.2), not with the 0902 one the Max alias serves now (45.4). Whoever wants the Max can add
    // `qwen/qwen3.8-max` under "Add model"; it only answers with the privacy switch off, since no
    // exception covers Qwen.
    id: 'qwen/qwen3.8-2.4t-a95b',
    label: 'Qwen3.8 2.4T A95B (Alibaba)',
    // Not "Qwen3.8 Max": in the picker that read as if this row were the Max itself.
    descriptor: 'open weight · mid price',
    // The card's own recommendation. Sent rather than omitted: with four hosts, an omitted value is
    // whatever each host's server defaults to, not Qwen's.
    temperature: 1.0,
    // Not yet run on v5 (see the ratings block above).
    intelligence: null,
    vision: false,
    planTool: true,
    // Novita and Alibaba 1,000,000, SiliconFlow 1,048,576 — and Venice 262,144, the model's native
    // window, which the card extends to 1,010,000. As with GLM 5.3, the one fringe endpoint
    // is not taken; the smallest of the rest is.
    contextTokens: 1000000,
    // The card: "supported levels are xhigh, medium, and low", xhigh by default; thinking is always on.
    reasoningEfforts: ['low', 'medium', 'xhigh']
  },
  {
    // Xiaomi's top model, added to the catalogue. Checked against the privacy defaults before it went in:
    // all three OpenRouter endpoints are paid (no training-on-prompts free tier for
    // `data_collection: 'deny'` to block), and DeepInfra serves it zero-retention, so the ZDR switch
    // leaves it reachable rather than answering 404. No vendor temperature could be found and it is
    // a reasoning model, so the parameter is omitted — the catalogue's reasoning-model rule.
    id: 'xiaomi/mimo-v2.6-pro',
    label: 'MiMo-V2.6-Pro (Xiaomi)',
    descriptor: 'open weight · very cheap',
    temperature: null,
    intelligence: 29.9,
    vision: true,
    planTool: true,
    // Three endpoints, 1,048,576 to 1,050,000; the smallest, per the convention above.
    contextTokens: 1048576
  },
  {
    // Tencent's Hy4, on OpenRouter since 2026-11-04 — the successor of the Hy3 that once held the
    // writer's fallback. 34.6, second only to Haiku 5.5 among the rows below the mid price, at
    // $0.42/$1.25, and it takes images. One endpoint, Tencent's own (fp4-quantised), which is on
    // OpenRouter's zero-retention list, so the ZDR switch leaves it reachable; an account that
    // excludes Tencent cannot reach it at all. The weights are announced but not yet published,
    // hence no "open weight". No vendor temperature is stated and it is a reasoning model, so the
    // parameter is omitted — the catalogue's reasoning-model rule.
    id: 'tencent/hy4',
    label: 'Hy4 (Tencent)',
    descriptor: 'solid, very cheap',
    temperature: null,
    intelligence: 34.6,
    vision: true,
    // On by class: the cheap tier, with Haiku 5.5, GPT-6 Luna and the GLM rows. Unmeasured.
    planTool: true,
    // The one endpoint reports 1,048,576.
    contextTokens: 1048576,
    // Reasoning is optional: OpenRouter lists none | low | high, default high.
    reasoningEfforts: ['none', 'low', 'high']
  },
  {
    // Mistral's open-weight frontier model (about 1T parameters, 49B active; Mistral Ecosystem Open
    // Weight Licence), $0.70/$2.10, reads images. Served by Mistral alone, through two OpenRouter
    // endpoints, both on the zero-retention list — `mistral/zdr` and `mistral/eu`, which runs in the EU
    // (checked 2026-11-12) — so the ZDR switch and the provider allowlist leave it reachable. No vendor
    // temperature is published and reasoning is always on, so the parameter is omitted — the catalogue's
    // reasoning-model rule.
    id: 'mistralai/mistral-large-4-0',
    label: 'Mistral Large 4',
    descriptor: 'European lab · open weight',
    temperature: null,
    // AA's "(High)" row, its top effort and Mistral's own recommendation.
    intelligence: 26.1,
    vision: true,
    // On by class: the open-weight tier, with the GLM, Kimi and MiniMax rows. Unmeasured.
    planTool: true,
    // `mistral/zdr` reports 1,048,576, `mistral/eu` 524,288; the smaller is taken so the figure holds
    // whichever one routing picks (the convention the Kimi entry states).
    contextTokens: 524288,
    // Mistral's ladder for Large 4 only: low | medium | high, default high; it takes no `none` or
    // `xhigh` (docs.mistral.ai, reasoning).
    reasoningEfforts: ['low', 'medium', 'high']
  },
  {
    // Ox Alpha, unmasked. It ran in OpenRouter's stealth programme until 2026-08-26, when the
    // endpoint began answering 404 mid-run with "This model was ZAI's GLM-5.3 Flash" — sixteen of
    // them inside one report run, which is why the retired id is gone rather than kept as an alias:
    // a dead model in the picker costs a paid run to discover.
    //
    // One number from its two live runs under the old name is worth carrying over: the stealth
    // endpoint billed 0.217 $ for a modelling run whose report-writing calls cost nothing, which was never
    // the model's own price — it was the web-search plugin inside `research_web`, booked against the model
    // (V244).
    //
    // Reasoning is mandatory and the vendor recommends effort "max", so temperature stays null — the
    // same choice as Kimi K3. Its full sibling GLM 5.3 above is the stronger of the two.
    id: 'z-ai/glm-5.3-flash',
    label: 'GLM 5.3 Flash (Z.AI)',
    descriptor: 'lowest price here · open weight',
    temperature: null,
    intelligence: 27.8,
    vision: true,
    planTool: true,
    contextTokens: 1048576,
    // Same API as its sibling above: low | high | max, never off.
    reasoningEfforts: ['low', 'high', 'xhigh']
  },
  {
    // The GPT-6 family through OpenRouter, alongside the direct-OpenAI rows further down: the same
    // models, reachable without a second key and with the price coming live instead of hand-kept.
    // GPT-6 Astra sits further up. There is no GPT-6 Terra — OpenAI's GPT-6 line is Astra, Sol and
    // Luna, and Sol is offered in its 6.1 revision (which replaced the GPT-5.6 rows).
    //
    // Both routes cost the same since the 6.x generation ($2/$10 and $0.10/$0.50, checked
    // 2026-10-01) — the half-price Sol on OpenRouter was a GPT-5.6 oddity. What still differs: the
    // direct route reports no `usage.cost`, so its ledger entries are computed from the hand-kept
    // table rather than billed.
    //
    // No `explicitCache`: only Anthropic takes a cache breakpoint from us (agent.test.ts holds it).
    id: 'openai/gpt-6.1-sol',
    label: 'GPT-6.1 Sol (OpenAI)',
    descriptor: 'strong, mid price (default)',
    temperature: null,
    intelligence: 54.6,
    vision: true,
    planTool: false,
    contextTokens: 1050000,
    // The full GPT-6 vocabulary; `none` answers without reasoning (not available on Astra).
    reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
  },
  {
    id: 'openai/gpt-6-luna',
    label: 'GPT-6 Luna (OpenAI)',
    descriptor: 'cheapest',
    temperature: null,
    intelligence: 27.9,
    vision: true,
    planTool: true,
    contextTokens: 1050000,
    reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
  },
  {
    // Speech-to-text only (voice input) — listed for cost transparency, no chat ratings apply.
    id: 'openai/whisper-large-v3',
    label: 'Whisper large-v3 (OpenAI)',
    descriptor: 'voice transcription',
    temperature: null,
    intelligence: null,
    vision: false,
    selectable: false
  },
  // The rows served by a vendor directly, with their hand-kept prices (directModels.ts).
  ...DIRECT_MODELS
]

/**
 * Display order for the pickers AND the settings table: **lab A→Z, then the strongest model of
 * that lab first.** Derived rather than hand-kept, so a new entry sorts itself in.
 *
 * Why not the order of the literal above: that was the order models happened to be ADDED, which
 * put GLM 5.3 five rows away from GLM 5.3 Flash and scattered every family.
 *
 * Why not plain alphabetical by label: it groups by accident of naming — Claude would sit at F, O
 * and S, and GLM would land beside GPT.
 *
 * Why not by `intelligence` alone, tempting as it is for a comparison table: that column moves
 * with every index version. v4.1.1 → v4.3 shifted every figure by roughly 14 points, which would
 * have reshuffled the whole list; nothing would sit twice where the reader left it. Grouping by
 * lab is stable, it makes the logo column read as blocks instead of confetti, and inside a family
 * "which Claude, which GPT" is exactly the question the strength answers.
 *
 * Unrated rows (`null`) go last within their own lab — Whisper closes the OpenAI block rather than
 * leaving it. `label` breaks any remaining tie so the order is deterministic across runs.
 */
function byLabThenStrength(a: AiModel, b: AiModel): number {
  const lab = labKey(a.id).localeCompare(labKey(b.id))
  if (lab !== 0) return lab
  const ai = a.intelligence ?? -Infinity
  const bi = b.intelligence ?? -Infinity
  if (ai !== bi) return bi - ai
  return a.label.localeCompare(b.label)
}

const BUILTIN_IDS = new Set(CATALOGUE.map((m) => m.id))
const SORTED_BUILTINS = [...CATALOGUE].sort(byLabThenStrength).map((m) => Object.freeze(m))

let _userModels: AiModel[] = []
let _userProblems: string[] = []
let _models: readonly AiModel[] = Object.freeze([...SORTED_BUILTINS])

/**
 * What PrismLCA refused in `models.json`, one line each — surfaced under the settings table.
 */
export function getUserModelProblems(): string[] {
  return _userProblems
}

/**
 * The catalogue this process runs on: the built-in list in display order, then the user's own
 * models. Every entry is frozen, and a change REPLACES the array rather than mutating it — a run
 * resolves its model once (agent.ts) and keeps that object for the whole turn, so an entry that
 * could change underneath it would rewrite a configuration already in flight.
 *
 * Adding or removing through Settings takes effect at once; that is safe because it only ever adds
 * or drops WHOLE entries. Nothing an in-flight run already holds is touched, and a dropped id
 * degrades the same way a stored id from the other provider always has.
 */
export function getModels(): readonly AiModel[] {
  return _models
}

/** Replace the user half of the catalogue. Called at startup and after an edit in Settings. */
export function setUserModels(load: { models: AiModel[]; problems: string[] }): void {
  _userModels = load.models
  _userProblems = load.problems
  _models = Object.freeze([...SORTED_BUILTINS, ..._userModels])
}

/** The user's own rows, for writing the file back. */
export function getUserModels(): AiModel[] {
  return _userModels
}

export { BUILTIN_IDS }

setUserModels(loadUserModelsFromUserData(BUILTIN_IDS))

/**
 * The catalogue this process runs on: the built-in list in display order, then the user's own
 * models. ONE immutable generation per process — the entries are frozen because `runAgent`
 * captures its model before the first await and reuses it across rounds, so an object that could
 * change afterwards would silently rewrite a configuration already in flight.
 */

// Re-exported so existing importers of models.ts keep working; the value itself is shared with
// the renderer (see src/shared/aiDefaults.ts).
export { DEFAULT_MODEL_ID }

type ProviderKey = AiProviderId

const providerOf = (m: AiModel): ProviderKey => m.provider ?? 'openrouter'

const defaultIdFor = (p: ProviderKey): string => defaultChatModelFor(p)

/** Does the catalogue offer this id under this provider? Used to sanitize STORED model choices when
 *  the active provider changes: a Sonnet-5 id under the OpenAI provider is not an error, it is a
 *  choice that is inactive there — it degrades to '' (= the role's default) instead of a 404. */
export function modelBelongsTo(id: string | undefined, p: ProviderKey): boolean {
  return !!id && getModels().some((m) => m.id === id && providerOf(m) === p)
}

/** A catalogue id that belongs to a DIRECT provider and not to OpenRouter — a choice made under
 *  another provider, which must not travel to OpenRouter as-is. */
export function isDirectOnlyId(id: string): boolean {
  return (
    (modelBelongsTo(id, 'anthropic') || modelBelongsTo(id, 'openai') || modelBelongsTo(id, 'google')) &&
    !modelBelongsTo(id, 'openrouter')
  )
}

/** The catalogue entry for this id UNDER THIS PROVIDER — an unknown id, or one belonging to the
 *  other provider, falls back to that provider's default rather than travelling to the wrong API. */
export function findModel(id: string | undefined, provider: ProviderKey = 'openrouter'): AiModel {
  return (
    getModels().find((m) => m.id === id && providerOf(m) === provider) ??
    getModels().find((m) => m.id === defaultIdFor(provider))!
  )
}

/**
 * The default model per JOB, per provider. On OpenRouter these are the ids that have carried the
 * sub-agents since GLM 5.3 replaced 5.2 (research/review) and the writer's cheap fallback; under
 * OpenAI the cheap tier (Luna) takes over all three cheap roles — same "inexpensive, solid
 * synthesis" reasoning, one family. The exported constants at the historic sites (RESEARCH_MODEL,
 * REVIEW_MODEL, FALLBACK_MODEL) are assigned FROM here, so the two can never drift. The context
 * summariser has no role here: it runs on the chat model (compactionSummary.ts, summariseDropped).
 */
export function providerDefaults(p: ProviderKey): {
  chat: string
  research: string
  review: string
  writerFallback: string
  /** The import matcher. GPT-6 Luna on both routes, measured on four real
   *  import sets against GLM 5.3 Flash: 219 flows in 123 s instead of 20 min and
   *  $0.03 instead of $0.23 at 173 against 177 placed; on the material inputs GLM returned "no usable
   *  answer" 58 times, Luna none; Creosol and AOX, which GLM booked wrongly, Luna left open. */
  match: string
} {
  if (p === 'openai')
    return {
      chat: DEFAULT_OPENAI_MODEL_ID,
      research: 'gpt-6-luna',
      review: 'gpt-6-luna',
      writerFallback: 'gpt-6-luna',
      match: 'gpt-6-luna'
    }
  // Under Google every role runs on 3.8 Flash: it is the cheap tier and the only chat model a
  // free-tier key reaches. The reviewer is therefore the same model as the researcher, which the
  // OpenRouter defaults avoid on purpose — accepted here because the Google list has no second cheap
  // model; whoever wants a different reviewer picks Argon under Settings → AI → Models. Unmeasured as
  // matcher (the OpenRouter/OpenAI choice was measured on four import sets); the first paid run says.
  // Under Anthropic the cheap roles go to Haiku 5.5, as they go to Luna under OpenAI: the cheapest
  // class, and Anthropic's strongest model at that price. The reviewer is therefore the researcher's
  // model, as under Google; Sonnet 5.5 is one pick away under Settings → AI → Models, at twenty times the
  // price. Unmeasured as matcher.
  if (p === 'anthropic')
    return {
      chat: DEFAULT_ANTHROPIC_MODEL_ID,
      research: 'claude-haiku-5-5',
      review: 'claude-haiku-5-5',
      writerFallback: 'claude-haiku-5-5',
      match: 'claude-haiku-5-5'
    }
  if (p === 'google')
    return {
      chat: DEFAULT_GOOGLE_MODEL_ID,
      research: 'gemini-3.8-flash',
      review: 'gemini-3.8-flash',
      writerFallback: 'gemini-3.8-flash',
      match: 'gemini-3.8-flash'
    }
  return {
    chat: DEFAULT_MODEL_ID,
    // Research on the Flash sibling: same lab and price class, chosen on its agentic score under
    // v4.3, 1M context — and the review deliberately stays on the NON-flash sibling, so the
    // reviewer is at least a different model than the researcher.
    research: 'z-ai/glm-5.3-flash',
    review: 'z-ai/glm-5.3',
    writerFallback: 'deepseek/deepseek-v4.1-flash',
    match: 'openai/gpt-6-luna'
  }
}
