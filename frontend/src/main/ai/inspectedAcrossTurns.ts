/**
 * The record of opened datasets (`ctx.inspected`) from one turn of a chat to the next.
 *
 * Within a run, get_process_details files every dataset it reads under the database it was really
 * found in — `found_in` when the app fell back to the one background database because the call named
 * none, or resolved a name. The next turn used to rebuild that record from the call ARGUMENTS of the
 * carried transcript, which do not hold that: a dataset read by code alone came back filed under the
 * chat's own model, one read by name not at all. Both then counted as never opened — a link reminder,
 * a "not yet inspected" after the calculation and a "nobody looked at it" in the review dossier, all
 * three saying something false. Reading the results instead would hang on them still being there, and
 * compaction and the transcript's size bound drop old ones.
 *
 * So the record travels as itself: written with the transcript at every exit of a run, read back
 * when that transcript is carried. A transcript kept before the record was stored has none; for that
 * one turn the record is taken from the reads whose answers are still in it, and only from those —
 * what the next turn starts from is kept from then on, so a read that failed, was stopped or can no
 * longer be checked must not enter it as opened.
 *
 * A dataset of the model itself is filed under the model's name, and a model can be renamed: in the run
 * the record follows the rename (renameInspected), and the transcript stores the chat's own model's
 * datasets without its name, so a rename between turns (chats follow their model) keeps them too.
 * Names are compared exactly, as the backend stores them: `Bottle Glass` and `Bottle-Glass` can be two
 * models of one workspace, and a dataset read in one is not read in the other.
 */
import type { ChatMessage } from './providers/types'
import { datasetOfKey, inspectedKey } from './tools/advice/hotspots'

/** One opened dataset, as the transcript stores it; without `database` it is one of the chat's own model. */
export type InspectedDataset = { database?: string; code: string }

/** The record as the transcript stores it: one entry per dataset, in the order first read. */
export function inspectedForTranscript(
  record: ReadonlySet<string> | undefined,
  activeDb: string | null
): InspectedDataset[] {
  const out: InspectedDataset[] = []
  for (const key of record ?? []) {
    const ds = datasetOfKey(key)
    if (ds) out.push(ds.database === activeDb ? { code: ds.code } : ds)
  }
  return out
}

/** A model renamed in the run: the datasets opened in it are filed under its new name. */
export function renameInspected(record: Set<string> | undefined, was: string, now: string): void {
  if (!record || !now || was === now) return
  for (const key of [...record]) {
    const ds = datasetOfKey(key)
    if (!ds || ds.database !== was) continue
    record.delete(key)
    record.add(inspectedKey(now, ds.code))
  }
}

/** Add one dataset to the record when both halves are names; one without a database is the chat's model's. */
function addDataset(record: Set<string>, ds: unknown, activeDb: string | null = null): void {
  const database: unknown = (ds as { database?: unknown } | null)?.database ?? activeDb
  const code: unknown = (ds as { code?: unknown } | null)?.code
  if (typeof database === 'string' && database && typeof code === 'string' && code)
    record.add(inspectedKey(database, code))
}

/**
 * The datasets a transcript's get_process_details answers show as read. Every read answers with the
 * dataset's `activity`, which names the database it really came from and its code — a batch once per
 * code under `results`. A failed or stopped call answers `{error}`, a failed code of a batch the same
 * inside its entry, and a result compaction replaced is no longer JSON: none of them has an activity.
 */
function readsInResults(record: Set<string>, messages: readonly ChatMessage[]): void {
  const reads = new Set<string>()
  for (const m of messages)
    if (m.role === 'assistant')
      for (const tc of m.tool_calls ?? []) if (tc.function?.name === 'get_process_details') reads.add(tc.id)
  for (const m of messages) {
    if (m.role !== 'tool' || !m.tool_call_id || !reads.has(m.tool_call_id) || typeof m.content !== 'string')
      continue
    let answer: any
    try {
      answer = JSON.parse(m.content)
    } catch {
      continue
    }
    if (answer?.activity) addDataset(record, answer.activity)
    if (Array.isArray(answer?.results))
      for (const item of answer.results) if (item?.activity && !item.error) addDataset(record, item.activity)
  }
}

/**
 * Seed the run's record from the transcript it carries on: the stored record when the transcript has
 * one (an entry without a database is one of the chat's model, under the name it has now), otherwise
 * the reads its answers still show (see the module comment). No transcript, nothing
 * seeded — the turn is rebuilt from prose and the model has not seen those datasets in this context.
 */
export function seedInspected(
  record: Set<string> | undefined,
  carried: { messages: readonly ChatMessage[]; inspected?: unknown } | null,
  activeDb: string | null
): void {
  if (!record || !carried) return
  if (Array.isArray(carried.inspected)) for (const ds of carried.inspected) addDataset(record, ds, activeDb)
  else readsInResults(record, carried.messages)
}
