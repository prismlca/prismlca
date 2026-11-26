import { useSettings, fmtSig } from '../../lib/settings'
import { copyNumber } from '../../lib/copyNumber'
import EscapeCloser from '../../components/EscapeCloser'
import DialogBox from '../../components/DialogBox'
import type { DifferenceBlock, MatrixRow, Picked } from './types'
import { deltaLabel, fmtShare, fmtSigned, pairingText, vsLabel, type WhyPair } from './whySplits'

/**
 * Every change behind one pair's difference in one indicator: what changed and where, before and after, unit,
 * location, formula, its contribution and its share — largest first, as the split ranks them. Below the list,
 * what it does not name: changes past the ones listed, the rest the split leaves over, and for a copy which
 * processes only one of the two models has.
 */
export function WhyDifferentDialog({
  pair,
  block,
  rows,
  indicator,
  onClose
}: {
  pair: WhyPair
  block: DifferenceBlock
  rows: MatrixRow[]
  indicator: Picked
  onClose: () => void
}): JSX.Element {
  const { round } = useSettings()
  const digits = round.results
  const sub = rows[pair.sub]?.label ?? ''
  const vs = vsLabel(rows, pair.sub, pair.ref)
  const title = `${sub} vs ${vs} — ${indicator.label}`
  const { pairing, note } = pair.split
  const num = (x: number): string => fmtSig(x, digits)
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <EscapeCloser onClose={onClose} />
      <DialogBox className="why-dialog" label={title}>
        <div className="chart-zoom-head">
          <span>{title}</span>
          <button className="btn sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="why-dialog-body">
          <p className="why-sum">
            {num(block.reference_score)} → {num(block.score)} {block.unit} · {fmtSigned(block.delta, digits)}{' '}
            ({deltaLabel(block, digits)})
          </p>
          {note ? <p className="why-sub">{note}</p> : null}
          {pairing ? <p className="why-sub">{pairingText(pairing)}</p> : null}
          <div className="why-scroll">
            <table className="why-table" aria-label="All changes">
              <thead>
                <tr>
                  <th>Change</th>
                  <th>Kind</th>
                  <th className="num">Before</th>
                  <th className="num">After</th>
                  <th>Unit</th>
                  <th>Location</th>
                  <th>Formula</th>
                  <th className="num">Contribution</th>
                  <th className="num">Share</th>
                </tr>
              </thead>
              <tbody>
                {block.changes.map((c, k) => (
                  <tr key={k}>
                    <td className="why-what">
                      <b>{c.exchange ?? c.process}</b>
                      {c.exchange && c.process ? <small>in {c.process}</small> : null}
                    </td>
                    <td>{c.kind}</td>
                    <td className="num">{num(c.before)}</td>
                    <td className="num">{num(c.after)}</td>
                    <td>{c.unit ?? ''}</td>
                    <td>{c.location ?? ''}</td>
                    <td className="why-formula">{c.formula ?? ''}</td>
                    <td
                      className="num"
                      // The full contribution, unrounded as the answer carries it, to the clipboard.
                      onDoubleClick={(e) => void copyNumber(c.contribution, e)}
                    >
                      {fmtSigned(c.contribution, digits)}
                    </td>
                    <td className="num">{c.share_pct != null ? fmtShare(c.share_pct) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {block.more ? (
            <p className="why-sub">
              {block.more.count} more change{block.more.count === 1 ? '' : 's'}, together{' '}
              {fmtSigned(block.more.contribution, digits)} {block.unit}.
            </p>
          ) : null}
          {block.not_explained !== 0 ? (
            <p className="why-sub">
              Not explained: {fmtSigned(block.not_explained, digits)} {block.unit}
              {block.exact ? ' — rounding of the two calculations.' : '.'}
            </p>
          ) : null}
          {block.changed_without_effect ? (
            <p className="why-sub">
              {block.changed_without_effect} further change{block.changed_without_effect === 1 ? '' : 's'}{' '}
              without effect on this indicator.
            </p>
          ) : null}
          <p className="why-foot">
            Each change is valued at what it costs in the reference, with every other change already made, so
            the contributions add up to the difference exactly. Double-click a contribution to copy it.
          </p>
        </div>
      </DialogBox>
    </div>
  )
}
