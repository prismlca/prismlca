/**
 * The transport-agnostic half of a streamed chat request: send with retry-and-backoff, abandon a
 * stalled stream, split SSE lines, and let the transport translate each parsed event. Extracted
 * verbatim from the original OpenRouter client — both supported providers speak SSE over one POST,
 * so the resilience mechanics are genuinely shared while the wire formats are not.
 */
import { AiProviderError, type ChatTransport, type StreamChatOpts, type StreamEvent } from './types'

/** No byte at all for this long means the connection is dead, whatever the socket believes.
 *
 *  A model that is thinking still sends nothing — reasoning models go quiet for a minute before their
 *  first token, and a provider under load queues a request without closing it. So this is deliberately
 *  far above "slow": it is the line between waiting and hanging. A live run lost 34 minutes to one
 *  research call with no timeout anywhere in this client, and the only escape was the Stop button,
 *  which throws the whole run away. */
export const STALL_MS = 180_000

/** Attempts for a request that failed before producing a single byte. Once text has been yielded a
 *  retry would duplicate it, so the loop below only ever re-sends a request that produced nothing. */
const MAX_ATTEMPTS = 3

/** Base for the exponential wait between attempts. The providers' docs ask for exponential backoff
 *  and send `Retry-After` where they can be precise, which takes precedence. */
const BACKOFF_MS = 1_500

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

/**
 * Stream a chat completion through the given transport. Yields the transport's StreamEvents as they
 * arrive.
 *
 * Bounded in two ways that a plain `fetch` is not: a stalled stream is abandoned after `STALL_MS`
 * rather than held open forever, and a request that failed before yielding anything is retried with
 * backoff. Both are preconditions for doing several of these at once — serially a rate limit costs a
 * pause, in parallel it costs a chapter.
 *
 * The engine also guarantees exactly one 'usage' event per request: a request that ended without the
 * provider ever reporting one still happened, and the ledger has to know. Without this the stream
 * simply stopped and `onCost` was never called, so the call was not counted at all: four correction
 * calls appeared in the dialog and three in `ai-usage.json` (V166). It hits the empty
 * answers hardest — exactly the calls worth counting, because they are the ones that cost money for
 * nothing.
 */
export async function* runChatStream<S>(
  transport: ChatTransport<S>,
  opts: StreamChatOpts,
  key: string
): AsyncGenerator<StreamEvent> {
  const { url, headers, body } = transport.buildRequest(opts, key)

  // Send, and re-send while nothing has been streamed yet. The retry lives here rather than around the
  // whole generator on purpose: the moment a delta has been yielded the caller owns partial text, and
  // starting over would append a second answer to the first.
  let stream: ReadableStream<Uint8Array> | null = null
  for (let attempt = 1; ; attempt++) {
    let sent: Response
    try {
      sent = await fetch(url, { method: 'POST', headers, body, signal: opts.signal })
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return
      if (attempt >= MAX_ATTEMPTS) throw new AiProviderError(transport.unreachable, 'network')
      await wait(BACKOFF_MS * 2 ** (attempt - 1), opts.signal)
      if (opts.signal?.aborted) return
      continue
    }

    if (sent.ok && sent.body) {
      stream = sent.body
      break
    }

    const text = await sent.text().catch(() => '')
    if (!transport.retryable(sent.status, text) || attempt >= MAX_ATTEMPTS)
      throw transport.translateStatus(sent.status, text)
    // The provider's own number where it gave one, our curve where it did not. Said in the log:
    // silent backoff looked exactly like a slow model, and four parallel report lanes hitting a
    // rate limit serialised themselves with nothing anywhere to show why.
    const pause = retryAfterMs(sent) ?? BACKOFF_MS * 2 ** (attempt - 1)
    console.warn(
      `[${transport.name}] ${sent.status} on ${opts.model}, attempt ${attempt}/${MAX_ATTEMPTS}, waiting ${Math.round(pause)}ms`
    )
    await wait(pause, opts.signal)
    if (opts.signal?.aborted) return
  }

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sentUsage = false // a request that never reports one still happened — see the doc block above
  const state = transport.createState(opts)

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

  let finished = false
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await readOrStall()
      } catch (e) {
        if (stalled) {
          await reader.cancel().catch(() => {})
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
          'network'
        )
      }
      if (chunk.done) {
        finished = true
        break
      }
      buffer += decoder.decode(chunk.value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line || !line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        let parsed: unknown
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }
        for (const ev of transport.interpret(parsed, state)) {
          if (ev.type === 'usage') sentUsage = true
          yield ev
        }
      }
    }
  } finally {
    // A consumer that leaves early (the agent's repetition detector, a thrown interpret) ends the
    // generator, not the HTTP response — the provider kept generating into a dead socket.
    if (!finished) await reader.cancel().catch(() => {})
  }

  const rest = transport.finish(state)
  if (rest.some((ev) => ev.type === 'usage')) sentUsage = true
  // See the doc block: exactly one usage per request, empty when the provider stayed silent.
  if (!sentUsage) yield { type: 'usage', usage: {} }
  yield* rest
}
