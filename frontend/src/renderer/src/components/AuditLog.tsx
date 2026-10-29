import { useState } from 'react'
import { type AuditEntry, isAttributed } from '../lib/api'
import { HistoryIcon, NoUndoIcon } from './icons'

/**
 * Chronological audit log (newest first) — same look as the canvas inspector's log.
 *
 * Two lists, not one. The pages that show this (Parameters, Scenarios) are about **one** model and
 * ask the backend for that model's entries; what comes back also contains the history written
 * before entries named a model at all — in the development log that is every one of its 1268 lines,
 * because the field did not exist before this release. Those are shown
 * as their own collapsed block at the bottom and never mixed in, because `Set parameter 'tube_mass'
 * = 0.4` sitting in the wrong model's list is precisely the confusion the attribution field was
 * added to end. They are not sorted into a model by matching its name in the text either: that
 * guess is what made the bundle export ship an arbitrary slice of the history and call it complete.
 *
 * Two things the backend resolves and this only renders (a name in the log is the name *at the
 * time*, and only the log's own order says which model had it): an entry whose model no longer
 * exists says so instead of going missing, and an entry written under an older name says what the
 * model is called now. Neither can be worked out here — it takes the whole log to know.
 */
/**
 * Group a newest-first list into runs of consecutive entries sharing one assistant turn.
 * Grouped on the written `turn` field only — never on source + timestamp proximity, which is the
 * guess-identity-from-prose mistake this log once got wrong. Entries without
 * a turn come back as single-item groups with `turn: undefined`.
 */
export function groupByTurn(newestFirst: AuditEntry[]): Array<{ turn?: string; items: AuditEntry[] }> {
  const groups: Array<{ turn?: string; items: AuditEntry[] }> = []
  for (const e of newestFirst) {
    const last = groups[groups.length - 1]
    if (e.turn && last?.turn === e.turn) last.items.push(e)
    else groups.push({ turn: e.turn ?? undefined, items: [e] })
  }
  return groups
}

/** One dashed box per assistant turn of two or more changes; a turn of one renders bare. The box
 *  says "these belong together", and one entry has nothing to belong with — its row already names the
 *  assistant as its source, and undoing the turn is undoing that entry. Shared by
 *  this component and the canvas inspector's inline log, so the two lists cannot drift apart on this. */
export function TurnGroups({
  entries,
  row
}: {
  entries: AuditEntry[]
  row: (e: AuditEntry) => JSX.Element
}): JSX.Element {
  return (
    <>
      {groupByTurn(entries).map((g) =>
        g.turn && g.items.length > 1 ? (
          <div
            key={`t-${g.items[0].index}`}
            className="aud-turn"
            title="These changes were made by the assistant in one turn (one chat message). Undo offers to take the whole turn back."
          >
            <div className="aud-turn-head">assistant turn · {g.items.length} changes</div>
            {g.items.map(row)}
          </div>
        ) : (
          g.items.map(row)
        )
      )}
    </>
  )
}

export default function AuditLog({ entries }: { entries: AuditEntry[] }): JSX.Element {
  const [showEarlier, setShowEarlier] = useState(false)
  const own = entries.filter(isAttributed)
  const earlier = entries.filter((e) => !isAttributed(e))
  // Where this model came from, if it was copied out of another one. The backend marks the single
  // entry that created it and keeps that entry inside the `limit`, so this line does not go missing
  // on exactly the models with enough history to make the question worth asking.
  const copiedFrom = own.find((e) => e.copied_from)?.copied_from

  return (
    <div className="audit-wrap">
      <div className="eyebrow audit-head">
        <HistoryIcon /> Audit log
      </div>
      {own.length === 0 && earlier.length === 0 ? (
        <p className="hint-sm" style={{ margin: 0 }}>
          No actions recorded yet.
        </p>
      ) : (
        <>
          {copiedFrom ? (
            <p className="audit-origin">
              Copied from <b>{copiedFrom}</b> — see its history for everything before that.
            </p>
          ) : null}
          {own.length === 0 ? (
            // With older history below, the model most likely predates entries naming their model —
            // "nothing recorded" read as a broken log on exactly those models.
            <p className="hint-sm" style={{ margin: 0 }}>
              {earlier.length
                ? 'No entry names this model. Entries name their model since August 2026; anything older is in the block below, among other models’ lines.'
                : 'Nothing recorded for this model yet.'}
            </p>
          ) : (
            <div className="audit-list">
              <TurnGroups entries={[...own].reverse()} row={(a) => <Row key={a.index} entry={a} />} />
            </div>
          )}
          {earlier.length ? (
            <div className="audit-earlier">
              <button
                className="linklike"
                onClick={() => setShowEarlier((v) => !v)}
                aria-expanded={showEarlier}
                title="History from before entries recorded which model they belonged to"
              >
                {showEarlier ? '▾' : '▸'} earlier history · not attributable to a model ({earlier.length})
              </button>
              {showEarlier ? (
                <div className="audit-list">
                  {[...earlier].reverse().map((a) => (
                    <Row key={a.index} entry={a} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {/* A filtered list invites the assumption of a filtered Undo, and there is none. Said
              here rather than found out by undoing something in a model you are not looking at. */}
          <p className="audit-note">
            This model’s changes. Undo takes back only these, newest first, back to the start of this session
            — past other models’ newer edits of amounts, parameters, fields, scenarios and goal & scope. A
            newer structural change in another model (a process added or deleted, the library, tags) holds
            Undo here: undoing that one frees it, but takes it back; editing the value directly does not.
          </p>
        </>
      )}
    </div>
  )
}

function Row({ entry }: { entry: AuditEntry }): JSX.Element {
  return (
    <div className={`aud ${entry.action}`}>
      {/* Who did it and — underneath — whether it can be taken back. The "no undo" marker used to be
          a pill on the RIGHT edge, where it competed with the summary for the same line; entries have
          grown long enough that the text lost. Stacked under the source label it
          costs the text no width at all. */}
      <span className="aud-who">
        <span className="aud-src">{entry.source}</span>
        {entry.undoable === false ? (
          <span className="aud-noundo" title="Not part of the undo history — cannot be undone">
            <NoUndoIcon />
          </span>
        ) : null}
      </span>
      <span>{entry.summary}</span>
      {entry.related ? (
        <span className="aud-rel" title={`This change came from ${entry.related}`}>
          from {entry.related}
        </span>
      ) : null}
      {/* The name in the line is the name at the time and is never rewritten, so the two markers
          below are what the log says about it now. `model_gone` is the one that has to be here: the
          entry stays after its model is deleted, and a line pointing at a name that means nothing is
          worse than no line at all. */}
      {entry.model_gone ? (
        <span
          className="aud-rel"
          title={`‘${entry.database}’ was deleted; this entry stays because the history outlives the model`}
        >
          model no longer exists
        </span>
      ) : null}
      {entry.current_name ? (
        <span
          className="aud-rel"
          title={`Recorded under ‘${entry.database}’; the model has since been renamed to ‘${entry.current_name}’`}
        >
          now {entry.current_name}
        </span>
      ) : null}
      {entry.databases?.length ? (
        <span className="aud-rel" title={`Workspace-wide action; it changed ${entry.databases.join(', ')}`}>
          workspace-wide
        </span>
      ) : entry.workspace ? (
        <span
          className="aud-rel"
          title="Workspace-wide action: it changes no single model and appears in every model's log"
        >
          workspace-wide
        </span>
      ) : null}
    </div>
  )
}
