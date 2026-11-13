/**
 * The questions the assistant asked and the user's answers, found in the text of its answer.
 *
 * `ask_user` writes the exchange into the assistant's text (main/ai/tools/groups/canvas.ts), so it
 * survives in the stored chat and the model reads it in its own history:
 *
 *     > ❓ Which system boundary?
 *     > ➤ cradle-to-gate excluding use phase
 *     >
 *     > ❓ Where is it made?
 *     > ➤ RER, Europe
 *
 * That format stays as it is — stored chats carry it, and it is what the model sees. The panel only
 * draws it differently: a block of such lines becomes a segment of its own, everything else stays text
 * for the Markdown renderer. A line that does not fit the pattern exactly (a question with a line break
 * in it) leaves the block to Markdown as before.
 */

export interface AskedPair {
  question: string
  answer: string
}

export type AnswerSegment = { kind: 'text'; text: string } | { kind: 'asked'; pairs: AskedPair[] }

const QUESTION = /^> ❓ (.*)$/
const ANSWER = /^> ➤ (.*)$/
const SEPARATOR = /^>\s*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/**
 * The first line after `from` that no longer continues the line before it. ask_user prefixes only the
 * first line of a question or answer; an answer typed over several lines (Shift+Enter) goes on in
 * plain lines, which Markdown read as the same quote, and so do we — up to a blank line or a line of
 * the format itself. A typed line that begins with ">" ("> 90 % required") is part of the answer and
 * stays as typed.
 */
function continued(lines: string[], from: number): number {
  let k = from
  while (
    k < lines.length &&
    lines[k].trim() !== '' &&
    !QUESTION.test(lines[k]) &&
    !ANSWER.test(lines[k]) &&
    !SEPARATOR.test(lines[k])
  )
    k++
  return k
}

/** The pairs of a block that starts at line `i`, and the first line after it; null if none starts there. */
function readBlock(lines: string[], i: number): { pairs: AskedPair[]; end: number } | null {
  const pairs: AskedPair[] = []
  let j = i
  for (;;) {
    const q = QUESTION.exec(lines[j] ?? '')
    if (!q) break
    const qEnd = continued(lines, j + 1)
    const a = ANSWER.exec(lines[qEnd] ?? '')
    if (!a) break
    const aEnd = continued(lines, qEnd + 1)
    pairs.push({
      question: [q[1], ...lines.slice(j + 1, qEnd)].join('\n').trim(),
      answer: [a[1], ...lines.slice(qEnd + 1, aEnd)].join('\n').trim()
    })
    j = aEnd
    // The blank quote line between two pairs belongs to the block; a trailing one does not.
    if (SEPARATOR.test(lines[j] ?? '') && QUESTION.test(lines[j + 1] ?? '')) j += 1
  }
  return pairs.length ? { pairs, end: j } : null
}

/**
 * The text cut into Markdown and asked-and-answered segments, in order. A block is recognised only
 * where ask_user puts one — at the start of a paragraph and outside a fenced code block — so an
 * example of the format in code, or a quote inside a paragraph, stays Markdown.
 */
export function splitAskTranscript(text: string): AnswerSegment[] {
  if (!text.includes('> ❓ ')) return [{ kind: 'text', text }]
  const lines = text.split('\n')
  const out: AnswerSegment[] = []
  let prose: string[] = []
  const flushProse = (): void => {
    // Only the blank lines that separated the block go; indentation inside the text stays.
    const joined = prose.join('\n').replace(/^\n+|\n+$/g, '')
    if (joined.trim()) out.push({ kind: 'text', text: joined })
    prose = []
  }
  // The open fence, if any: closed only by the same character, at least as long, with nothing after it.
  let fence: { char: string; len: number } | null = null
  let i = 0
  while (i < lines.length) {
    const paragraphStart = i === 0 || lines[i - 1].trim() === ''
    const block = !fence && paragraphStart ? readBlock(lines, i) : null
    if (block) {
      flushProse()
      out.push({ kind: 'asked', pairs: block.pairs })
      i = block.end
      continue
    }
    const f = FENCE.exec(lines[i])
    if (f && !fence) fence = { char: f[1][0], len: f[1].length }
    else if (f && fence && f[1][0] === fence.char && f[1].length >= fence.len && !f[2].trim()) fence = null
    prose.push(lines[i])
    i += 1
  }
  flushProse()
  return out
}
