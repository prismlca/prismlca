/**
 * Bringing a written chapter up to date instead of writing it again.
 *
 * When the model changes under a chapter, its figures follow by themselves — they are placeholders.
 * What can go false are the words around them: a rank, a comparison, "most", a cause, a name. So an
 * update hands the writer the chapter as it stands, the staleness check's own sentences about what
 * changed, and the second reader's points still open, and asks for exact replacements — the chapter
 * the author has read stays the chapter they read, with the few words that went false changed.
 *
 * The answer is applied here; the conversation with the gate and the reader that follows is the same
 * one a fresh chapter has (writer/dialogue.ts). The chapter arrives rebased into today's positions
 * (engine/report_rebase), so its placeholders and the facts beside it speak one order, and the result
 * is checked and stored like a fresh write.
 */
import type { ChatMessage } from '../providers/types'
import { collectText } from '../stream'
import type { CostSink } from '../subagent'
import type { Lookup } from '../../../shared/ipc'
import { applyPatch } from './answers'
import { clean, parseRevision } from './text'

/** What the backend's update brief adds to the ordinary brief (engine/report_review.update_brief). */
export interface UpdateBrief {
  /** The chapter as stored, placeholders and all — each one pointing at its member's place today. */
  text: string
  /** The same text as printed today. */
  printed: string
  /** What changed under the chapter, in the staleness check's words. */
  changes: string[]
  /** The second reader's points still open from the last reading. */
  open_points: Array<{ quote: string; problem: string }>
  /** What the chapter was accepted with: the sentences an update leaves standing still rest on it. */
  lookups?: Lookup[]
}

/** A placeholder whose member has left the results (engine/report_rebase.GONE_PREFIX). */
const GONE = '{{gone:'

/** The user turn of an update, minus the parts it shares with a fresh write (plan, facts, paths). */
export function updateAssignment(update: UpdateBrief): string[] {
  return [
    'This chapter is already written. It reads, with its placeholders:',
    '<<<',
    update.text,
    '>>>',
    '',
    "As printed today, with the placeholders filled in from today's numbers:",
    '<<<',
    update.printed,
    '>>>',
    '',
    ...(update.changes.length
      ? ['Since it was written, this changed under it:', ...update.changes.map((c) => `- ${c}`)]
      : ['The check found no change that touches this chapter; read it against the numbers once more.']),
    ...(update.open_points.length
      ? [
          '',
          'A second reader still doubted these sentences when it last read the chapter:',
          ...update.open_points.map((p) => `- "${p.quote}" — ${p.problem}`)
        ]
      : []),
    ...(update.text.includes(GONE)
      ? [
          '',
          'Placeholders written {{gone:…}} cited something that is no longer in the results. Rewrite each ' +
            "sentence carrying one from today's facts, or remove it. A placeholder in its place must be the one " +
            'today\'s facts give for what the sentence names — taking the "gone:" off would show whatever ' +
            'stands in that place today.'
        ]
      : []),
    '',
    'Bring the chapter up to date. The figures in placeholders follow the data by themselves; what may ' +
      'no longer be true are the words around them — a rank, a comparison, "most", a cause, a name. ' +
      'Change only what is no longer true or what the changes require, and keep every other sentence ' +
      'exactly as it is, placeholders included. Look things up first if you need to know why something changed.',
    'Reply with JSON only, one of:',
    '{"replacements": [{"old": "<text from the chapter above, verbatim>", "new": "<replacement>"}]}',
    '{"unchanged": true, "why": "<one sentence: why the chapter is still right>"}',
    '{"chapter": "<the whole new chapter>"} — only if more than about a quarter of it has to change.'
  ]
}

export type UpdateAnswer =
  | { kind: 'edited'; text: string }
  | { kind: 'unchanged'; text: string; why: string }
  | { kind: 'refused'; error: string }

/** Read an update reply against the chapter it was asked about. */
export function readUpdate(raw: string, original: string): UpdateAnswer {
  const text = clean(raw)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
      if (parsed.unchanged === true)
        return { kind: 'unchanged', text: original, why: String(parsed.why ?? '').trim() }
    } catch {
      // not JSON — parseRevision below gives the same answer
    }
  }
  const revision = parseRevision(raw)
  if (!revision)
    return {
      kind: 'refused',
      error:
        'The reply was not one of the three JSON forms. Reply with replacements, {"unchanged": true, …} ' +
        'or the whole chapter.'
    }
  if ('chapter' in revision) return { kind: 'edited', text: clean(revision.chapter) }
  const patched = applyPatch(original, revision.replacements)
  return patched.ok ? { kind: 'edited', text: patched.text } : { kind: 'refused', error: patched.error }
}

/**
 * Turn the writer's final answer into the updated chapter. A refused answer is handed back once with
 * the reason — it names the next step — and the second answer stands or falls as it is.
 */
export async function settleUpdate(opts: {
  raw: string
  original: string
  model: string
  messages: ChatMessage[]
  signal?: AbortSignal
  onCost?: CostSink
  maxTokens?: number
}): Promise<UpdateAnswer> {
  let answer = readUpdate(opts.raw, opts.original)
  if (answer.kind !== 'refused') return answer
  opts.messages.push({ role: 'assistant', content: opts.raw })
  opts.messages.push({ role: 'user', content: `That answer was refused: ${answer.error}` })
  const again = await collectText({
    model: opts.model,
    messages: opts.messages,
    signal: opts.signal,
    onCost: opts.onCost,
    maxTokens: opts.maxTokens
  })
  answer = readUpdate(again, opts.original)
  return answer
}
