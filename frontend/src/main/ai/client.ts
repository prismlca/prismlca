/**
 * The provider dispatcher: one `streamChat` for every caller, routed to the active provider's
 * transport (Settings → AI → Provider; module state in providers/state.ts, mirrored like
 * the ZDR flag, so a call deep inside an agent turn needs no path back to the renderer). Key
 * resolution and caching live here too — per provider, because all keys may be stored at once and
 * switching providers must never forget another one.
 *
 * The API key never reaches the renderer — it is read here in the main process only.
 */
import { resolve, type Provider } from '../secrets'
import { isDirectOnlyId, modelBelongsTo, providerDefaults } from './models'
import { anthropicTransport } from './providers/anthropic'
import { runChatStream } from './providers/engine'
import { googleTransport, transcribeGoogle } from './providers/google'
import { openaiTransport, transcribeOpenAi } from './providers/openai'
import { openrouterTransport, transcribeOpenRouter } from './providers/openrouter'
import { fetchOpenRouterPricing } from './providers/openrouterListings'
import { getActiveProvider } from './providers/state'
import {
  AiProviderError,
  type ChatTransport,
  type ProviderId,
  type ProviderReplay,
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
  anthropic: 'No Anthropic API key found — add one under Settings → AI → Provider.',
  openai: 'No OpenAI API key found — add one under Settings → AI → Provider.',
  google: 'No Google API key found — add one under Settings → AI → Provider.'
}

const TRANSPORTS: Record<ProviderId, ChatTransport<any>> = {
  openrouter: openrouterTransport,
  anthropic: anthropicTransport,
  openai: openaiTransport,
  google: googleTransport
}

/**
 * Last-resort guard on the model id, per provider. The call sites already resolve their defaults
 * provider-aware (findModel, providerDefaults) and ai/index.ts sanitizes stored choices, so this
 * firing means a straggler — but an id from another provider travelling to a direct API would 404 an
 * entire run over a stale setting, and that trade is never worth it. OpenRouter keeps today's
 * permissive pass-through (the eval harness sends ids the catalogue does not know on purpose).
 */
function requestModelFor(id: string, p: ProviderId): string {
  if (p === 'openrouter' && !isDirectOnlyId(id)) return id
  if (p !== 'openrouter' && modelBelongsTo(id, p)) return id
  const fallback = providerDefaults(p).chat
  console.warn(`[prism-ai] model "${id}" is not available under the ${p} provider — using ${fallback}`)
  return fallback
}

/** How often one call continues a reply the provider paused (Anthropic's `pause_turn`: a long turn of
 *  its server-side web search). Each continuation is a request of its own, billed as such. */
const MAX_CONTINUATIONS = 3

/**
 * Stream a chat completion via the active provider. Yields text deltas as they arrive, and (at the
 * end of a round) any assembled tool calls — see StreamEvent in providers/types.ts for the full
 * vocabulary and providers/engine.ts for the shared resilience mechanics.
 *
 * A paused reply is continued here, so no caller has to know the case: the transport reports the pause
 * as a `pause_turn` finish plus a replay without calls, and the paused content goes back as the last
 * assistant turn — the documented way on, and the one place an assistant turn may end a request. The
 * caller sees one reply with one usage report per request it took.
 */
export async function* streamChat(opts: StreamChatOpts): AsyncGenerator<StreamEvent> {
  const p = (opts.provider as ProviderId | undefined) ?? getActiveProvider()
  const key = getApiKey(p)
  if (!key) throw new AiProviderError(NO_KEY_MESSAGE[p], 'no_key')
  const model = requestModelFor(opts.model, p)
  let messages = opts.messages
  /** The paused passes' content so far. It is the front of the round: the caller stores it with the
   *  round's calls, or the next request would carry a search result without the search that asked. */
  let carried: unknown[] = []
  for (let hop = 0; ; hop++) {
    let pausing = false
    let paused: ProviderReplay | undefined
    for await (const ev of runChatStream(TRANSPORTS[p], { ...opts, model, messages }, key)) {
      if (ev.type === 'finish' && ev.reason === 'pause_turn') pausing = true
      else if (ev.type === 'tool_calls' && pausing && ev.calls.length === 0) paused = ev.replay
      else if (ev.type === 'tool_calls' && carried.length && ev.replay)
        yield { ...ev, replay: { ...ev.replay, steps: [...carried, ...ev.replay.steps] } }
      else yield ev
    }
    if (!pausing || opts.signal?.aborted) return
    // Each continuation is billed: none once the caller's spend ceiling has tripped.
    if (!paused || hop >= MAX_CONTINUATIONS || opts.budget?.aborted) {
      // Given up on a paused reply: what arrived stands, and the caller learns it is not the whole.
      yield { type: 'finish', reason: 'length' }
      return
    }
    carried = [...carried, ...paused.steps]
    messages = [...opts.messages, { role: 'assistant', content: null, replay: { ...paused, steps: carried } }]
  }
}

/** Transcribe a voice recording via the active provider (see providers/*.ts for the three endpoints —
 *  genuinely different wire formats AND models, which is why the ledger books what this returns). */
export async function transcribeAudio(
  opts: TranscribeOpts
): Promise<{ text: string; cost?: number; model: string }> {
  const p = getActiveProvider()
  const key = getApiKey(p)
  if (!key) throw new AiProviderError(NO_KEY_MESSAGE[p], 'no_key')
  // Anthropic has no speech-to-text model; the composer hides the microphone under it (providerCaps.ts),
  // so this only answers a stray call — never by sending the recording to another provider's key.
  if (p === 'anthropic')
    throw new AiProviderError(
      'Voice input is not available under Anthropic, which has no speech model.',
      'http'
    )
  if (p === 'openai') return transcribeOpenAi(opts, key)
  if (p === 'google') return transcribeGoogle(opts, key)
  return transcribeOpenRouter(opts, key)
}

/** Live pricing ($/1M tokens) for the given model ids. OpenRouter publishes its prices over the API;
 *  OpenAI and Google do not, so their catalogue entries carry hand-maintained list prices instead
 *  (see directModels.ts) and are never looked up here. */
export async function fetchPricing(
  ids: string[]
): Promise<Record<string, { input: number; output: number }>> {
  return fetchOpenRouterPricing(ids, getApiKey('openrouter'))
}
