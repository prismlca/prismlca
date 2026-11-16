/**
 * One log line per request of a helper role: a research leg, a review attempt.
 *
 * The chat's rounds have their line (roundLog.ts). The requests that run beside them — the research
 * legs behind `research_bom` and `research_web`, the reviewer behind `review_model` — left none: who
 * served them, what they cost and how much of their prompt the cache served stood only in the
 * provider's own activity list. On OpenRouter speed, price and cache belong to the endpoint, so a slow
 * or costly leg could not be traced to it; and with chat, research and review on the same model, the
 * ledger's sum per model could not be split by role.
 *
 * The line carries the figures of the round's line in the same order and starts with the role, never
 * with "cache:" — a reader that counts the chat's rounds by that start does not count these. Figures
 * and names only: no prompt text, no answer, no key.
 */
import { aiLog } from './aiLog'
import { addUsage, figureParts, hasFigures, type RoundUsage } from './roundLog'
import { describeWebLookups } from './webLookups'
import type { ChatMessage, ProviderId, StreamEvent } from './providers/types'

export interface RequestFigures {
  /** What the request was for, as the log names it: `research_bom`, `research_web`, `review_model`. */
  role: string
  model: string
  provider: ProviderId
  /** Who answered: the routed endpoint on OpenRouter, the provider itself on a direct API. */
  servedBy?: string
  usage?: RoundUsage
  /** From the request (or its last re-send) to the first piece of the reply. */
  firstTokenMs?: number
  /** From the request (or its last re-send) to the end of its stream. */
  durationMs: number
  /** Characters the request carried: for a review, the size of the dossier. */
  sentChars?: number
  /** The provider-side web lookups, in words. */
  web?: string
  /** Billed requests behind the line, when more than one: a paused reply continued, a re-sent attempt. */
  requests?: number
  failed?: boolean
  /** What only this kind of request has to say — which attempt, how much it reasoned, why it ended. */
  notes?: string[]
}

/** The request's line, without stamp and tag. */
export function requestLine(f: RequestFigures): string {
  return `${f.role}: ${[...figureParts(f, 'request'), ...(f.notes ?? [])].join(', ')} — ${f.model}`
}

/** Characters of the messages a request sends; parts that are not text count by their serialised size. */
export function sentChars(messages: ChatMessage[]): number {
  let n = 0
  for (const m of messages) {
    if (typeof m.content === 'string') n += m.content.length
    else if (m.content) n += JSON.stringify(m.content).length
  }
  return n
}

export interface RequestLog {
  /** One event of the request's stream. Events that carry no figure are ignored. */
  event(ev: StreamEvent): void
  /** The stream is over: writes the line. A second call writes nothing. */
  end(opts?: { failed?: boolean; notes?: string[] }): void
}

export function createRequestLog(o: {
  role: string
  model: string
  provider: ProviderId
  sentChars?: number
  now?: () => number
}): RequestLog {
  const now = o.now ?? Date.now
  let start = now()
  let first: number | undefined
  let servedBy: string | undefined
  let usage: RoundUsage | undefined
  /** What attempts before the last re-send cost — billed, but not part of its figures. */
  let earlierCost = 0
  let requests = 0
  let web: string | undefined
  let reasoning = 0
  let finish: string | undefined
  let done = false

  const output = (): void => {
    if (first === undefined) first = now()
  }

  return {
    event(ev) {
      if (done) return
      if (ev.type === 'delta') output()
      else if (ev.type === 'reasoning') {
        reasoning += ev.chars
        output()
      } else if (ev.type === 'provider') {
        servedBy = ev.name
        // As in the round's line: OpenRouter names the endpoint when the upstream starts to answer, a
        // direct API names itself when it opens the stream — only the first is a mark of the first token.
        if (o.provider === 'openrouter') output()
      } else if (ev.type === 'retry' && ev.phase === 'send') {
        // The same request goes out again: time and first token count from here, what was billed stays.
        start = now()
        first = undefined
        earlierCost += usage?.cost ?? 0
        usage = undefined
      } else if (ev.type === 'usage') {
        const u = ev.usage
        if (hasFigures(u)) requests++
        usage = addUsage(usage, u)
        const lookups = describeWebLookups(u.server_tool_use)?.short
        if (lookups) web = web ? `${web}; ${lookups}` : lookups
      } else if (ev.type === 'finish') finish = ev.reason
    },
    end(opts) {
      if (done) return
      done = true
      const t = now()
      const notes = [...(opts?.notes ?? [])]
      // Below half a thousand characters the figure would read "0k": too little to be worth a word.
      if (reasoning >= 500) notes.push(`reasoning ${Math.round(reasoning / 1000)}k chars`)
      // Only an end that is not the natural one is worth a word: a reply cut at its token limit, a refusal.
      if (finish && finish !== 'stop') notes.push(`finish ${finish}`)
      aiLog(
        requestLine({
          role: o.role,
          model: o.model,
          provider: o.provider,
          servedBy,
          usage: earlierCost > 0 ? { ...usage, cost: (usage?.cost ?? 0) + earlierCost } : usage,
          requests,
          failed: opts?.failed,
          firstTokenMs: first !== undefined ? first - start : undefined,
          durationMs: t - start,
          sentChars: o.sentChars,
          web,
          notes
        })
      )
    }
  }
}
