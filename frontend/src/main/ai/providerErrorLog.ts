/**
 * What stays of a failed provider request once its message has left the screen: one log line, and a
 * short record on the answer the chat stores.
 *
 * The window shows the error once; without these, a run that ended after a second with a refusal left
 * `outcome: error` and nothing else, and why it failed could not be read again after a reload. Both
 * records are cut short and have anything that looks like a key masked: a provider's error text may
 * quote the credential it refused. The prompt never goes in — only the status and the provider's
 * (translated) words.
 */
import { aiWarn } from './aiLog'
import { AiProviderError, type ProviderId } from './providers/types'

/** How much of the provider's words the log line keeps. */
const LOG_CHARS = 300
/** How much the stored answer keeps. Status and the provider's words lead the record, so a cut takes
 *  the tail of a long explanation, not the reason. */
export const STORED_ERROR_CHARS = 600

/** Mask what looks like a credential: API keys of the known shapes, bearer tokens, key parameters. */
export function maskSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_*.-]{6,}/g, 'sk-…')
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, 'AIza…')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 …')
    .replace(/([?&](?:key|api_key|apikey|token)=)[^&\s"']+/gi, '$1…')
}

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** Quoted or JSON stretches longer than this are dropped from the log line. */
const QUOTE_CHARS = 40

/**
 * Drop what a provider quotes back from the request. A validation error may cite the value it
 * refused — a piece of a message, a tool's arguments — and the log is not the place for request
 * content. Field names, statuses and short values stay: they are what the line is read for. Only
 * straight double quotes, backticks and braces count — what a provider's JSON error quotes with; an
 * apostrophe is too often a word's, and typographic quotes are our own messages naming a setting.
 */
export function maskQuoted(text: string): string {
  const n = QUOTE_CHARS
  return text
    .replace(new RegExp(`"[^"]{${n},}"`, 'g'), '"…"')
    .replace(new RegExp(`\`[^\`]{${n},}\``, 'g'), '`…`')
    .replace(new RegExp(`\\{[^{}]{${n},}\\}`, 'g'), '{…}')
}

/** "HTTP 404", or the kind of failure where there was no status ("network", "stalled"). */
export function errorStatus(e: unknown): string {
  if (e instanceof AiProviderError) return typeof e.status === 'number' ? `HTTP ${e.status}` : e.code
  return 'error'
}

function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return maskSecrets(raw.replace(/\s+/g, ' ').trim())
}

/** The record kept on the stored answer: `<Status> — <Text>`. */
export function storedError(e: unknown): string {
  return cut(`${errorStatus(e)} — ${errorText(e)}`, STORED_ERROR_CHARS)
}

/** Errors already written — the loop may meet the same one twice (the round, then the run). */
const logged = new WeakSet<object>()

/** The text of the log line: cut short, keys and quoted request content masked. */
const logText = (e: unknown): string => cut(maskQuoted(errorText(e)), LOG_CHARS)

/**
 * A failed attempt the transport sends again (providers/engine.ts): the same record as a final
 * failure, plus the attempt and the wait. Not marked as logged — if the last attempt fails too, the
 * run's own line says so.
 */
export function logRetriedError(
  e: unknown,
  ctx: { transport: string; model: string; attempt: number; waitMs: number; detail: string }
): void {
  aiWarn(
    `provider error, retrying: ${ctx.transport} ${ctx.model} — ${errorStatus(e)} (${ctx.detail}) — ` +
      `${logText(e)} — attempt ${ctx.attempt}, next in ${ctx.waitMs} ms`
  )
}

/**
 * One line per failed request: provider, route, model, status, the provider's words. Said once per
 * error object, also when the loop recovers from it (a refused reasoning level, a context overflow).
 */
export function logProviderError(
  e: unknown,
  /** `servedBy`: the endpoint that answered the failed request itself, where it got that far. */
  ctx: { provider: ProviderId; model: string; servedBy?: string }
): void {
  if (typeof e === 'object' && e !== null) {
    if (logged.has(e)) return
    logged.add(e)
  }
  const route = ctx.provider === 'openrouter' && ctx.servedBy ? `openrouter/${ctx.servedBy}` : ctx.provider
  const kind = e instanceof AiProviderError ? 'provider error' : 'run error'
  aiWarn(`${kind}: ${route} ${ctx.model} — ${errorStatus(e)} — ${logText(e)}`)
}
