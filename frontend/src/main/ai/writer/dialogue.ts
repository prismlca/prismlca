/**
 * The conversation a drafted chapter goes through before it is stored: the contract check, then a
 * second reader, then the writer's answer to the reader, then the reader again.
 *
 * Two parties with different jobs, the evaluator–optimizer shape. The backend gate keeps what only
 * arithmetic can decide — placeholders, units, references, typed numbers — and blocks on it whoever
 * has read the text. Everything the gate can only guess at from word lists (a rank word, a name in
 * front of a figure, a quoted dataset) goes to the reader as a suspicion, and the reader decides. The
 * writer may answer a point by fixing the sentence or by saying why it is right; the reader then
 * closes the point, calls it a false alarm, or holds it. What is still open after the last reading is
 * kept with the chapter for the author, not thrown at them as a refusal.
 *
 * Without a reader (switched off, none configured, or it came back empty) the gate decides alone,
 * exactly as it did before the reader existed: every finding outside the advisory set blocks.
 */
import type { ChatMessage } from '../providers/types'
import { collectText } from '../stream'
import type { CostSink } from '../subagent'
import type { ToolCtx } from '../tools'
import type {
  ChapterReview,
  Finding,
  Lookup,
  ReviewIssue,
  ReviewQuestion,
  WritePhase
} from '../../../shared/ipc'
import type { WriteBrief } from '../reportWriter'
import { applyPatch, MAX_REVISIONS } from './answers'
import { READER_SYSTEM, read, readerBrief, type RaisedIssue, type ReviewBrief } from './reviewer'
import { flaggedSentences, sentenceRepairPrompt, withinFlagged } from './sentences'
import { clean, parseRevision } from './text'

/**
 * The gate's findings no reader can overrule (engine/report_review.CONTRACT_FINDINGS). Kept in step by
 * name, like the advisory list; a parity test reads the backend's set.
 */
export const CONTRACT_FINDINGS = new Set([
  'unresolved_placeholder',
  'malformed_placeholder',
  'unknown_reference',
  'unit_mismatch',
  'duplicated_unit',
  'literal_number',
  'empty_chapter',
  'emoji'
])

/**
 * Findings the gate raises but does not block on when it decides alone
 * (report_prompts.ADVISORY_FINDINGS), plus the frontend-born `figure_refused`.
 */
export const ADVISORY_FINDINGS = new Set([
  // The declaration beside its own label (V434): the document folds it, the author hears about it.
  'declaration_beside_label',
  'unverifiable_claim',
  'value_judgement',
  'weak_difference',
  'antithesis_habit',
  'repaired_literal',
  'chapter_long',
  'prose_placeholder_in_sentence',
  // Frontend-born: a refused figure spec keeps the chapter and drops the chart.
  'figure_refused'
])

/** How often the reader reads one chapter, and so how often the writer answers it (one fewer). */
export const MAX_READINGS = 3

export interface DialogueOpts {
  text: string
  figure: Record<string, unknown> | null
  lookups: Lookup[]
  brief: WriteBrief
  /** The writer's model and its conversation so far — revisions continue it. */
  model: string
  messages: ChatMessage[]
  /** The second reader. Absent = the gate decides alone. */
  reviewModel?: string
  api: NonNullable<ToolCtx['api']>
  checkPath: string
  reviewPath?: string
  runId?: string
  signal?: AbortSignal
  onCost?: CostSink
  maxTokens?: number
  tick: (p: WritePhase, changed?: boolean) => void
  assertLive: () => void
  /** Kept current with every change, so a stop mid-conversation keeps the latest text as a draft. */
  onDraft: (text: string) => void
}

export interface DialogueResult {
  text: string
  figure: Record<string, unknown> | null
  /** The last verdict's findings. Blocking ones mean the chapter could not be finished. */
  findings: Finding[]
  /** Model answers the writer gave: the draft plus every revision. */
  attempts: number
  /** The reading, when one ran; the proposal sends it on as `review` with `reviewed_by`. */
  review: ChapterReview | null
}

interface Verdict {
  ok: boolean
  findings: Finding[]
}

/** A point of the reading, numbered across readings, with how it stands. */
type Point = RaisedIssue & { n: number; status: ReviewIssue['status']; resolution?: string }

const kindsOf = (findings: Finding[]): Set<string> => new Set(findings.map((f) => f.kind))

/** Read the writer's answer to a reading: replacements or a whole chapter, plus disputed points. */
export function parseAnswer(
  raw: string
): { edit: ReturnType<typeof parseRevision>; disputes: Array<{ point: number; why: string }> } | null {
  const edit = parseRevision(raw)
  let disputes: Array<{ point: number; why: string }> = []
  const text = clean(raw)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
      if (Array.isArray(parsed.disputes)) {
        disputes = (parsed.disputes as Array<Record<string, unknown>>)
          .map((d) => ({ point: Number(d?.point), why: String(d?.why ?? '').trim() }))
          .filter((d) => Number.isInteger(d.point) && d.why)
      }
    } catch {
      // parseRevision has already said whether anything usable is in there
    }
  }
  return edit || disputes.length ? { edit, disputes } : null
}

function pointLines(points: Point[]): string[] {
  return points.map(
    (p) =>
      `${p.n}. "${p.quote}" — ${p.problem}` +
      (p.evidence ? ` Evidence: ${p.evidence}` : '') +
      (p.fix ? ` Suggested: ${p.fix}` : '')
  )
}

/** The writer's assignment after a reading: answer each point, by a fix or by a reason. */
export function answerPrompt(points: Point[], authorInstructions?: string): string {
  return [
    'A second reader checked the chapter against the data and the study. Points:',
    ...pointLines(points),
    '',
    'For each point, fix the sentence — or, if you are sure it is right, say why, pointing at the fact ' +
      'that shows it. Change nothing the points do not touch. The quotes are from the chapter as printed; ' +
      'your chapter has placeholders where the figures are, so quote YOUR text exactly in a replacement ' +
      'and keep its placeholders.',
    // A fix tends to add a qualifying clause, and two readings of them outgrew a three-paragraph brief.
    ...(authorInstructions
      ? [
          `A fix stays within the author's instructions for this chapter — ${authorInstructions} — so say it in as few words as it needs.`
        ]
      : []),
    'Reply with JSON only:',
    '{"replacements": [{"old": "<text from your chapter, verbatim>", "new": "<replacement>"}], ' +
      '"disputes": [{"point": 1, "why": "<the fact that shows the sentence is right>"}]}',
    'Either list may be empty. If the fixes cannot be expressed as replacements, reply with ' +
      '{"chapter": "<the whole corrected chapter>", "disputes": [...]} instead.'
  ].join('\n')
}

/** The reader's follow-up turn: what the writer said, and the chapter as it now prints. */
export function followUp(open: Point[], disputes: Map<number, string>, printed: string): string {
  return [
    'The writer has answered your points:',
    ...open.map((p) =>
      disputes.has(p.n)
        ? `${p.n}. Disputed — the writer says: ${disputes.get(p.n)}`
        : `${p.n}. Not disputed — changed where the writer agreed.`
    ),
    '',
    'The chapter now reads, as printed:',
    '<<<',
    printed,
    '>>>',
    '',
    'Judge each of these points: "resolved" (the sentence is right now), "false_positive" (the ' +
      'writer’s reason holds — it was right all along), or "open" (still wrong). Raise a new issue only ' +
      'if the revision made something wrong.',
    'Reply with JSON only:',
    '{"points": [{"n": 1, "status": "resolved" | "false_positive" | "open", "note": "…"}], ' +
      '"issues": [<new issues, same shape as before>], "questions": [<as before>]}'
  ].join('\n')
}

/**
 * Talk a drafted chapter through to a verdict. Never throws for a refusal — a chapter that could not
 * be finished comes back with its blocking findings, and the caller keeps it as a draft.
 */
export async function converse(opts: DialogueOpts): Promise<DialogueResult> {
  const { api, brief } = opts
  let text = opts.text
  let figure = opts.figure
  let attempts = 1
  let checks = 0
  let reviewer = opts.reviewModel || ''

  const check = async (candidate: string): Promise<Verdict> => {
    opts.tick({ phase: 'checking' }, true)
    checks += 1
    const verdict = (await api('POST', opts.checkPath, {
      text: candidate,
      store: false,
      lookups: opts.lookups,
      figure,
      run: opts.runId,
      attempt: checks,
      snapshot_id: brief.snapshot_id,
      ...(reviewer ? { reviewed_by: reviewer } : {})
    })) as { ok?: boolean; findings?: Finding[] } | null
    const findings = (verdict?.findings ?? []) as Finding[]
    if (figure && findings.some((f) => f.kind === 'figure_refused')) figure = null
    return { ok: verdict?.ok !== false, findings }
  }
  const checkFailed = (e: unknown): Finding => ({
    kind: 'check_failed',
    detail: `The check could not run: ${e instanceof Error ? e.message : String(e)}. The chapter was kept, unchecked.`
  })
  /** What the writer has to fix before anyone reads on: the contract with a reader, else everything
   *  outside the advisory set. */
  const blocking = (findings: Finding[]): Finding[] =>
    findings.filter((f) => (reviewer ? CONTRACT_FINDINGS.has(f.kind) : !ADVISORY_FINDINGS.has(f.kind)))

  /** The writer's answer as a model call. Null when the call failed and the text should stand. */
  const ask = async (): Promise<string | null> => {
    try {
      const raw = await collectText({
        model: opts.model,
        messages: opts.messages,
        signal: opts.signal,
        onCost: opts.onCost,
        maxTokens: opts.maxTokens
      })
      opts.assertLive()
      attempts++
      return raw
    } catch (e) {
      // The correction call failing is not the chapter failing: the paid-for text stands.
      if (opts.signal?.aborted) throw e
      console.log(
        `[writer] revision call failed, keeping the text: ${e instanceof Error ? e.message : String(e)}`
      )
      return null
    }
  }

  /**
   * Revise until the gate has nothing blocking left, or the revisions run out. The findings go back
   * as a patch assignment: a chapter is 2000 characters and two of them are wrong, so a targeted
   * replacement is cheaper and keeps the sentences that were already right.
   */
  const repair = async (verdict: Verdict): Promise<Verdict> => {
    let pushFindings = true
    for (let revision = 0; revision < MAX_REVISIONS && blocking(verdict.findings).length; revision++) {
      opts.tick({ phase: 'revising', attempt: attempts + 1 }, true)
      if (pushFindings) {
        opts.messages.push({ role: 'assistant', content: text })
        opts.messages.push({
          role: 'user',
          content: [
            'The chapter was checked and refused. Findings:',
            ...blocking(verdict.findings).map((f) => `- ${f.detail}`),
            '',
            'Fix exactly these points and change nothing else. Reply with JSON only:',
            '{"replacements": [{"old": "<text to replace, quoted from the chapter verbatim>", "new": "<replacement>"}]}',
            'The search text must match the chapter exactly, including spaces, and occur only once — include ' +
              'surrounding words if needed. If a fix cannot be expressed as a replacement, reply with ' +
              '{"chapter": "<the whole corrected chapter>"} instead.'
          ].join('\n')
        })
      }
      pushFindings = true
      const raw = await ask()
      if (raw === null) break
      const parsed = parseRevision(raw)
      if (!parsed) break
      if ('chapter' in parsed) text = clean(parsed.chapter)
      else {
        const patched = applyPatch(text, parsed.replacements)
        if (!patched.ok) {
          // Handed back verbatim: it names the next step, so the model can retry properly.
          opts.messages.push({ role: 'assistant', content: raw })
          opts.messages.push({ role: 'user', content: `That patch was refused: ${patched.error}` })
          pushFindings = false
          continue
        }
        text = patched.text
      }
      opts.onDraft(text)
      try {
        verdict = await check(text)
      } catch (e) {
        return { ok: false, findings: [...verdict.findings, checkFailed(e)] }
      }
    }
    return verdict
  }

  /**
   * The repair for a revision that answered the reader: the sentences that carry the findings, quoted,
   * and replacements accepted only inside them — the rest of the answer stays as it was written
   * (writer/sentences.ts). Findings no sentence can be found for go the general way (`repair`).
   */
  const repairSentences = async (verdict: Verdict): Promise<Verdict> => {
    let pushPrompt = true
    for (let round = 0; round < MAX_REVISIONS && blocking(verdict.findings).length; round++) {
      const { sentences, unplaced } = flaggedSentences(text, blocking(verdict.findings))
      if (!sentences.length || unplaced.length) return repair(verdict)
      opts.tick({ phase: 'revising', attempt: attempts + 1 }, true)
      if (pushPrompt) {
        console.log(`[writer] ${brief.title}: repairing ${sentences.length} sentence(s) of the answer`)
        opts.messages.push({ role: 'assistant', content: text })
        opts.messages.push({ role: 'user', content: sentenceRepairPrompt(sentences) })
      }
      pushPrompt = true
      const raw = await ask()
      if (raw === null) break
      const parsed = parseRevision(raw)
      const refusal = !parsed
        ? 'That reply was not the JSON asked for.'
        : 'chapter' in parsed || !withinFlagged(parsed.replacements, sentences)
          ? 'That patch changes text outside the sentences listed. Replace only those sentences, each quoted exactly as "old".'
          : null
      const patched = refusal || !parsed || 'chapter' in parsed ? null : applyPatch(text, parsed.replacements)
      if (refusal || !patched?.ok) {
        opts.messages.push({ role: 'assistant', content: raw })
        opts.messages.push({
          role: 'user',
          content: `${refusal ?? `That patch was refused: ${patched && !patched.ok ? patched.error : ''}`}`
        })
        pushPrompt = false
        continue
      }
      text = patched.text
      opts.onDraft(text)
      try {
        verdict = await check(text)
      } catch (e) {
        return { ok: false, findings: [...verdict.findings, checkFailed(e)] }
      }
    }
    return verdict
  }

  const done = (verdict: Verdict, review: ChapterReview | null): DialogueResult => ({
    text,
    figure,
    findings: verdict.findings,
    attempts,
    review
  })

  let verdict: Verdict
  try {
    verdict = await check(text)
  } catch (e) {
    return done({ ok: false, findings: [checkFailed(e)] }, null)
  }
  verdict = await repair(verdict)
  if (!reviewer || !opts.reviewPath || blocking(verdict.findings).length) {
    return done(verdict, null)
  }

  // ---- the reading ---------------------------------------------------------------------------
  const firstHints = kindsOf(verdict.findings.filter((f) => !CONTRACT_FINDINGS.has(f.kind)))
  const readerMessages: ChatMessage[] = [{ role: 'system', content: READER_SYSTEM }]
  const points: Point[] = []
  const questions: ReviewQuestion[] = []
  const addQuestions = (qs: ReviewQuestion[]): void => {
    for (const q of qs) if (!questions.some((x) => x.id === q.id)) questions.push(q)
  }
  let readings = 0
  let disputes = new Map<number, string>()

  for (; readings < MAX_READINGS; ) {
    let reviewBrief: ReviewBrief
    try {
      reviewBrief = (await api('POST', opts.reviewPath, {
        text,
        lookups: opts.lookups,
        snapshot_id: brief.snapshot_id
      })) as ReviewBrief
    } catch (e) {
      console.log(`[reader] no review brief: ${e instanceof Error ? e.message : String(e)}`)
      break
    }
    const open = points.filter((p) => p.status === 'open')
    readerMessages.push({
      role: 'user',
      content:
        readings === 0
          ? readerBrief(
              reviewBrief,
              opts.lookups,
              verdict.findings.filter((f) => !CONTRACT_FINDINGS.has(f.kind))
            )
          : followUp(open, disputes, reviewBrief.printed)
    })
    readings++
    opts.tick({ phase: 'reviewing', round: readings }, true)
    const reading = await read({
      model: reviewer,
      messages: readerMessages,
      printed: reviewBrief.printed,
      signal: opts.signal,
      onCost: opts.onCost,
      maxTokens: opts.maxTokens
    })
    opts.assertLive()
    if (reading.empty) {
      readings--
      break
    }
    // One line per reading: what it raised, what it settled, what it dropped — the log is where a run
    // that "just worked" is read afterwards.
    console.log(
      `[reader] ${brief.title}: reading ${readings} by ${reviewer} — ${reading.issues.length} new point(s), ` +
        `${reading.points.filter((p) => p.status !== 'open').length} settled, ${reading.questions.length} question(s)` +
        (reading.dropped ? `, ${reading.dropped} dropped without a real quote` : '')
    )
    for (const v of reading.points) {
      const p = points.find((x) => x.n === v.n)
      if (p && p.status === 'open') {
        p.status = v.status
        p.resolution = v.note ?? (v.status === 'false_positive' ? disputes.get(v.n) : undefined)
      }
    }
    for (const issue of reading.issues) points.push({ ...issue, n: points.length + 1, status: 'open' })
    addQuestions(reading.questions)

    const stillOpen = points.filter((p) => p.status === 'open')
    if (!stillOpen.length || readings >= MAX_READINGS) break

    // ---- the writer answers ----
    opts.tick({ phase: 'revising', attempt: attempts + 1 }, true)
    opts.messages.push({ role: 'assistant', content: text })
    opts.messages.push({ role: 'user', content: answerPrompt(stillOpen, brief.author_instructions) })
    const raw = await ask()
    if (raw === null) break
    const answer = parseAnswer(raw)
    disputes = new Map((answer?.disputes ?? []).map((d) => [d.point, d.why]))
    const edit = answer?.edit
    if (edit) {
      const next =
        'chapter' in edit
          ? { ok: true as const, text: clean(edit.chapter) }
          : applyPatch(text, edit.replacements)
      if (next.ok) {
        const before = text
        text = next.text
        opts.onDraft(text)
        let after: Verdict
        try {
          after = await repairSentences(await check(text))
        } catch (e) {
          after = { ok: false, findings: [...verdict.findings, checkFailed(e)] }
        }
        if (blocking(after.findings).length) {
          // The answer broke the contract and even the sentence repair could not mend it: keep the text
          // the reader last read, whose contract held. Its open points stay open.
          text = before
          opts.onDraft(text)
          break
        }
        verdict = after
      } else {
        console.log(`[writer] ${brief.title}: answer patch refused — ${next.error}`)
      }
    }
    // The answer itself is not kept in the writer's conversation: the next turn shows the chapter as it
    // now stands, which is what the answer amounted to — the same shape the repair loop uses.
  }

  if (!readings) {
    // The reader produced nothing: the gate decides alone, as if no reader existed.
    reviewer = ''
    try {
      verdict = await repair(await check(text))
    } catch (e) {
      verdict = { ok: false, findings: [...verdict.findings, checkFailed(e)] }
    }
    return done(verdict, null)
  }

  const finalHints = kindsOf(verdict.findings.filter((f) => !CONTRACT_FINDINGS.has(f.kind)))
  const hints: ChapterReview['hints'] = {}
  for (const kind of firstHints) hints[kind] = finalHints.has(kind) ? { dismissed: 1 } : { fixed: 1 }
  return done(verdict, {
    reviewer,
    rounds: readings,
    issues: points.map(({ quote, problem, evidence, fix, status, resolution }) => ({
      quote,
      problem,
      evidence,
      fix,
      status,
      resolution
    })),
    questions,
    hints
  })
}
