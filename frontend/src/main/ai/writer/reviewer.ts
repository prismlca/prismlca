/**
 * The second reader of a drafted chapter: one model pass over the chapter as the document will print
 * it, against the same facts the writer had. No tools — it reads, it does not search — and a second
 * draw when the first comes back empty, the lesson the model reviewer already paid for (subagent.ts).
 *
 * Its points are not believed on sight. Every issue has to quote the chapter, and a quote that is not
 * in the printed text is dropped here, in code: a reader that invents a sentence to object to costs a
 * revision of a chapter that was right.
 */
import type { ChatMessage } from '../providers/types'
import { collectText } from '../stream'
import type { CostSink } from '../subagent'
import type { Finding, Lookup, ReviewQuestion } from '../../../shared/ipc'
import { forReader } from './readerEvidence'
import { clean } from './text'

/** What the backend's review brief carries (engine/report_review.review_brief). */
export interface ReviewBrief {
  title?: string
  kind?: string
  language?: string
  assignment?: string
  cautions?: string[]
  study?: Record<string, unknown>
  facts?: Record<string, unknown>
  document_plan?: Record<string, unknown>
  /** The chapter as printed: every placeholder worked out. */
  printed: string
  siblings?: Array<{ title: string; kind: string; text: string }>
  /** What the author answered when a writer asked — part of the study record. */
  author_answers?: Array<{ question: string; answer: string }>
  /** The figures and tables printed with the chapter, each with what it shows. */
  renders?: Array<{ ref: string; kind: string; shows: string }>
}

/** A point the reader raised, before anyone has answered it. */
export interface RaisedIssue {
  quote: string
  problem: string
  evidence?: string
  fix?: string
}

/** How the reader judged an earlier point after the writer's answer. */
export interface PointVerdict {
  n: number
  status: 'resolved' | 'false_positive' | 'open'
  note?: string
}

export interface Reading {
  accepted: boolean
  issues: RaisedIssue[]
  questions: ReviewQuestion[]
  /** Second and later readings only: the verdict on each earlier point, by its number. */
  points: PointVerdict[]
  /** Issues dropped because their quote is not in the chapter. */
  dropped: number
  /** The reader produced nothing usable, twice. Not a pass — the caller decides what that means. */
  empty: boolean
}

export const READER_SYSTEM = [
  'You are the second reader of one chapter of an ISO 14040/14044 life cycle assessment report, ' +
    'written for a client by a colleague. You read it the way a careful LCA reviewer reads before ' +
    'a report goes out: against the data and the study, sentence by sentence. You do not rewrite the ' +
    'chapter — you say what is wrong, why, and what would be right.',
  'You are given the chapter AS PRINTED (every figure filled in), the assignment it was written to, ' +
    'the study record, the facts and numbers the writer had, what the writer looked up, the other ' +
    "chapters of the report, and the report's own situation. Judge only against these.",
  'Raise an issue when a sentence is wrong or unsupported:\n' +
    '- A figure is attached to the wrong thing: another process, phase, variant, indicator or unit than ' +
    'the one it belongs to in the facts.\n' +
    '- A quantity in words ("two thirds", "twice", "3x", "about a quarter", "most") does not match the ' +
    'numbers.\n' +
    '- A rank or comparison ("the largest", "leading", "main driver", "lower than", "ahead on both") is ' +
    'not true for the numbers given.\n' +
    '- A cause ("because", "driven by", "due to") that nothing handed over supports. A dataset\'s own ' +
    'description, a study text or a lookup that describes a process — its fuel, technology, origin — ' +
    'supports a sentence naming that as the reason the process weighs. A share alone never explains ' +
    'itself.\n' +
    '- Something contradicts the study record: functional unit, system boundaries, what is included or ' +
    'excluded, allocation, data years.\n' +
    '- A dataset, process or scenario is named that appears nowhere in the facts, the study or the ' +
    'lookups.\n' +
    '- A statement about the world outside the study — a regulation, a market, what another study ' +
    'found — that no research finding handed over supports (the research log in the facts, or what ' +
    'the writer looked up); a figure from such a finding that is not what the finding says; or a ' +
    "comparison with another study's figure that does not say what differs between the two " +
    '(functional unit, system boundaries, method).\n' +
    '- A recommendation outside the conclusions; a preference between the assessed variants where the ' +
    "report's situation forbids one; a value word (green, eco-friendly, sustainable, clearly better) " +
    'outside a quotation; an everyday comparison (car kilometres, households) or a claim about how ' +
    'consumers behave.\n' +
    '- The chapter talks about how the report was made — an AI, an assistant, a model, a tool, a check, ' +
    'a review, the software — in any language.\n' +
    '- It contradicts another chapter, or defines again what the plan says another chapter settles.',
  'Read each sentence as a fair reader of the report would: a sentence that is correct on a plain ' +
    'reading is correct, even if you would have put it differently. Do not raise an issue about style, ' +
    'length or wording that is correct — nor about how many sentences or paragraphs the assignment ' +
    'asked for. Do not ask for more content. Do not invent problems to look ' +
    'thorough: a false alarm costs a revision and can make a true sentence worse. If nothing is wrong, ' +
    'accept the chapter.',
  'Every figure in the chapter as printed was filled in from the data, and an automatic check has already ' +
    'looked at every figure typed by hand — the few it could not settle go to the author. Never raise an ' +
    'issue about how a figure is written — typed or from a placeholder — only about whether it belongs ' +
    'where it stands and whether the words around it are true.',
  'An automatic word check may have flagged some sentences; its notes are listed. It is often wrong. ' +
    'Judge each one yourself and raise it only if the sentence really is wrong.',
  'Ask the author a question only about the study itself — its goal, scope, assumptions, or a fact it does ' +
    'not record — where neither the data nor the study settles it and the answer changes what the chapter ' +
    'may say: the study record and the model disagree about whether a stage is included, say. Give your ' +
    'proposed answer. Never ask about wording, about which of two figures to use, or about why a lookup ' +
    "shows a different number than the facts: the facts are the report's figures, a lookup may measure " +
    "something else, and settling that is the writer's job — raise it as an issue if the chapter gets it wrong.",
  'Reply with JSON only:\n' +
    '{"verdict": "accept" | "revise", ' +
    '"issues": [{"quote": "<words copied exactly from the printed chapter, enough to be unique>", ' +
    '"problem": "<what is wrong>", "evidence": "<the fact, figure or study text that shows it>", ' +
    '"fix": "<what the sentence should say instead>"}], ' +
    '"questions": [{"question": "…", "why": "…", "proposal": "<your proposed answer>", "options": ["…", "…"]}]}\n' +
    '"verdict" is "accept" exactly when "issues" is empty.'
].join('\n\n')

/** The first reading's user turn: everything the reader judges against, the chapter last. */
export function readerBrief(brief: ReviewBrief, lookups: Lookup[], hints: Finding[]): string {
  const parts = [
    `Chapter: ${brief.title || brief.kind || 'chapter'} (written in ${brief.language || 'English'})`,
    '',
    'Assignment the chapter was written to:',
    brief.assignment || '(none)',
    ...(brief.cautions?.length
      ? ['', "The report's own situation:", ...brief.cautions.map((c) => `- ${c}`)]
      : []),
    '',
    'Study record (JSON):',
    JSON.stringify(brief.study ?? {}, null, 1),
    ...(brief.author_answers?.length
      ? [
          '',
          'The author has answered these questions (part of the study record):',
          ...brief.author_answers.map((a) => `- ${a.question} — ${a.answer}`)
        ]
      : []),
    '',
    'Facts and numbers the writer had (JSON):',
    JSON.stringify(brief.facts ?? {}, null, 1),
    ...(brief.document_plan && Object.keys(brief.document_plan).length
      ? ['', 'The report plan (`this_one` is this chapter):', JSON.stringify(brief.document_plan, null, 1)]
      : []),
    ...(lookups.length
      ? [
          '',
          'What the writer looked up while writing:',
          ...lookups.map((l) => `- ${l.name}(${l.args})\n${forReader(l)}`)
        ]
      : ['', 'The writer looked nothing up.']),
    ...(brief.renders?.length
      ? [
          '',
          'Printed with the chapter (a sentence may point at these):',
          ...brief.renders.map((r) => `- ${r.kind}: ${r.shows}`)
        ]
      : []),
    ...(brief.siblings?.length
      ? ['', 'The other chapters, as printed:', ...brief.siblings.map((s) => `--- ${s.title} ---\n${s.text}`)]
      : []),
    ...(hints.length
      ? ['', 'Notes of the automatic word check (often wrong):', ...hints.map((h) => `- ${h.detail}`)]
      : []),
    '',
    'The chapter, as printed:',
    '<<<',
    brief.printed,
    '>>>'
  ]
  return parts.join('\n')
}

/** Whitespace and quote marks folded, so a quote that differs only in a curly apostrophe still counts. */
function folded(text: string): string {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Whether a quote is really the chapter's own words. */
export function quoted(quote: string, printed: string): boolean {
  const q = folded(quote).replace(/^[.…\s]+|[.…\s]+$/g, '')
  return q.length >= 3 && folded(printed).includes(q)
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v ?? '').trim()).filter(Boolean) : []
}

/** A stable id for a question, so the same question asked twice is one question. */
export function questionId(question: string): string {
  let h = 0
  for (const ch of folded(question)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0
  return `q-${(h >>> 0).toString(36)}`
}

/** Read a reply into a Reading; null when it is not the JSON asked for. */
export function parseReading(raw: string, printed: string): Omit<Reading, 'empty'> | null {
  const text = clean(raw)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  // A reading says something about the chapter: a verdict, its issues, or (on a follow-up) the points.
  // Any other object — `{"error": "…"}` from a provider in trouble — would pass as an acceptance.
  const reads =
    parsed.verdict === 'accept' ||
    parsed.verdict === 'revise' ||
    Array.isArray(parsed.issues) ||
    Array.isArray(parsed.points)
  if (!reads) return null
  const raised = Array.isArray(parsed.issues) ? (parsed.issues as Array<Record<string, unknown>>) : []
  const issues: RaisedIssue[] = []
  let dropped = 0
  for (const i of raised) {
    const quote = String(i?.quote ?? '').trim()
    const problem = String(i?.problem ?? '').trim()
    if (!problem) continue
    if (!quoted(quote, printed)) {
      dropped++
      continue
    }
    issues.push({
      quote,
      problem,
      evidence: String(i.evidence ?? '').trim() || undefined,
      fix: String(i.fix ?? '').trim() || undefined
    })
  }
  const questions: ReviewQuestion[] = (Array.isArray(parsed.questions) ? parsed.questions : [])
    .map((q) => q as Record<string, unknown>)
    .filter((q) => String(q?.question ?? '').trim())
    .map((q) => ({
      id: questionId(String(q.question)),
      question: String(q.question).trim(),
      why: String(q.why ?? '').trim() || undefined,
      proposal: String(q.proposal ?? '').trim() || undefined,
      options: strings(q.options).slice(0, 6)
    }))
  const points: PointVerdict[] = (Array.isArray(parsed.points) ? parsed.points : [])
    .map((p) => p as Record<string, unknown>)
    .map((p) => ({
      n: Number(p?.n),
      status: (['resolved', 'false_positive', 'open'] as const).find((s) => s === p?.status) ?? 'open',
      note: String(p?.note ?? '').trim() || undefined
    }))
    .filter((p) => Number.isInteger(p.n) && p.n > 0)
  return { accepted: issues.length === 0, issues, questions, points, dropped }
}

/**
 * Ask the reader once — and once more if it came back empty, unreadable or failed. `messages` is the
 * reader's own conversation, kept by the caller across readings so a second reading is a follow-up turn
 * (and reads its long first turn from the prompt cache where the provider has one).
 *
 * A failed call (a rate limit, a dropped connection) is an empty reading, not an error: the chapter it
 * was about is written and paid for, and the caller falls back to the gate deciding alone. Only a stop
 * is thrown on.
 */
export async function read(opts: {
  model: string
  messages: ChatMessage[]
  printed: string
  signal?: AbortSignal
  onCost?: CostSink
  maxTokens?: number
}): Promise<Reading> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string
    try {
      raw = await collectText({
        model: opts.model,
        messages: opts.messages,
        signal: opts.signal,
        onCost: opts.onCost,
        maxTokens: opts.maxTokens
      })
    } catch (e) {
      if (opts.signal?.aborted) throw e
      console.log(
        `[reader] ${opts.model}: call failed, attempt ${attempt + 1} — ${e instanceof Error ? e.message : String(e)}`
      )
      continue
    }
    if (opts.signal?.aborted) break
    const reading = parseReading(raw, opts.printed)
    if (reading) {
      opts.messages.push({ role: 'assistant', content: raw })
      return { ...reading, empty: false }
    }
    console.log(`[reader] ${opts.model}: unreadable reply (${raw.length} chars), attempt ${attempt + 1}`)
  }
  return { accepted: false, issues: [], questions: [], points: [], dropped: 0, empty: true }
}
