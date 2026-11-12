/**
 * OpenRouter's public listings, as PrismLCA shows them: the price of each catalogue model under the
 * user's routing settings, the full model catalogue for "Add model", and the names of the hosts for the
 * allowlist editor. Every lookup here is asked only with an OpenRouter key (the IPC handlers check) and
 * kept for an hour; none of them carries anything from the user's work. The request transport, and the
 * routing state these lookups price against, are in openrouter.ts.
 */
import { allowlistMatches, PROVIDER_NAMES } from '../../../shared/providerAllowlist'
import { APP_HEADERS, BASE_URL, providerAllowlist, routingSignature, zdrForModel } from './openrouter'

const HOUR_MS = 3_600_000
/** A listing that came back incomplete is asked for again after a minute, not after the hour. */
const RETRY_MS = 60_000
/** Timeout for one lookup. Without it a stalled connection holds the settings table's first paint. */
const LOOKUP_TIMEOUT_MS = 4000
/** Per-model price lookups at once, and in all. `ai:models` awaits the prices before it returns any
 *  row; beyond the cap a row shows no price, which the table renders as a dash. */
const LOOKUP_CONCURRENCY = 8
const MAX_PRICE_LOOKUPS = 60
/** All price lookups together may take this long. A slow OpenRouter would otherwise hold the model
 *  table and the chat's model choice for many seconds; what has not answered by then shows no price and
 *  is asked again after a minute. */
const PRICING_DEADLINE_MS = 5000
let pricingDeadlineMs = PRICING_DEADLINE_MS

/** Test seam: a shorter deadline, so a test of a stalled OpenRouter need not wait five seconds. */
export function setPricingDeadlineForTests(ms: number = PRICING_DEADLINE_MS): void {
  pricingDeadlineMs = ms
}

type Price = { input: number; output: number }

const headersFor = (key: string | null): Record<string, string> =>
  key ? { Authorization: `Bearer ${key}`, ...APP_HEADERS } : APP_HEADERS

/** Run `fn` over `items`, at most `limit` at a time, results in input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * The price ($/1M tokens) of each model id, as routing may serve it under the user's settings: the
 * cheapest endpoint that the provider allowlist admits and — for a model whose requests carry `zdr` —
 * that retains nothing. Asked per model from `/models/{id}/endpoints`, so an alias that OpenRouter's
 * `/models` listing does not carry (`qwen/qwen3.8-max` answers, only `…-max-0902` is listed) is priced
 * as well.
 *
 * The listing's own figure is OpenRouter's cheapest endpoint across every host. With an allowlist that
 * figure belonged to a host the request may never reach — GLM 5.3 showed $0.07 per million input tokens
 * from a host off the list, where the cheapest allowed one asks $0.40. Flex-tier endpoints are left out
 * too: routing only uses them when a request asks for the `:floor` variant, and PrismLCA never does.
 *
 * No price — a dash in the table — means that no endpoint qualifies (the model would answer "no
 * endpoint"), or that its lookup failed. Pass only token-billed chat ids: the speech model is billed per
 * audio unit, which a column headed $/1M would misstate.
 */
let _priceCache: { ts: number; sig: string; asked: Set<string>; data: Record<string, Price> } = {
  ts: 0,
  sig: '',
  asked: new Set(),
  data: {}
}

/**
 * Drop the price cache. Called when the catalogue gains a model: the cache answers for the ids it was
 * asked for, and a model added through the dialog would otherwise show "–" until the hour was up —
 * which is what happened the first time the dialog was used against the running app.
 */
export function clearPriceCache(): void {
  _priceCache = { ts: 0, sig: '', asked: new Set(), data: {} }
}

export async function fetchOpenRouterPricing(
  ids: string[],
  key: string | null
): Promise<Record<string, Price>> {
  // The ids as they are priced — once each, at most the cap — so the cache is asked about exactly the set
  // it was filled for.
  const wanted = [...new Set(ids)].slice(0, MAX_PRICE_LOOKUPS)
  // The routing state, taken once before anything is awaited: a setting changed while the lookups run
  // must not mix two states into one answer, nor file it under the wrong signature.
  const sig = routingSignature()
  const only = providerAllowlist()
  const needsZdr = new Map(wanted.map((id) => [id, zdrForModel(id)]))
  // Valid only for the ids it was asked for and the settings it was filled under: a model added from
  // the dialog, or an allowlist edited on the Provider page, has to be priced again.
  if (
    _priceCache.sig === sig &&
    wanted.every((id) => _priceCache.asked.has(id)) &&
    Date.now() - _priceCache.ts < HOUR_MS
  )
    return _priceCache.data
  const headers = headersFor(key)
  const deadline = AbortSignal.timeout(pricingDeadlineMs)
  // The zero-retention endpoints, asked once for all models — only when some request would carry `zdr`.
  // null = not needed; undefined = needed and not to be had.
  const zdr = [...needsZdr.values()].some(Boolean) ? await fetchZdrEndpoints(headers, deadline) : null
  const looked = await mapLimit(wanted, LOOKUP_CONCURRENCY, async (id) => {
    // Without the ZDR listing a model whose requests carry `zdr` cannot be priced honestly: the cheapest
    // endpoint might be one its request is never sent to. No price, asked again in a minute.
    if (needsZdr.get(id) && !zdr) return 'failed' as const
    return fetchEndpointPricing(id, headers, deadline, (tag) => {
      if (only && !allowlistMatches(only, tag)) return false
      return !(needsZdr.get(id) && zdr && !zdr.has(`${id}\n${tag}`))
    })
  })
  const data: Record<string, Price> = {}
  wanted.forEach((id, i) => {
    const p = looked[i]
    if (p && p !== 'failed') data[id] = p
  })
  const complete = !looked.includes('failed')
  _priceCache = {
    ts: complete ? Date.now() : Date.now() - HOUR_MS + RETRY_MS,
    sig,
    asked: new Set(wanted),
    data
  }
  return data
}

/** `model_id\ntag` of every zero-retention endpoint, or undefined when the listing could not be had. */
async function fetchZdrEndpoints(
  headers: Record<string, string>,
  deadline: AbortSignal
): Promise<Set<string> | undefined> {
  try {
    const res = await fetch(`${BASE_URL}/endpoints/zdr`, {
      headers,
      signal: AbortSignal.any([AbortSignal.timeout(LOOKUP_TIMEOUT_MS), deadline])
    })
    if (!res.ok) return undefined
    const json = (await res.json()) as { data?: Array<{ model_id?: unknown; tag?: unknown }> }
    const out = new Set<string>()
    for (const e of json.data ?? [])
      if (typeof e.model_id === 'string' && typeof e.tag === 'string') out.add(`${e.model_id}\n${e.tag}`)
    return out
  } catch {
    return undefined
  }
}

/** The cheapest endpoint of one model that `admits`, null when none does, 'failed' when the lookup did. */
async function fetchEndpointPricing(
  id: string,
  headers: Record<string, string>,
  deadline: AbortSignal,
  admits: (tag: string) => boolean
): Promise<Price | null | 'failed'> {
  if (deadline.aborted) return 'failed'
  try {
    // Segment-encoded: this id can come from the user's own models.json. The loader's grammar
    // already refuses URL syntax, but a single door on a value that steers an authenticated
    // request is one door too few.
    const path = id.split('/').map(encodeURIComponent).join('/')
    const res = await fetch(`${BASE_URL}/models/${path}/endpoints`, {
      headers,
      signal: AbortSignal.any([AbortSignal.timeout(LOOKUP_TIMEOUT_MS), deadline])
    })
    // A 404 is an answer — the id has no page (a promo that ended); anything else is a failed lookup.
    if (res.status === 404) return null
    if (!res.ok) return 'failed'
    const json = (await res.json()) as {
      data?: {
        endpoints?: Array<{ tag?: unknown; service_tier?: unknown; pricing?: Record<string, string> }>
      }
    }
    const priced = (json.data?.endpoints ?? [])
      .filter((e) => typeof e.tag === 'string' && e.service_tier !== 'flex' && admits(e.tag))
      .map((e) => ({
        input: parseFloat(e.pricing?.prompt ?? '') * 1_000_000,
        output: parseFloat(e.pricing?.completion ?? '') * 1_000_000
      }))
      .filter((p) => Number.isFinite(p.input) && Number.isFinite(p.output))
    if (!priced.length) return null
    return priced.reduce((a, b) => (a.input + a.output <= b.input + b.output ? a : b))
  } catch {
    return 'failed'
  }
}

/**
 * Everything the "Add model" dialog needs about one OpenRouter model, in the shape it is shown.
 *
 * Assembled from two endpoints, both cached for the hour: `/models` for the listing, and
 * `/endpoints/zdr` for the one column a user cannot guess — whether the model can be served at all
 * under PrismLCA's privacy rule. Measured: sixteen of the eighteen catalogue models have a
 * zero-retention endpoint and two have none, so this is not a nicety, it is the difference between
 * a model that works and a 404 on first use.
 */
export interface OrCatalogueEntry {
  id: string
  name: string
  contextTokens: number | null
  vision: boolean
  pricing: { input: number; output: number } | null
  /** Has at least one zero-retention endpoint. `false` = unusable while the privacy rule is on;
   *  `null` = the ZDR listing could not be fetched, so nothing is known either way. */
  zdr: boolean | null
}

let _cat: { ts: number; rows: OrCatalogueEntry[] } = { ts: 0, rows: [] }

/** The full OpenRouter model list, for the picker. One hour of cache, like the prices. */
export async function fetchOpenRouterCatalogue(key: string | null): Promise<OrCatalogueEntry[]> {
  if (Date.now() - _cat.ts < HOUR_MS && _cat.rows.length) return _cat.rows
  const headers = headersFor(key)
  try {
    const [listRes, zdrRes] = await Promise.all([
      fetch(`${BASE_URL}/models`, { headers }),
      // Best effort: without it every row would claim "no ZDR", which is worse than saying nothing.
      fetch(`${BASE_URL}/endpoints/zdr`, { headers }).catch(() => null)
    ])
    if (!listRes.ok) return _cat.rows
    const list = (await listRes.json()) as {
      data: Array<{
        id: string
        name?: string
        context_length?: number
        top_provider?: { context_length?: number }
        architecture?: { input_modalities?: string[] }
        pricing?: Record<string, string>
      }>
    }
    const zdrIds = new Set<string>()
    let zdrKnown = false
    if (zdrRes?.ok) {
      const z = (await zdrRes.json()) as { data?: Array<{ model_id?: string }> }
      for (const e of z.data ?? []) if (e.model_id) zdrIds.add(e.model_id)
      zdrKnown = true
    }
    const rows = list.data.map((m) => {
      const input = parseFloat(m.pricing?.prompt ?? '') * 1_000_000
      const output = parseFloat(m.pricing?.completion ?? '') * 1_000_000
      return {
        id: m.id,
        name: m.name || m.id,
        // top_provider is the conservative figure — the catalogue's own convention (see the Kimi
        // entry in models.ts): the smallest window any serving endpoint offers.
        contextTokens: m.top_provider?.context_length ?? m.context_length ?? null,
        vision: (m.architecture?.input_modalities ?? []).includes('image'),
        pricing: Number.isFinite(input) && Number.isFinite(output) ? { input, output } : null,
        // Unknown stays unknown: a failed ZDR fetch used to mark every model "no ZDR" for an hour.
        zdr: zdrKnown ? zdrIds.has(m.id) : null
      }
    })
    rows.sort((a, b) => a.id.localeCompare(b.id))
    // Without the ZDR column the listing is served now but retried on the next call, not in an hour.
    _cat = { ts: zdrKnown ? Date.now() : Date.now() - HOUR_MS + RETRY_MS, rows }
    return rows
  } catch {
    return _cat.rows
  }
}

/** One host OpenRouter routes to, as the allowlist editor completes it. */
export interface OrProviderEntry {
  slug: string
  name: string
  /** Country code of the headquarters, where OpenRouter states one. */
  headquarters: string | null
}

let _providers: { ts: number; rows: OrProviderEntry[] } = { ts: 0, rows: [] }

/** Every host OpenRouter routes to, for completing a name in the allowlist editor — our spelling where
 *  we have one (PROVIDER_NAMES). An hour of cache; an empty answer leaves the editor without completion,
 *  and a slug typed in full is still taken. */
export async function fetchOpenRouterProviders(key: string | null): Promise<OrProviderEntry[]> {
  if (Date.now() - _providers.ts < HOUR_MS && _providers.rows.length) return _providers.rows
  try {
    const res = await fetch(`${BASE_URL}/providers`, {
      headers: headersFor(key),
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
    })
    if (!res.ok) return _providers.rows
    const json = (await res.json()) as {
      data?: Array<{ slug?: unknown; name?: unknown; headquarters?: unknown }>
    }
    const rows = (json.data ?? [])
      .filter(
        (p): p is { slug: string; name?: unknown; headquarters?: unknown } => typeof p.slug === 'string'
      )
      .map((p) => ({
        slug: p.slug,
        name:
          PROVIDER_NAMES[p.slug] ?? (typeof p.name === 'string' && p.name.trim() ? p.name.trim() : p.slug),
        headquarters: typeof p.headquarters === 'string' && p.headquarters ? p.headquarters : null
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug))
    _providers = { ts: Date.now(), rows }
    return rows
  } catch {
    return _providers.rows
  }
}
