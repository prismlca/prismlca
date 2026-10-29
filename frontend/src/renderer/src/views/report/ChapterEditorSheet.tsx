import FigureEditor from '../FigureEditor'
import Busy from '../../components/Busy'
import { ChartIcon, InfoIcon } from '../../components/icons'
import {
  chapterLabel,
  COMMENTABLE,
  kindLabel,
  LCI_DEFAULT_PARTS,
  LCI_PARTS,
  type ReportSection,
  type ResolvedPart,
  type StoredReportFull
} from '../../lib/report/model'
import ReviewDetails from './ReviewDetails'
import { writeStatus, writeTooltip, type WriteStage } from '../../lib/report/writeStatus'
import { indicatorLabel } from '../../lib/methods'
import EscapeCloser from '../../components/EscapeCloser'
import { NumberInput, shownNumber } from '../../components/NumberInput'

/** The inventory table's row count as the field clamps it: 0 (= all rows) to 5000. */
const inventoryRows = (raw: string): number => Math.max(0, Math.min(5000, Number(raw) || 0))

/** The chapter editor: the text and the instruction, out of the chapter list on purpose — a six-line
 * box and an eight-line prompt inside a row you also drag made both hard to use and the list hard to
 * read. Here they get the room they need, and the list stays a list. (It keeps its own error line — a refused
 * edit is answered where it was typed, the panel's line sits
 * behind this overlay.) */
export default function ChapterEditorSheet({
  open,
  report,
  base,
  error,
  drafts,
  findings,
  resolved,
  prompts,
  promptsRead,
  writing,
  runActive,
  stage,
  writeSeconds,
  indicatorNames,
  mutate,
  patchOpen,
  clearResolved,
  setDraftText,
  storeDraft,
  discardDraft,
  toggleResolved,
  askWrite,
  loadPrompts,
  onKeepPoint,
  onFix,
  onEarlier,
  onClose
}: {
  open: ReportSection
  report: StoredReportFull
  base: string
  /** The panel's error line sits BEHIND this overlay — whatever failed while it is open shows here. */
  error: string | null
  drafts: Record<string, { text: string; model?: string; lookups?: unknown[]; figure?: unknown }>
  findings: Record<string, { kind: string; detail: string }[]>
  resolved: Record<string, { parts?: ResolvedPart[]; error?: string }>
  prompts: Record<string, string>
  promptsRead: boolean
  writing: string | null
  /** A "Write all" run is on: the box is locked, a blur would post pre-run text over fresh chapters. */
  runActive: boolean
  stage: WriteStage | null
  writeSeconds: number
  indicatorNames: Map<string, string>
  mutate: (method: string, path: string, body?: object) => Promise<boolean>
  patchOpen: (patch: Partial<ReportSection>) => void
  clearResolved: (id: string) => void
  setDraftText: (id: string, text: string) => void
  storeDraft: (id: string) => Promise<void>
  discardDraft: (id: string) => void
  toggleResolved: (section: ReportSection) => Promise<void>
  askWrite: (section: ReportSection) => void
  loadPrompts: () => Promise<void>
  /** Keep a sentence the second reader still doubts, as written. */
  onKeepPoint: (section: ReportSection, quote: string) => Promise<void>
  /** Have the writer fix what the second reader still doubts — an update of this one chapter. */
  onFix: (section: ReportSection) => void
  /** What this chapter said before its last change, with "Put it back". */
  onEarlier: (section: ReportSection) => void
  onClose: () => void
}): JSX.Element {
  // The blur is the save. Escape unmounted the box without one, and everything typed since the last
  // click-out was gone on the next load — so the focused field is blurred first, which
  // runs its onBlur synchronously, and only then does the sheet go.
  const close = (): void => {
    const el = document.activeElement
    if (el instanceof HTMLElement) el.blur()
    onClose()
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <EscapeCloser onClose={close} />
      {/* The text and the instruction moved out of the chapter list on purpose: a six-line box and an
              eight-line prompt inside a row you also drag made both hard to use and the list hard to read.
              Here they get the room they need, and the list stays a list. */}
      <div className="modal sheet rsec-modal" onClick={(e) => e.stopPropagation()}>
        {/* Sheet frame (draft popup_edit_chapters): the head with its ✕ and the foot with Write
                stay put while the long middle scrolls — the exit and the main action never drift away. */}
        <div className="sheet-head">
          <div className="sheet-head-grow">
            <h3>
              {chapterLabel(open)}
              <span className="rsec-kind">
                {COMMENTABLE.has(open.kind) ? 'comment on this chapter’s tables' : 'written chapter'}
              </span>
            </h3>
          </div>
          <button className="sheet-x" aria-label="Close" onClick={close}>
            ✕
          </button>
        </div>
        <div className="rsec-modal-body">
          {open.locked ? (
            <p className="settings-hint">Locked — unlock the chapter to change its text.</p>
          ) : null}
          {/* The panel's error line sits BEHIND this overlay — a refused edit looked saved and
                reverted on the next load. Whatever failed while the modal is open is shown in it. */}
          {error ? <p className="chat-error">{error}</p> : null}

          <label className="settings-field">
            <span>Text</span>
            {drafts[open.id] ? (
              <p className="settings-hint">
                The check refused this text — it is held as a <strong>draft</strong>, not part of the report.
                Edit it (or fix the study data it contradicts) and check again; clicking elsewhere does not
                store it.{' '}
                <button
                  className="btn sm"
                  disabled={writing !== null || runActive}
                  onClick={() => void storeDraft(open.id)}
                >
                  {writing === open.id ? <Busy label="Checking" /> : 'Check & store'}
                </button>{' '}
                <button
                  className="btn sm"
                  disabled={writing !== null || runActive}
                  onClick={() => discardDraft(open.id)}
                >
                  Discard draft
                </button>
              </p>
            ) : null}
            {/* Body face rather than mono (draft popup_edit_chapters): this box holds prose, and
                  prose is read — the few {{placeholders}} in it survive a proportional font fine. */}
            <textarea
              rows={14}
              value={drafts[open.id] ? drafts[open.id].text : open.text}
              // Locked means locked: the hint above said so while the box still took edits — the
              // blur-save was then refused by the store, but the refusal landed in the panel's error
              // line behind this overlay, so the text looked saved and reverted on the next load.
              // And no edits during a "Write all" run: the quiet lanes do not reload per chapter, so
              // this box shows the pre-run text — a blur would post it over the freshly written one.
              // Nor while THIS chapter is being written on its own: the writer's store would land over
              // the blur-save (the store refuses that too, this just keeps it from being tried).
              disabled={(open.locked && !drafts[open.id]) || runActive || writing === open.id}
              autoFocus
              placeholder={
                COMMENTABLE.has(open.kind)
                  ? 'A comment on the tables of this chapter. Reference numbers as {{checks.sensitivity.0.spread_percent}} and tables as {{ref:t-lcia}} — they resolve when the report is typeset.'
                  : 'Write the chapter. Reference numbers as {{results.0.score}} and tables as {{ref:t-lcia}} — they resolve when the report is typeset.'
              }
              onChange={(e) => {
                // The resolved view below describes the text as it was when it was fetched. One
                // keystroke later it describes something else, so it goes rather than lies.
                if (resolved[open.id]) clearResolved(open.id)
                return drafts[open.id]
                  ? setDraftText(open.id, e.target.value)
                  : patchOpen({ text: e.target.value })
              }}
              // A draft never rides the blur-save: that endpoint knows no gate, and "clicked into
              // the box and out again" must not be how refused text enters a client's report.
              onBlur={() =>
                drafts[open.id]
                  ? undefined
                  : void mutate('POST', `${base}/sections/${open.id}`, {
                      kind: open.kind,
                      text: open.text,
                      // The version this box was opened on: a write that landed in between is refused
                      // instead of overwritten, and the refusal says so.
                      expected_text_version: open.text_version
                    })
              }
            />
          </label>

          {/* What the second reader made of the chapter — or, for a held draft, why it is not finished. */}
          <ReviewDetails
            section={open}
            draftReason={drafts[open.id] ? (findings[open.id]?.[0]?.detail ?? 'it was not stored.') : null}
            busy={writing !== null || runActive}
            onKeep={(quote) => onKeepPoint(open, quote)}
            onFix={() => onFix(open)}
          />

          {/* The safety net under every change: what the chapter said before its last one, offered here
                because the editor is where a chapter is read — and the version people most want back is
                the one a run replaced a minute ago, which they had not approved. */}
          {open.previous?.text && open.previous.text !== (open.text ?? '') ? (
            <button
              type="button"
              className="btn sm"
              title="What this chapter said before its last change — compare, and put it back if you prefer it"
              onClick={() => onEarlier(open)}
            >
              Earlier wording
            </button>
          ) : null}

          {/* The chapter as the document will read it. The box above is the only place a placeholder
                is ever seen, so "which number is that, and which row does it belong to?" had no answer
                anywhere in the app — you found out by generating a PDF. Resolved on the backend through
                the same substitution the document uses, so the two cannot drift apart. */}
          {(open.text ?? '').includes('{{') ? (
            <div className="rsec-resolved-box">
              <button
                className="btn sm"
                onClick={() => void toggleResolved(open)}
                title="Show this chapter with every placeholder worked out, and what each number points at"
              >
                <ChartIcon /> {resolved[open.id] ? 'Hide the numbers' : 'Show with the numbers'}
              </button>
              {resolved[open.id]?.error ? (
                <p className="rsec-findings" style={{ margin: '8px 0 0' }}>
                  {resolved[open.id].error}
                </p>
              ) : null}
              {resolved[open.id]?.parts ? (
                <p className="rsec-resolved">
                  {resolved[open.id].parts!.map((part, i) =>
                    part.kind === 'text' ? (
                      <span key={i}>{part.text}</span>
                    ) : (
                      <span
                        key={i}
                        className={`rsec-pval${part.missing ? ' bad' : ''}${part.pinned ? ' pinned' : ''}`}
                        title={[
                          part.token,
                          part.member ? `→ ${part.member}` : '',
                          part.pinned ? '(pinned to this member, whatever its rank becomes)' : ''
                        ]
                          .filter(Boolean)
                          .join('  ')}
                      >
                        {part.text}
                      </span>
                    )
                  )}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* What this chapter draws. Every chapter may carry figures — a figure is a drawing of numbers the
                report already has, and which chapter argues with a chart is the author's call, not ours. */}
          <FigureEditor
            figures={open.figures ?? (open.figure ? [open.figure] : [])}
            canCompare={(report.subjects?.length ?? 0) > 1}
            indicatorCount={report.methods?.length ?? 0}
            onChange={(figures) => {
              // `figure: null` locally because the backend drops the legacy single figure as soon as
              // the list is written (report_store.update_section) — the list is what the author edits.
              // Without it the panel re-seeded the deleted figure from stale state until the next load,
              // which is the same lie as the document drawing it.
              patchOpen({ figures, figure: null })
              void mutate('POST', `${base}/sections/${open.id}`, { kind: open.kind, figures })
            }}
          />

          {/* What the inventory chapter is made of. The parts exist whether or not this chapter shows
                them — the parameters and the flows also live in the annex — so which chapter carries
                which is the author's arrangement, not ours. Off by default for those two, because a
                chapter repeating an annex is the padding this report was criticised for. */}
          {open.kind === 'inventory' ? (
            <div className="rsec-instruction">
              <div className="rsec-head">
                <span className="modal-h">What this chapter shows</span>
              </div>
              <div className="rsec-figopts">
                {LCI_PARTS.map(([part, label, hint]) => {
                  const on = (open.inventory_parts ?? LCI_DEFAULT_PARTS).includes(part)
                  return (
                    <label key={part} title={hint}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => {
                          const now = new Set(open.inventory_parts ?? LCI_DEFAULT_PARTS)
                          if (e.target.checked) now.add(part)
                          else now.delete(part)
                          const parts = LCI_PARTS.map(([p]) => p).filter((p) => now.has(p))
                          patchOpen({ inventory_parts: parts })
                          void mutate('POST', `${base}/sections/${open.id}`, {
                            kind: open.kind,
                            inventory_parts: parts
                          })
                        }}
                      />
                      <span>{label}</span>
                    </label>
                  )
                })}
              </div>
              <div className="rsec-figopts">
                <label title="Written, the model turns the process notes into report prose. The other three print the notes themselves — fifteen processes with a paragraph each is four pages, right for a study under review, too much for a screening report.">
                  <span>Process descriptions</span>{' '}
                  <select
                    value={open.inventory_detail ?? 'written'}
                    onChange={(e) => {
                      patchOpen({ inventory_detail: e.target.value })
                      void mutate('POST', `${base}/sections/${open.id}`, {
                        kind: open.kind,
                        inventory_detail: e.target.value
                      })
                    }}
                  >
                    <option value="written">Written from the notes</option>
                    <option value="full">The notes in full</option>
                    <option value="short">The opening of each note</option>
                    <option value="list">Leave them out</option>
                  </select>
                </label>
              </div>
              <p className="settings-hint">
                A process note is whatever was recorded against that process — what it represents, which
                dataset stands in for it, why that proxy holds and what it biases. Those notes are working
                notes, so by default they are not printed: the chapter is written from them, and the reader
                gets prose instead of the model&rsquo;s documentation. Print them raw where the notes really
                are the deliverable.
              </p>
            </div>
          ) : null}

          {/* How the results chapter is *set*, as opposed to what it says. Both of these were fixed
                behaviour until a real report showed why they cannot be: eleven indicators as columns
                overlapped their own headers, and eleven charts of one 3×11 matrix stood in front of a
                heatmap and a radar of the same matrix. Neither is wrong in a five-indicator study —
                which is why they are settings and not new rules. */}
          {open.kind === 'lcia' ? (
            <div className="rsec-instruction">
              <div className="rsec-head">
                <span className="modal-h">Results table and charts</span>
              </div>
              <div className="rsec-figopts">
                <label title="With more indicators than variants, indicators as columns overlap their own headers and squeeze small numbers to zero. Auto turns the table at that point.">
                  <span>Table</span>{' '}
                  <select
                    value={open.table_layout ?? 'auto'}
                    onChange={(e) => {
                      patchOpen({ table_layout: e.target.value })
                      void mutate('POST', `${base}/sections/${open.id}`, {
                        kind: open.kind,
                        table_layout: e.target.value
                      })
                    }}
                  >
                    <option value="auto">Turn it when it needs turning</option>
                    <option value="indicators">Indicators down the side</option>
                    <option value="subjects">Variants down the side</option>
                  </select>
                </label>
                <label title="One bar chart per indicator, comparing the variants. The heatmap and the radar are report-wide and live under Appearance.">
                  <span>A chart per indicator</span>{' '}
                  <select
                    value={open.per_indicator_charts ?? 'all'}
                    onChange={(e) => {
                      patchOpen({ per_indicator_charts: e.target.value })
                      void mutate('POST', `${base}/sections/${open.id}`, {
                        kind: open.kind,
                        per_indicator_charts: e.target.value
                      })
                    }}
                  >
                    <option value="all">All of them</option>
                    <option value="lead">Only the leading one</option>
                    <option value="none">None</option>
                  </select>
                </label>
              </div>
              <p className="settings-hint">
                With ten or more indicators, practice is one overview plus the table rather than a chart per
                category — the heatmap and the radar under Appearance are that overview.
              </p>
            </div>
          ) : null}

          {/* The contribution chapter breaks down every indicator the report computes. Which of them it
                prints is a judgement the data cannot make: three indicators whose phases sit in the same
                order say the same thing three times, and a study that only ever discusses its carbon
                footprint has no use for the other two. Deselected by *label*, because a position moves
                when the report's method list is edited — and then a different indicator would vanish. */}
          {open.kind === 'contribution' && (report.methods?.length ?? 0) > 1 ? (
            <div className="rsec-instruction">
              <div className="rsec-head">
                <span className="modal-h">Indicators in this chapter</span>
              </div>
              <div className="rsec-figopts">
                {(report.methods ?? []).map((m) => {
                  const label = m.join(' / ')
                  const hidden = (open.hidden_indicators ?? []).includes(label)
                  // The same name the chapter's own sub-headings use, decided against the whole
                  // family: twelve ReCiPe endpoint indicators otherwise offered twelve identical
                  // checkboxes, and unticking one hid another (V203, lib/methods).
                  const short = m.length >= 3 ? indicatorLabel(m, indicatorNames) : label
                  return (
                    <label key={label} title={label}>
                      <input
                        type="checkbox"
                        checked={!hidden}
                        onChange={() => {
                          const next = hidden
                            ? (open.hidden_indicators ?? []).filter((x) => x !== label)
                            : [...(open.hidden_indicators ?? []), label]
                          patchOpen({ hidden_indicators: next })
                          void mutate('POST', `${base}/sections/${open.id}`, {
                            kind: open.kind,
                            hidden_indicators: next
                          })
                        }}
                      />{' '}
                      <span>{short}</span>
                    </label>
                  )
                })}
              </div>
              <p className="settings-hint">
                Each one gets its own table — and, where the report compares variants, its own chart with the
                baseline and every scenario side by side. Indicators do not share a unit, so one chart across
                them would put incomparable quantities on one axis.
              </p>
            </div>
          ) : null}

          {/* The annex' inventory table is the one deterministic chapter whose length is a judgement call:
                25 rows is a hotspot list, every flow is a data appendix, and both are legitimate. It sits here
                rather than on the card because it belongs to this chapter and nothing else. */}
          {open.kind === 'appendix' ? (
            <div className="rsec-instruction">
              <div className="rsec-head">
                <span className="modal-h">Inventory table</span>
              </div>
              <div className="rsec-figopts">
                <label>
                  <span>Rows</span>{' '}
                  <NumberInput
                    min={0}
                    max={5000}
                    style={{ width: '5.5em' }}
                    value={open.inventory_rows ?? 25}
                    onValue={(raw) => patchOpen({ inventory_rows: inventoryRows(raw) })}
                    onBlur={(e) => {
                      // What the field shows, not `open` — see shownNumber.
                      const shown = shownNumber(e.currentTarget)
                      const rows = shown === null ? (open.inventory_rows ?? 25) : inventoryRows(shown)
                      if (shown !== null) patchOpen({ inventory_rows: rows })
                      void mutate('POST', `${base}/sections/${open.id}`, {
                        kind: open.kind,
                        inventory_rows: rows
                      })
                    }}
                  />
                </label>
                <label title="Every characterised elementary flow of the reference process — thousands on an ecoinvent-backed model">
                  <input
                    type="checkbox"
                    checked={open.inventory_rows === 0}
                    onChange={(e) => {
                      const rows = e.target.checked ? 0 : 25
                      patchOpen({ inventory_rows: rows })
                      void mutate('POST', `${base}/sections/${open.id}`, {
                        kind: open.kind,
                        inventory_rows: rows
                      })
                    }}
                  />
                  <span>All flows</span>
                </label>
              </div>
              {open.inventory_rows === 0 ? (
                <p className="rsec-findings" style={{ margin: '6px 0 0' }}>
                  Every characterised flow of the reference process. On an ecoinvent-backed model that is
                  typically a few thousand rows — a data appendix of its own, tens of pages long.
                </p>
              ) : (
                <p className="settings-hint">
                  The largest by contribution. The chapter states the total, which is the whole score — so the
                  rows shown do not add up to it.
                </p>
              )}
            </div>
          ) : null}

          <div className="rsec-instruction">
            <div className="rsec-head">
              <span className="modal-h">
                Instruction
                {open.prompt_override ? <span className="rsec-kind">customised</span> : null}
              </span>
              <select
                aria-label="Start from a built-in instruction"
                value=""
                onChange={(e) => {
                  const text = prompts[e.target.value]
                  if (!text) return
                  void mutate('POST', `${base}/sections/${open.id}`, {
                    kind: open.kind,
                    prompt_override: text
                  })
                }}
              >
                <option value="">
                  {promptsRead ? 'Start from a built-in one…' : 'Built-in instructions unavailable'}
                </option>
                {Object.keys(prompts).map((k) => (
                  <option key={k} value={k}>
                    {kindLabel(k)}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              rows={9}
              value={open.prompt_override ?? prompts[open.kind] ?? ''}
              placeholder={
                promptsRead
                  ? 'What this chapter is asked to do.'
                  : 'The built-in instructions could not be read — this box is empty because a request failed, not because this chapter has none.'
              }
              onChange={(e) => patchOpen({ prompt_override: e.target.value })}
              onBlur={() =>
                void mutate('POST', `${base}/sections/${open.id}`, {
                  kind: open.kind,
                  // Edited back to the standard text? Then it is not an override any more — otherwise the
                  // "customised" badge would lie for the rest of the report's life.
                  prompt_override:
                    (open.prompt_override ?? '').trim() === (prompts[open.kind] ?? '').trim()
                      ? null
                      : open.prompt_override
                })
              }
            />
            {open.prompt_override ? (
              <button
                className="btn sm"
                onClick={() =>
                  void mutate('POST', `${base}/sections/${open.id}`, {
                    kind: open.kind,
                    prompt_override: null
                  })
                }
              >
                Back to the standard instruction
              </button>
            ) : null}
            {promptsRead ? null : (
              <p className="settings-hint">
                The built-in instructions could not be loaded, so this box and the picker above are empty for
                that reason alone — a chapter with no override still writes against its standard instruction.{' '}
                <button className="btn sm" onClick={() => void loadPrompts()}>
                  Try again
                </button>
              </p>
            )}
            <label className="settings-field">
              <span>Additional instructions for this chapter</span>
              <textarea
                rows={3}
                value={open.extra_instructions}
                placeholder="Appended to the instruction above — house conventions, emphasis, what to leave out."
                onChange={(e) => patchOpen({ extra_instructions: e.target.value })}
                onBlur={() =>
                  void mutate('POST', `${base}/sections/${open.id}`, {
                    kind: open.kind,
                    extra_instructions: open.extra_instructions
                  })
                }
              />
            </label>
            <div className="rsec-note">
              <InfoIcon />
              <span>
                The rules every chapter obeys — no literal numbers, no invented facts, no emojis, the
                report&apos;s language — are appended to this and cannot be edited away.
              </span>
            </div>
          </div>
        </div>

        <div className="sheet-foot">
          {/* The modal covers the panel, so the foot line's commentary cannot be read from here —
                  and this is where the second Write button lives. Same string, same clock. */}
          {writing === open.id && stage ? (
            <span className="meta">{writeStatus(chapterLabel(open), stage, writeSeconds)}</span>
          ) : open.source ? (
            <span className="meta">
              Written by {open.source === 'ai' ? 'the assistant' : 'you'}
              {open.generated_at ? ` · ${open.generated_at.slice(0, 16).replace('T', ' ')}` : ''}
            </span>
          ) : null}
          <div className="acts">
            <button
              className="btn primary"
              disabled={writing !== null || runActive || open.locked}
              title={writeTooltip(open, null)}
              onClick={() => askWrite(open)}
            >
              {writing === open.id ? <Busy label="Writing" /> : 'Write'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
