/**
 * When a request that failed before any of its reply arrived is sent again, and after how long.
 *
 * The policy half of the engine's retry: which failures are worth another attempt, which of two clocks
 * they run on, and how long the next pause is. engine.ts keeps the request, the stream and the waiting;
 * this module knows no network, so every rule here is testable on its own.
 *
 * Two clocks, because the two failures last differently:
 * - `busy`: the provider answered and said not now (a rate limit, an overload, a server fault) or a
 *   connection to it failed. Overload waves last tens of seconds; three attempts within five seconds
 *   used to end a run inside one.
 * - `offline`: this computer has no path to the provider at all: its name does not resolve, or there is
 *   no route. A Wi-Fi change, a VPN reconnecting, a router restart; it lasts as long as it lasts.
 *
 * Each window is counted on the wall clock from the first failure of its kind, request time included, and
 * the two are kept apart, so a flaky link does not spend the overload allowance and the other way round.
 * A pause that would end past its window is not taken: the error goes to the caller instead.
 */
import type { ProviderErrorCode, RetryCause, RetryWindows } from './types'

/** For every caller: two minutes of patience for either kind of failure. Helpers that show no countdown
 *  (research legs, report lanes, the history summariser) never wait longer than this, unseen. */
export const DEFAULT_WINDOWS: RetryWindows = { busyMs: 120_000, offlineMs: 120_000 }

/** The chat's own rounds wait out a lost network for longer: the run bar counts the wait down, and Stop
 *  ends it at any moment. Past a quarter of an hour, "no connection" is the more honest answer. */
export const CHAT_OFFLINE_MS = 15 * 60_000

/** The first pause; each further one doubles, up to the cap of its kind. */
const BASE_MS = 2_000
const CAP_MS: Record<RetryCause, number> = { busy: 20_000, offline: 30_000 }

/** A random share added to every pause. Parallel requests that hit one rate limit together (research
 *  legs, report lanes) would otherwise come back in the same instant and hit it again together. */
export const JITTER_MS = 750

/** Attempts of the busy kind in all, the first one included: a provider that has refused ten times in two
 *  minutes is not going to answer the eleventh. */
const MAX_BUSY_ATTEMPTS = 10

/** How late a pause may end and its attempt still start: timers fire a little after their time. A pause
 *  that ends much later — the computer slept through it — has outlived its window. */
const LATE_MS = 1_000

/** The longest `Retry-After` honoured. A provider asking for longer is one to give up on, not to sleep
 *  behind, and asking earlier than it said only collects another refusal. */
export const RETRY_AFTER_MAX_MS = 60_000

/** Codes that say this computer reached no one: the name did not resolve, or no route leads there. */
const OFFLINE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN'])

/** Certificate and TLS failures: the same on every attempt (a proxy that intercepts TLS, a clock far
 *  off), so they fail at once instead of after two minutes of trying. */
const TLS_CODE =
  /^(CERT_|ERR_TLS_|ERR_SSL_)|^(UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?)$/

/**
 * Every error code a failed `fetch` carries, however deeply it is nested. Node's fetch throws
 * `TypeError('fetch failed')` with the socket's error as `cause`; a host with several addresses fails as an
 * `AggregateError` whose `errors` hold one failure per address. Bounded in depth and safe against cycles.
 */
export function errorCodes(e: unknown): string[] {
  const codes: string[] = []
  const seen = new Set<object>()
  const walk = (x: unknown, depth: number): void => {
    if (!x || typeof x !== 'object' || seen.has(x) || depth > 5) return
    seen.add(x)
    const o = x as { code?: unknown; cause?: unknown; errors?: unknown }
    if (typeof o.code === 'string') codes.push(o.code)
    walk(o.cause, depth + 1)
    if (Array.isArray(o.errors)) for (const inner of o.errors) walk(inner, depth + 1)
  }
  walk(e, 0)
  return codes
}

/** The certificate or TLS code a failed `fetch` carries, if any: such a failure needs its own words, since
 *  "check your internet connection" sends the user to the wrong place. */
export function tlsFailure(e: unknown): string | undefined {
  return errorCodes(e).find((c) => TLS_CODE.test(c))
}

/**
 * What a `fetch` that threw is worth: a wait for the network, another attempt, or nothing (null), when
 * sending it again cannot change the answer.
 *
 * Offline only when every code found says so. A connect timeout or a mix (one address unreachable,
 * another timing out) cannot tell a dead uplink from a slow host, so it counts as busy: two minutes
 * cover a short VPN blip either way. A TypeError other than "fetch failed" is a request that never left
 * (a malformed URL or header), the same every time.
 */
export function classifyFetchFailure(e: unknown): { cause: RetryCause; detail: string } | null {
  const codes = errorCodes(e)
  if (tlsFailure(e)) return null
  if (e instanceof TypeError && e.message !== 'fetch failed') return null
  if (codes.length && codes.every((c) => OFFLINE_CODES.has(c)))
    return { cause: 'offline', detail: 'no connection' }
  return { cause: 'busy', detail: 'connection failed' }
}

/** A refused request's status in a few words, for the run bar and the log. */
export function statusDetail(status: number): string {
  if (status === 429) return 'rate limit (429)'
  if (status === 529) return 'overloaded (529)'
  if (status === 503) return 'unavailable (503)'
  if (status === 408) return 'timeout (408)'
  if (status >= 500) return `server error (${status})`
  return `HTTP ${status}`
}

/** The same for a failure the provider reported inside a stream it had accepted. */
export function streamFailureDetail(code: ProviderErrorCode, message: string): string {
  if (/overload/i.test(message)) return 'overloaded'
  if (code === 'rate_limit') return 'rate limit'
  if (code === 'network') return 'connection dropped'
  return 'provider error'
}

/**
 * The retry state of one request. `next` answers with the pause before the next attempt, or null when
 * this kind of failure has had its time; a null leaves the state as it was. `stillOpen` is asked again
 * when the pause is over, because a pause can end long after it was due.
 */
export class RetryClock {
  private readonly windows: RetryWindows
  private readonly first: Partial<Record<RetryCause, number>> = {}
  private readonly retries: Record<RetryCause, number> = { busy: 0, offline: 0 }

  constructor(
    windows: Partial<RetryWindows> = {},
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random
  ) {
    this.windows = { ...DEFAULT_WINDOWS, ...windows }
  }

  /** `retryAfterMs` is the provider's own figure (`Retry-After`), which replaces our curve. */
  next(cause: RetryCause, retryAfterMs: number | null = null): number | null {
    const t = this.now()
    const first = this.first[cause] ?? t
    const n = this.retries[cause]
    if (cause === 'busy' && n + 1 >= MAX_BUSY_ATTEMPTS) return null
    if (retryAfterMs !== null && retryAfterMs > RETRY_AFTER_MAX_MS) return null
    const curve = Math.min(BASE_MS * 2 ** n, CAP_MS[cause])
    const pause = Math.round((retryAfterMs ?? curve) + this.random() * JITTER_MS)
    if (t + pause - first > this.window(cause)) return null
    this.first[cause] = first
    this.retries[cause] = n + 1
    return pause
  }

  /** Whether an attempt of this kind may still start now: a laptop that slept through the pause wakes
   *  past the window, and the request it would send is one nobody is waiting for any more. */
  stillOpen(cause: RetryCause): boolean {
    const first = this.first[cause]
    return first === undefined || this.now() - first <= this.window(cause) + LATE_MS
  }

  private window(cause: RetryCause): number {
    return cause === 'busy' ? this.windows.busyMs : this.windows.offlineMs
  }
}
