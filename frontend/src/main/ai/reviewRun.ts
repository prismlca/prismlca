/**
 * The clock of one review: how long the reviewer may take, the one restart it gets, what is kept when
 * time runs out, and the line the run bar shows meanwhile. The critic's prompt and its default model
 * stay with the critic (subagent.ts); this module owns only how a pass over the dossier is run.
 *
 * The first attempt runs on the reviewer model's own settings — no reasoning effort is imposed. What
 * this adds is the outlier: a reviewer that thinks for ten minutes and more while the chat waits. The
 * provider's stall watchdog never fires on it, because a thinking model keeps sending bytes. So:
 *
 *  - the first attempt is stopped after FIRST_ATTEMPT_MS;
 *  - every second attempt is the same restart, whatever caused it — that stop, an empty answer (a model
 *    that spends its whole reply limit thinking ends at `length` with no text), or a failed stream: low
 *    reasoning effort where the model's catalogue row offers "low", a deadline of RESTART_MS that the
 *    reviewer is TOLD, and the request to write each finding down as it goes — the pattern of the
 *    research legs, whose partial text survives their clock;
 *  - past that deadline, what the reviewer has written stands as a partial review. With nothing written
 *    the review has timed out, and the tool says so instead of the chat waiting on.
 */
import { streamChat } from './client'
import { getModels } from './models'
import { getActiveProvider } from './providers/state'
import type { ChatMessage, StreamChatOpts, StreamEvent } from './providers/types'
import type { ReasoningEffort } from '../../shared/aiDefaults'
import { costOf, type CostSample } from './stream'
import { aiLog } from './aiLog'

/** The first attempt's ceiling. No observed review came near it (the slowest took 594 s, reasoning
 *  throughout); it is there for the one that would otherwise hold the chat indefinitely. */
export const FIRST_ATTEMPT_MS = 600_000
/** The restart's deadline — the figure the reviewer is told. */
export const RESTART_MS = 360_000
/** How long the restart's request may keep retrying a busy or unreachable provider: well inside its
 *  deadline, so "the provider was down" does not read as "the reviewer ran out of time". */
const RESTART_RETRY = { busyMs: 60_000, offlineMs: 60_000 }
/** A progress line every this many characters of reasoning or text — a number that visibly moves,
 *  without an IPC message for every frame of the stream. */
const PROGRESS_TICK_CHARS = 1_000

/** What became of a review. `empty` and `timeout` are failures of the reviewer, not a clean bill of health. */
export type ReviewOutcome = 'ok' | 'empty' | 'error' | 'timeout'

export interface ReviewResult {
  text: string
  outcome: ReviewOutcome
  /** The text was cut off at a deadline: findings the reviewer had not reached are missing. */
  partial?: boolean
  /** Why the model stopped, when the provider said so — `stop`, `length`, `error`, … */
  finish_reason?: string
  /** Characters of reasoning it produced. High with empty text = it thought and wrote nothing. */
  reasoning_chars: number
  attempts: number
  ms: number
  /** Set when the stream itself failed. */
  error?: string
}

/** Why the restart runs; the reviewer is told the first two, a failed request is none of its business. */
export type RestartCause = 'timeout' | 'empty' | 'error'

/**
 * The effort the restart asks for: "low" when the reviewer's catalogue row under the active provider
 * lists it, otherwise none — the model keeps its own default. An effort the row does not list is not
 * sent at all; some routes refuse a value the model does not accept.
 */
export function restartEffort(model: string, provider = getActiveProvider()): ReasoningEffort | undefined {
  const row = getModels().find((m) => m.id === model && (m.provider ?? 'openrouter') === provider)
  return row?.reasoningEfforts?.includes('low') ? 'low' : undefined
}

/** What the restart adds to the dossier: why it runs, its deadline, and to write as it goes. */
export function restartNote(cause: RestartCause, budgetMs: number): string {
  const minutes = Math.max(1, Math.round(budgetMs / 60_000))
  const why =
    cause === 'timeout'
      ? `Your first attempt at this review ran for ${Math.round(FIRST_ATTEMPT_MS / 60_000)} minutes without finishing and was stopped. `
      : cause === 'empty'
        ? 'Your previous answer contained no text at all. '
        : ''
  return (
    `\n\n${why}You have ${minutes} minutes. Write each finding down as soon as you have it instead of ` +
    'saving them for the end: when the time is up, only what is already written is kept. Answer in ' +
    'plain text, starting with the line "Blocking:" (write "Blocking: none" if there is nothing), then ' +
    '"Should fix" and "Worth a look".'
  )
}

export interface ReviewRunOpts {
  system: string
  dossier: string
  model: string
  /** Ends the review: the user's Stop, and with it the run's spend ceiling. */
  signal?: AbortSignal
  /** The user's Stop alone. When given, `signal` firing without it means the spend ceiling: the words
   *  already received are kept (cut off unless the stream had ended) and nothing is tried again. */
  stop?: AbortSignal
  onCost?: (model: string, sample: CostSample) => void
  /** One line for the run bar: how far the reviewer has got, and a restart when it happens. */
  onProgress?: (note: string) => void
  /** The stream to read; streamChat unless a test supplies one. */
  stream?: (opts: StreamChatOpts) => AsyncIterable<StreamEvent>
}

interface Attempt {
  text: string
  timedOut: boolean
  finish?: string
  error?: string
  /** The spend ceiling ended it (see `stop`): keep what arrived, start nothing more. */
  budgetStopped?: boolean
}

/** Run the review against its clock; see the module comment for the schedule. */
export async function runReview(opts: ReviewRunOpts): Promise<ReviewResult> {
  const stream = opts.stream ?? streamChat
  const startedAt = Date.now()
  let reasoningChars = 0

  const attempt = async (a: {
    user: string
    budgetMs: number
    effort?: ReasoningEffort
    retry?: StreamChatOpts['retry']
    label: string
  }): Promise<Attempt> => {
    // Our own clock beside the caller's signal, so "stopped by the user" and "out of time" stay apart.
    const clock = new AbortController()
    const timer = setTimeout(() => clock.abort(), a.budgetMs)
    const signal = opts.signal ? AbortSignal.any([opts.signal, clock.signal]) : clock.signal
    const messages: ChatMessage[] = [
      { role: 'system', content: opts.system },
      { role: 'user', content: a.user }
    ]
    let text = ''
    let finish: string | undefined
    let error: string | undefined
    let shown = 0
    const tick = (n: number, what: string): void => {
      if (n - shown < PROGRESS_TICK_CHARS) return
      shown = n
      opts.onProgress?.(`${a.label}${what}, ${Math.round(n / 100) / 10}k characters`)
    }
    let attemptReasoning = 0
    try {
      for await (const ev of stream({
        model: opts.model,
        messages,
        temperature: null,
        signal,
        ...(a.effort ? { reasoningEffort: a.effort } : {}),
        ...(a.retry ? { retry: a.retry } : {})
      })) {
        if (ev.type === 'delta') {
          // Writing restarts the count: the line now follows the text, not the thinking before it.
          if (!text) shown = 0
          text += ev.text
          tick(text.length, 'writing')
        } else if (ev.type === 'reasoning') {
          reasoningChars += ev.chars
          attemptReasoning += ev.chars
          if (!text) tick(attemptReasoning, 'reasoning')
        } else if (ev.type === 'finish') finish = ev.reason
        else if (ev.type === 'usage') opts.onCost?.(opts.model, costOf(ev.usage))
      }
    } catch (e) {
      if (!signal.aborted) error = e instanceof Error ? e.message : String(e)
    } finally {
      clearTimeout(timer)
    }
    // A stop from the user ends the review at once, partial text or not. The spend ceiling does too —
    // but a review already received (the ceiling often trips on its own closing usage event) is paid
    // for and kept, when the caller tells the two apart.
    if (opts.signal?.aborted && (!opts.stop || opts.stop.aborted))
      throw new Error('The review was stopped before it finished.')
    const budgetStopped = !!opts.signal?.aborted
    return { text: text.trim(), timedOut: clock.signal.aborted, finish, error, budgetStopped }
  }

  const result = (
    outcome: ReviewOutcome,
    last: Attempt,
    attempts: number,
    text = last.text,
    partial = false
  ): ReviewResult => ({
    text,
    outcome,
    ...(partial ? { partial: true } : {}),
    finish_reason: last.finish,
    reasoning_chars: reasoningChars,
    attempts,
    ms: Date.now() - startedAt,
    ...(outcome === 'error' && last.error ? { error: last.error } : {})
  })

  /** Only a reply the provider ended on its natural end is whole; every transport names that end "stop".
   *  The output-token limit ("length"), a refusal, a filter — or no reason at all — leave it cut short,
   *  even with text: its last findings may be missing. */
  const cutShort = (a: Attempt): boolean => a.finish !== 'stop'

  /** The spend ceiling ended an attempt: what was received is the review, marked cut off; nothing at all
   *  is the same stop as the user's. */
  const budgetEnd = (last: Attempt, attempts: number, earlier = ''): ReviewResult => {
    const text = last.text || earlier
    if (!text)
      throw new Error('The review was stopped before it finished: the spend limit of this run was reached.')
    // Only a finish of "stop" is the provider's word that the reply is whole; the engine hands it out even
    // when the ceiling stopped the stream on the reply's own usage report.
    return result('ok', last, attempts, text, !(last.text && last.finish === 'stop'))
  }

  const first = await attempt({ user: opts.dossier, budgetMs: FIRST_ATTEMPT_MS, label: '' })
  // Only a stream that ended on its own counts as a whole review: text from one that was stopped or
  // broke off is kept below as a last resort, marked as cut off.
  if (first.budgetStopped) return budgetEnd(first, 1)
  if (first.text && !first.timedOut && !first.error)
    return result('ok', first, 1, first.text, cutShort(first))

  const cause: RestartCause = first.timedOut ? 'timeout' : first.error ? 'error' : 'empty'
  const effort = restartEffort(opts.model)
  aiLog(
    `review_model: restarting (${cause}${first.error ? `: ${first.error}` : ''}) after ` +
      `${Math.round((Date.now() - startedAt) / 1000)} s, ${Math.round(reasoningChars / 1000)}k characters of ` +
      `reasoning, finish_reason=${first.finish ?? 'none'}, effort=${effort ?? 'model default'}, ` +
      `dossier ${opts.dossier.length} chars`
  )
  const label = `second try${effort ? ' at low effort' : ''}, ${Math.round(RESTART_MS / 60_000)} min limit — `
  opts.onProgress?.(`${label}starting`)
  const second = await attempt({
    user: opts.dossier + restartNote(cause, RESTART_MS),
    budgetMs: RESTART_MS,
    effort,
    retry: RESTART_RETRY,
    label
  })

  if (second.budgetStopped) return budgetEnd(second, 2, first.text)
  if (second.text)
    return result('ok', second, 2, second.text, second.timedOut || !!second.error || cutShort(second))
  // The first attempt's own words, when it was stopped mid-way and the restart wrote nothing.
  if (first.text) return result('ok', second, 2, first.text, true)
  aiLog(
    `review_model: no review after 2 attempts, ${Math.round((Date.now() - startedAt) / 1000)} s, ` +
      `${Math.round(reasoningChars / 1000)}k characters of reasoning, finish_reason=${second.finish ?? 'none'}` +
      (second.timedOut ? ', restart deadline passed' : '')
  )
  if (second.timedOut) return result('timeout', second, 2)
  return result(second.error ? 'error' : 'empty', second, 2)
}
