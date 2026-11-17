/**
 * The sentence a merge confirm adds about what the merge touches besides the tags, from the backend's
 * preview (`/api/v1/model/tag-groups/merge-preview`).
 *
 * A group merge takes the model's saved breakdowns and reports along: they name the group, and they name the
 * group it is merged into afterwards — except a report that already splits by both, which keeps its breakdowns
 * (the preview's note says so). A value merge does not re-point the report chapters that cite the value;
 * they show a gap until they are updated, and the preview's note says which reports those are.
 */
export interface MergePreview {
  /** Group merge: the saved breakdowns that name the group, as a sentence calls them ("the Results split"). */
  views?: string[]
  /** Group merge: the model's reports that split or colour by the group. */
  reports?: { id: string; name: string }[]
  /** Group merge: the reports that split by both groups and keep their breakdowns. */
  reports_kept?: { id: string; name: string }[]
  /** Value merge: the reports whose chapters cite the value. */
  reports_citing?: { id: string; name: string; chapters: number }[]
  /** The sentence about `reports_kept` or `reports_citing`, worded once on the backend for the chat too. */
  note?: string
}

function joinAnd(items: string[]): string {
  return items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** One sentence, or '' when the merge touches nothing besides the tags. */
export function mergeNotice(
  preview: MergePreview,
  group: string,
  value: string | null,
  into: string
): string {
  if (value !== null) return preview.reports_citing?.length ? (preview.note ?? '') : ''
  const named = [
    ...(preview.views ?? []),
    ...(preview.reports ?? []).map((r) => `report “${r.name || r.id}”`)
  ]
  const list = joinAnd(named)
  const follows = named.length
    ? `${list[0].toUpperCase()}${list.slice(1)} ${named.length === 1 ? 'uses' : 'use'} “${group}” and will use “${into}”.`
    : ''
  const kept = preview.reports_kept?.length ? (preview.note ?? '') : ''
  return [follows, kept].filter(Boolean).join(' ')
}
