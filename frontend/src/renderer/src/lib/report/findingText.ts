/**
 * Why a chapter could not be finished, in the author's words.
 *
 * The gate's findings are written for the writer model — they name placeholders, paths and the fix in
 * the model's terms ("Write it as {{parameters.3.amount}} …"), and that was what the author read under a
 * chapter that could not be finished. One sentence per kind says what went wrong for a reader of the
 * report; the model's text stays available under "Details" for whoever wants to see it.
 */
import type { Finding } from '../../../../shared/ipc'

const PLAIN: Record<string, string> = {
  literal_number:
    'A number is typed into the text instead of being taken from the results, so it would not change when the model is recalculated.',
  unresolved_placeholder:
    'A placeholder points at a value this report does not have, so the document would print a gap there.',
  malformed_placeholder: 'A placeholder is written in a form the document cannot print.',
  unknown_reference: 'The text refers to a table or figure this report does not contain.',
  unit_mismatch: 'A unit written after a figure is not the unit the figure is in.',
  duplicated_unit: 'A unit or percent sign is written twice.',
  empty_chapter: 'The writer returned no text.',
  empty_answer: 'The writer returned no text.',
  emoji: 'The text contains emoji or symbols a report does not print.',
  self_reference: 'The text talks about how the report was made instead of about the study.',
  contradicted_claim: 'A comparison in the text contradicts the results.',
  ambiguous_comparison: 'A comparison in the text does not say clearly what it compares.',
  misbound_name: 'A name in the text does not match the figure printed next to it.',
  unsupported_fact: 'A statement rests on nothing the writer looked up or was given.',
  declaration_beside_label: 'A name is printed twice in a row.',
  prose_placeholder_in_sentence:
    'A whole paragraph from the data would be printed in the middle of a sentence.',
  check_failed: 'The check could not run, so the chapter was kept unchecked.',
  incomplete_answer: 'The writer’s answer broke off before the end.',
  update_failed: 'The update could not be applied to the chapter.',
  run_stopped: 'The run was stopped before the chapter was finished.'
}

/** One finding in the author's words — the model's own text where no sentence exists for its kind. */
export function plainFinding(f: Finding): string {
  return PLAIN[f.kind] ?? f.detail
}

/** Why a held draft is not the chapter, in the author's words: the first finding that stops a chapter
 *  (the list above names only those), else the first of any kind. */
export function plainReason(findings: Finding[] | undefined): string {
  const first = findings?.find((f) => f.kind in PLAIN) ?? findings?.[0]
  return first ? plainFinding(first) : 'It was not stored.'
}
