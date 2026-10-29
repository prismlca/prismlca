/** What a chapter costs in model answers, and what makes an answer a chapter: patch, continuation, finish. */
import type { Finding } from '../../../shared/ipc'
import type { WriteBrief } from '../reportWriter'
import { lookupBudget, MAX_LOOKUPS } from './lookups'

/**
 * Apply `replace(old, new)` operations to a chapter, on the `str_replace` contract.
 *
 * Exact bytes, whitespace included — no fuzzy matching, because a near miss silently edits the wrong
 * sentence, the most expensive failure mode there is. A search string occurring more than once is
 * refused rather than guessed at; `all` makes the mass case explicit. A no-op is an error, not a
 * success. Every refusal names the next step, the lesson from the tool-argument guard: a rejection a
 * model cannot learn from produces a repeat loop.
 *
 * Returns the new text, or the reason it was refused — never a partially applied patch.
 */
export function applyPatch(
  text: string,
  ops: Array<{ old: string; new: string; all?: boolean }>
): { ok: true; text: string } | { ok: false; error: string } {
  let out = text
  if (!ops.length) return { ok: false, error: 'No replacements given.' }
  for (const [i, op] of ops.entries()) {
    const where = ops.length > 1 ? ` (replacement ${i + 1})` : ''
    if (!op.old)
      return { ok: false, error: `Empty search text${where}. Quote the passage you want to change.` }
    if (op.old === op.new) {
      return {
        ok: false,
        error: `Search and replacement are identical${where}. A patch that changes nothing is a mistake.`
      }
    }
    const first = out.indexOf(op.old)
    if (first < 0) {
      return {
        ok: false,
        error:
          `Not found${where}: ${JSON.stringify(op.old.slice(0, 80))}. It must match the chapter exactly, ` +
          'including spaces and punctuation — re-read the text and quote it verbatim.'
      }
    }
    if (!op.all && out.indexOf(op.old, first + op.old.length) >= 0) {
      return {
        ok: false,
        error:
          `Found more than once${where}: ${JSON.stringify(op.old.slice(0, 60))}. Include enough surrounding ` +
          'words to make it unique, or set "all": true if every occurrence should change.'
      }
    }
    // The replacer callback keeps `op.new` literal: a plain string still expands `$&`/`$'`-patterns,
    // and a model writing about "US$" would splice the matched text into the chapter.
    out = op.all ? out.split(op.old).join(op.new) : out.replace(op.old, () => op.new)
  }
  return { ok: true, text: out }
}

/** How many times a rejected chapter may be revised before the author is asked to look. */
export const MAX_REVISIONS = 2

/** How often a chapter cut off at the model's output limit is asked to go on. Two: a chapter that
 *  needs three continuations is not a chapter, and every one of them counts on the clock and the bill. */
export const MAX_CONTINUATIONS = 2

/** The one extra answer a model that only ever called tools is made to give ("write the chapter now"). */
export const FORCED_ANSWERS = 1

/**
 * How many model answers one chapter waits for, one after another: a round per allowed lookup, the
 * round that finally writes the prose, and up to `MAX_REVISIONS` goes at the gate's objections.
 *
 * Derived from the constants rather than written down as a number, so the backstop moves along when
 * somebody changes the lookup allowance or the revision limit — the flat ten minutes it replaces did
 * not, and the longest chapter of a live run already took 324 s of them (V185).
 *
 * The result looks large, and that is right: the outer clock is not the tool against slowness. A
 * stream that has really hung is caught by `streamChat`'s stall guard after 180 s, long before this.
 * What is left for the outer clock is the case where nobody is watching any more — and a chapter cut
 * off by it is a chapter that was paid for and lost.
 */
export function sectionAnswers(brief: WriteBrief): number {
  // …the continuations a chapter cut off at the output limit may ask for, and the one
  // forced answer a model that only ever called tools is made to give — with no lookups
  // allowed the chapter could still take five answers while the clock counted three.
  return lookupBudget(brief) + 1 + FORCED_ANSWERS + MAX_REVISIONS + MAX_CONTINUATIONS
}

/**
 * The same count for a chapter whose brief has not been fetched yet. "Write all" sets its clock from
 * the plan, before it knows what any chapter reports on, so it has to assume the wider allowance.
 */
export const MAX_SECTION_ANSWERS = MAX_LOOKUPS + 1 + FORCED_ANSWERS + MAX_REVISIONS + MAX_CONTINUATIONS

/** Finish reasons that mean "the model was done": OpenRouter's and OpenAI's spellings. */
const COMPLETE_FINISH = new Set(['stop', 'end_turn', 'tool_calls', 'completed'])

/**
 * Why an answer is not a chapter — or null when it is one. Exported for the tests; the wording is
 * what the author reads under a chapter that stayed a draft.
 */
export function incompleteReason(finish: string | null, text: string): Finding | null {
  if (!text.trim()) {
    return {
      kind: 'empty_answer',
      detail:
        `The model returned no text (finish: ${finish ?? 'none'}). Nothing was checked or stored — ` +
        'the chapter is as it was. Try again, or pick another writing model under Settings → AI → Models.'
    }
  }
  if (finish === null) {
    return {
      kind: 'incomplete_answer',
      detail:
        'The answer ended without a completion signal from the model — the connection may have ' +
        'dropped mid-answer. What arrived is kept as a draft; it was not checked and not stored. Write ' +
        'the chapter again.'
    }
  }
  if (finish === 'length') {
    return {
      kind: 'incomplete_answer',
      detail:
        `The model hit its output limit ${MAX_CONTINUATIONS + 1} times over and the chapter is still ` +
        'not finished. What arrived is kept as a draft; it was not checked and not stored. Shorten the ' +
        'assignment, or pick a model with a larger output window.'
    }
  }
  if (!COMPLETE_FINISH.has(finish)) {
    return {
      kind: 'incomplete_answer',
      detail:
        `The model stopped for “${finish}” instead of finishing. What arrived is kept as a draft; it ` +
        'was not checked and not stored.'
    }
  }
  return null
}

/**
 * Append a continuation, dropping the overlap a model produces when it "continues" by repeating its
 * last words. The longest suffix of `head` (up to 200 characters, at least 8 — a word or two) that
 * `tail` starts with is taken as that overlap.
 */
export function joinContinuation(head: string, tail: string): string {
  const trimmedTail = tail.replace(/^\s+/, '')
  for (let n = Math.min(200, head.length); n >= 8; n--) {
    if (trimmedTail.startsWith(head.slice(-n))) return head + trimmedTail.slice(n)
  }
  const glue = /\s$/.test(head) || /^[.,;:!?)]/.test(trimmedTail) ? '' : ' '
  return head + glue + trimmedTail
}
