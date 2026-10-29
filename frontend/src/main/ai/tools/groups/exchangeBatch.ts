/**
 * How one edit_exchange call with an `exchanges` list becomes items: which top-level fields act as defaults
 * for every item, which name a single exchange and are reported instead of applied, and how an item that
 * took its input_database from the top level explains a "not found".
 *
 * A batch used to take *only* the items, so `activity_code` written once at the top — the obvious way to
 * say "all of these belong to this process" — was silently ignored and every item failed for want of a
 * process. It cost one run two rounds and 18 refused items.
 *
 * Top-level fields are now defaults and the item wins, but only for what is genuinely batch-wide: which
 * process is being edited, and what kind of edit it is. The fields that name *one* exchange stay out,
 * because spreading one of them across N rows is not a default, it is a different (and wrong) request —
 * one `uid` would point every item at the same exchange, one `amount` would overwrite N amounts with one
 * number.
 *
 * Those are reported, not refused. A run in practice wrote a batch-level `comment` ("PET body replaced with
 * bottle-grade granulate") beside per-item comments, and those calls *worked* — refusing them now would
 * break a working pattern to fix a broken one. The batch goes through and the answer names what did not
 * apply, because the defect here was silence, and trading it for a different silence would be no fix at all.
 */

export const BATCH_WIDE = [
  'activity_database',
  'activity_code',
  'activity_name',
  'location',
  'action',
  'type',
  'input_database'
] as const
const PER_EXCHANGE = ['uid', 'input_code', 'amount', 'formula', 'comment'] as const

export interface ExchangeBatch {
  items: any[]
  /** Per-exchange fields given at the top level, which apply to nothing. */
  ignored: string[]
  /** Items whose input_database came from the top level rather than from the item. */
  inheritedDb: WeakSet<object>
}

export function expandBatch(a: any): ExchangeBatch {
  const inheritedDb = new WeakSet<object>()
  if (!Array.isArray(a.exchanges) || !a.exchanges.length) return { items: [a], ignored: [], inheritedDb }
  const shared: Record<string, unknown> = {}
  for (const key of BATCH_WIDE) if (a[key] !== undefined) shared[key] = a[key]
  // Only what was actually SAID counts. A model that fills every schema field it does not use with "" or
  // 0 (GPT-5.6 does) used to trip this on EVERY batch — one run read the hint eleven times for fields
  // nobody had given (V335).
  const ignored = PER_EXCHANGE.filter((key) => {
    const v = a[key]
    return v !== undefined && v !== null && v !== '' && !(key === 'amount' && v === 0)
  })
  const items = a.exchanges.map((it: any) => {
    const item = { ...shared, ...it }
    if (shared.input_database !== undefined && it?.input_database === undefined) inheritedDb.add(item)
    return item
  })
  return { items, ignored, inheritedDb }
}

/** The note for per-exchange fields given at the top level, or null when there were none. */
export function ignoredNote(ignored: string[]): Record<string, unknown> | null {
  if (!ignored.length) return null
  return {
    not_applied: ignored,
    hint:
      `${ignored.map((k) => `"${k}"`).join(', ')} names a single exchange and was given for the ` +
      'whole batch, so it was not applied to anything. Put it on the items it belongs to. ' +
      `Fields that may sit at the top level and act as defaults: ${BATCH_WIDE.join(', ')}.`
  }
}

/**
 * The error of a failed item, with its cause when the input was not found in a database the item took from
 * the top level. A batch that links a process of the model and some background datasets under one top-level
 * input_database fails on the background rows with "not found in '<model>'" — which names the database but
 * not where it came from, so the cause took a round to find.
 */
export function explainNotFound(it: any, inheritedDb: WeakSet<object>, e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e)
  const ours =
    inheritedDb.has(it) && it.input_code && msg.includes(String(it.input_code)) && /not found/i.test(msg)
  if (!ours) return e instanceof Error ? e : new Error(msg)
  return new Error(
    `${msg} — This item took input_database "${it.input_database}" from the top level of the batch. ` +
      'If the input is a background or library dataset, give the item its own input_database.'
  )
}
