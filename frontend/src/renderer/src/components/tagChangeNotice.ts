/**
 * The sentence a merge or delete confirm adds about what the step touches besides the tags, from the backend's
 * preview (`/api/v1/model/tag-groups/references`).
 *
 * A group merge takes the model's saved breakdowns and reports along: they name the group, and they name the
 * group it is merged into afterwards — except a report that already splits by both, which keeps its breakdowns
 * (the preview's note says so). A group delete takes the group out of the saved breakdowns and leaves the
 * reports as they are, so the confirm names them. A merged or deleted value is not re-pointed in the report
 * chapters that cite it; they show a gap until they are updated, and the preview's note says which reports
 * those are.
 */
export interface TagReferences {
  /** Group: the saved breakdowns that name the group, as a sentence calls them ("the Results split"). */
  views?: string[]
  /** Group: the model's reports that split or colour by the group. */
  reports?: { id: string; name: string }[]
  /** Group merge: the reports that split by both groups and keep their breakdowns. */
  reports_kept?: { id: string; name: string }[]
  /** Value: the reports whose chapters cite the value. */
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
  preview: TagReferences,
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

/** One sentence for a delete confirm — a group delete `value` null — or '' when it touches only the tags. */
export function deleteNotice(preview: TagReferences, group: string, value: string | null): string {
  if (value !== null) return preview.reports_citing?.length ? (preview.note ?? '') : ''
  const views = preview.views ?? []
  const reports = (preview.reports ?? []).map((r) => `“${r.name || r.id}”`)
  const out = views.length ? `“${group}” is taken out of ${joinAnd(views)}.` : ''
  const left =
    reports.length === 1
      ? `Report ${reports[0]} uses “${group}” and is left as it is; change it in the report.`
      : reports.length
        ? `Reports ${joinAnd(reports)} use “${group}” and are left as they are; change them in the reports.`
        : ''
  return [out, left].filter(Boolean).join(' ')
}
