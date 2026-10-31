/** The note an edit_parameter answer carries when a number it was sent did not replace a formula. */

/**
 * Parameters a write sent a number for that kept their formula. The formula wins (a strict schema fills
 * `value: 0` into every partial update, so reading any value as "replace the formula" would turn a
 * comment edit into a wiped formula), and the answer used to show the formula's result with no word on
 * why the number did not land: the model found out from the arithmetic and stored its constant AS a
 * formula. A zero is left out for the same reason — it is what an untouched field looks like.
 */
export function formulaKept(
  items: Array<{ name?: string; value?: number; formula?: string; clear_formula?: boolean }>,
  written: Array<{ name?: string; formula?: string | null }>
): { formula_kept: string[]; note: string } | null {
  const names = items
    .filter(
      (it) => !it.formula && it.clear_formula !== true && typeof it.value === 'number' && it.value !== 0
    )
    .filter((it) => written.find((p) => p?.name === it.name)?.formula)
    .map((it) => String(it.name))
  return names.length
    ? {
        formula_kept: names,
        note:
          'These parameters are computed by their formula, so the value you sent was not stored. To ' +
          'replace a formula with a fixed number, send the value again with clear_formula: true; to ' +
          'keep the formula, nothing to do.'
      }
    : null
}
