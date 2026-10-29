/**
 * The provider dispatcher: one `streamChat` for every caller, routed to the active provider's
 * transport (Settings → AI → Provider; module state in providers/state.ts, mirrored like
 * the ZDR flag, so a call deep inside an agent turn needs no path back to the renderer). Key
 * resolution and caching live here too — per provider, because both keys may be stored at once and
 * switching providers must never forget the other one.
 *
 * The API key never reaches the renderer — it is read here in the main process only.
 */
import { resolve, type Provider } from '../secrets'
import { modelBelongsTo, providerDefaults } from './models'
import { runChatStream } from './providers/engine'
import { openaiTransport, transcribeOpenAi } from './providers/openai'
import { fetchOpenRouterPricing, openrouterTransport, transcribeOpenRouter } from './providers/openrouter'
import { getActiveProvider } from './providers/state'
import {
  AiProviderError,
  type ChatTransport,
  type ProviderId,
  type StreamChatOpts,
  type StreamEvent,
  type TranscribeOpts
} from './providers/types'

// The mirror is set where settings are written (main/ai/index.ts); re-exported here so the façade
// (openrouter.ts) can keep offering the whole client surface from one import path.
export { getActiveProvider, setActiveProvider } from './providers/state'

/** Only FOUND keys are cached — a missing key is re-probed on each call, so dropping a key file into
 *  place starts working without an app restart. Entering one in Settings calls `resetApiKey()`. */
const _keys = new Map<Provider, string>()

/** The active provider's key by default (never bundled/logged). The resolution order lives in
 * `secrets.resolve()` — one order for the client and for what Settings displays, because two of them
 * meant a developer with a key in `.secrets/` had a working assistant and a panel insisting there
 * was no key. */
export function getApiKey(p: ProviderId = getActiveProvider()): string | null {
  const hit = _keys.get(p)
  if (hit !== undefined) return hit
  const { key } = resolve(p)
  if (key) {
    _keys.set(p, key)
    return key
  }
  return null
}

/** Forget the cached keys, so the next call re-resolves. Called when Settings stores or clears one. */
export function resetApiKey(): void {
  _keys.clear()
}

const NO_KEY_MESSAGE: Record<ProviderId, string> = {
  openrouter: 'No OpenRouter API key found — add one under Settings → AI → Provider.',
  openai: 'No OpenAI API key found — add one under Settings → AI → Provider.'
}

const TRANSPORTS: Record<ProviderId, ChatTransport<any>> = {
  openrouter: openrouterTransport,
  openai: openaiTransport
}

/**
 * Last-resort guard on the model id, per provider. The call sites already resolve their defaults
 * provider-aware (findModel, providerDefaults) and ai/index.ts sanitizes stored choices, so this
 * firing means a straggler — but a bare OpenRouter id travelling to api.openai.com would 404 an
 * entire run over a stale setting, and that trade is never worth it. OpenRouter keeps today's
 * permissive pass-through (the eval harness sends ids the catalogue does not know on purpose).
 */
function requestModelFor(id: string, p: ProviderId): string {
  if (p === 'openrouter' && !(modelBelongsTo(id, 'openai') && !modelBelongsTo(id, 'openrouter'))) return id
  if (p !== 'openrouter' && modelBelongsTo(id, p)) return id
  const fallback = providerDefaults(p).chat
  console.warn(`[prism-ai] model "${id}" is not available under the ${p} provider — using ${fallback}`)
  return fallback
}

/**
 * Stream a chat completion via the active provider. Yields text deltas as they arrive, and (at the
 * end of a round) any assembled tool calls — see StreamEvent in providers/types.ts for the full
 * vocabulary and providers/engine.ts for the shared resilience mechanics.
 */
export async function* streamChat(opts: StreamChatOpts): AsyncGenerator<StreamEvent> {
  const p = (opts.provider as ProviderId | undefined) ?? getActiveProvider()
  const key = getApiKey(p)
  if (!key) throw new AiProviderError(NO_KEY_MESSAGE[p], 'no_key')
  yield* runChatStream(TRANSPORTS[p], { ...opts, model: requestModelFor(opts.model, p) }, key)
}

/** Transcribe a voice recording via the active provider (see providers/*.ts for the two endpoints —
 *  genuinely different wire formats AND models, which is why the ledger books what this returns). */
export async function transcribeAudio(
  opts: TranscribeOpts
): Promise<{ text: string; cost?: number; model: string }> {
  const p = getActiveProvider()
  const key = getApiKey(p)
  if (!key) throw new AiProviderError(NO_KEY_MESSAGE[p], 'no_key')
  return p === 'openai' ? transcribeOpenAi(opts, key) : transcribeOpenRouter(opts, key)
}

/** Live pricing ($/1M tokens) for the given model ids. OpenRouter publishes its prices over the API;
 *  OpenAI does not, so OpenAI catalogue entries carry hand-maintained list prices instead
 *  (see models.ts) and are never looked up here. */
export async function fetchPricing(
  ids: string[]
): Promise<Record<string, { input: number; output: number }>> {
  return fetchOpenRouterPricing(ids, getApiKey('openrouter'))
}
