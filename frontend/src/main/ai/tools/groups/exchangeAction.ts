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
  throw new Error(
    `Missing "action". Expected one of: ${EXCHANGE_ACTIONS.join(', ')}. ` +
      `It may be passed ONCE at call level, where it applies to every item of "exchanges".`
  )
}
