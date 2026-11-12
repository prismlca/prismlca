/**
 * Linking an input together with its formula (edit_exchange action="add"): the formula is checked before
 * anything is written, and a refusal says exactly what is left in the model.
 *
 * An add with an amount and a bad formula used to keep the link and report the refusal; a model that read
 * "refused" sent the add again and booked the input twice. Taking the link back afterwards was no cure
 * either — the removal is its own undo step, and undoing it brings the refused input back. So the formula
 * is evaluated first, read-only, and the write only starts once it can work.
 */
import type { ToolCtx } from '../context'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Refuses — before anything is written — a formula that cannot be evaluated: an unknown name, a slip in
 *  the syntax. Read-only: the evaluation stores nothing and leaves no trace in the undo history. */
export async function checkFormulaBeforeAdd(ctx: ToolCtx, database: string, formula: string): Promise<void> {
  try {
    await ctx.api('POST', '/api/v1/params/evaluate', { database, formula })
  } catch (e) {
    throw new Error(`${message(e)} — nothing was added; send the add again with a corrected formula.`)
  }
}

/**
 * The error for a formula that evaluated and was still refused on writing (a rule on its result, another
 * writer in between) — rare. Without an amount the link only carried the formula, a silent zero, so it is
 * taken back. With one it stays, and the message says so, with the way to correct it in place.
 */
export async function refusedOnWrite(
  e: unknown,
  link: { uid?: string; amount?: number; hasAmount: boolean; remove: () => Promise<unknown> }
): Promise<Error> {
  const removed =
    !link.hasAmount &&
    !!link.uid &&
    (await link.remove().then(
      () => true,
      () => false
    ))
  return new Error(
    removed
      ? `${message(e)} — nothing was added; send the add again with a corrected formula.`
      : `${message(e)} — the input WAS added (uid ${link.uid}${link.hasAmount ? `, amount ${link.amount}` : ''}) ` +
        `but its formula was refused; correct it with action="set_formula" on that uid instead of adding it again.`
  )
}
