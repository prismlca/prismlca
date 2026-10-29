/**
 * The HTTP side of the distance lookups — the first non-LLM external client in the app.
 *
 * Two things a bare `fetch` does not give us and both matter here: a bound on how fast we hit a
 * rate-limited free plan (openrouteservice allows 40 routing and 100 geocoding requests a minute, and
 * a ten-pair batch under `Promise.all` would send thirty at once), and a bound on how long one call
 * may hang. Retry is deliberately modest: one more attempt on 429/5xx, honouring `Retry-After`
 * (capped — a user is waiting on the other side of this, not a report writer).
 */

export class DistanceHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string
  ) {
    super(message)
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A gate that admits at most `perMinute` starts in any sliding 60-second window and at most
 * `concurrency` calls in flight. One instance per rate-limited endpoint (module state, like the
 * provider transports): two tool calls running in the same round share it, which is the point.
 */
export class RateGate {
  private starts: number[] = []
  private inFlight = 0
  private waiters: Array<() => void> = []

  constructor(
    public readonly perMinute: number,
    public readonly concurrency: number,
    private readonly now: () => number = () => Date.now()
  ) {}

  private prune(t: number): void {
    while (this.starts.length && t - this.starts[0] >= 60_000) this.starts.shift()
  }

  private async admit(): Promise<void> {
    for (;;) {
      const t = this.now()
      this.prune(t)
      if (this.inFlight < this.concurrency && this.starts.length < this.perMinute) {
        this.inFlight += 1
        this.starts.push(t)
        return
      }
      if (this.inFlight >= this.concurrency) {
        await new Promise<void>((resolve) => this.waiters.push(resolve))
      } else {
        await wait(Math.max(50, 60_000 - (t - this.starts[0])))
      }
    }
  }

  private release(): void {
    this.inFlight -= 1
    const next = this.waiters.shift()
    if (next) next()
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.admit()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

export interface FetchJsonOpts {
  timeoutMs?: number
  /** Turn a non-2xx body into the sentence the user sees; falls back to the status line. */
  describeError?: (status: number, body: unknown) => string | undefined
  fetchImpl?: typeof fetch
  /** Called before EVERY attempt: a retry is a second request, and the quota and the ledger have to
   *  see it — counted once per fetchJson they missed every retried call. */
  onAttempt?: () => void
  /** The caller's stop: a chat run that is stopped stops the geocoding it started. */
  signal?: AbortSignal
  /** Refuse a body larger than this many bytes — by its Content-Length, or while it streams in —
   *  with a `DistanceHttpError` coded 'too_large' (not retried). Unset = no limit. */
  maxBytes?: number
}

/** The body as text, stopped the moment it passes `maxBytes`. A body that claims (or turns out) to be
 *  bigger is refused rather than read: whatever parses it runs synchronously afterwards. */
async function readText(res: Response, maxBytes?: number): Promise<string> {
  if (!maxBytes) return await res.text()
  const tooLarge = (): DistanceHttpError =>
    new DistanceHttpError('Response too large.', res.status, 'too_large')
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    void res.body?.cancel().catch(() => {})
    throw tooLarge()
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(all)
}

/** A fetch error with the request's header values blanked out. undici's header validation quotes the
 *  offending value in full — for an Authorization header that is the API key, and the sentence went
 *  on into the tool result and the chat. */
function scrub(message: string, init: RequestInit): string {
  let out = message
  const headers = init.headers
  const values: string[] = []
  if (headers instanceof Headers) headers.forEach((v) => values.push(v))
  else if (Array.isArray(headers)) for (const [, v] of headers) values.push(String(v))
  else if (headers) for (const v of Object.values(headers)) values.push(String(v))
  for (const v of values) {
    const s = v.trim()
    if (s.length >= 8 && out.includes(s)) out = out.split(s).join('[redacted]')
  }
  return out
}

const RETRY_AFTER_CAP_MS = 10_000

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after')
  if (!raw) return null
  const seconds = Number(raw)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now()
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, RETRY_AFTER_CAP_MS) : null
}

/** GET/POST JSON with a timeout and one retry on 429/5xx. Throws `DistanceHttpError`. */
export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit,
  opts: FetchJsonOpts = {}
): Promise<{ data: T; headers: Headers }> {
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 15_000
  let lastError: DistanceHttpError | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    if (opts.signal?.aborted) throw new DistanceHttpError('Stopped.', 0, 'aborted')
    opts.onAttempt?.()
    const ctrl = new AbortController()
    const stop = (): void => ctrl.abort()
    opts.signal?.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    let res: Response
    let text: string
    try {
      res = await doFetch(url, { ...init, signal: ctrl.signal })
      // Inside the timeout, not after it: the headers can arrive at once and the body never — the
      // 6/15/30 s limits ended at the headers and a slow body held a gate slot for as long as it liked.
      text = await readText(res, opts.maxBytes)
    } catch (err) {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', stop)
      // Too large is an answer, not a hiccup: asking again would only fetch the same body again.
      if (err instanceof DistanceHttpError && err.code === 'too_large') throw err
      if (opts.signal?.aborted) throw new DistanceHttpError('Stopped.', 0, 'aborted')
      const aborted = err instanceof Error && err.name === 'AbortError'
      lastError = new DistanceHttpError(
        aborted
          ? `No answer within ${Math.round(timeoutMs / 1000)} s.`
          : `Network error: ${scrub((err as Error).message, init)}`,
        0
      )
      if (attempt === 0) {
        await wait(1_000)
        continue
      }
      throw lastError
    }
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', stop)
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    if (res.ok) return { data: body as T, headers: res.headers }
    const described = opts.describeError?.(res.status, body)
    lastError = new DistanceHttpError(described ?? `HTTP ${res.status}`, res.status)
    const retryable = res.status === 429 || res.status >= 500
    if (retryable && attempt === 0) {
      await wait(retryAfterMs(res) ?? 1_500)
      continue
    }
    throw lastError
  }
  throw lastError ?? new DistanceHttpError('Request failed.', 0)
}
