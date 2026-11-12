/**
 * The OpenRouter provider allowlist: which hosts may serve a model request while
 * Settings → AI → Provider → "Only use providers from the allowlist" is on.
 *
 * Why a list at all: OpenRouter serves the same open model from many hosts, and the hosts differ in
 * ways that only show in long agent runs — the same model with the same prompt lost required tool
 * arguments on one host in three runs out of three and on another in none. Auto Exacto (OpenRouter's
 * own quality routing for tool calls) only reorders hosts, it never removes one.
 *
 * Stored as the user's DIFFERENCE from our default, not as a copy of it: `added` and `removed`. A copy
 * written on first use would freeze our list of that day on every installation — a host we take off
 * later would stay allowed, and one we add would never arrive. With the difference, an installation
 * that never touched the list always runs on the current default, and one that did keeps exactly its
 * own decisions on top of it. Reset clears both.
 *
 * Slugs are OpenRouter's provider slugs (`deepinfra`, `google-vertex`). A base slug matches every
 * variant and region of that host; a full one (`deepinfra/fp8`) narrows to that endpoint.
 */

/**
 * Our default: the labs and large clouds that carry Claude, GPT and Gemini, the labs of the open
 * models, and the established inference hosts with clean measurements — less those our own runs
 * showed breaking tool calls. Each entry is an OpenRouter provider slug, checked against
 * GET /api/v1/providers.
 */
export const DEFAULT_PROVIDER_ALLOWLIST: readonly string[] = [
  // Labs and large clouds
  'anthropic',
  'claude-on-aws',
  'openai',
  'azure',
  'amazon-bedrock',
  'google-vertex',
  'google-ai-studio',
  'z-ai',
  'moonshotai',
  'tencent',
  'minimax',
  'xiaomi',
  // Established inference hosts
  'deepinfra',
  'fireworks',
  'together',
  'baseten',
  'novita',
  'crusoe',
  'modal',
  'nebius',
  'mistral',
  'digitalocean',
  'cloudflare',
  'primeintellect'
]

/**
 * How the allowlist editor names a host, where we know better than a slug: every default entry, so the
 * list reads well without an OpenRouter key, and in our spelling where OpenRouter's misleads — its
 * listing calls Vertex AI just "Google", which beside "Google AI Studio" read as if Vertex were missing.
 * With a key, the editor completes from OpenRouter's own listing and these names win over it.
 */
export const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  'claude-on-aws': 'Claude Platform on AWS',
  openai: 'OpenAI',
  azure: 'Azure',
  'amazon-bedrock': 'Amazon Bedrock',
  'google-vertex': 'Google Vertex',
  'google-ai-studio': 'Google AI Studio',
  'z-ai': 'Z.AI',
  moonshotai: 'Moonshot AI',
  tencent: 'Tencent',
  minimax: 'MiniMax',
  xiaomi: 'Xiaomi',
  deepinfra: 'DeepInfra',
  fireworks: 'Fireworks',
  together: 'Together',
  baseten: 'Baseten',
  novita: 'Novita',
  crusoe: 'Crusoe',
  modal: 'Modal',
  nebius: 'Nebius',
  mistral: 'Mistral',
  digitalocean: 'DigitalOcean',
  cloudflare: 'Cloudflare',
  primeintellect: 'Prime Intellect'
}

export const DEFAULT_PROVIDER_ALLOWLIST_ON = true

/** What "Reset defaults" writes — and the global "Reset AI settings" with it. */
export const PROVIDER_ALLOWLIST_RESET = {
  providerAllowlistOn: DEFAULT_PROVIDER_ALLOWLIST_ON,
  providerAllowlistAdded: [] as string[],
  providerAllowlistRemoved: [] as string[]
}

/** More than OpenRouter has hosts; a hand-edited file cannot grow the request without bound. */
const MAX_ENTRIES = 200
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9._-]{1,64}){0,3}$/

/** A typed or stored slug in its canonical form, or '' when it is not one. */
export function normaliseSlug(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const s = raw.trim().toLowerCase()
  return SLUG.test(s) ? s : ''
}

/** A stored list as the file may hold it: every entry checked, duplicates dropped, capped. */
export function sanitiseSlugList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    const s = normaliseSlug(v)
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= MAX_ENTRIES) break
  }
  return out
}

export interface AllowlistDelta {
  added: string[]
  removed: string[]
}

/** The list in force: our default without what the user removed, then what the user added.
 *  `defaults` is a parameter for the test that plays a later release's default against a stored delta. */
export function effectiveAllowlist(
  delta: AllowlistDelta,
  defaults: readonly string[] = DEFAULT_PROVIDER_ALLOWLIST
): string[] {
  const removed = new Set(delta.removed)
  const out = defaults.filter((s) => !removed.has(s))
  for (const s of delta.added) if (!out.includes(s)) out.push(s)
  return out
}

/** Allow one more host. A default entry the user had removed comes back by leaving `removed`. */
export function addToAllowlist(delta: AllowlistDelta, raw: string): AllowlistDelta {
  const slug = normaliseSlug(raw)
  if (!slug) return delta
  if (DEFAULT_PROVIDER_ALLOWLIST.includes(slug)) {
    return { added: delta.added.filter((s) => s !== slug), removed: delta.removed.filter((s) => s !== slug) }
  }
  return delta.added.includes(slug) ? delta : { added: [...delta.added, slug], removed: delta.removed }
}

/** Take one host off. A default entry is remembered as removed; an added one is simply dropped. */
export function removeFromAllowlist(delta: AllowlistDelta, slug: string): AllowlistDelta {
  const added = delta.added.filter((s) => s !== slug)
  if (!DEFAULT_PROVIDER_ALLOWLIST.includes(slug)) return { added, removed: delta.removed }
  return { added, removed: delta.removed.includes(slug) ? delta.removed : [...delta.removed, slug] }
}

/** Has the user changed anything about the list or the switch? Drives the Reset button's state. */
export function allowlistIsDefault(on: boolean, delta: AllowlistDelta): boolean {
  return on === DEFAULT_PROVIDER_ALLOWLIST_ON && !delta.added.length && !delta.removed.length
}

/**
 * May an endpoint (`deepinfra/fp8/priority`) serve a request with this allowlist? OpenRouter's rule for
 * `only`: a slug matches itself and every endpoint below it — `deepinfra` all of DeepInfra's variants and
 * regions, `deepinfra/fp8` only that variant.
 */
export function allowlistMatches(list: readonly string[], endpointTag: string): boolean {
  return list.some((s) => endpointTag === s || endpointTag.startsWith(`${s}/`))
}
