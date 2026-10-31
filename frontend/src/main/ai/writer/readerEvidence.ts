/**
 * What the second reader sees of the writer's lookups.
 *
 * The reader judges whether a sentence rests on something the writer read, so it has to see what the
 * writer read. A hard cut at 4 000 characters did not show it: a literature search with three or four
 * questions answers with 20 000–26 000 characters, so the reader saw the first question's findings and
 * called every sentence built on the others unsupported; a dataset's documentation puts its data year
 * and the regions it was extrapolated from at the end, past the cut. Measured on three reports: all 13
 * of the reader's false alarms were of that kind, each closed only after the writer quoted the finding
 * back, a round apiece.
 *
 * So a literature search is shown as what the writer cites from it — every question with its findings
 * and their sources — without the raw evidence excerpts and the bookkeeping beside them; everything
 * else is cut later than before. A result that is not the expected JSON (an error, a cut record) is
 * shown as it is.
 */
import type { Lookup } from '../../../shared/ipc'

/** Any other lookup: a dataset's documentation is 4–8 k characters, and its provenance sits at the end. */
export const LOOKUP_CHARS = 8_000
/** A literature search, as findings: four questions of five to seven findings fit with room to spare. */
export const RESEARCH_CHARS = 20_000

function cut(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… [cut]`
}

interface Finding {
  text?: unknown
  sources?: unknown
}
interface Answer {
  question?: unknown
  findings?: unknown
  sources?: unknown
}

/** One question's findings as lines; null when the object is not a research answer. */
function answerLines(a: Answer, n: number | null): string[] | null {
  if (!a || typeof a !== 'object' || !Array.isArray(a.findings)) return null
  const head = `${n === null ? 'Question' : `Question ${n}`}: ${String(a.question ?? '').trim()}`
  const findings = (a.findings as Finding[]).map((f) => {
    const sources = Array.isArray(f?.sources) ? (f.sources as unknown[]).map(String).filter(Boolean) : []
    const text = String(f?.text ?? '').trim()
    // A source the text already names is not repeated.
    const extra = sources.filter((s) => !text.includes(s))
    return `  - ${text}${extra.length ? ` (${extra.join(', ')})` : ''}`
  })
  return [head, ...(findings.length ? findings : ['  - (no finding)'])]
}

/** A `research_web` result as its findings, or null when it is not one the reader can be shown that way. */
export function researchDigest(result: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(result)
  } catch {
    return null
  }
  const p = parsed as { results?: Array<{ ok?: boolean; error?: unknown; result?: Answer }> } & Answer
  if (Array.isArray(p.results)) {
    const lines: string[] = []
    p.results.forEach((r, i) => {
      const answer = r?.ok ? answerLines(r.result as Answer, i + 1) : null
      lines.push(...(answer ?? [`Question ${i + 1}: failed — ${String(r?.error ?? 'no answer')}`]))
    })
    return lines.join('\n')
  }
  return answerLines(p, null)?.join('\n') ?? null
}

/** One lookup as the reader is shown it. */
export function forReader(l: Lookup): string {
  if (l.name === 'research_web') {
    const digest = researchDigest(l.result)
    if (digest !== null) return cut(digest, RESEARCH_CHARS)
  }
  return cut(l.result, LOOKUP_CHARS)
}
