/**
 * What each AI provider's API can do, in one table — read by the settings pages, the model picker,
 * the cost table, the key IPC and the agent instead of `provider === 'x'` checks spread over them.
 * Facts about an API, not preferences. Prose that EXPLAINS a difference (privacy terms, why a switch is
 * inert) stays where it is shown; the table decides only what is offered, enabled and named.
 *
 * `providerCaps.test.ts` holds the transports to it: a capability the table claims must show in the
 * request a transport builds, and one it denies must not.
 */
import type { AiProviderId } from './aiDefaults'

export interface ProviderCaps {
  /** The provider's name, as the pickers, tabs and hints say it. */
  name: string
  /** OpenRouter's routing knobs apply: the zero-retention filter with its vendor exceptions, and the
   *  speed preference. A direct API is one provider with nothing to route. */
  routing: boolean
  /** A per-reply ceiling on the provider's own web lookups exists (Settings → AI → Chat). */
  webLookupsCap: boolean
  /** The research legs' domain allow list is a real filter; without it the transport can only ask. */
  webDomainFilter: boolean
  /** Web search may run beside our function tools in the chat itself. Without it the chat reaches the
   *  web through the research tools only. */
  searchBesideTools: boolean
  /** Users may add their own models (models.json); a direct catalogue has no such door. */
  userModels: boolean
  /** Where prices come from: the provider's API, or list prices kept by hand (main/ai/directModels.ts). */
  pricing: 'live' | 'list'
  /** The backend needs this provider's key too (API embeddings). */
  backendKey: boolean
  /** The speech-to-text model, as Settings names it. */
  speechModel: string
  /** One web search as the research-model hint prices it. */
  searchPrice: string
}

/** The providers in the order every list shows them. */
export const AI_PROVIDERS: readonly AiProviderId[] = ['openrouter', 'openai', 'google']

export const PROVIDER_CAPS: Record<AiProviderId, ProviderCaps> = {
  openrouter: {
    name: 'OpenRouter',
    routing: true,
    webLookupsCap: true,
    webDomainFilter: true,
    searchBesideTools: true,
    userModels: true,
    pricing: 'live',
    backendKey: true,
    speechModel: 'OpenRouter (Whisper)',
    searchPrice: 'about $0.005 per search'
  },
  openai: {
    name: 'OpenAI',
    routing: false,
    webLookupsCap: true,
    webDomainFilter: true,
    searchBesideTools: true,
    userModels: false,
    pricing: 'list',
    backendKey: true,
    speechModel: 'OpenAI (gpt-transcribe)',
    searchPrice: 'about $0.01 per search'
  },
  google: {
    name: 'Google',
    routing: false,
    webLookupsCap: false,
    webDomainFilter: false,
    // A preview on Google's API, and a different tool-choice mode with it.
    searchBesideTools: false,
    userModels: false,
    pricing: 'list',
    // The backend has no Google embeddings; the key goes where it is used and nowhere else.
    backendKey: false,
    speechModel: 'Google (Gemini 3.5 Transcribe)',
    searchPrice: 'about $0.014 per search query, after 5,000 free a month'
  }
}

/** The names of the providers that have a capability, joined for a sentence ("OpenRouter and OpenAI"). */
export function providersWith(cap: keyof ProviderCaps): string {
  const names = AI_PROVIDERS.filter((p) => PROVIDER_CAPS[p][cap] === true).map((p) => PROVIDER_CAPS[p].name)
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}
