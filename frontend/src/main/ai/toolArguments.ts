/**
 * Tool-call arguments that are not a JSON object: telling them apart, keeping them out of the next
 * request, logging which host sent them, and telling the model what arrived.
 *
 * A host now and then streams arguments that end mid-value — measured on OpenRouter: `{"filtered_queries": `
 * followed by `finish_reason: tool_calls`, both times where a field holding a list of objects begins. Sent
 * back unchanged in the next request, such a string got the whole request refused (HTTP 400) and ended the
 * run; the transcript kept it, so "Continue" would have sent it again. The executor refuses the call with
 * a readable reason (execute.ts), the transports that echo the raw string send `{}` in its place, and the
 * transcript keeps what the host really delivered.
 */
import type { ChatMessage } from './providers/types'
import { aiLog } from './aiLog'

/** Why a tool-argument string is not a JSON object, or null when it is one. Empty or blank is `syntax`
 *  here: what to make of "no arguments" is the caller's decision (the executor reads it as `{}`). */
export type ArgumentsProblem = 'syntax' | 'array' | 'null' | 'string' | 'number' | 'boolean'

export function argumentsProblem(raw: string): ArgumentsProblem | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return 'syntax'
  }
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'object') return null
  return typeof v as 'string' | 'number' | 'boolean'
}

/** Arguments as they may go back to a provider: the original string when it is a JSON object — byte for
 *  byte, so the cached prefix and a reasoning replay stay as they were — and `"{}"` for anything else. */
export function sendableArguments(raw: string): string {
  return argumentsProblem(raw) ? '{}' : raw
}

type WithToolCalls = { tool_calls?: ChatMessage['tool_calls'] }

/** The message as it may be sent: the same object when every call's arguments are a JSON object, a copy
 *  with `{}` in place of the others when not. The caller's transcript is never changed. */
export function withSendableArguments<M extends WithToolCalls>(m: M): M {
  const calls = m.tool_calls
  if (!calls?.some((c) => argumentsProblem(c.function.arguments))) return m
  return {
    ...m,
    tool_calls: calls.map((c) =>
      argumentsProblem(c.function.arguments) ? { ...c, function: { ...c.function, arguments: '{}' } } : c
    )
  }
}

/** One log line per call a host delivered with arguments that are not a JSON object: host, tool, kind and
 *  length — never the content, which can carry the user's data. A call with no arguments at all is a
 *  parameterless call, not a fault, and stays quiet. */
export function logUnsendableArguments(
  host: string,
  calls: ReadonlyArray<{ name: string; arguments: string }>
): void {
  for (const c of calls) {
    if (!c.arguments.trim()) continue
    const problem = argumentsProblem(c.arguments)
    if (problem)
      aiLog(
        `${host} delivered tool arguments that are not a JSON object for ${c.name} ` +
          `(${problem}, ${c.arguments.length} chars)`
      )
  }
}

/** How much of a broken argument string the refusal quotes back. */
export const QUOTED_CHARS = 120

const KIND: Record<Exclude<ArgumentsProblem, 'syntax'>, string> = {
  array: 'an array',
  null: 'null',
  string: 'a string',
  number: 'a number',
  boolean: 'a boolean'
}

/** The refusal the model reads. "Most likely cut off" names the usual cause without ruling out the model's
 *  own typo — a model that wrote broken JSON itself should fix it, not split the call — and "send fewer per
 *  call" only after a second cut-off, so a whole call is always tried again first. */
export function argumentsRefusal(tool: string, raw: string, problem: ArgumentsProblem): string {
  if (problem !== 'syntax')
    return (
      `The arguments of this ${tool} call must be a JSON object with named fields; what arrived was ` +
      `${KIND[problem]}, so nothing was run.`
    )
  const head = raw.length > QUOTED_CHARS ? `${raw.slice(0, QUOTED_CHARS)}…` : raw
  return (
    `The arguments of this ${tool} call were not valid JSON — most likely cut off on the way — so nothing ` +
    `was run. What arrived: \`${head}\`. Send the complete call again. If it arrives cut off again and the tool ` +
    `takes several items, send fewer per call.`
  )
}
