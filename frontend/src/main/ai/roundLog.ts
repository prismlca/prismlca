/**
 * One log line per model round of a chat run, for every provider, and the cache watch it feeds.
 *
 * The line says who served the round, how much of its prompt the provider's cache served, what it
 * cost, how long until the first token, how long the round took, how much it wrote and how fast. It is
 * written for every round, also one the cache did not serve — those are the rounds billed in full —
 * and names the route every time, because OpenRouter may switch endpoints within a run and speed,
 * price and cache belong to the endpoint, not to the model.
 *
 * It starts with "cache:" as the old line did, so a reader of older logs reads the new ones too. No
 * prompt text, no tool result, no key — figures and names only.
 */
import { aiLog, aiWarn } from './aiLog'
import { createCacheWatch, type CacheAlarm, type CacheSignal } from './cacheWatch'
import type { ProviderId } from './providers/types'

/** The usage figures of one request, as the stream's `usage` event carries them. */
export interface RoundUsage {
  cost?: number
  estimated?: boolean
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  cache_discount?: number
  generation_id?: string
}

export interface RoundFigures {
  /** 1-based round of the run. */
  round: number
  model: string
  provider: ProviderId
  /** Who answered: the routed endpoint on OpenRouter, the provider itself on a direct API. */
  servedBy?: string
  usage?: RoundUsage
  /** From the request (or its last re-send) to the first piece of the reply. Absent when nothing was
   *  streamed before the end — a round that only calls tools and shows no reasoning. */
  firstTokenMs?: number
  /** From the request (or its last re-send) to the end of the reply. */
  durationMs: number
  /** Characters the request carried — beside the provider's token count, it tells a real prompt from
   *  a misreported one. */
  sentChars?: number
  /** The provider-side web lookups of the round, in words. */
  web?: string
  /** Billed requests in the round, when more than one: a paused reply continued, a re-sent attempt. */
  requests?: number
  /** The round's request failed; the figures are what it got to before. */
  failed?: boolean
}

/**
 * Two usage reports of one round added up. A round can bill several requests — a reply the provider
 * paused and the transport continued, an attempt that failed after it streamed — and the line has to
 * cover all of them, or it shows the cost of the last one beside the duration of the whole.
 */
export function addUsage(a: RoundUsage | undefined, u: RoundUsage): RoundUsage {
  const add = (x?: number, y?: number): number | undefined =>
    typeof x === 'number' || typeof y === 'number' ? (x ?? 0) + (y ?? 0) : undefined
  const cached = add(a?.prompt_tokens_details?.cached_tokens, u.prompt_tokens_details?.cached_tokens)
  return {
    cost: add(a?.cost, u.cost),
    estimated: a?.estimated || u.estimated || undefined,
    prompt_tokens: add(a?.prompt_tokens, u.prompt_tokens),
    completion_tokens: add(a?.completion_tokens, u.completion_tokens),
    prompt_tokens_details: cached !== undefined ? { cached_tokens: cached } : undefined,
    cache_discount: add(a?.cache_discount, u.cache_discount),
    generation_id: u.generation_id ?? a?.generation_id
  }
}

/** Does a usage report carry any figure? The transport sends an empty one for a request it could
 *  not price (an aborted or failed stream). */
const hasFigures = (u: RoundUsage): boolean =>
  [u.cost, u.prompt_tokens, u.completion_tokens].some((x) => typeof x === 'number')

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

/** Output tokens per second of generation: from the first token on where that is known (the wait
 *  before it is the queue and the prompt, not the speed), else over the whole round. */
export function tokensPerSecond(
  f: Pick<RoundFigures, 'usage' | 'firstTokenMs' | 'durationMs'>
): number | null {
  const out = f.usage?.completion_tokens
  if (typeof out !== 'number' || out <= 0) return null
  const span = f.firstTokenMs !== undefined ? f.durationMs - f.firstTokenMs : f.durationMs
  const ms = span >= 250 ? span : f.durationMs
  return ms > 0 ? out / (ms / 1000) : null
}

/** The round's line, without stamp and tag. */
export function roundLine(f: RoundFigures): string {
  const u = f.usage ?? {}
  const parts: string[] = []
  if (typeof u.prompt_tokens === 'number' && u.prompt_tokens > 0) {
    // A provider that reports no cache figure served nothing from a cache we could see.
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0
    const pct = Math.round((cached / u.prompt_tokens) * 100)
    let cache = `cache: ${cached}/${u.prompt_tokens} prompt tokens (${pct}%)`
    if (typeof u.cache_discount === 'number') cache += `, saved $${u.cache_discount.toFixed(5)}`
    parts.push(cache)
  } else {
    parts.push('cache: no usage reported')
  }
  if (typeof u.cost === 'number')
    parts.push(
      `${u.estimated ? '≈' : ''}$${u.cost.toFixed(4)}` +
        (f.requests && f.requests > 1 ? ` for ${f.requests} requests` : '')
    )
  parts.push(`first token ${f.firstTokenMs !== undefined ? secs(f.firstTokenMs) : '—'}`)
  parts.push(`round ${secs(f.durationMs)}`)
  if (f.failed) parts.push('failed')
  if (typeof u.completion_tokens === 'number') {
    const tps = tokensPerSecond(f)
    parts.push(
      `${u.completion_tokens} out tokens` +
        (tps !== null ? `, ${tps >= 10 ? Math.round(tps) : tps.toFixed(1)} tok/s` : '')
    )
  }
  parts.push(
    f.provider === 'openrouter'
      ? `via OpenRouter/${f.servedBy ?? '?'}`
      : `via ${f.servedBy ?? f.provider} (direct)`
  )
  if (f.sentChars) parts.push(`sent ≈${Math.round(f.sentChars / 1000)}k chars`)
  if (u.generation_id) parts.push(`gen ${u.generation_id}`)
  if (f.web) parts.push(`web: ${f.web}`)
  return `${parts.join(', ')} — ${f.model} (round ${f.round})`
}

/** The warning line for a cache alarm, without stamp and tag. */
export function cacheAlarmLine(alarm: CacheAlarm, f: RoundFigures): string {
  const prompt = f.usage?.prompt_tokens ?? 0
  const cached = f.usage?.prompt_tokens_details?.cached_tokens ?? 0
  const route = f.provider === 'openrouter' ? `OpenRouter/${f.servedBy ?? '?'}` : (f.servedBy ?? f.provider)
  const what =
    alarm === 'dropped'
      ? `none of this round's ${prompt} prompt tokens came from the cache, although earlier rounds of the run did — billed in full`
      : `the cache has served the same ${cached} tokens for several rounds while the prompt grew to ${prompt} — the new part of every round is billed in full`
  return `cache warning: ${what} (via ${route}) — ${f.model} (round ${f.round})`
}

export interface RunTelemetry {
  /** A request of round `round` (0-based, as the loop counts) goes out now. */
  begin(round: number, sentChars: number): void
  /** The transport sends the same request again after a failed attempt. */
  resend(): void
  /** Part of the reply arrived: text or reasoning. */
  output(): void
  /** The stream named who serves it. */
  servedBy(name: string): void
  /** Who serves the request in flight, if its stream got far enough to say — for an error's log line. */
  servedNow(): string | undefined
  /** One request's usage; a round may report several (they are added up). */
  usage(u: RoundUsage, web?: string): void
  /** The round's stream is over — finished, broken off by the loop, or `failed`. Writes the line; a
   *  failed round is not read by the cache watch. */
  end(opts?: { failed?: boolean }): void
  /** The conversation was compacted: the cache watch starts over. */
  compacted(): void
}

export function createRunTelemetry(o: {
  model: string
  provider: ProviderId
  /** Called on every change of the cache's state — an alarm, and the round that ends it — so the run bar
   *  says what holds now rather than what once went wrong. */
  onCacheSignal?: (signal: CacheSignal) => void
  now?: () => number
}): RunTelemetry {
  const now = o.now ?? Date.now
  const watch = createCacheWatch()
  let lastEnd: number | undefined
  let cur:
    | {
        round: number
        sentChars: number
        start: number
        first?: number
        idleMs?: number
        servedBy?: string
        /** Usage of the current attempt (since the last re-send), all its requests added up. */
        usage?: RoundUsage
        /** What attempts before the last re-send cost — billed, but not part of its figures. */
        earlierCost: number
        requests: number
        web?: string
      }
    | undefined

  const output = (): void => {
    if (cur && cur.first === undefined) cur.first = now()
  }

  return {
    begin(round, sentChars) {
      const t = now()
      cur = {
        round: round + 1,
        sentChars,
        start: t,
        idleMs: lastEnd !== undefined ? t - lastEnd : undefined,
        earlierCost: 0,
        requests: 0
      }
    },
    resend() {
      if (!cur) return
      cur.start = now()
      cur.first = undefined
      cur.earlierCost += cur.usage?.cost ?? 0
      cur.usage = undefined
      // A long wait for the network counts towards the cache's expiry like any other pause.
      if (lastEnd !== undefined) cur.idleMs = cur.start - lastEnd
    },
    output,
    servedBy(name) {
      if (!cur) return
      cur.servedBy = name
      // OpenRouter's first chunk comes when the upstream starts to answer — the closest mark of the
      // first token it gives, also for a round that streams nothing but tool calls. A direct API names
      // itself when it opens the stream, before the model has written anything, so there it is not one.
      if (o.provider === 'openrouter') output()
    },
    servedNow: () => cur?.servedBy,
    usage(u, web) {
      if (!cur) return
      if (hasFigures(u)) cur.requests++
      cur.usage = addUsage(cur.usage, u)
      if (web) cur.web = cur.web ? `${cur.web}; ${web}` : web
    },
    end(opts) {
      if (!cur) return
      const t = now()
      const usage =
        cur.earlierCost > 0 ? { ...cur.usage, cost: (cur.usage?.cost ?? 0) + cur.earlierCost } : cur.usage
      const f: RoundFigures = {
        round: cur.round,
        model: o.model,
        provider: o.provider,
        servedBy: cur.servedBy,
        usage,
        requests: cur.requests,
        failed: opts?.failed,
        firstTokenMs: cur.first !== undefined ? cur.first - cur.start : undefined,
        durationMs: t - cur.start,
        sentChars: cur.sentChars,
        web: cur.web
      }
      const idleMs = cur.idleMs
      cur = undefined
      lastEnd = t
      aiLog(roundLine(f))
      const prompt = f.usage?.prompt_tokens
      if (f.failed || typeof prompt !== 'number' || prompt <= 0) return
      const alarm = watch.observe({
        prompt,
        cached: f.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        idleMs
      })
      if (!alarm) return
      if (alarm === 'recovered') aiLog(`cache working again — ${f.model} (round ${f.round})`)
      else aiWarn(cacheAlarmLine(alarm, f))
      o.onCacheSignal?.(alarm)
    },
    compacted() {
      watch.reset()
    }
  }
}
