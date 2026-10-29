/**
 * Which report chapters a writer is working on right now: one run per chapter, decided in main.
 *
 * Every way of starting a writer arrives here — the plan's Run, the update an answer starts on its own,
 * a single Write, a second window. The renderer's own "is a run under way" is a render behind, so two of
 * them can fire before either has painted; and each call gets its own abort controller and cost
 * account, so nothing else stops two paid runs on one chapter, the second text then lost to the
 * text-version check at the store.
 */
const busy = new Set<string>()

/** A chapter's key: its section route, which both writer calls know. */
export const chapterKey = (base: string, sectionId: string): string => `${base}/sections/${sectionId}`

/** Take these chapters for one run, or refuse the whole run if any is taken. Returns the release. */
export function claimChapters(keys: string[]): () => void {
  if (keys.some((k) => busy.has(k)))
    throw new Error(
      'A writer is already working on this chapter — wait for that run to finish, then start this one again.'
    )
  const mine = [...new Set(keys)]
  mine.forEach((k) => busy.add(k))
  return () => mine.forEach((k) => busy.delete(k))
}
