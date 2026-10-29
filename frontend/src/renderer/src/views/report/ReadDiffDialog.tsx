import Overlay from '../../components/Overlay'
import { wordDiff } from '../../lib/wordDiff'
import { chapterLabel, type ReportSection } from '../../lib/report/model'

/** What moved since the author last read this chapter — the answer to "is this still the
 * report I know?", shown rather than asserted. `kind` says which question the diff answers:
 * what moved since the author marked the chapter read, or what its last change did to it. */
export default function ReadDiffDialog({
  diff,
  onClose,
  onPutBack,
  onMarkRead
}: {
  diff: { section: ReportSection; before: string; kind?: 'reviewed' | 'previous' }
  onClose: () => void
  /** Put the earlier wording back — the parent runs it through its mutation queue. */
  onPutBack: () => void
  onMarkRead: () => void
}): JSX.Element {
  return (
    <Overlay onClose={onClose} className="modal sheet rsec-patch">
      <div className="sheet-head">
        <div className="sheet-head-grow">
          <h3>
            {diff.kind === 'previous'
              ? `What changed in “${chapterLabel(diff.section)}”`
              : `Since you approved “${chapterLabel(diff.section)}”`}
          </h3>
        </div>
        <button className="sheet-x" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="rsec-patch-body">
        {(() => {
          // A word diff earns its keep on targeted edits — a correction, a re-linked figure.
          // After a wholesale rewrite the two texts share almost nothing, and the "diff" is the
          // old chapter struck through with the new one underlined between the lines: noise, not
          // an answer. Below a third of surviving words, show the versions whole instead.
          const parts = wordDiff(diff.before, diff.section.text ?? '')
          const words = (t: string): number => t.split(/\s+/).filter(Boolean).length
          const total = parts.reduce((n, p) => n + words(p.text), 0)
          const same = parts.filter((p) => p.kind === 'same').reduce((n, p) => n + words(p.text), 0)
          if (total > 40 && same / total < 0.3) {
            return (
              <>
                <p className="hint rsec-patch-lead">
                  {diff.kind === 'previous'
                    ? 'This chapter was rewritten wholesale — the two versions share too little for a word-by-word diff to mean anything, so here they are whole.'
                    : 'This chapter was rewritten wholesale since you approved it — the two versions share too little for a word-by-word diff, so here they are whole.'}{' '}
                  Nothing here is written or stored — it is a view of two versions.
                </p>
                <p className="hint rsec-patch-label">
                  <b>Before</b>
                </p>
                <p className="rsec-worddiff">{diff.before}</p>
                <p className="hint rsec-patch-label">
                  <b>Now</b>
                </p>
                <p className="rsec-worddiff">{diff.section.text ?? ''}</p>
              </>
            )
          }
          return (
            <>
              {/* Two texts and two colours, and neither says which is which. The heading names
                      the comparison but not what is being compared *against*, and a struck-through
                      word is only obviously a removal once you know that. */}
              <p className="hint rsec-patch-lead">
                {diff.kind === 'previous'
                  ? 'The wording this chapter had before its last change, against what it says now.'
                  : 'What this chapter said when you approved it, against what it says now.'}{' '}
                <del>Struck through</del> was taken out, <ins>underlined</ins> was added; everything else is
                unchanged. Nothing here is written or stored — it is a view of two versions.
              </p>
              <p className="rsec-worddiff">
                {parts.map((part, i) =>
                  part.kind === 'same' ? (
                    <span key={i}>{part.text}</span>
                  ) : part.kind === 'added' ? (
                    <ins key={i}>{part.text}</ins>
                  ) : (
                    <del key={i}>{part.text}</del>
                  )
                )}
              </p>
            </>
          )
        })()}
      </div>
      <div className="sheet-foot">
        <div className="acts">
          {/* Only for the previous wording: putting a version back is a text change like any
                    other, so it goes through the same call — and the version it replaces becomes the
                    new "previous", which is what makes this reversible rather than a one-way door. */}
          {diff.kind === 'previous' ? (
            <button
              className="btn"
              title="Put the earlier wording back. The present one becomes the version you can return to."
              onClick={onPutBack}
            >
              Put it back
            </button>
          ) : (
            <button
              className="btn primary"
              title="You have read the chapter as it stands now and stand behind it — it is approved again."
              onClick={onMarkRead}
            >
              Approve again
            </button>
          )}
        </div>
      </div>
    </Overlay>
  )
}
