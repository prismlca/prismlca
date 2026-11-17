/**
 * The critic behind `review_model`: the reviewer's prompt, its default model, and the one call that has a
 * prepared dossier judged. How a pass is run — its clock, the restart, what survives a deadline — is
 * reviewRun.ts; what goes into the dossier is the tool's (tools/groups/review.ts).
 */
import { providerDefaults } from './models'
import { getActiveProvider } from './providers/state'
import { runReview, type ReviewResult } from './reviewRun'
import type { CostSink } from './subagent'

/** Model for the review pass. Reasoning about numbers matters more here than breadth of knowledge. */
/**
 * Default reviewer, same override. Being a DIFFERENT model from the chat is a feature rather than a
 * cost saving: in a live run the reviewer caught a wrong background dataset that
 * the model which had chosen it kept overlooking.
 */
export const REVIEW_MODEL = providerDefaults('openrouter').review

const REVIEW_SYSTEM = `You are a critical LCA reviewer. You are given a DOSSIER about one product
system — the structural health check, the biggest contributors, the goal & scope on record, and the
background datasets used. You cannot look anything up: judge only what is in the dossier.

Report what a reviewer would challenge, grouped as "Blocking", "Should fix" and "Worth a look".
Start every finding with its id — [F1], [F2], … numbered on through all three groups — so the
assistant can record what became of each one.
Rules:
- Every finding must quote the concrete number, process or dataset name from the dossier that
  prompted it. No quote, no finding — say "cannot judge from this dossier" instead.
- **A claim about a quantity must show its arithmetic.** If you say a count, a mass or a total is
  wrong, list the exchange amounts you added and the sum you got. Without that, put it under "Worth
  a look" and ask the question instead of asserting the error. "Blocking" is reserved for findings
  whose evidence you can quote in full. A wrong Blocking finding is expensive: on the 2026-08-13
  practice run a reviewer double-counted an initial battery, declared the bill of materials
  inconsistent (16 cells where the model books 8, which the exchange amounts show plainly), and cost
  a round to disprove — while its one correct point about a dataset was dismissed along with it,
  because the reason it gave for that one was also checkable and also wrong.
- If the dossier states that datasets carrying the result were never opened, that is a measured fact
  and belongs in your findings: a proxy defended by its name alone is not defended. Say what reading
  each one could still change.
- Where the dossier quotes what a dataset says about itself, read the sentence against the product
  under study and quote it back when it does not fit: a dataset that names another product class —
  a NiMH battery "for laptop applications" inside a garden lamp, a wiring board "for desktop and
  laptop computer" behind a 5-gram driver — is a finding even when the dataset's NAME looks generic,
  and it is the kind the assistant misses precisely because the name looked right.
- Check specifically: does the modelled system match the stated system boundaries and functional
  unit; are the background datasets plausible proxies for what they stand in for (geography,
  technology, reference year); is the impact method the right variant for the stated goal; do
  treatment/waste processes carry the sign you would expect; is a single hotspot so dominant that
  the whole result hinges on one assumption.
- If the goal & scope is empty, say so first: without it nothing else can be assessed properly.
- Be terse. No praise, no restating the dossier, no closing summary.`

/** The model a review goes to: the review model chosen in Settings, or the active provider's default. */
export const reviewerModel = (chosen?: string): string =>
  chosen || providerDefaults(getActiveProvider()).review

/**
 * Judge a prepared dossier: one model pass, no tools, no web search.
 *
 * Deliberately not an agent with its own read-only tools. The dossier is gathered deterministically
 * by the caller, which keeps the cost of a review fixed and predictable, makes it impossible for the
 * critic to touch anything, and means every finding is anchored to a figure we know we handed over.
 * The price is that it only sees what the caller collected.
 *
 * How the pass runs — its clock, the one restart, what survives a deadline — is reviewRun.ts. That a
 * pass can fail at all, and must say so, comes from a live picture-frame run: `review_model` ran for
 * 114 seconds, returned "The reviewer returned nothing.", and the model read that as "no findings" and
 * shipped a study whose headline was wrong by a factor of two. Hence the restart, the recorded
 * `finish_reason` and reasoning count, and an `outcome` that tells "found nothing" from "said nothing".
 */
export async function reviewDossier(opts: {
  dossier: string
  model?: string
  signal?: AbortSignal
  stop?: AbortSignal
  onCost?: CostSink
  onProgress?: (note: string) => void
}): Promise<ReviewResult> {
  return runReview({
    ...opts,
    system: REVIEW_SYSTEM,
    model: reviewerModel(opts.model)
  })
}
