/**
 * What the summariser of dropped tool results reads and writes.
 *
 * Compaction (contextBudget.ts) replaces older tool results with a stub once the conversation fills its
 * share of the window; the summariser condenses what they said into a few bullet points the agent keeps.
 * Summarising beats plain truncation measurably: OpenHands report ~2× lower API cost from their
 * summarising condenser with no drop in agent performance, because the agent stops re-fetching what it
 * already learned. Best-effort by design — on any failure the run continues with the stubs alone.
 *
 * Its input is chosen here, and it used to be the wrong part: every dropped result joined, then the first
 * 60 000 characters — the OLDEST ones. A large drop reached the summariser as its first quarter, and the
 * results closest to the current work never arrived. Each result also came without its call, as JSON from
 * nowhere, and without the user's request, so what the agent "will still need" was a guess. Now every
 * result is headed by its call, the newest are taken first, the room is shared out so one giant result
 * cannot fill it alone, and the user's current request comes along for orientation.
 *
 * Runs on the CHAT model, not on a cheap one of its own. It had its own setting and a cheap default for a
 * while: the call is rare and capped, so the cheap tier saved cents — while what it writes replaces what
 * the agent read, and a lost database name or a number without its unit costs a re-fetch worth more than
 * those cents.
 */
import type { DroppedResult } from './contextBudget'
import type { ProviderId, StreamChatOpts } from './providers/types'
import { collectText, type CostSample } from './stream'

/** Below this much dropped content a summary is not worth a request. */
export const SUMMARY_MIN_CHARS = 4_000

/** The most the summariser reads of the dropped results, headings and markers included. */
export const SUMMARY_MAX_INPUT = 60_000

/** Every result taken gets at least this much of its text (or all of it, if shorter); below that the
 *  oldest results are left out rather than cut to nothing. */
const ENTRY_FLOOR = 1_500

/** Arguments are an orientation, not content: a search's query, a dataset's code. */
const ARGS_CHARS = 200

/** The user's request beside the results: the original message of the run, then what they sent while it
 *  worked, labels and line breaks included. Outside SUMMARY_MAX_INPUT, and bounded on its own. */
export const TASK_CHARS = 2_000
/** What the original request keeps however long the later messages are: the task they correct. */
const REQUEST_FLOOR = 500
const STEERING_LABEL = 'Then, while it worked: '

const CUT_MARK = '\n… [cut] …\n'
const SEPARATOR = '\n\n'
/** Room kept for the line that counts the results left out. */
const OMITTED_ROOM = 60

/** A summariser gets no more patience than this when its provider fails: it is best-effort, and the round
 *  it runs before is waiting for it. */
const SUMMARY_RETRY: StreamChatOpts['retry'] = { busyMs: 30_000, offlineMs: 30_000 }

const SYSTEM =
  'You compress tool output for an LCA agent whose context is full. Each result is headed by the call ' +
  "that produced it, and the user's current request comes first so you know what the work is for. Reply " +
  'with at most 12 terse bullet points capturing ONLY facts the agent will still need: names, codes, ' +
  'database names, numbers with units, methods, and anything it already tried. Put what the current ' +
  'request needs first, but keep every name, code or number the agent may need to finish the work. No ' +
  'prose, no preamble, no advice.'

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/** A text cut to at most `n` characters, marker included, keeping its start and its end — where a
 *  message tends to put its last constraint. */
function clipMiddle(s: string, n: number): string {
  if (s.length <= n) return s
  const mark = ' … '
  if (n <= mark.length + 2) return s.slice(0, Math.max(0, n))
  const head = Math.ceil(((n - mark.length) * 2) / 3)
  return `${s.slice(0, head)}${mark}${s.slice(s.length - (n - mark.length - head))}`
}

const heading = (d: DroppedResult): string => {
  const args = d.args.replace(/\s+/g, ' ').trim()
  return `### ${d.tool}${args && args !== '{}' ? ` ${clip(args, ARGS_CHARS)}` : ''}`
}

/** What one entry costs besides its text: heading, newline, the cut mark it may need, the separator. */
const overhead = (d: DroppedResult): number => heading(d).length + 1 + CUT_MARK.length + SEPARATOR.length

/** A text cut to `n` characters: two thirds from the front, where identifiers stand, one third from the
 *  end, where conclusions, totals and warnings tend to. */
function fit(text: string, n: number): string {
  if (text.length <= n) return text
  const head = Math.ceil((n * 2) / 3)
  return `${text.slice(0, head)}${CUT_MARK}${text.slice(text.length - (n - head))}`
}

/**
 * The dropped results as the summariser reads them, at most `max` characters.
 *
 * Newest first: results are taken from the end for as long as each can still have at least
 * min(its length, ENTRY_FLOOR); the oldest beyond that are counted, not shown. The room left after the
 * headings is then shared out like water filling vessels — short results keep all of their text, and what
 * they do not use goes to the long ones in equal parts. Printed in their original order.
 */
export function summaryInput(dropped: DroppedResult[], max = SUMMARY_MAX_INPUT): string {
  let room = max - OMITTED_ROOM
  let start = dropped.length
  while (start > 0) {
    const d = dropped[start - 1]
    const need = overhead(d) + Math.min(d.text.length, ENTRY_FLOOR)
    if (need > room) break
    room -= need
    start--
  }
  const kept = dropped.slice(start)
  let textRoom = max - OMITTED_ROOM - kept.reduce((sum, d) => sum + overhead(d), 0)
  const share = new Array<number>(kept.length)
  const shortestFirst = kept.map((_, i) => i).sort((a, b) => kept[a].text.length - kept[b].text.length)
  let left = kept.length
  for (const i of shortestFirst) {
    share[i] = Math.min(kept[i].text.length, Math.floor(textRoom / left))
    textRoom -= share[i]
    left--
  }
  const body = kept.map((d, i) => `${heading(d)}\n${fit(d.text, share[i])}`).join(SEPARATOR)
  const omitted = start ? `(${start} older result${start === 1 ? '' : 's'} not included)${SEPARATOR}` : ''
  return omitted + body
}

/**
 * The user's request for the summariser: the run's own message, then what they sent while it worked. At
 * most `max` characters in all. The newest messages are served first — they correct the older ones —
 * while the original request keeps REQUEST_FLOOR characters of its own and whatever the others leave; a
 * text that does not fit keeps its start and its end. A run resumed with "continue" has its real task in
 * the steering or in the plan the agent keeps, so the request alone would not be enough.
 */
export function summaryTask(notes: string[], max = TASK_CHARS): string {
  const [request = '', ...steering] = notes.map((n) => n.trim()).filter(Boolean)
  const reserved = Math.min(request.length, REQUEST_FLOOR, max)
  let room = max - reserved
  const later: string[] = []
  for (let i = steering.length - 1; i >= 0; i--) {
    // A line of its own: the label, the text and the line break before it.
    const fits = room - STEERING_LABEL.length - 1
    if (fits <= 0) break
    const line = STEERING_LABEL + clipMiddle(steering[i], fits)
    later.unshift(line)
    room -= line.length + 1
  }
  const first = clipMiddle(request, reserved + room)
  return [first, ...later].filter(Boolean).join('\n')
}

/**
 * Condense the tool output just dropped into a few lines the agent can keep working from, or null when
 * there was too little to bother or the request failed.
 */
export async function summariseDropped(opts: {
  dropped: DroppedResult[]
  /** The user's request (summaryTask). */
  task: string
  /** The chat model's id. */
  model: string
  /** The run's pinned provider: the chat model's id only means something there. Without it the
   *  dispatcher would use whichever provider is active at compaction time, substitute its default for
   *  an id it does not serve, and book the usage under the id it never used. */
  provider: ProviderId
  signal?: AbortSignal
  /** The run's spend ceiling: a summary is a request like any other, and none starts past the limit. */
  budget?: AbortSignal
  onCost?: (modelId: string, sample: CostSample) => void
}): Promise<string | null> {
  const content = opts.dropped.reduce((sum, d) => sum + d.text.length, 0)
  if (content < SUMMARY_MIN_CHARS) return null
  const task = opts.task.trim()
  try {
    const out = await collectText({
      model: opts.model,
      provider: opts.provider,
      signal: opts.signal,
      budget: opts.budget,
      retry: SUMMARY_RETRY,
      onCost: opts.onCost,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content:
            (task ? `The user's current request:\n${task}\n\n` : '') +
            `Tool results being dropped (oldest first):\n\n${summaryInput(opts.dropped)}`
        }
      ]
    })
    return out.trim() || null
  } catch {
    return null // never let the summariser break the run
  }
}
