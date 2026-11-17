import type { ToolCtx } from '../context'

/**
 * Whether a link that edit_exchange added makes a process take one of the model's own processes twice:
 * directly, and again through a step beneath it, with the same amount.
 *
 * It is what re-wiring leaves when a step is put in between and the old direct links stay: four assemblies
 * hung under the delivery step and again under the final assembly inserted above them, the result at twice
 * its value, every link valid on its own. The health check names it too, but only when it is run; the
 * answer of the call that closed the second route is the earliest place, and the cheapest to act on. A
 * part used at two levels on purpose looks the same, so this is a hint, never a refusal. Which doubles
 * count — same amount, the model's own processes only — is decided by the backend, once for the health
 * check and this hint alike.
 *
 * One request per call, after every item has run, and only when the call linked two of the model's own
 * processes: a batch that adds twenty background inputs costs nothing.
 */

export interface ReachedTwiceWatch {
  /** After an add: note the link if it joins two of the model's own processes. */
  added(process: string, inputDb: unknown, inputCode: unknown): void
  /** Once every item has run: ask which doubles this call's links are part of. */
  settle(): Promise<void>
  /** What the call's answer carries: the doubles and one sentence on them, or nothing. */
  note(): Record<string, unknown>
}

export function watchReachedTwice(ctx: ToolCtx, db: string): ReachedTwiceWatch {
  const links: Array<[string, string]> = []
  let found: unknown[] = []
  return {
    added: (process, inputDb, inputCode) => {
      if (String(inputDb ?? '') === db && inputCode) links.push([process, String(inputCode)])
    },
    settle: async () => {
      if (!links.length) return
      try {
        const out = await ctx.api('POST', `/api/v1/model/reached-twice/${encodeURIComponent(db)}`, {
          touching: links
        })
        found = Array.isArray(out?.reached_twice) ? out.reached_twice : []
      } catch {
        // A courtesy: a check that fails must not cost the call the links it made.
        found = []
      }
    },
    note: () => (found.length ? { reached_twice: found, reached_twice_note: REACHED_TWICE_NOTE } : {})
  }
}

/** The one sentence a call answer carries when its links closed a second route to a process. */
export const REACHED_TWICE_NOTE =
  "A link added here makes a process take one of this model's processes twice — directly and again " +
  'through a step beneath it, with the same amount (listed under reached_twice). Both count in the ' +
  'result. One of the two is often left over from re-wiring: the direct link (direct_uids) when a step ' +
  'was put in between, the lower one (through_uids) when a process was moved up — then remove those ' +
  'uids. If the part is really used at both levels, leave both.'
