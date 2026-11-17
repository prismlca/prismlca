// The reminder edit_exchange gives at link time: background datasets linked here that nobody has opened.
import type { ToolCtx } from '../context'
import { S } from '../format'
import { inspectedKey } from './hotspots'
import { openedDatasets } from './opened'

export type LinkedInput = { name?: string; database: string; code: string }

/** Most datasets one link call names in its reminder; a 20-item batch should not echo 20 rows. */
export const UNOPENED_LINKS_SHOWN = 12

/**
 * The reminder at link time, one step before the one explain_result gives. That one speaks after a
 * calculation — by then the dataset is linked, scaled and often commented, and a hose-cart run's own
 * critique was "never opened the PP market (36 %)": the check came after the building. Here the share
 * is not known yet, so the reminder names every unopened link of THIS call and leaves the judgement
 * which of them will carry the result with the model; the post-calculation list stays the backstop
 * with real shares. Datasets of the model itself are not background and are left out. `opened` is the
 * run's record as openedDatasets widens it — a market whose producer was read is not named.
 */
export function unopenedLinks(
  linked: LinkedInput[],
  foregroundDb: string,
  opened: Set<string> | undefined
): LinkedInput[] {
  if (!opened) return []
  const seen = new Set<string>()
  return linked.filter((l) => {
    const key = inspectedKey(l.database, l.code)
    if (l.database === foregroundDb || opened.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * What edit_exchange says beside a link to a background dataset nobody has opened. Without it, models
 * moved on after linking — searching for the next input or asking the user about masses — and opened
 * nothing; with it, they open the carrying datasets (say PP, steel and moulding of a hose cart) in one
 * call. It must not override the plan: small auxiliaries after the main materials were checked are left
 * alone, and the last sentence keeps a user's "don't spend calls on checking" above the nudge — without
 * it the nudge won; with it the model calculates and flags the unopened inputs as provisional.
 */
export const openBeforeRelying = (n: number): string =>
  `You linked ${n} background dataset(s) this chat has not opened yet (not_yet_opened). Open the ones ` +
  'that will carry the result — the main material, the energy, anything you expect at a tenth of the ' +
  'total or more — with get_process_details before you build further on them (one call takes a ' +
  '"codes" list; summary=true shows the biggest inputs): a name does not say what a dataset contains or ' +
  'what it was built for. Small auxiliaries can wait; after calculating, explain_result names the ' +
  'unopened ones that turned out to matter. If the user has told you not to check datasets, follow ' +
  'that, and name the unopened ones in your answer.'

/**
 * What stands in the paragraph's place from the second reminder of a run on. Not nothing: with the
 * paragraph still in view a test model acted on the bare list as it should, but with the paragraph
 * compacted away the same list was once passed over for a dataset not yet linked and once answered by
 * opening everything in sight. This sentence alone brought back the two main materials, and left two
 * small auxiliaries for after the calculation.
 */
export const OPEN_BEFORE_RELYING_AGAIN =
  'Open the ones that will carry the result with get_process_details before you build further on ' +
  'them; small auxiliaries can wait.'

/**
 * An edit_exchange answer with the reminder added, when the call linked something unopened.
 *
 * The list rides on every such answer; the paragraph explaining it only on the first of a run, one
 * sentence after that. A model that builds first and checks afterwards links a dozen inputs in a row,
 * and the same 630 characters came back on nine of thirteen answers of one run — 5,700 characters
 * saying one thing, which that run's model called constant noise and read past. The list is what
 * changes from call to call. A new turn of a chat is a new run and explains in full once more.
 */
export async function withLinkReminder(
  out: string,
  linked: LinkedInput[],
  foregroundDb: string,
  ctx: ToolCtx
): Promise<string> {
  // First against the record as it stands, so the app is asked only about links that are open on it.
  const unreadItself = unopenedLinks(linked, foregroundDb, ctx.inspected)
  if (!unreadItself.length) return out
  const unread = unopenedLinks(unreadItself, foregroundDb, await openedDatasets(ctx, unreadItself))
  if (!unread.length) return out
  let parsed: unknown
  try {
    parsed = JSON.parse(out)
  } catch {
    return out
  }
  const explain = !ctx.linkReminderExplained
  ctx.linkReminderExplained = true
  return S({
    ...(parsed as object),
    not_yet_opened: unread.slice(0, UNOPENED_LINKS_SHOWN),
    ...(unread.length > UNOPENED_LINKS_SHOWN
      ? { not_yet_opened_more: unread.length - UNOPENED_LINKS_SHOWN }
      : {}),
    open_before_relying: explain ? openBeforeRelying(unread.length) : OPEN_BEFORE_RELYING_AGAIN
  })
}
