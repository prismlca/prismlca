/**
 * The run's record of which LCIA indicators it has scored, per model.
 *
 * Read by the review dossier, which otherwise named only the one method its hotspot analysis used. In a
 * run that had scored eight indicators, the reviewer was told about climate change alone, objected that
 * a goal of "potential environmental impacts" did not fit a single indicator, and the assistant narrowed
 * the study's goal to match — without asking the user.
 *
 * What counts is what a call's RESULT scored: an indicator that failed inside a batch, a call that was
 * refused, or a background job that has not delivered yet, is not coverage, and the dossier states the list
 * as a fact. The arguments only say which model a call was about, never that it scored anything: a call
 * whose result cannot be read records nothing. So the record travels to the next turn as itself, with the
 * transcript (`scored`), like the record of opened datasets (inspectedAcrossTurns.ts) — rebuilt from the
 * carried calls, it lost every indicator whose result compaction had replaced, and when it fell back to
 * the arguments instead, a refused calculation came back as a scored one. Models are filed under their
 * folded name, the way the backend resolves `bottle glass` to `Bottle Glass`, so a call and the review
 * that reads it agree. A model renamed takes its indicators along: in the run (renameScored), and between
 * turns because the transcript stores the chat's own model without its name.
 */
import { foldDbName } from '../../modelScope'

/** Per model (folded database name): indicator key → how the dossier names it. */
export type ScoredRecord = Map<string, Map<string, string>>

/** The tools whose calls score indicators for a model, and where each names its subject's model. */
const SCORING_TOOLS: Record<string, (args: Record<string, unknown>, activeDb: string | null) => string[]> = {
  calculate: (a, db) => own(a.database, db),
  explain_result: (a, db) => own(a.database, db),
  compare_scenarios: (_a, db) => (db ? [db] : []),
  compare: (a) =>
    Array.isArray(a.subjects)
      ? a.subjects.map((s) =>
          s && typeof s === 'object' ? String((s as { database?: unknown }).database ?? '') : ''
        )
      : [],
  setup_results: (a, db) =>
    Array.isArray(a.subjects)
      ? a.subjects.map((s) =>
          s && typeof s === 'object' ? String((s as { database?: unknown }).database ?? db ?? '') : ''
        )
      : db
        ? [db]
        : []
}

const own = (database: unknown, activeDb: string | null): string[] => {
  const db = typeof database === 'string' && database ? database : activeDb
  return db ? [db] : []
}

const isTuple = (m: unknown): m is string[] =>
  Array.isArray(m) && m.length > 0 && m.every((x) => typeof x === 'string' && x.trim() !== '')

/** The key a method tuple is filed under — for callers that add tuples of their own. */
export const scoredKey = (method: string[]): string => JSON.stringify(method)

/** Deep enough for a batch of batches (`results[i].result.results[j].method`), not for a whole tree. */
const MAX_DEPTH = 5

/** Every method tuple a result carries, leaving out entries that failed (`ok: false`, an `error`). */
function methodsIn(node: unknown, out: Map<string, string>, depth = 0): void {
  if (depth > MAX_DEPTH || !node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const x of node) methodsIn(x, out, depth + 1)
    return
  }
  const o = node as Record<string, unknown>
  if (o.ok === false || (typeof o.error === 'string' && o.error)) return
  for (const [k, v] of Object.entries(o)) {
    if (k === 'method' && isTuple(v)) out.set(scoredKey(v), v.join(' | '))
    // `methods: [[…], […]]` as setup_results answers, or `[{method, unit}]` as compare does.
    else if (k === 'methods' && Array.isArray(v))
      for (const m of v) {
        if (isTuple(m)) out.set(scoredKey(m), m.join(' | '))
        else methodsIn(m, out, depth + 1)
      }
    else methodsIn(v, out, depth + 1)
  }
}

/**
 * Note the indicators one call scored, under every model it scored them for. A no-op for other tools.
 * `result` is the call's answer; one that failed records nothing, and so does one that is not JSON.
 */
export function noteScored(
  record: ScoredRecord | undefined,
  tool: string,
  args: Record<string, unknown> | null | undefined,
  activeDb: string | null,
  result: string
): void {
  if (!record || !args || typeof args !== 'object' || !Object.hasOwn(SCORING_TOOLS, tool)) return
  const subjects = SCORING_TOOLS[tool](args, activeDb).filter(Boolean)
  if (!subjects.length) return
  const found = new Map<string, string>()
  try {
    methodsIn(JSON.parse(result), found)
  } catch {
    return
  }
  if (!found.size) return
  for (const db of new Set(subjects.map(foldDbName))) {
    const forDb = record.get(db) ?? new Map<string, string>()
    for (const [k, v] of found) forDb.set(k, v)
    record.set(db, forDb)
  }
}

/** A model renamed in the run: what was scored for it now belongs to its new name. */
export function renameScored(record: ScoredRecord | undefined, was: string, now: string): void {
  const from = foldDbName(was)
  const to = foldDbName(now)
  const moved = record?.get(from)
  if (!record || !moved || from === to) return
  record.delete(from)
  const forTo = record.get(to) ?? new Map<string, string>()
  for (const [k, v] of moved) forTo.set(k, v)
  record.set(to, forTo)
}

/** One scored indicator, as the transcript stores it; without `database` it is the chat's own model's. */
export type ScoredEntry = { database?: string; method: string[] }

/**
 * The record as the transcript stores it: one entry per model and indicator, in the order first seen. The
 * chat's own model goes without its name, so a rename between turns (chats follow their model) keeps it.
 */
export function scoredForTranscript(
  record: ScoredRecord | undefined,
  activeDb: string | null
): ScoredEntry[] {
  const own = activeDb ? foldDbName(activeDb) : null
  const out: ScoredEntry[] = []
  for (const [database, forDb] of record ?? [])
    for (const key of forDb.keys()) {
      let method: unknown
      try {
        method = JSON.parse(key)
      } catch {
        continue // not a method tuple's key: nothing to store
      }
      if (isTuple(method)) out.push(database === own ? { method } : { database, method })
    }
  return out
}

type CarriedMessage = {
  role: string
  content?: unknown
  tool_call_id?: string
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
}

/** The indicators a carried transcript's results show as scored, for a transcript stored without the record. */
function scoredInResults(
  record: ScoredRecord,
  messages: readonly CarriedMessage[],
  activeDb: string | null
): void {
  const results = new Map<string, string>()
  for (const m of messages)
    if (m.role === 'tool' && m.tool_call_id && typeof m.content === 'string')
      results.set(m.tool_call_id, m.content)
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const tc of m.tool_calls ?? []) {
      const name = tc.function?.name ?? ''
      if (!Object.hasOwn(SCORING_TOOLS, name) || !tc.id || !results.has(tc.id)) continue
      try {
        noteScored(record, name, JSON.parse(tc.function?.arguments || '{}'), activeDb, results.get(tc.id)!)
      } catch {
        // Unparseable arguments: one call fewer in the record.
      }
    }
  }
}

/**
 * Seed the run's record from the transcript it carries on: the stored record when the transcript has one
 * (an entry without a model is the chat's own, under the name it has now), otherwise the indicators its
 * results still show — only those, since what the next turn starts from is kept from then on. No
 * transcript, nothing seeded.
 */
export function seedScored(
  record: ScoredRecord | undefined,
  carried: { messages: readonly CarriedMessage[]; scored?: unknown } | null,
  activeDb: string | null
): void {
  if (!record || !carried) return
  if (!Array.isArray(carried.scored)) return scoredInResults(record, carried.messages, activeDb)
  for (const e of carried.scored) {
    const { database = activeDb, method } = (e ?? {}) as { database?: unknown; method?: unknown }
    if (typeof database !== 'string' || !database || !isTuple(method)) continue
    const db = foldDbName(database)
    record.set(db, (record.get(db) ?? new Map<string, string>()).set(scoredKey(method), method.join(' | ')))
  }
}

/** The indicators this run has scored for one model, in the order first seen. */
export function scoredFor(record: ScoredRecord | undefined, database: string): Map<string, string> {
  return new Map(record?.get(foldDbName(database)) ?? [])
}
