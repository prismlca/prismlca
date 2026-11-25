import type { ToolCtx } from '../context'
import { activityRoute } from '../../../../shared/processRoutes'

/**
 * Whether an "add" of edit_exchange gives a process a further exchange from an input it already had.
 *
 * Two exchanges from one dataset both count in the result. Sometimes that is the model — two transport
 * legs on the same lorry — and sometimes it is an edit gone wrong: a run that meant to change 14 existing
 * exchanges added 14 new ones beside them, the answer said "succeeded 14", and the result stood at ten
 * times its value until the model found the pairs by reading the graph. So the answer of such an add lists
 * what the process already had from that input, as a hint the caller can act on, never as a refusal.
 *
 * The process is read once per call, before the call's first add to it, so a batch of twenty adds costs
 * one read; adds of the same input within the call are matched against each other as they land. A batch
 * may also remove or replace the exchange the hint names, so once every item has run the hints are checked
 * against the model as the call left it: what is gone is dropped, what was changed is shown as it is now.
 */

export interface SameInputRow {
  uid: string
  amount?: unknown
  formula?: string
  comment?: string
}

export interface SameInputWatch {
  /** Read the process's exchanges as they stood before this call added to it. Await it before adding. */
  before(process: string): Promise<void>
  /** After an add: put what the process already had from the same input on the add's answer, if anything. */
  after(
    answer: Record<string, unknown>,
    process: string,
    inputDb: unknown,
    inputCode: unknown,
    added: SameInputRow
  ): Promise<void>
  /** Once every item has run: check each hint against the model as the call left it. */
  settle(): Promise<void>
  /** Whether any answer of this call still carries a hint. */
  readonly seen: boolean
}

const COMMENT_CHARS = 100
const FIELD = 'same_input_already'

function row(e: any): SameInputRow {
  const comment = typeof e?.comment === 'string' ? e.comment.trim() : ''
  return {
    uid: String(e.uid),
    amount: e.amount,
    ...(e.formula ? { formula: String(e.formula) } : {}),
    ...(comment
      ? { comment: comment.length > COMMENT_CHARS ? `${comment.slice(0, COMMENT_CHARS - 1)}…` : comment }
      : {})
  }
}

export function watchSameInput(ctx: ToolCtx, db: string): SameInputWatch {
  const existing = new Map<string, Promise<Array<{ key: string; row: SameInputRow }>>>()
  const addedHere = new Map<string, SameInputRow[]>()
  const hinted: Array<{ answer: Record<string, unknown>; process: string }> = []
  const keyOf = (process: string, inputDb: unknown, inputCode: unknown): string =>
    JSON.stringify([process, String(inputDb ?? ''), String(inputCode ?? '')])

  const read = async (process: string): Promise<Array<{ key: string; row: SameInputRow }>> => {
    try {
      const detail = await ctx.api('GET', activityRoute(db, process))
      return (Array.isArray(detail?.exchanges) ? detail.exchanges : [])
        .filter((e: any) => e?.uid && e?.type !== 'production' && e?.input?.code)
        .map((e: any) => ({ key: keyOf(process, e.input.database, e.input.code), row: row(e) }))
    } catch {
      // The hint is a courtesy: a read that fails must not stop the add it would have commented on.
      return []
    }
  }

  return {
    before: async (process) => {
      if (!existing.has(process)) existing.set(process, read(process))
      await existing.get(process)
    },
    after: async (answer, process, inputDb, inputCode, added) => {
      if (!added.uid) return
      const key = keyOf(process, inputDb, inputCode)
      const rows = (await (existing.get(process) ?? Promise.resolve([])))
        .filter((r) => r.key === key)
        .map((r) => r.row)
      // From here to the push nothing awaits, so two adds of one input in the same batch see each other
      // in the order they land, and the later one is told about the earlier.
      const here = addedHere.get(key) ?? []
      const same = [...rows, ...here].filter(
        (r, i, all) => r.uid !== added.uid && all.findIndex((o) => o.uid === r.uid) === i
      )
      addedHere.set(key, [...here, row(added)])
      if (!same.length) return
      answer[FIELD] = same
      hinted.push({ answer, process })
    },
    settle: async () => {
      for (const process of new Set(hinted.map((h) => h.process))) {
        let now: Map<string, SameInputRow>
        try {
          const detail = await ctx.api('GET', activityRoute(db, process))
          const rows: any[] = Array.isArray(detail?.exchanges) ? detail.exchanges : []
          now = new Map(rows.filter((e) => e?.uid).map((e) => [String(e.uid), row(e)]))
        } catch {
          continue // the hint as it was taken: better than none, and the add itself stands
        }
        for (const { answer } of hinted.filter((h) => h.process === process)) {
          const left = (answer[FIELD] as SameInputRow[]).flatMap((r) => now.get(r.uid) ?? [])
          if (left.length) answer[FIELD] = left
          else delete answer[FIELD]
        }
      }
    },
    get seen() {
      return hinted.some((h) => FIELD in h.answer)
    }
  }
}

/** The one sentence a call answer carries when any of its adds met an input its process already had. */
export const SAME_INPUT_NOTE =
  'An exchange added here comes from an input its process already had (listed under same_input_already): ' +
  'the process now has both, and both count in the result. That is right for two separate uses of one ' +
  'dataset — two transport legs, say. If you meant to change the existing exchange instead, remove the new ' +
  'one (its uid is in the result) and use set_amount or set_formula on the existing uid.'
