/**
 * The sentences a gate finding stands in — so a repair can be asked for those sentences and nothing else.
 *
 * A revision that answers the reader is the expensive kind: it rewrites several passages at once, and a
 * writer that types a figure out in one of them got the whole revision thrown away when the general
 * repair could not mend it (V458: Kimi K3 answered 12 reader points, typed out three figures, and the
 * chapter was stored as it stood before the reader). Quoting the sentence that carries each finding
 * tells the writer where to look, and accepting replacements only inside those sentences keeps the
 * rest of the revision as it was answered.
 */
import type { Finding } from '../../../shared/ipc'

/** Where a finding can be found in the text: a typed figure, or a placeholder the finding names. */
export function anchorOf(f: Finding): { number: string } | { token: string } | null {
  if (f.kind === 'literal_number') {
    const named = (f as Finding & { names?: unknown }).names
    const bare = Array.isArray(named) && named.length ? String(named[0]) : null
    const fromDetail = /^The (?:number|figure) ([-+]?\d[\d.,]*)/.exec(f.detail ?? '')?.[1]
    const number = bare ?? fromDetail
    return number ? { number } : null
  }
  const path = (f as Finding & { path?: unknown }).path
  if (typeof path === 'string' && path.trim()) return { token: path.trim() }
  return null
}

/** Spans of `{{…}}` placeholders, whose dots and digits belong to a path, not to the prose. */
function placeholderSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const re = /\{\{[^{}]*\}\}/g
  for (let m = re.exec(text); m; m = re.exec(text)) spans.push([m.index, m.index + m[0].length])
  return spans
}

const inside = (spans: Array<[number, number]>, i: number): boolean => spans.some(([a, b]) => i >= a && i < b)

/**
 * The sentence around position `at`: from after the previous sentence end to the next one. A sentence
 * ends at a line break, or at `.`, `!` or `?` followed by a space and something that can start a
 * sentence — never inside a placeholder, never between digits (4.2), never after a lone initial or a
 * common abbreviation (z. B., e. g., et al.).
 */
export function sentenceAround(text: string, at: number): { start: number; end: number } {
  const spans = placeholderSpans(text)
  const isEnd = (i: number): boolean => {
    const c = text[i]
    if (c === '\n') return true
    if (c !== '.' && c !== '!' && c !== '?') return false
    if (inside(spans, i)) return false
    const next = text.slice(i + 1, i + 3)
    if (!/^\s[\p{Lu}„"“({\d]/u.test(next) && i + 1 < text.length) return false
    const before = text.slice(Math.max(0, i - 6), i)
    // "z. B.", "d. h.", "e. g.", "u. a." and their second halves, and a few written abbreviations. A lone
    // letter in general is NOT one: "1042 g. Then" ends a sentence after a unit.
    if (
      c === '.' &&
      (/\b\p{L}\.\s?\p{L}$/u.test(before) ||
        /(?:^|\s)[zdusvoei]$/u.test(before) ||
        /\b(?:al|ca|Nr|vgl|bzw|ggf|resp)$/u.test(before))
    )
      return false
    return true
  }
  let start = at
  while (start > 0 && !isEnd(start - 1)) start--
  while (start < at && /\s/.test(text[start])) start++
  let end = at
  while (end < text.length && !isEnd(end)) end++
  if (end < text.length && text[end] !== '\n') end++
  return { start, end }
}

/** Where a typed figure stands: the number on its own, not part of a longer one, not inside a placeholder. */
function numberAt(text: string, number: string): number[] {
  const spans = placeholderSpans(text)
  const esc = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<![\\d.,])${esc}(?![\\d]|[.,]\\d)`, 'g')
  const out: number[] = []
  for (let m = re.exec(text); m; m = re.exec(text)) if (!inside(spans, m.index)) out.push(m.index)
  return out
}

export interface FlaggedSentence {
  sentence: string
  details: string[]
}

/**
 * The sentences that carry these findings, each once, with what is wrong in it. `unplaced` are the
 * findings no sentence could be found for — a repair that has them cannot be limited to sentences.
 */
export function flaggedSentences(
  text: string,
  findings: Finding[]
): { sentences: FlaggedSentence[]; unplaced: Finding[] } {
  const byStart = new Map<number, FlaggedSentence & { start: number }>()
  const unplaced: Finding[] = []
  for (const f of findings) {
    const anchor = anchorOf(f)
    const positions = !anchor
      ? []
      : 'number' in anchor
        ? numberAt(text, anchor.number)
        : [text.indexOf(anchor.token)].filter((i) => i >= 0)
    if (!positions.length) {
      unplaced.push(f)
      continue
    }
    for (const at of positions) {
      const { start, end } = sentenceAround(text, at)
      const hit = byStart.get(start) ?? { start, sentence: text.slice(start, end).trim(), details: [] }
      if (!hit.details.includes(f.detail)) hit.details.push(f.detail)
      byStart.set(start, hit)
    }
  }
  const sentences = [...byStart.values()]
    .sort((a, b) => a.start - b.start)
    .map(({ sentence, details }) => ({ sentence, details }))
  return { sentences, unplaced }
}

/** Whether every replacement stays inside the sentences that were flagged. */
export function withinFlagged(replacements: Array<{ old: string }>, sentences: FlaggedSentence[]): boolean {
  return replacements.every((r) => r.old.trim() && sentences.some((s) => s.sentence.includes(r.old.trim())))
}

/** The assignment that asks for exactly these sentences, nothing else. */
export function sentenceRepairPrompt(sentences: FlaggedSentence[]): string {
  return [
    `Your revision answers the reader, but ${sentences.length === 1 ? 'one sentence in it breaks' : `${sentences.length} sentences in it break`} the report's rules, so it cannot be stored yet. Rewrite only ${sentences.length === 1 ? 'this sentence' : 'these sentences'} — everything else stays as you wrote it:`,
    '',
    ...sentences.flatMap((s, i) => [`${i + 1}. «${s.sentence}»`, ...s.details.map((d) => `   — ${d}`)]),
    '',
    'Reply with JSON only: {"replacements": [{"old": "<one of the sentences above, quoted exactly>", "new": "<that sentence rewritten>"}]}.',
    'Keep what each sentence says. Where a figure has no placeholder in your brief, write the sentence without that figure.'
  ].join('\n')
}
