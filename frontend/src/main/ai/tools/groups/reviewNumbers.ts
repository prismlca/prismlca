/**
 * Whether anything a number depends on changed between a review and the outcomes recorded for it — so a
 * "fixed" after a mere rewording gets a note.
 *
 * The review log takes every outcome as given. In three runs findings about a figure were recorded as fixed
 * after only the comment beside it had been rewritten: the amount, the formula and the dataset were what the
 * reviewer had challenged, and none of them had moved. So each review remembers a fingerprint of the model's
 * numbers — amounts, formulas, inputs, tags and parameter values, no comments or names — and recording
 * outcomes compares it with the model as it stands. Equal means only text changed since; the answer then says
 * so, without refusing anything: a finding about the text itself (a comment that contradicted the model) is
 * rightly fixed by a text change. Memory only — after a restart the comparison is silent.
 */
import { createHash } from 'node:crypto'

/** Enough for every review of a long session; the oldest goes first. */
const MAX_REMEMBERED = 50
const judged = new Map<string, string>()

const listOf = (v: unknown): any[] =>
  Array.isArray(v) ? v : Array.isArray((v as any)?.activities) ? (v as any).activities : []

const tagsOf = (tags: unknown): string[] =>
  Array.isArray(tags) ? tags.map((t: any) => `${t?.dimension}=${t?.value}`).sort() : []

/** The model's numbers as one value: equal when no amount, formula, input, tag or parameter value changed. */
export function numbersFingerprint(activities: unknown, params: unknown): string {
  const processes = listOf(activities)
    .map((a: any) => ({
      code: a?.code,
      unit: a?.unit,
      tags: tagsOf(a?.tags),
      exchanges: (Array.isArray(a?.exchanges) ? a.exchanges : [])
        .map((e: any) => [
          e?.type,
          e?.amount,
          e?.formula ?? null,
          e?.input?.database ?? null,
          e?.input?.code ?? null,
          tagsOf(e?.tags)
        ])
        .map((row: unknown[]) => JSON.stringify(row))
        .sort()
    }))
    .sort((x, y) => String(x.code).localeCompare(String(y.code)))
  const values = (Array.isArray(params) ? params : [])
    .map((p: any) => [p?.name, p?.amount, p?.formula ?? null])
    .sort((x, y) => String(x[0]).localeCompare(String(y[0])))
  return createHash('sha256').update(JSON.stringify({ processes, values })).digest('hex')
}

/** Remember the numbers a logged review judged. */
export function rememberJudged(reviewId: unknown, fingerprint: string | null): void {
  if (typeof reviewId !== 'string' || !reviewId || !fingerprint) return
  judged.delete(reviewId)
  judged.set(reviewId, fingerprint)
  while (judged.size > MAX_REMEMBERED) judged.delete(judged.keys().next().value as string)
}

/** The numbers a review judged, if this session ran it. */
export const judgedNumbers = (reviewId: unknown): string | undefined =>
  typeof reviewId === 'string' ? judged.get(reviewId) : undefined

/** The note for outcomes recorded as fixed while only text changed since the review — or null. */
export function textOnlyNote(fixedIds: string[], judgedFingerprint: string, now: string): string | null {
  if (!fixedIds.length || judgedFingerprint !== now) return null
  const which = fixedIds.length === 1 ? `finding ${fixedIds[0]}` : `findings ${fixedIds.join(', ')}`
  return (
    `You recorded ${which} as fixed, but since that review no amount, formula, input, tag or parameter value ` +
    'of the model has changed — only text. A finding about a figure, a dataset or a missing input is not ' +
    'settled by rewording: change the model, or record it as rejected or open with the reason. A finding ' +
    'about the text itself — a comment or a study field that said something wrong — is fixed by the new ' +
    'text; then leave it as it is.'
  )
}

/** `answer` (the recorded outcomes) with the note added when it applies. ``readModel`` reads the model as it
 *  stands — only called when this session remembers the review and something was recorded as fixed. */
export async function withTextOnlyNote<T extends Record<string, unknown>>(
  answer: T,
  resolutions: unknown[],
  readModel: () => Promise<[unknown, unknown]>
): Promise<T & { note?: string }> {
  if (!answer || typeof answer !== 'object' || 'error' in answer) return answer
  const was = judgedNumbers(answer.id)
  const fixed = resolutions
    .filter((r: any) => r?.resolution === 'fixed')
    .map((r: any) =>
      typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `"${String(r.finding ?? '').slice(0, 60)}"`
    )
  if (!was || !fixed.length) return answer
  let now: string
  try {
    const [activities, params] = await readModel()
    now = numbersFingerprint(activities, params)
  } catch {
    return answer // the comparison is a courtesy; an unreadable model leaves the answer as it was
  }
  const note = textOnlyNote(fixed, was, now)
  if (!note) return answer
  return { ...answer, note: typeof answer.note === 'string' && answer.note ? `${answer.note} ${note}` : note }
}
