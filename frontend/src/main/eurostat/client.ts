/**
 * The HTTP side of the Eurostat lookups: one GET per slice, decoded from JSON-stat 2.0 into flat
 * rows, behind a TTL cache.
 *
 * The cache is the feature, not an optimisation: a chat about end-of-life asks for the same
 * country/dataset slice many times (once per material, once per scenario, once more after the user
 * asks "and for France?"), and the tables themselves change a handful of times a year. Keyed by the
 * full URL, so a different filter is a different entry; in-flight requests are shared, so two tool
 * calls in one round do not both hit the API.
 *
 * `fetchJson` is borrowed from main/distance — it is the app's one HTTP helper with a timeout and
 * a single retry on 429/5xx, and there is nothing distance-specific about it.
 */
import { fetchJson, type FetchJsonOpts } from '../distance/http'
import { EUROSTAT_API, EUROSTAT_CACHE_TTL_MS, type EurostatDataset } from './datasets'

/** JSON-stat 2.0, the parts we read. */
export interface JsonStat {
  version?: string
  class?: string
  label?: string
  source?: string
  updated?: string
  id: string[]
  size: number[]
  value: Record<string, number | null>
  status?: Record<string, string>
  dimension: Record<
    string,
    { label?: string; category: { index: Record<string, number>; label?: Record<string, string> } }
  >
  extension?: { status?: { label?: Record<string, string> } }
  error?: Array<{ status?: number; id?: number; label?: string }>
}

export interface Row {
  /** Dimension id → category code, e.g. { wst_oper: 'RCV_R', unit: 'PC', geo: 'DE', time: '2022' }. */
  codes: Record<string, string>
  value: number | null
  /** Eurostat's status string for the cell ('p', 'ep', 'b', 'c', 'm' …) or null. */
  status: string | null
}

export interface Decoded {
  label: string
  updated: string | null
  rows: Row[]
  /** Dimension id → (code → label), as the API spelled them. */
  labels: Record<string, Record<string, string>>
  /** Codes per dimension, in the API's order. */
  codes: Record<string, string[]>
  /** The labels the API gave for the status strings it used. */
  statusLabels: Record<string, string>
}

/** Flatten a JSON-stat cube: every cell (present or not) becomes a row with its codes. */
export function decodeJsonStat(d: JsonStat): Decoded {
  const ids = d.id
  const size = d.size
  const codes: Record<string, string[]> = {}
  const labels: Record<string, Record<string, string>> = {}
  for (const dim of ids) {
    const cat = d.dimension[dim]?.category
    const ordered = Object.entries(cat?.index ?? {})
      .sort((a, b) => a[1] - b[1])
      .map(([code]) => code)
    codes[dim] = ordered
    labels[dim] = cat?.label ?? {}
  }
  const total = size.reduce((a, b) => a * b, 1)
  const rows: Row[] = []
  // Row-major: the last dimension varies fastest (JSON-stat 2.0 §4.1).
  for (let n = 0; n < total; n++) {
    let rest = n
    const cell: Record<string, string> = {}
    for (let k = ids.length - 1; k >= 0; k--) {
      const s = size[k]
      const idx = rest % s
      rest = Math.floor(rest / s)
      cell[ids[k]] = codes[ids[k]][idx]
    }
    const key = String(n)
    const raw = d.value[key]
    rows.push({
      codes: cell,
      value: typeof raw === 'number' ? raw : null,
      status: d.status?.[key] ?? null
    })
  }
  return {
    label: d.label ?? '',
    updated: d.updated ?? null,
    rows,
    labels,
    codes,
    statusLabels: d.extension?.status?.label ?? {}
  }
}

export class EurostatError extends Error {
  constructor(
    message: string,
    public readonly status = 0
  ) {
    super(message)
  }
}

interface CacheEntry {
  at: number
  data: Promise<Decoded>
}

const cache = new Map<string, CacheEntry>()
const CACHE_MAX_ENTRIES = 300

/** Test hook — and what a future "clear cache" button would call. */
export function resetEurostatCache(): void {
  cache.clear()
}

export interface ClientOpts {
  fetchOpts?: FetchJsonOpts
  now?: () => number
  ttlMs?: number
}

/** The URL one slice is fetched from; exported so the tool can name it as the source. */
export function eurostatUrl(dataset: EurostatDataset, filters: Record<string, string>): string {
  const params = new URLSearchParams({ format: 'JSON', lang: 'EN' })
  for (const k of Object.keys(filters).sort()) params.set(k, filters[k])
  return `${EUROSTAT_API}/${dataset}?${params.toString()}`
}

/**
 * Fetch one slice, from the cache when it is fresh. Filters are Eurostat's dimension=code pairs plus
 * the API's own `lastTimePeriod`. A dimension whose code the API does not know comes back with
 * size 0 rather than an error — the caller reads that from `codes`.
 */
export async function fetchSlice(
  dataset: EurostatDataset,
  filters: Record<string, string>,
  opts: ClientOpts = {}
): Promise<Decoded> {
  const url = eurostatUrl(dataset, filters)
  const now = opts.now ?? Date.now
  const ttl = opts.ttlMs ?? EUROSTAT_CACHE_TTL_MS
  const hit = cache.get(url)
  if (hit && now() - hit.at < ttl) return hit.data
  const data = (async (): Promise<Decoded> => {
    let body: JsonStat
    try {
      body = (
        await fetchJson<JsonStat>(
          url,
          { method: 'GET', headers: { accept: 'application/json' } },
          {
            timeoutMs: 30_000,
            describeError: (status, b) => {
              const label = (b as JsonStat | null)?.error?.[0]?.label
              return label ? `Eurostat: ${label}` : `Eurostat answered HTTP ${status}.`
            },
            ...opts.fetchOpts
          }
        )
      ).data
    } catch (e) {
      throw new EurostatError(
        e instanceof Error ? e.message : String(e),
        (e as { status?: number })?.status ?? 0
      )
    }
    if (!body || !Array.isArray(body.id) || !Array.isArray(body.size) || !body.dimension)
      throw new EurostatError('Eurostat answered with something that is not a JSON-stat dataset.')
    return decodeJsonStat(body)
  })()
  // A failure must not be remembered for a day.
  data.catch(() => cache.delete(url))
  cache.set(url, { at: now(), data })
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return data
}
