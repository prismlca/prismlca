/**
 * Which action an edit_exchange item asks for: the one it names, or — when it names none — the one its
 * fields leave no doubt about. A shape that fits two different edits is refused with both readings, never
 * guessed.
 */

export const EXCHANGE_ACTIONS = [
  'add',
  'set_amount',
  'set_formula',
  'set_comment',
  'remove',
  'replace_input'
] as const

export type ExchangeAction = (typeof EXCHANGE_ACTIONS)[number]

/**
 * A uid names an exchange that already exists, and an input_code with a number or a formula reads like an
 * "add". Together, without an action, they used to become an add that ignored the uid: a run that meant to
 * put formulas on 14 existing exchanges got 14 new ones beside them, a success answer with 14 fresh uids,
 * and a result ten times too high. Neither reading is safe to pick, so the item is refused with both.
 */
function uidWithoutAction(uid: string, code: unknown): string {
  return (
    `No "action", and this item gives both a "uid" (${uid}) and an "input_code" (${String(code)}) — ` +
    'that fits two different edits, so nothing was done. The uid names an exchange that already exists: ' +
    'to change it, send action "set_amount", "set_formula" or "set_comment" with the uid (or ' +
    '"replace_input" with new_input_code to swap its dataset). To add a further exchange from this input, ' +
    'send action "add" without a uid. In a batch, one "action" at the top level applies to every item.'
  )
}

/**
 * A call that names no exchange at all — `exchanges: null` (dropped as empty before the tool) beside a
 * process and nothing else — used to be told `Missing "action"`. True, and beside the point: an action
 * added to the same call still names nothing to act on. Said as it is, before the action question; an
 * item that does name an exchange (a uid without an action) still hears about the action.
 */
const NAMES_NO_EXCHANGE =
  'This call names no exchange — no "exchanges" list (or an empty one), no "uid", no "input_code" — so ' +
  'nothing was done. To change an exchange, send its "uid" with an "action"; to add one, send action "add" ' +
  'with input_database, input_code and an amount or formula. For several, put them as items in "exchanges".'

/** Does an item carry anything that points at an exchange or says what to write into one? */
function namesAnExchange(it: any): boolean {
  if (!it || typeof it !== 'object') return false
  const said = (v: unknown): boolean => v !== undefined && v !== null && !(typeof v === 'string' && !v.trim())
  return ['uid', 'input_code', 'new_input_code', 'amount', 'formula', 'comment'].some((k) => said(it[k]))
}

export function actionOf(it: any): ExchangeAction {
  const named = String(it?.action ?? '').trim()
  if (named) {
    // `includes`, not a lookup in an object: "constructor" and "toString" are not actions.
    if ((EXCHANGE_ACTIONS as readonly string[]).includes(named)) return named as ExchangeAction
    throw new Error(`Unknown action "${named}". Expected one of: ${EXCHANGE_ACTIONS.join(', ')}.`)
  }
  const uid = typeof it?.uid === 'string' ? it.uid.trim() : ''
  if (uid && it?.input_code) throw new Error(uidWithoutAction(uid, it.input_code))
  // An item that names an input and says what it is worth can only be an "add", and this guesses so
  // rather than refusing. It used to demand an `amount` — which refused exactly the shape the tool asks
  // for, because a FORMULA *is* the amount. Measured in a real run: 21 exchanges in one call, the 3
  // carrying a number went through and the 18 carrying a formula came back as `Missing "action"`,
  // costing a round and 9,336 characters of error to say one thing.
  if (it?.input_code && (it?.amount !== undefined || it?.formula)) return 'add'
  if (!namesAnExchange(it)) throw new Error(NAMES_NO_EXCHANGE)
  throw new Error(
    `Missing "action". Expected one of: ${EXCHANGE_ACTIONS.join(', ')}. ` +
      `It may be passed ONCE at call level, where it applies to every item of "exchanges".`
  )
}
