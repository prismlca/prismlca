/**
 * Where an input code lives, for an edit_exchange "add" that came without input_database.
 *
 * The call still has to name the database: the write side does not pick one for the caller. But the
 * refusal used to stop at "also requires: input_database", and finding the database cost a round. It is
 * looked up on this error path only, through the read that already falls back on the one background
 * holding a code, and the refusal names the holder. Where the code sits in several databases or in none,
 * the backend's own not-found hint says so — it names only databases this caller may see.
 */
import type { ToolCtx } from '../context'

export async function missingInputDatabase(ctx: ToolCtx, db: string, code: unknown): Promise<string> {
  const wanted = typeof code === 'string' ? code.trim() : ''
  if (!wanted) return 'action="add" also requires: input_database and input_code.'
  const head = 'action="add" also requires: input_database.'
  try {
    const hit = await ctx.api(
      'GET',
      `/api/v1/model/activities/${encodeURIComponent(db)}/${encodeURIComponent(wanted)}?background_fallback=true`
    )
    const holder = typeof hit?.found_in === 'string' && hit.found_in ? hit.found_in : db
    const what = holder === db ? `a process of this model, '${db}'` : `a dataset of '${holder}'`
    return `${head} The code ${wanted} is ${what} — send input_database: "${holder}".`
  } catch (e) {
    return `${head} Looking the code up: ${e instanceof Error ? e.message : String(e)}`
  }
}
