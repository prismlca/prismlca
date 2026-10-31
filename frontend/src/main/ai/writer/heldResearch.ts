/**
 * The web research a chapter paid for while no chapter came of it.
 *
 * A literature chapter may search the web (writer/lookups.ts), and that is the dearest thing a chapter
 * does: every question is a sub-agent with its own paid search. What it finds travels with the chapter
 * as a lookup and is stored with the text — so a chapter the gate refused took its research down with
 * it, and writing it again bought the same research a second time. Measured on a steel-bottle report:
 * the interpretation was refused in two runs, and the research model cost three times what the writer
 * did.
 *
 * So a write that leaves no stored chapter behind holds its research here, per chapter, and the next
 * write of the same chapter starts from it: shown to the writer as earlier research (writer/messages.ts),
 * never as the chapter's text; handed to the gate and the reader as evidence, the way an update hands on
 * what the stored chapter was accepted with; and a question asked again is answered from it rather
 * than from the web. Once a chapter is stored it carries the research itself, and the hold is released:
 * at once where main stores it (Write all), and for a single Write — which the renderer stores after
 * the check, so main never hears the outcome — when the next write's brief shows the stored chapter
 * carrying that research (`earlierResearch`).
 *
 * A chapter written anew on purpose (a ticked "Keep") still starts without the stored chapter's
 * evidence — its brief has no `update`. What it can find held is only research paid for by writes
 * since the chapter was last stored by a writer, which release the hold — in practice an earlier
 * attempt at that same rewrite — and it is shown as research to write from, not as text to keep.
 *
 * Research only. The other lookups are reads of this model that cost no model call, and their answers
 * describe the model as it was — after a recalculation a held one would contradict the new brief. A
 * finding about the world outside the model does not move with it.
 *
 * In memory, for the app session. The backend stores lookups only with a stored chapter; the findings
 * themselves are in the model's research log as well (`/provenance/research`), which is what the
 * bibliography reads, so what is lost with a restart is only the chance to skip a paid search.
 */
import type { Lookup } from '../../../shared/ipc'
import { canonicalArgs } from '../toolGuards'
import { RESEARCH_CALLS } from './lookups'

/**
 * The arguments a lookup was made with, whole — `args` is cut for storage, and two calls that differ
 * only past the cut are two lookups. Module-wide, so a held lookup still knows them in the next write;
 * a lookup that is not in here (the evidence an update brief carries) was not paid for by a write of
 * this session.
 */
export const madeWith = new WeakMap<Lookup, string>()

/** Research calls held per chapter, the newest kept: a few failed runs must not grow the prompt for ever. */
const PER_CHAPTER = 2 * RESEARCH_CALLS
/** Chapters held at once; the oldest goes first. */
const CHAPTERS = 32

/** Chapter route (`…/report/one/<db>/<report>/sections/<id>`) → the research held for it. */
const held = new Map<string, Lookup[]>()

/** The chapter a write belongs to: its proposal route without `/proposal`, as the run claims it. */
export const chapterOf = (checkPath?: string): string | undefined =>
  checkPath?.replace(/\/proposal$/, '') || undefined

/**
 * What a research result brought back. A call that failed outright is no finding, and asking it again may
 * work. A batch answers with an envelope even when every question in it failed (`succeeded: 0`, e.g. a
 * provider's 503), so the envelope is read rather than trusted: research that found something is worth
 * holding, but only research that answered EVERY question it was asked may stand in for asking again —
 * a question that failed once deserves another try.
 */
function outcome(l: Lookup): { found: boolean; complete: boolean } {
  if (/^Error:/.test(l.result) || /^\{"error":/.test(l.result)) return { found: false, complete: false }
  const batch = /^\{"total":(\d+),"succeeded":(\d+),"failed":(\d+)/.exec(l.result)
  if (!batch) return { found: true, complete: true }
  return { found: Number(batch[2]) > 0, complete: Number(batch[3]) === 0 }
}

const research = (l: Lookup): boolean => l.name === 'research_web' && outcome(l).found

/** The research held for this chapter, oldest first. */
export function heldResearch(chapter: string | undefined): Lookup[] {
  return chapter ? [...(held.get(chapter) ?? [])] : []
}

/**
 * The held research a write starts from: what the stored chapter does not carry already. An update brief
 * hands on the stored chapter's lookups (`carried`); research found there was stored with a chapter, so
 * it is released here rather than shown twice. Matched on the stored, cut `args`, which a held lookup
 * carries in the same cut form.
 */
export function earlierResearch(chapter: string | undefined, carried: readonly Lookup[] = []): Lookup[] {
  if (!chapter) return []
  const stored = new Set(carried.filter((l) => l.name === 'research_web').map((l) => l.args))
  const rest = (held.get(chapter) ?? []).filter((l) => !stored.has(l.args))
  if (rest.length) held.set(chapter, rest)
  else held.delete(chapter)
  return [...rest]
}

/**
 * Hold the research a write of this chapter made — what it was started with included — because the
 * write leaves no stored chapter behind. A write that made no research leaves the hold as it was.
 */
export function holdResearch(chapter: string | undefined, lookups: readonly Lookup[] | undefined): void {
  if (!chapter) return
  const paid = (lookups ?? []).filter((l) => research(l) && madeWith.has(l)).slice(-PER_CHAPTER)
  if (!paid.length) return
  held.delete(chapter)
  held.set(chapter, paid)
  if (held.size > CHAPTERS) held.delete(held.keys().next().value as string)
}

/** The chapter is stored and carries its research now. */
function releaseResearch(chapter: string | undefined): void {
  if (chapter) held.delete(chapter)
}

/** How a write ended for its research: a stored chapter releases it, anything else holds it. */
export function settleResearch(
  chapter: string | undefined,
  lookups: readonly Lookup[],
  stored: boolean
): void {
  if (stored) releaseResearch(chapter)
  else holdResearch(chapter, lookups)
}

/**
 * The research already in hand that answers this call: `research_web` with the same arguments, in
 * their canonical spelling. The web does not answer a question differently because it is asked twice,
 * so the second asking is not paid for.
 */
export function answered(lookups: readonly Lookup[], name: string, args: string | undefined): Lookup | null {
  if (name !== 'research_web') return null
  const asked = canonicalArgs(args)
  return (
    lookups.find(
      (l) =>
        l.name === 'research_web' && outcome(l).complete && canonicalArgs(madeWith.get(l) ?? l.args) === asked
    ) ?? null
  )
}
