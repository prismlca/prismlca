/**
 * The transport-agnostic half of a streamed chat request: send with retry-and-backoff, give up on a
 * provider that does not answer or goes silent, frame the SSE events (sse.ts), let the transport
 * translate each one, and refuse to call a reply finished that the provider never finished. Extracted
 * from the original OpenRouter client — every supported provider speaks SSE over one POST, so the
 * resilience mechanics are genuinely shared while the wire formats are not.
 */
import { parseEventData, SseFramer } from './sse'
import { AiProviderError, type ChatTransport, type StreamChatOpts, type StreamEvent } from './types'

/** No byte at all for this long means the connection is dead, whatever the socket believes.
 *
 *  A model that is thinking still sends nothing — reasoning models go quiet for a minute before their
 *  first token, and a provider under load queues a request without closing it. So this is deliberately
 *  far above "slow": it is the line between waiting and hanging. A live run lost 34 minutes to one
 *  research call with no timeout anywhere in this client, and the only escape was the Stop button,
 *  which throws the whole run away. */
export const STALL_MS = 180_000

/** The same line before the first byte: a request the provider accepted but never answered — not
 *  even with its headers — is held in a queue nobody will empty. Measured: a free-tier Gemini request
 *  sat there past four minutes. Not retried: sending it again joins the same queue. */
export const HEADERS_MS = STALL_MS

/** One ceiling for a non-streaming request (voice transcription): its whole answer, not a gap. */
export const ONE_SHOT_MS = 120_000

export const TRANSCRIBE_TIMEOUT = `The transcription did not answer within ${ONE_SHOT_MS / 60_000} minutes — try again.`

/** The caller's signal plus a deadline, for the one-shot requests that have no stall watchdog. A
 *  deadline that fires aborts with a `TimeoutError`, which the caller tells apart from the user's Stop. */
export function withDeadline(signal: AbortSignal | undefined, ms: number = ONE_SHOT_MS): AbortSignal {
  const deadline = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, deadline]) : deadline
}

/** Attempts for a request that failed before producing a single byte. Once text has been yielded a
 *  retry would duplicate it, so the loop below only ever re-sends a request that produced nothing. */
const MAX_ATTEMPTS = 3

/** Base for the exponential wait between attempts. The providers' docs ask for exponential backoff
 *  and send `Retry-After` where they can be precise, which takes precedence. */
const BACKOFF_MS = 1_500

/** A random share added to every wait. Parallel requests that hit one rate limit together — research
 *  legs, report lanes — would otherwise come back in the same instant and hit it again together. */
const JITTER_MS = 750

const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true }
    )
  })

/** `Retry-After` in milliseconds — seconds or an HTTP date, per RFC 9110 — or null. Capped: a provider
 *  asking for ten minutes is a provider to give up on, not to sleep behind. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after')
  if (!raw) return null
  const seconds = Number(raw)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now()
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 60_000) : null
}

/** The wait before attempt `attempt + 1`: the provider's own figure where it gave one, our curve where
 *  it did not, either way plus the jitter. */
const backoff = (attempt: number, providerMs: number | null = null): number =>
  (providerMs ?? BACKOFF_MS * 2 ** (attempt - 1)) + Math.random() * JITTER_MS

/** Events that hand the caller part of the reply. Before the first of them a failed request can be sent
 *  again without the caller noticing; after it, a second answer would be appended to the first. */
const DELIVERS = new Set<StreamEvent['type']>(['delta', 'tool_calls', 'citations'])

/** How one attempt ended, when it did not end the stream for good. `error` is what to raise instead
 *  when another attempt is not allowed after all (the caller's spend ceiling tripped meanwhile). */
type Attempt = { again: true; pauseMs: number; why: string; error: AiProviderError } | { again: false }

/**
 * Stream a chat completion through the given transport. Yields the transport's StreamEvents as they
 * arrive.
 *
 * Bounded in three ways that a plain `fetch` is not: a provider that sends no headers within
 * `HEADERS_MS`, or no byte for `STALL_MS` after them, is given up on rather than waited for forever; a
 * request that failed before yielding anything is retried with backoff; and a stream that ends without
 * the provider's own end-of-reply event is an error, not a short answer. All three are preconditions for
 * doing several of these at once — serially a rate limit costs a pause, in parallel it costs a chapter.
 * The last one also means a cut-off round never releases its tool calls: half a round's writes are a
 * partial change to the user's model.
 *
 * "Before yielding anything" covers more than an HTTP status: a provider may accept the request and
 * report its trouble as the stream's first event (Anthropic's documented overload error after a 200), or
 * the connection may drop before a word arrived. Such a failure is retried like a refused request, as long
 * as nothing of the reply reached the caller (`DELIVERS`) and the transport marked the error `retryable`.
 *
 * The engine also guarantees exactly one 'usage' event per request that got as far as a stream —
 * including one that then failed, because the provider billed what it generated before it failed. A
 * request that ended without the provider ever reporting one still happened, and the ledger has to know.
 * Without this the stream simply stopped and `onCost` was never called, so the call was not counted at
 * all: four correction calls appeared in the dialog and three in `ai-usage.json` (V166). It hits the
 * empty answers hardest — exactly the calls worth counting, because they are the ones that cost money
 * for nothing. A request refused with an HTTP error before streaming was not billed and books nothing.
 */
export async function* runChatStream<S>(
  transport: ChatTransport<S>,
  opts: StreamChatOpts,
  key: string
): AsyncGenerator<StreamEvent> {
  const { url, headers, body } = transport.buildRequest(opts, key)
  // Stop ends the wait as well as the ceiling does; only Stop ends it quietly.
  const waitSignal =
    opts.budget && opts.signal ? AbortSignal.any([opts.signal, opts.budget]) : (opts.budget ?? opts.signal)
  for (let attempt = 1; ; attempt++) {
    const outcome = yield* sendOnce(transport, opts, { url, headers, body }, attempt)
    if (!outcome.again) return
    // Every attempt is a request of its own, billed as such: none once the spend ceiling has tripped —
    // possibly on the usage of the attempt that just failed.
    if (opts.budget?.aborted) throw outcome.error
    // Said in the log: silent backoff looked exactly like a slow model, and four parallel report lanes
    // hitting a rate limit serialised themselves with nothing anywhere to show why.
    console.warn(
      `[${transport.name}] ${outcome.why} on ${opts.model}, attempt ${attempt}/${MAX_ATTEMPTS}, ` +
        `waiting ${Math.round(outcome.pauseMs)}ms`
    )
    await wait(outcome.pauseMs, waitSignal)
    if (opts.signal?.aborted) return
    if (opts.budget?.aborted) throw outcome.error
  }
}

/** One request: send it, stream it, and say whether it is worth another attempt. */
async function* sendOnce<S>(
  transport: ChatTransport<S>,
  opts: StreamChatOpts,
  request: { url: string; headers: Record<string, string>; body: string },
  attempt: number
): AsyncGenerator<StreamEvent, Attempt> {
  const last = attempt >= MAX_ATTEMPTS
  // The header deadline rides on the request's own signal, so it must be disarmed the moment the
  // headers are in — the same signal governs the body, and the stall watchdog takes over there.
  const unanswered = new AbortController()
  const timer = setTimeout(() => unanswered.abort(), HEADERS_MS)
  const signal = opts.signal ? AbortSignal.any([opts.signal, unanswered.signal]) : unanswered.signal
  let sent: Response
  try {
    sent = await fetch(request.url, { method: 'POST', headers: request.headers, body: request.body, signal })
  } catch (e) {
    if (opts.signal?.aborted) return { again: false }
    // Not retried: a request the provider accepted but never answered sits in a queue, and sending it
    // again joins the same queue.
    if (unanswered.signal.aborted)
      throw new AiProviderError(
        `The provider did not answer for ${Math.round(HEADERS_MS / 1000)} s — the request was abandoned. ` +
          'Try again, or pick another model.',
        'stalled'
      )
    if ((e as Error)?.name === 'AbortError') return { again: false }
    const unreachable = new AiProviderError(transport.unreachable, 'network')
    if (last) throw unreachable
    return { again: true, pauseMs: backoff(attempt), why: 'no connection', error: unreachable }
  } finally {
    clearTimeout(timer)
  }

  if (!sent.ok || !sent.body) {
    const text = await sent.text().catch(() => '')
    const refused = transport.translateStatus(sent.status, text)
    if (!transport.retryable(sent.status, text) || last) throw refused
    return {
      again: true,
      pauseMs: backoff(attempt, retryAfterMs(sent)),
      why: String(sent.status),
      error: refused
    }
  }

  const reader = sent.body.getReader()
  const decoder = new TextDecoder()
  const framer = new SseFramer()
  const state = transport.createState(opts)
  let sentUsage = false // exactly one per request — see the doc block above
  let sawDone = false // the `[DONE]` sentinel, for transports whose end-of-reply is that line
  let delivered = false // part of the reply has reached the caller: no second attempt from here on
  // The stop reason is held back until this attempt has finished: one that failed after stating it would
  // otherwise leave its reason with the caller (a `pause_turn`, a `length`) beside the retry's own.
  const finishes: StreamEvent[] = []

  // One event's data → the transport's events. Unreadable data is said in the log rather than skipped
  // in silence: it may have been the event that carried a tool call. The run goes on — whether the
  // reply as a whole finished is decided at the end, by the provider's own end-of-reply event.
  const eventsOf = (data: string): StreamEvent[] => {
    if (data === '[DONE]') {
      sawDone = true
      return []
    }
    const parsed = parseEventData(data)
    if (!parsed) {
      console.warn(`[${transport.name}] unreadable stream event on ${opts.model}: ${data.slice(0, 200)}`)
      return []
    }
    return parsed.flatMap((p) => transport.interpret(p, state))
  }
  // A second usage from one request would be booked twice; transports report once by construction,
  // so one more is a transport bug to see in the log, not a cost to count.
  const keep = (ev: StreamEvent): boolean => {
    if (DELIVERS.has(ev.type)) delivered = true
    if (ev.type === 'finish') {
      finishes.push(ev)
      return false
    }
    if (ev.type !== 'usage') return true
    if (sentUsage) {
      console.warn(`[${transport.name}] a second usage report on ${opts.model} was ignored`)
      return false
    }
    sentUsage = true
    return true
  }

  // A read that never resolves is what a hung provider looks like from here: the socket stays open, so
  // neither `fetch` nor the reader ever gives up. Racing each read against a timer is the only place
  // this can be caught, because "no progress" is a property of the gaps between chunks and of nothing
  // else. The error is thrown rather than swallowed — the caller has to see the difference between "the
  // model finished" and "the model stopped answering", or it stores a truncated chapter as a whole one.
  let stalled = false
  const readOrStall = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            stalled = true
            reject(new Error('stalled'))
          }, STALL_MS)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    let finished = false
    try {
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await readOrStall()
        } catch (e) {
          if (stalled) {
            throw new AiProviderError(
              `The model sent nothing for ${Math.round(STALL_MS / 1000)} s — the request was abandoned. ` +
                'Try again, or pick another model.',
              'stalled'
            )
          }
          if (opts.signal?.aborted) break // the user stopped: the partial text is theirs to keep
          // A connection that dropped mid-answer used to end the loop like a finished one, and the
          // partial text was stored as the answer — or a half review counted as "ok".
          throw new AiProviderError(
            `The connection to the model dropped mid-answer (${e instanceof Error ? e.message : String(e)}). ` +
              'What arrived is shown; send it again to get the rest.',
            'network',
            true
          )
        }
        if (chunk.done) {
          finished = true
          break
        }
        for (const data of framer.push(decoder.decode(chunk.value, { stream: true })))
          for (const ev of eventsOf(data)) if (keep(ev)) yield ev
      }
      if (finished) for (const data of framer.end()) for (const ev of eventsOf(data)) if (keep(ev)) yield ev
    } finally {
      // A consumer that leaves early (the agent's repetition detector, a thrown interpret) ends the
      // generator, not the HTTP response — the provider kept generating into a dead socket.
      if (!finished) await reader.cancel().catch(() => {})
    }

    if (opts.signal?.aborted) {
      // Stopped by the user: what arrived is theirs, the call is booked, and an unfinished round's tool
      // calls are not handed out — nothing would run them, and nothing should.
      if (!sentUsage) yield { type: 'usage', usage: {} }
      return { again: false }
    }
    if (!transport.completed(state, sawDone))
      throw new AiProviderError(
        'The reply ended before the provider finished it — what arrived is shown; send it again to get the rest.',
        'network',
        true
      )
    const rest = await transport.finish(state)
    if (!sentUsage && !rest.some((ev) => ev.type === 'usage')) yield { type: 'usage', usage: {} }
    // The finished attempt's stop reason first, then what the transport assembled at the end — a caller
    // reads the reason before the calls (client.ts tells a paused reply by it).
    for (const ev of rest) if (ev.type === 'finish') finishes.push(ev)
    yield* finishes
    for (const ev of rest) if (ev.type !== 'finish' && keep(ev)) yield ev
    return { again: false }
  } catch (e) {
    // Failed after the stream began: the provider billed what it generated until then. Booked with the
    // cost unknown, before the error goes on, so the ledger and the cost limit count the call.
    if (!sentUsage) {
      sentUsage = true
      yield { type: 'usage', usage: {} }
    }
    // Nothing of the reply reached the caller, and a second request may clear it: send it again.
    if (e instanceof AiProviderError && e.retryable && !delivered && !last && !opts.signal?.aborted)
      return { again: true, pauseMs: backoff(attempt), why: e.message, error: e }
    throw e
  }
}
