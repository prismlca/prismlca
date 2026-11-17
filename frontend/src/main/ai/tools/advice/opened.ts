// What counts as "opened": the datasets this run has read, and the markets read through a producer.
import type { ToolCtx } from '../context'
import {
  inspectedKey,
  linkedHotspots,
  needsALook,
  unopenedLinkedHotspots,
  type LinkedHotspot
} from './hotspots'

type DatasetRef = { database: string; code: string }

/**
 * The run's record of opened datasets (`ctx.inspected`), widened by the markets among `candidates` that
 * count as read because a producer behind them was read.
 *
 * The record holds exactly what `get_process_details` was called on. For a market that is the wrong
 * question: its own comment is boilerplate, the tool texts send the model to the producer behind it,
 * and a model that follows them reads the producers and links the market. Counting only the linked
 * dataset then reminds it, after every link, to open what it has read, and tells the reviewer as a
 * measured fact that the dataset was never looked at — a statement the model itself went on to repeat
 * about its own work. So a market is opened when it was read OR when one of the datasets it buys its
 * own product from was. Any it draws on, whatever its share: the reminder exists so that no input rests
 * on a name alone, and one producer read is past that. One level only — a market group is opened through
 * a member market, not through that market's producers.
 *
 * The record itself is not widened: it stays what was read, and the suppliers are asked for when the
 * question comes up, so a dataset read in an earlier turn (the record is seeded from the transcript)
 * counts the same way. Nothing read yet means no producer was read either, and the question is not
 * asked. Undefined when the run keeps no record.
 *
 * Throws when the app cannot say which producers stand behind the candidates. What that means is the
 * caller's to decide: a reminder may fall back to the record (openedDatasets), a statement of fact to
 * someone who cannot check it may not.
 */
export async function openedOrThrow(
  ctx: ToolCtx,
  candidates: DatasetRef[]
): Promise<Set<string> | undefined> {
  const read = ctx.inspected
  if (!read || !read.size) return read
  const open = new Map<string, DatasetRef>()
  for (const c of candidates) {
    const key = inspectedKey(c.database, c.code)
    if (!read.has(key)) open.set(key, { database: c.database, code: c.code })
  }
  if (!open.size) return read
  const answer = await ctx.api('POST', '/api/v1/model/market-suppliers', { datasets: [...open.values()] })
  const markets: unknown = answer?.markets
  if (!Array.isArray(markets)) throw new Error('the producers behind the linked markets could not be read')
  const opened = new Set(read)
  for (const m of markets) {
    const suppliers: unknown = m?.suppliers
    if (!Array.isArray(suppliers)) continue
    if (suppliers.some((s) => read.has(inspectedKey(String(s?.database), String(s?.code)))))
      opened.add(inspectedKey(String(m.database), String(m.code)))
  }
  return opened
}

/**
 * The same for a reminder: when the producers cannot be asked for, the record stands as it is. A
 * reminder too many is the harmless direction.
 */
export async function openedDatasets(
  ctx: ToolCtx,
  candidates: DatasetRef[]
): Promise<Set<string> | undefined> {
  try {
    return await openedOrThrow(ctx, candidates)
  } catch {
    return ctx.inspected
  }
}

/**
 * The biggest linked datasets of a result that are not opened in the sense above (see hotspots.ts).
 * `unsure` says what to do when the producers behind them cannot be asked for: "remind" lists every
 * dataset not read itself, "throw" passes the failure on.
 */
export async function unopenedHotspots(
  ctx: ToolCtx,
  tree: any,
  foregroundDb: string,
  unsure: 'remind' | 'throw' = 'remind'
): Promise<LinkedHotspot[]> {
  const big = needsALook(linkedHotspots(tree, foregroundDb))
  const opened = await (unsure === 'throw' ? openedOrThrow : openedDatasets)(ctx, big)
  return unopenedLinkedHotspots(tree, foregroundDb, opened)
}
