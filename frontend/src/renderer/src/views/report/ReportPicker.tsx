import { useState } from 'react'
import { api } from '../../lib/api'
import { errMsg } from '../../lib/errors'
import { TrashIcon } from '../../components/icons'
import ConfirmDialog, { type ConfirmSpec } from '../ConfirmDialog'
import { reportBase, useWritingAll } from '../../lib/report/writeAllRuns'

export interface StoredReport {
  id: string
  name: string
  lang: string
  section_count: number
  /** Last-modified stamp from the store — what tells an open preview it no longer shows this report. */
  updated?: string
}

/**
 * Which full report is open: the list, one button to start another, and one to delete the open one.
 *
 * Delete sits beside the list rather than inside the report's groups because it acts on the choice, not on
 * the document — and a report you are about to delete is exactly the one you have picked here. It asks first
 * and says what goes: the chapters, including the written ones, which may have cost an afternoon and a model
 * bill. It waits while chapters are being written or corrected, because a run whose report vanished under it
 * would post its chapters into a 404.
 */
export default function ReportPicker({
  database,
  reports,
  selected,
  onSelect,
  onCreate,
  canCreate,
  busy,
  writing,
  onDeleted
}: {
  database: string
  reports: StoredReport[]
  selected: string
  onSelect: (id: string) => void
  /** Start a new report — the page builds it from the model. */
  onCreate: () => void
  canCreate: boolean
  busy: boolean
  /** Chapters of the open report are being written or corrected. */
  writing: boolean
  /** After a delete: the page re-reads the list; the selection is already cleared. */
  onDeleted: () => void
}): JSX.Element {
  const [confirming, setConfirming] = useState<ConfirmSpec | null>(null)
  const [error, setError] = useState<string | null>(null)
  const open = reports.find((r) => r.id === selected)
  // The panel's own flag misses a "Write all" that a previous panel started; the run registry does not.
  const runningAll = useWritingAll(open ? reportBase(database, open.id) : '')
  const busyWriting = writing || runningAll

  const remove = async (r: StoredReport): Promise<void> => {
    setError(null)
    try {
      await api('POST', `${reportBase(database, r.id)}/delete`)
      onSelect('')
      onDeleted()
    } catch (e) {
      setError(errMsg(e))
    }
  }

  return (
    <>
      {/* Which report, one button to start another and one to delete this one — on one line, the way the
          models list pairs its search with its "+ Model". */}
      <div className="report-pick">
        <select value={selected} aria-label="Report" onChange={(e) => onSelect(e.target.value)}>
          <option value="">—</option>
          {reports.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} · {r.lang} · {r.section_count} sections
            </option>
          ))}
        </select>
        {/* New and Delete as one pair: Delete wears the same button with only its icon, and within the pair
            it is stretched to exactly the height of "New report" — an icon alone is shorter than a line of
            text, and stretched to the whole row it stood as tall as the select instead. */}
        <div className="report-pick-acts">
          <button
            className="btn sm"
            disabled={busy || !canCreate}
            title="Start a new full report on this model — pick what it covers below"
            onClick={onCreate}
          >
            New report
          </button>
          <button
            className="btn sm report-del"
            disabled={!open || busy || busyWriting}
            title={
              busyWriting
                ? 'Wait until the chapters being written are done'
                : open
                  ? 'Delete this report'
                  : 'Pick a report to delete it'
            }
            aria-label="Delete report"
            onClick={() =>
              open &&
              setConfirming({
                title: 'Delete report',
                message:
                  `Delete the report “${open.name}” and its ${open.section_count} ` +
                  `chapter${open.section_count === 1 ? '' : 's'}? Written chapters go with it, and this ` +
                  `cannot be undone. The model itself is not touched.`,
                confirmLabel: 'Delete report',
                danger: true,
                onConfirm: () => void remove(open)
              })
            }
          >
            <TrashIcon />
          </button>
        </div>
      </div>
      {error ? <p className="cover-error">{error}</p> : null}
      {confirming ? <ConfirmDialog spec={confirming} onClose={() => setConfirming(null)} /> : null}
    </>
  )
}
