import { useState } from 'react'
import { useSettings } from '../../lib/settings'
import { ChevronIcon } from '../../components/icons'
import { WhyDifferentDialog } from './WhyDifferentDialog'
import type { MatrixRow, Picked, WhyData } from './types'
import {
  ASK_BASELINE,
  changeName,
  changePart,
  changeTitle,
  deltaLabel,
  needsBaseline,
  pairsFor,
  vsLabel,
  whyNote,
  type WhyPair
} from './whySplits'

/** How many drivers a pair names under the chart; "all changes…" lists the rest. */
export const DRIVERS_SHOWN = 3

/**
 * What makes the difference, under one indicator's bar chart: for every scenario or copy, its difference to its
 * reference in % and its three largest drivers with their share; "all changes…" opens the whole list. Computed
 * with the scores, in the same run (`useCompareRun`), so it describes exactly the bars above it. A scenario is
 * split only against its baseline: without the baseline ticked, one sentence asks for it.
 *
 * Folded until its head is clicked, per chart: sixteen indicators with three scenarios each is a long page, and the
 * charts are what it is read for; the switch in "Chart display" hides the sections altogether.
 */
export function WhyDifferent({
  why,
  rows,
  indicator,
  color
}: {
  why: WhyData
  rows: MatrixRow[]
  indicator: Picked
  color: (s: MatrixRow) => string
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState<WhyPair | null>(null)
  const { round } = useSettings()
  const digits = round.results
  const pairs = pairsFor(why, indicator.key)
  const askBaseline = needsBaseline(why)
  if (!pairs.length) return askBaseline ? <p className="why-ask">{ASK_BASELINE}</p> : null
  return (
    <div className={`why${open ? ' open' : ''}`}>
      <button
        className="why-head"
        aria-expanded={open}
        aria-label={`What makes the difference — ${indicator.label}`}
        onClick={() => setOpen(!open)}
      >
        <span className="car" aria-hidden="true">
          <ChevronIcon />
        </span>
        What makes the difference
      </button>
      {open ? (
        <ul className="why-list">
          {pairs.map((pair) => {
            const row = rows[pair.sub]
            if (!row) return null
            const { block } = pair
            return (
              <li key={pair.sub} className="why-item">
                <div className="why-who">
                  <span className="why-dot" style={{ background: color(row) }} aria-hidden="true" />
                  <span className="why-name" title={row.label}>
                    {row.label}
                  </span>
                  <span className="why-vs">vs {vsLabel(rows, pair.sub, pair.ref)}</span>
                  {block ? (
                    <span className={`why-delta${block.delta > 0 ? ' up' : block.delta < 0 ? ' down' : ''}`}>
                      {deltaLabel(block, digits)}
                    </span>
                  ) : null}
                </div>
                {pair.split.error ? (
                  <div className="why-err">{pair.split.error}</div>
                ) : block ? (
                  <div className="why-drivers">
                    {block.changes.length ? (
                      block.changes.slice(0, DRIVERS_SHOWN).map((c, k) => (
                        <span key={k} className="why-chip" title={changeTitle(c, digits)}>
                          {changeName(c)} <b>{changePart(c, digits)}</b>
                        </span>
                      ))
                    ) : (
                      <span className="why-none">Nothing changed that moves this indicator.</span>
                    )}
                    {block.changes.length ? (
                      <button
                        className="why-all"
                        aria-label={`All changes — ${row.label} — ${indicator.label}`}
                        onClick={() => setShown(pair)}
                      >
                        all changes…
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      {open && askBaseline ? <p className="why-ask">{ASK_BASELINE}</p> : null}
      {shown?.block ? (
        <WhyDifferentDialog
          pair={shown}
          block={shown.block}
          rows={rows}
          indicator={indicator}
          onClose={() => setShown(null)}
        />
      ) : null}
    </div>
  )
}

/** The one sentence for subjects nothing is split against, above the per-indicator charts. */
export function WhyNote({ why, rows }: { why: WhyData; rows: MatrixRow[] }): JSX.Element | null {
  const note = whyNote(why, rows)
  return note ? <p className="why-note">{note}</p> : null
}
