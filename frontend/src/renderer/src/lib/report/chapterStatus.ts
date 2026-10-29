/**
 * One state per chapter, in the author's words — the single answer the chapter list, the run plan and
 * the foot line all read.
 *
 * It replaces three systems that each spoke for themselves: the gate's remarks per run, the freshness
 * badges with their repair offers, and the release chips. What the author needs from a row is what to
 * do next, if anything; everything a model settles on its own stays out of it.
 */
import type { ReportSection, StoredReportFull, StoredReview } from './model'
import type { StaleChapter } from './staleness'

export type ChapterStateKind =
  | 'working'
  | 'unfinished'
  | 'blocked'
  | 'update'
  | 'input'
  | 'check'
  | 'new'
  | 'ready'
  | 'empty'

export interface ChapterState {
  kind: ChapterStateKind
  /** The chip's word; empty for the states that show no chip. */
  label: string
  /** One sentence: what this means and what to do about it. */
  title: string
}

/** The chapter's reading, while it still describes the text the chapter has. */
export function currentReview(section: ReportSection): StoredReview | null {
  const review = section.ai_review
  if (!review || !section.text_version || review.text_version !== section.text_version) return null
  return review
}

/** Questions a chapter's writer asked that nobody has answered yet. */
export function openQuestions(
  section: ReportSection,
  answers: StoredReportFull['answers']
): NonNullable<StoredReview['questions']> {
  return (currentReview(section)?.questions ?? []).filter((q) => !answers?.[q.id]?.answer)
}

/** Questions of this chapter that were answered after it was last written — it should hear the answer. */
export function answeredSince(section: ReportSection, answers: StoredReportFull['answers']): number {
  const review = currentReview(section)
  if (!review) return 0
  return review.questions.filter((q) => {
    const a = answers?.[q.id]
    return a?.answer && a.at > review.at
  }).length
}

/** The second reader's points still standing — the sentences it could not settle with the writer. */
export const openPoints = (section: ReportSection): number =>
  (currentReview(section)?.issues ?? []).filter((i) => i.status === 'open').length

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

export function chapterState(
  section: ReportSection,
  ctx: {
    stale?: StaleChapter
    /** A refused or unfinished text is held for this chapter, with the reason. */
    draftReason?: string | null
    /** It is being written or updated right now. */
    working?: 'write' | 'update' | null
    /** A setting this kind needs before it can be written at all. */
    blocker?: string | null
    answers?: StoredReportFull['answers']
  }
): ChapterState {
  if (ctx.working)
    return {
      kind: 'working',
      label: ctx.working === 'update' ? 'Updating…' : 'Writing…',
      title: 'A model is working on this chapter.'
    }
  if (ctx.draftReason != null)
    return {
      kind: 'unfinished',
      label: 'Couldn’t finish',
      title:
        `The writer could not finish this chapter${ctx.draftReason ? `: ${ctx.draftReason}` : '.'} ` +
        'Open it to see the draft, or write it again.'
    }
  if (ctx.blocker) return { kind: 'blocked', label: 'Needs a setting', title: ctx.blocker }
  if (!(section.text ?? '').trim()) return { kind: 'empty', label: '', title: '' }
  const remedy = ctx.stale?.remedy
  if (remedy === 'rewrite' || remedy === 'review' || answeredSince(section, ctx.answers))
    return {
      kind: 'update',
      label: 'Needs update',
      title:
        remedy === 'rewrite' || remedy === 'review'
          ? 'The model changed under this chapter. “Update report” brings it up to date.'
          : 'You answered a question this chapter asked. “Update report” works the answer in.'
    }
  const questions = openQuestions(section, ctx.answers).length
  if (questions)
    return {
      kind: 'input',
      label: plural(questions, 'Question', `${questions} questions`),
      title: 'The writer needs your answer — see the questions above the chapters.'
    }
  const points = openPoints(section)
  if (points)
    return {
      kind: 'check',
      label: plural(points, '1 point', `${points} points`),
      title:
        'The second reader still doubts a sentence here. Open the chapter to keep it as written or have it fixed.'
    }
  if (ctx.stale?.review === 'pending')
    return {
      kind: 'new',
      label: 'New',
      title: 'Written or changed since you last approved the report. Read it, then approve the report.'
    }
  return { kind: 'ready', label: '', title: '' }
}

/** How many chapters are in each state — the foot line's one sentence. */
export function stateCounts(states: ChapterState[]): Partial<Record<ChapterStateKind, number>> {
  const out: Partial<Record<ChapterStateKind, number>> = {}
  for (const s of states) out[s.kind] = (out[s.kind] ?? 0) + 1
  return out
}

/** The foot line when nothing is running: what is left to do, in order of what the author does next. */
export function stateSummary(counts: Partial<Record<ChapterStateKind, number>>): string {
  const n = (k: ChapterStateKind): number => counts[k] ?? 0
  const parts = [
    n('empty') ? `${n('empty')} ${plural(n('empty'), 'chapter', 'chapters')} to write` : '',
    n('unfinished') ? `${n('unfinished')} could not be finished` : '',
    n('update') ? `${n('update')} ${plural(n('update'), 'needs', 'need')} an update` : '',
    n('input') ? `${n('input')} ${plural(n('input'), 'has a question', 'have questions')} for you` : '',
    n('check') ? `${n('check')} with a point to check` : '',
    n('new')
      ? `${n('new')} new for you — approve the report once you have read ${plural(n('new'), 'it', 'them')}`
      : ''
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Up to date and approved'
}
