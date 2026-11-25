import type { SubjectRef } from '../../lib/subjectKey'
import { lciExport, lciRows } from './lciRows'
import type { Matrix, Picked, StackedData } from './types'

/**
 * What the Results page's "Export Excel" writes, as `/export/compare-matrix` takes it: the score sheet, plain or
 * disaggregated, and the life cycle inventory of the same subjects on a second sheet.
 */

/** What the "Split by" choice is called in a document — the sheet's group column is headed with it. */
export function splitLabel(stackBy: string): string {
  return stackBy === 'isic'
    ? 'ISIC classification'
    : stackBy === 'cpc'
      ? 'CPC classification'
      : stackBy.startsWith('tag:')
        ? stackBy.slice(4)
        : stackBy
}

/** The stacked split the sheet comes apart by: the computed split, the keys of the chosen dimension, the
 *  dimension itself, and the name of each key. */
export interface WorkbookSplit {
  data: StackedData
  keys: string[]
  by: string
  label: (key: string) => string
}

export interface ResultsWorkbook {
  columns: { key: string; family: string; label: string; unit: string }[]
  subjects: { label: string; group?: string; total?: boolean; scores: Record<string, number | null> }[]
  group_header: string | null
  inventory: ReturnType<typeof lciExport> | null
  filename: string
}

/**
 * The workbook for `matrix` over the `picked` indicators (in display order).
 *
 * Disaggregated when a `split` is given and has keys: one row per part of each subject, then the row that adds
 * them up. The parts come from the stacked calculation the chart already made, so the export costs nothing extra
 * and can never disagree with the bars beside it.
 *
 * The LCI sheet holds every flow of the run, in the table's name order — not the table's filter or sort, which
 * its own export writes.
 */
export function resultsWorkbook(
  matrix: Matrix,
  picked: Picked[],
  split: WorkbookSplit | null,
  keyOf: (s: SubjectRef) => string
): ResultsWorkbook {
  const columns = picked.map((p) => ({ key: p.key, family: p.family, label: p.label, unit: p.unit }))
  const parts = split && split.keys.length ? split : null
  const subjects = parts
    ? parts.data.subjects.flatMap((s) => {
        const label = s.label ?? keyOf(s)
        const part = (k: string): Record<string, number | null> =>
          Object.fromEntries(
            picked.map((p) => [
              p.key,
              (s.methods[p.key]?.dims[parts.by] ?? []).find((g) => g.key === k)?.impact ?? 0
            ])
          )
        // A part that is zero across every indicator for THIS subject is not its part at all — the key list is
        // the union over all subjects, and printing forty empty rows per subject is how a disaggregated sheet
        // stops being readable.
        const used = parts.keys.filter((k) => Object.values(part(k)).some((v) => v !== 0))
        return [
          ...used.map((k) => ({ label, group: parts.label(k), scores: part(k) })),
          {
            label,
            group: 'Total',
            total: true,
            scores: Object.fromEntries(picked.map((p) => [p.key, s.methods[p.key]?.total ?? null]))
          }
        ]
      })
    : matrix.subjects.map((s) => ({
        label: s.label,
        scores: Object.fromEntries(picked.map((p) => [p.key, s.scores[p.key] ?? null]))
      }))
  return {
    columns,
    subjects,
    group_header: parts ? splitLabel(parts.by) : null,
    inventory: matrix.flows ? lciExport(matrix, lciRows(matrix)) : null,
    filename: 'prism-results'
  }
}
