/**
 * The one reading of a backend error response — shared by the three paths that talk to the backend.
 *
 * There used to be three hand-written unwrappers, and they had drifted into three dialects: the
 * agent's kept the FastAPI validation detail and the hint but dropped the error code; the report
 * writer's (`backendApi`) kept only message and hint, so a 422 reached a paid chapter run as a bare
 * "HTTP 422" with the field names thrown away; the renderer's `ApiError` was the only one that kept
 * `.code`. This module is the superset, so every caller gets everything the backend said.
 *
 * Shared-module constraints apply (see aiDefaults.ts): pure values and classes only — no Node, no
 * DOM, no Electron.
 */

/** Error thrown for a backend 4xx/5xx; `.code` carries the backend PrismError code
 *  (e.g. 'calc_superseded'), `.status` the HTTP status, `.details` the structured facts some errors
 *  add for a UI to word its own dialog from (the message is complete without them). */
export class ApiError extends Error {
  code?: string
  status: number
  details?: Record<string, unknown>
  constructor(message: string, status: number, code?: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * Turn FastAPI's validation body into a sentence the model (or the user) can act on.
 *
 * FastAPI answers a schema violation with `{"detail":[{loc,msg,…}]}`, which is NOT PrismLCA's own
 * `{"error":{message,hint}}` envelope — so a reader looking only for that envelope fell through to
 * a bare `HTTP 422` and threw the useful half away. The model then knew only that it had failed,
 * not which field was wrong: on the Kimi practice run a `calculate` without `code` cost a full
 * round to guess back. `loc` is a path like ["body","code"]; its last segment is the field name
 * worth saying.
 */
export function validationDetail(body: unknown): string | undefined {
  const detail = (body as { detail?: unknown })?.detail
  if (typeof detail === 'string') return detail
  if (!Array.isArray(detail) || !detail.length) return undefined
  const parts = detail
    .map((d) => {
      const loc = Array.isArray((d as { loc?: unknown[] }).loc) ? (d as { loc: unknown[] }).loc : []
      // Drop the "body"/"query" prefix — the model passes tool arguments, not HTTP envelopes.
      const field = loc.filter((p) => typeof p === 'string' && p !== 'body' && p !== 'query').join('.')
      const msg = String((d as { msg?: unknown }).msg ?? 'invalid')
      return field ? `${field}: ${msg}` : msg
    })
    .filter(Boolean)
  return parts.length ? `Invalid arguments — ${parts.join('; ')}` : undefined
}

/**
 * The error a backend response deserves, or null for a healthy status.
 *
 * Message precedence: the backend's own `{error:{message}}` envelope, then the FastAPI validation
 * detail, then a plain string body, then `HTTP <status>`. The hint is appended rather than kept
 * separate because the backend puts the *way out* in it — which parameter names exist, what a value
 * is allowed to be — and every consumer that dropped it left its caller to guess at a refusal it
 * could have acted on. It is one sentence.
 */
export function apiError(status: number, body: unknown): ApiError | null {
  if (status < 400) return null
  const err = (
    body as {
      error?: { message?: string; hint?: string; code?: string; details?: Record<string, unknown> }
    }
  )?.error
  const msg = err?.message ?? validationDetail(body) ?? (typeof body === 'string' ? body : `HTTP ${status}`)
  return new ApiError(err?.hint ? `${msg} — ${err.hint}` : msg, status, err?.code, err?.details)
}
