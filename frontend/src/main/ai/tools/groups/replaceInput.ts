/**
 * edit_exchange action="replace_input": the dataset behind an existing exchange swapped for another, with
 * what the exchange meant — amount, formula, comment, its own tags — carried over unless the call says
 * otherwise. Also the repeat check (the swap has already happened) and what the answer says about a
 * comment that was carried over.
 */
import type { ToolCtx } from '../context'
import { activityRoute } from '../../../../shared/processRoutes'
import { IMPL } from '../impl'

type Base = { activity_database: string; activity_code: string }

/** How much of a carried-over comment the answer quotes: enough to recognise what it says. */
const KEPT_COMMENT_CHARS = 200

/**
 * Said once per call when a comment was carried over. The answer used to report only
 * `kept_old.comment: true` — even where there had been no comment — and in one run the old comment went
 * on describing the dataset that had just been replaced, so the study document said something untrue.
 * The comment is quoted beside it so the caller judges it itself; a word list of "old dataset" terms
 * would not have caught that case. A comment about the amount that still holds stays as it is.
 */
export const KEPT_COMMENT_NOTE =
  'kept_comment is the comment of the replaced exchange, carried over unchanged to the new dataset. ' +
  'If it names the old dataset, its region or why it was chosen, correct it with action="set_comment"; ' +
  'if it is about the amount and still holds, leave it.'

function newCodeOf(it: any): string {
  const code = String(it?.new_input_code ?? '').trim()
  if (!code) throw new Error('action="replace_input" also requires: new_input_code.')
  return code
}

function quoted(comment: string): string {
  const text = comment.trim()
  return text.length > KEPT_COMMENT_CHARS ? `${text.slice(0, KEPT_COMMENT_CHARS).trimEnd()}…` : text
}

async function exchangesOf(ctx: ToolCtx, db: string, activityCode: string): Promise<any[]> {
  const detail = await ctx.api('GET', activityRoute(db, activityCode))
  return detail?.exchanges ?? []
}

/**
 * The answer for a replacement that has already happened, or null. Doing it twice is the same as doing it
 * once: when nothing carries the old input any more but something already carries the NEW one, "No exchange
 * on this process has input X" would send the caller hunting for a wrong code instead of telling it the job
 * is done. Measured in a real run: a repeated batch cost two refused items and a round, on a model that was
 * already correct.
 */
export async function alreadyReplaced(
  ctx: ToolCtx,
  db: string,
  activityCode: string,
  it: any
): Promise<Record<string, unknown> | null> {
  const wanted = newCodeOf(it)
  const rows = (await exchangesOf(ctx, db, activityCode)).filter((e: any) => e?.type !== 'production')
  const oldCode = typeof it?.input_code === 'string' ? it.input_code.trim() : ''
  const stillThere = it?.uid
    ? rows.some((e: any) => e.uid === it.uid)
    : rows.some((e: any) => e?.input?.code === oldCode)
  const already = rows.find((e: any) => e?.input?.code === wanted)
  if (stillThere || !already) return null
  return {
    uid: already.uid,
    input_code: wanted,
    amount: already.amount,
    formula: already.formula ?? null,
    already_replaced: true,
    note: 'Already points at the new input — an earlier call did this. Nothing was changed. Use action="set_comment" if only the comment is missing.'
  }
}

export interface Replacement {
  answer: Record<string, unknown>
  /** The new exchange as the backend answered it, and the database and type it was linked with. */
  exchange: any
  database: unknown
  type: unknown
}

/**
 * Swap the dataset behind exchange `uid`. Swapping one background dataset for another — the commonest repair
 * after a review — was five calls: search, find the exchange, remove it, add the replacement, restore the
 * amount. Four of those carried no decision, and dropping the old link before the new one is what made it
 * risky. Add first, then remove: a failure leaves the model as it was.
 */
export async function replaceInput(ctx: ToolCtx, base: Base, uid: string, it: any): Promise<Replacement> {
  const newCode = newCodeOf(it)
  const cur = (await exchangesOf(ctx, base.activity_database, base.activity_code)).find(
    (e: any) => e?.uid === uid
  )
  // What the exchange MEANT carries over unless the caller says otherwise; only the dataset behind it
  // changes. A replacement that silently reset the amount to 1 would be worse than the five calls it
  // replaces.
  const amount = it.amount ?? cur?.amount
  const formula = it.formula ?? cur?.formula ?? undefined
  const oldComment = typeof cur?.comment === 'string' && cur.comment.trim() ? cur.comment : undefined
  const keptComment = it.comment === undefined ? oldComment : undefined
  const comment = it.comment ?? oldComment
  // The input's own tags (its life-cycle phase) belong to the input, not to the dataset behind it.
  const tags: Record<string, string> | undefined =
    Array.isArray(cur?.tags) && cur.tags.length
      ? Object.fromEntries(cur.tags.map((t: any) => [t.dimension, t.value]))
      : undefined
  if (amount === undefined || amount === null)
    throw new Error('Could not read the old amount — pass "amount" explicitly.')
  const database = it.new_input_database ?? it.input_database ?? cur?.input?.database
  const type = it.type ?? cur?.type
  const made: any = await IMPL.add_exchange(
    { ...base, input_database: database, input_code: newCode, amount, type, ...(tags ? { tags } : {}) },
    ctx
  )
  const parsed = typeof made === 'string' ? JSON.parse(made) : made
  const newUid = parsed?.exchange?.uid
  let finalAmount = amount
  try {
    if (newUid && formula) {
      const set = await IMPL.set_exchange_formula({ ...base, uid: newUid, formula }, ctx)
      // The formula's own value, not the amount read before it was set.
      const parsedSet = typeof set === 'string' ? JSON.parse(set) : set
      if (typeof parsedSet?.exchange?.amount === 'number') finalAmount = parsedSet.exchange.amount
    }
    if (newUid && comment) await IMPL.set_exchange_comment({ ...base, uid: newUid, comment }, ctx)
  } catch (e) {
    // A formula the backend refuses must not leave the old AND the new input in the model: the
    // replacement is taken back out, the old one stays as it was.
    if (newUid) await IMPL.remove_exchange({ ...base, uid: newUid }, ctx).catch(() => {})
    throw e
  }
  await IMPL.remove_exchange({ ...base, uid }, ctx)
  return {
    exchange: parsed?.exchange,
    database,
    type,
    answer: {
      replaced: uid,
      uid: newUid,
      input_code: newCode,
      amount: finalAmount,
      formula: formula ?? null,
      // Same field, same meaning, same spelling as the "add" path: your comment was written. The only
      // field mentioning the comment was `carried_over.comment`, which is `false` EXACTLY WHEN one was
      // written — the opposite of how it reads next to `commented: true` on the sibling action. In that
      // run the model replaced two inputs successfully, read `comment: false`, replayed the whole batch
      // (two refused items and a round, because the old inputs were gone) and then set the comments a
      // third time.
      commented: Boolean(it.comment),
      kept_old: {
        amount: it.amount === undefined,
        formula: it.formula === undefined,
        comment: keptComment !== undefined
      },
      ...(keptComment !== undefined ? { kept_comment: quoted(keptComment) } : {})
    }
  }
}
