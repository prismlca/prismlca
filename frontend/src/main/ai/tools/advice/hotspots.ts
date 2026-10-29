// Pure analysis over calculation results: which linked background datasets deserve a look.

/**
 * Datasets the FOREGROUND itself links, big enough to deserve a look (see needsALook), that this run
 * has never opened with `get_process_details`.
 *
 * The 2026-08-13 solar-lamp run put two ecoinvent datasets in a model that say in their own comment
 * what they were built for: the surface-mounted PWB ("the composition of components is based on the
 * printed wiring board for desktop and laptop computer") and the NiMH battery ("a NiMH battery for
 * laptop applications … as used in a Fujitsu-Siemens laptop, model: C4135"). The first was caught by
 * the reviewer, after a finished baseline, and correcting it moved the total by −38.9 %. The second
 * was never opened and stood for 41 % of the result.
 *
 * This judges nothing about a dataset's text. It answers the question nobody asked: you know which
 * datasets carry this result — did you ever look at them? Both halves are facts already on hand, the
 * share from the tree and "opened" from the run. Two restrictions keep it from becoming noise:
 *
 * - **Big enough to matter.** A flat tenth-of-the-result rule was the first cut and it let the one
 *   real modelling error of the 2026-08-13 apple-sauce run through: the tinplate lid sat at 3.4 %,
 *   under the bar, and shipped as raw converter steel (+45 % on that item). So the bar is a union —
 *   everything above a tenth, PLUS the top few by share down to a floor — whichever side brings in
 *   more datasets wins, by construction. The floor exists because "top 8" in a model with twelve
 *   1-%-datasets would demand reading material that cannot move a screening conclusion.
 * - **Linked from the foreground**, because only a dataset somebody CHOSE is somebody's to defend.
 *   `electrode production, positive, LaNi5` carries 17 % of that lamp, and it arrived inside the
 *   battery's own recipe — demanding it be read is asking a modeller to audit ecoinvent.
 */
/**
 * The key under which a background dataset is remembered as "opened", used by BOTH the writer
 * (get_process_details) and the readers below. One function because two spellings is a bug that
 * type-checks: the first version of this wrote `db code` and looked up `db\u0000code`, so nothing
 * ever counted as read.
 */
export const inspectedKey = (database: string, code: string): string => `${database}\u0000${code}`

/** Everything above this share of the result must be looked at, full stop. */
export const NEEDS_A_LOOK = 0.1
/** …and so must the biggest few below it, because rank is the better net for small models: */
export const NEEDS_A_LOOK_TOP_N = 8
/** …down to a floor under which a wrong proxy cannot move a screening conclusion. */
export const NEEDS_A_LOOK_FLOOR = 0.02

export type LinkedHotspot = { name: string; database: string; code: string; cumulative_share: number }

/**
 * Every background dataset the foreground links directly, with its summed share of the result,
 * biggest first. The raw list — needsALook() decides which of them deserve attention.
 */
export function linkedHotspots(tree: any, foregroundDb: string): LinkedHotspot[] {
  if (!tree) return []
  const byKey = new Map<string, LinkedHotspot>()
  const walk = (n: any, parentIsForeground: boolean): void => {
    if (!n) return
    if (parentIsForeground && n.db !== foregroundDb) {
      const key = inspectedKey(n.db, n.c)
      const seen = byKey.get(key)
      if (seen) seen.cumulative_share += n.shr
      else byKey.set(key, { name: n.n, database: n.db, code: n.c, cumulative_share: n.shr })
    }
    for (const ch of n.ch ?? []) walk(ch, n.db === foregroundDb)
  }
  walk(tree, false)
  return [...byKey.values()].sort((x, y) => Math.abs(y.cumulative_share) - Math.abs(x.cumulative_share))
}

/**
 * The union rule (see the block comment above): a dataset deserves a look when it carries a tenth of
 * the result, OR ranks in the top NEEDS_A_LOOK_TOP_N and still carries at least the floor. Takes the
 * sorted output of linkedHotspots, so rank is rank among ALL linked datasets — a dataset does not
 * climb into the top 8 just because the ones above it were already read.
 */
export function needsALook(linked: LinkedHotspot[]): LinkedHotspot[] {
  return linked.filter(
    (v, rank) =>
      Math.abs(v.cumulative_share || 0) >= NEEDS_A_LOOK ||
      (rank < NEEDS_A_LOOK_TOP_N && Math.abs(v.cumulative_share || 0) >= NEEDS_A_LOOK_FLOOR)
  )
}

export type LinkedInput = { name?: string; database: string; code: string }

/** Most datasets one link call names in its reminder; a 20-item batch should not echo 20 rows. */
export const UNOPENED_LINKS_SHOWN = 12

/**
 * The reminder at link time, one step before the one above (16.10.2026). That one speaks after a
 * calculation — by then the dataset is linked, scaled and often commented, and the 2026-10-05 hose-cart
 * run's own critique was "never opened the PP market (36 %)": the check came after the building. Here
 * the share is not known yet, so the reminder names every unopened link of THIS call and leaves the
 * judgement which of them will carry the result with the model; the post-calculation list stays the
 * backstop with real shares. Datasets of the model itself are not background and are left out.
 */
export function unopenedLinks(
  linked: LinkedInput[],
  foregroundDb: string,
  inspected: Set<string> | undefined
): LinkedInput[] {
  if (!inspected) return []
  const seen = new Set<string>()
  return linked.filter((l) => {
    const key = inspectedKey(l.database, l.code)
    if (l.database === foregroundDb || inspected.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function unopenedLinkedHotspots(
  tree: any,
  foregroundDb: string,
  inspected: Set<string> | undefined
): LinkedHotspot[] {
  if (!inspected) return []
  return needsALook(linkedHotspots(tree, foregroundDb)).filter(
    (v) => !inspected.has(inspectedKey(v.database, v.code))
  )
}
