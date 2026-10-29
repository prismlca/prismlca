import { useState } from 'react'
import { LockIcon, PencilIcon, SparkleIcon, TrashIcon, UnlockIcon } from '../../components/icons'
import {
  chapterLabel,
  KINDS,
  kindLabel,
  LITERATURE_KINDS,
  untitledName,
  WRITABLE,
  type ReportSection,
  type StoredReportFull
} from '../../lib/report/model'
import type { StaleChapter } from '../../lib/report/staleness'
import { chapterState } from '../../lib/report/chapterStatus'
import { writeTooltip } from '../../lib/report/writeStatus'

/** The chapter list itself: the pinned title-page row, the generated-lists row, one draggable row
 * per chapter with its badges and offers. (The drag state lives here —
 * nothing outside the list ever read it.) */
export default function ChapterList({
  report,
  stale,
  drafts,
  draftReasons,
  working,
  placeholder,
  writing,
  runActive,
  blocker,
  mutate,
  base,
  onTitleDraft,
  onReorder,
  onWrite,
  onEdit,
  onDelete,
  onReadDiff,
  onQuestions,
  onResolveAbbreviations,
  onCoverOpen
}: {
  report: StoredReportFull
  stale: Record<string, StaleChapter>
  drafts: Record<string, { text: string }>
  /** Why a held draft could not be finished, in one sentence, by chapter. */
  draftReasons: Record<string, string>
  /** The chapters a model is working on right now. */
  working: Record<string, 'write' | 'update'>
  /** The picture shipped with the app, for the title-page thumbnail. */
  placeholder: string | null
  writing: string | null
  runActive: boolean
  blocker: (kind: string) => string | null
  mutate: (method: string, path: string, body?: object) => Promise<boolean>
  base: string
  onTitleDraft: (id: string, title: string) => void
  onReorder: (ids: string[]) => void
  onWrite: (s: ReportSection) => void
  onEdit: (id: string) => void
  onDelete: (s: ReportSection) => void
  onReadDiff: (diff: { section: ReportSection; before: string; kind?: 'reviewed' | 'previous' }) => void
  /** Bring the questions above the chapters into view. */
  onQuestions: () => void
  onResolveAbbreviations: (s: ReportSection) => void
  onCoverOpen: () => void
}): JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null)
  /** Where the dragged chapter would land: an id plus which side of it. A gap, not a target. */
  const [overId, setOverId] = useState<string | null>(null)
  const [overBefore, setOverBefore] = useState(true)

  /**
   * Drop the dragged chapter into the gap above or below `targetId`.
   *
   * Aiming at a chapter and hoping the code inserts on the right side is guesswork; the gap between two
   * chapters is what you actually mean, so that is what the drag shows (a line) and what this places
   * into. Dropping onto the dragged chapter's own gaps is a no-op rather than a reorder to the same
   * place — otherwise every accidental drag would write to the store.
   */
  const drop = (targetId: string, before: boolean): void => {
    if (!dragId) return
    const order = report.sections.map((s) => s.id)
    const from = order.indexOf(dragId)
    const target = order.indexOf(targetId)
    if (from < 0 || target < 0) return
    let at = before ? target : target + 1
    if (at === from || at === from + 1) return // the gap it already sits in
    const ids = order.filter((id) => id !== dragId)
    if (from < at) at -= 1
    ids.splice(at, 0, dragId)
    onReorder(ids)
  }

  /** Arrow-key reorder: one gap per press, never across the pinned front matter. */
  const keyMove = (s: ReportSection, delta: -1 | 1): void => {
    const ids = report.sections.map((x) => x.id)
    const movable = report.sections
      .filter((x) => x.kind !== 'summary' && x.kind !== 'abbreviations')
      .map((x) => x.id)
    const pos = movable.indexOf(s.id)
    const to = pos + delta
    if (pos < 0 || to < 0 || to >= movable.length) return
    const swap = movable[to]
    const a = ids.indexOf(s.id)
    const b = ids.indexOf(swap)
    ids[a] = swap
    ids[b] = s.id
    onReorder(ids)
  }

  return (
    <>
      <div className="rsec-list">
        {/* The title page, pinned. It is the first page of the document, so it belongs at the top of the
              list of pages — but it is not a chapter: no drag handle, no number, and it cannot be moved
              or deleted. Everything it shows is behind the one button, in an overlay. */}
        <div className="rsec-item rsec-cover-item">
          <div className="rsec-row">
            <span
              className="rsec-cover-pin"
              title="Always first — the title page cannot be moved"
              aria-hidden="true"
            >
              ★
            </span>
            <span className="rsec-title-static">Title page</span>
            {report.cover_image ? (
              <img
                className="rsec-cover-thumb"
                src={`data:image/png;base64,${report.cover_image === 'default' ? (placeholder ?? '') : report.cover_image}`}
                alt=""
              />
            ) : null}
            <span className="rsec-actions">
              <button className="btn sm" onClick={onCoverOpen}>
                Cover, logos &amp; author
              </button>
            </span>
          </div>
        </div>
        {(() => {
          // Reading order, as the renderer enforces it: executive summary → the generated
          // contents/figure/table lists (not chapters, shown as one fixed element so the list
          // says where they sit) → abbreviations → the reorderable chapters. The stored order may
          // differ in older reports; this list shows the truth, and the pinned rows cannot move.
          const summary = report.sections.filter((x) => x.kind === 'summary')
          const abbrev = report.sections.filter((x) => x.kind === 'abbreviations')
          const rest = report.sections.filter((x) => x.kind !== 'summary' && x.kind !== 'abbreviations')
          return [...summary, 'outlines' as const, ...abbrev, ...rest]
        })().map((s) => {
          if (s === 'outlines')
            return (
              <div key="__outlines" className="rsec-item rsec-generated">
                <div className="rsec-row">
                  <span
                    className="pdrag-handle pinned"
                    title="Pinned: generated by the typesetter, always in this position"
                    aria-hidden="true"
                  >
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="rsec-generated-label" title="Contents · List of figures · List of tables">
                    Contents · List of figures · List of tables
                  </span>
                  <span
                    className="rsec-kind"
                    title="Generated by the typesetter, in the study's language — the figure and table lists appear only when the document has figures or tables."
                  >
                    Generated
                  </span>
                </div>
              </div>
            )
          const meta = KINDS.find((k) => k.kind === s.kind)
          const pinned = s.kind === 'summary' || s.kind === 'abbreviations'
          const state = WRITABLE.has(s.kind)
            ? chapterState(s, {
                stale: stale[s.id],
                draftReason: drafts[s.id] ? (draftReasons[s.id] ?? '') : null,
                working: working[s.id] ?? null,
                blocker: blocker(s.kind),
                answers: report.answers
              })
            : null
          const lockLabel = s.locked
            ? 'Locked — click to unlock'
            : 'Lock this chapter — content changes are refused'
          return (
            <div
              key={s.id}
              className={[
                'rsec-item',
                dragId === s.id ? 'dragging' : '',
                // The line marks the gap the chapter would fall into, above or below this one.
                overId === s.id && dragId && dragId !== s.id
                  ? overBefore
                    ? 'drop-above'
                    : 'drop-below'
                  : '',
                s.locked ? 'locked' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              draggable={!pinned}
              onDragStart={(e) => {
                // Summary and abbreviations are pinned front matter: the renderer places them
                // around the generated lists whatever this list says, so dragging them (or
                // dropping into their gaps) could only lie about the PDF.
                if (pinned) {
                  e.preventDefault()
                  return
                }
                const control = (e.target as HTMLElement).closest('input, textarea, button, select')
                // The handle is a button now (keyboard reorder), and it is the one control a drag
                // may — must — start on.
                if (control && !control.classList.contains('pdrag-handle')) {
                  e.preventDefault()
                  return
                }
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', s.id)
                setDragId(s.id)
              }}
              onDragEnd={() => {
                setDragId(null)
                setOverId(null)
              }}
              onDragLeave={(e) => {
                // Only when the pointer really left this row, not when it crossed into a child.
                if (!e.currentTarget.contains(e.relatedTarget as Node) && overId === s.id) setOverId(null)
              }}
              onDragOver={(e) => {
                if (pinned) return
                e.preventDefault()
                const box = e.currentTarget.getBoundingClientRect()
                setOverId(s.id)
                setOverBefore(e.clientY < box.top + box.height / 2)
              }}
              onDrop={(e) => {
                if (pinned) return
                const box = e.currentTarget.getBoundingClientRect()
                drop(s.id, e.clientY < box.top + box.height / 2)
              }}
            >
              <div className="rsec-row">
                {/* A real button, not decoration: dragging was the only way to reorder, which
                      leaves keyboard users unable to arrange the document at all. Arrow keys move the
                      chapter one gap; the element is keyed by section id, so it keeps focus across the
                      re-render and a row can be walked up the list press by press. */}
                <button
                  type="button"
                  className={pinned ? 'pdrag-handle pinned' : 'pdrag-handle'}
                  disabled={pinned}
                  aria-label={
                    pinned
                      ? `${chapterLabel(s)}: pinned front matter, cannot be moved`
                      : `Reorder ${chapterLabel(s)} — arrow up or down moves it one position`
                  }
                  title={
                    s.kind === 'summary'
                      ? 'Pinned: the executive summary always opens the document, before the table of contents'
                      : s.kind === 'abbreviations'
                        ? 'Pinned: the abbreviations always follow the generated lists'
                        : 'Drag to reorder — or focus this handle and use the arrow keys'
                  }
                  onKeyDown={(e) => {
                    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
                    e.preventDefault()
                    keyMove(s, e.key === 'ArrowUp' ? -1 : 1)
                  }}
                >
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </button>
                {/* The row is one line, so a long title ends in an ellipsis; the tooltip carries it whole. */}
                <input
                  className="rsec-title"
                  value={s.title}
                  placeholder={untitledName(s.kind)}
                  title={s.title || untitledName(s.kind)}
                  aria-label="Chapter title"
                  onChange={(e) => onTitleDraft(s.id, e.target.value)}
                  onBlur={() =>
                    void mutate('POST', `${base}/sections/${s.id}`, { kind: s.kind, title: s.title })
                  }
                />
                {/* Only worth showing once the title has been renamed — otherwise the input's
                      placeholder already says which kind this is. */}
                {s.title ? (
                  <span className="rsec-kind" title={meta?.hint}>
                    {kindLabel(s.kind)}
                  </span>
                ) : null}
                {/* One state, in a word, with what it means and what to do in its tooltip. A click goes
                      where the author can act on it: the questions, the chapter, or what changed since the
                      last approval. */}
                <span className="rsec-badges">
                  {state?.label ? (
                    <button
                      type="button"
                      className={`rsec-stale link state-${state.kind}`}
                      aria-label={`${state.label} — ${state.title}`}
                      title={state.title}
                      onClick={() => {
                        if (state.kind === 'input') onQuestions()
                        else if (state.kind === 'new' && stale[s.id]?.changed_since_reviewed)
                          onReadDiff({ section: s, before: stale[s.id].reviewed_text ?? '' })
                        else onEdit(s.id)
                      }}
                    >
                      {state.label}
                    </button>
                  ) : null}
                </span>
                <div className="rsec-actions">
                  {/* Empty on purpose: the icons after it sit at the row's right end (`.rsec-offers` in report.css). */}
                  <div className="rsec-offers" />
                  {/* The abbreviations' counterpart of Write: a model fills the list, so it wears the same
                      sparkle. That kind is never writable, so the two never share a row. */}
                  {s.kind === 'abbreviations' ? (
                    <button
                      type="button"
                      className="act-icon"
                      disabled={writing !== null || runActive}
                      aria-label={
                        writing === s.id
                          ? 'Resolving the abbreviations'
                          : 'Resolve the abbreviations with AI now'
                      }
                      title="Find the abbreviations the document uses and have a model explain them"
                      onClick={() => void onResolveAbbreviations(s)}
                    >
                      {writing === s.id ? <span className="spinner" aria-hidden="true" /> : <SparkleIcon />}
                    </button>
                  ) : null}
                  {WRITABLE.has(s.kind) ? (
                    <>
                      {/* The action on the first line of the tooltip, what it means for this chapter — or
                          why it cannot be pressed — on the second. */}
                      <button
                        type="button"
                        className="act-icon"
                        disabled={writing !== null || runActive || s.locked || blocker(s.kind) !== null}
                        aria-label={
                          writing === s.id ? 'Writing this chapter' : 'Write this chapter with AI now'
                        }
                        title={`Write this chapter with AI now\n${writeTooltip(s, blocker(s.kind))}`}
                        onClick={() => onWrite(s)}
                      >
                        {writing === s.id ? <span className="spinner" aria-hidden="true" /> : <SparkleIcon />}
                      </button>
                      {/* One name for both jobs the overlay does — the chapter's text and the instruction it
                          was written from. "Comment text" named neither well, and a button called
                          "Instruction" would hide the more common reason to open it: fixing a sentence. */}
                      <button
                        type="button"
                        className="act-icon"
                        aria-label="Edit this chapter"
                        title="Edit this chapter — its text and the instruction it is written from"
                        onClick={() => onEdit(s.id)}
                      >
                        <PencilIcon />
                      </button>
                    </>
                  ) : null}
                  {/* A toggle that shows its state: the closed padlock, highlighted, on a locked chapter. */}
                  <button
                    type="button"
                    className={`act-icon${s.locked ? ' on' : ''}`}
                    aria-label={lockLabel}
                    title={lockLabel}
                    onClick={() =>
                      void mutate('POST', `${base}/sections/${s.id}`, { kind: s.kind, locked: !s.locked })
                    }
                  >
                    {s.locked ? <LockIcon /> : <UnlockIcon />}
                  </button>
                  <button
                    type="button"
                    className="act-icon danger"
                    aria-label="Delete this chapter"
                    title="Remove this chapter from the report"
                    onClick={() => onDelete(s)}
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>
              {/* Under the chapter's own buttons, because it governs the Write beside it: on until
                  unticked, and read when the writer starts, so a run already under way keeps its brief. */}
              {LITERATURE_KINDS.has(s.kind) ? (
                <div className="rsec-lit">
                  <label title="Before it writes, the writer may search the web through your AI provider (billed per search). What it finds is listed with its sources in the References.">
                    <input
                      type="checkbox"
                      checked={s.literature_search !== false}
                      onChange={(e) =>
                        void mutate('POST', `${base}/sections/${s.id}`, {
                          kind: s.kind,
                          literature_search: e.target.checked
                        })
                      }
                    />
                    Search the literature
                  </label>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </>
  )
}
