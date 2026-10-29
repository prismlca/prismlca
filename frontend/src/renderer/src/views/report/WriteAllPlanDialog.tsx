import Overlay from '../../components/Overlay'
import Busy from '../../components/Busy'
import { chapterLabel, writerModel } from '../../lib/report/model'
import { PLAN_LABEL, type PlanItem } from '../../lib/report/plan'

/** The dry run. Every chapter the run considered, what would happen to it and why — with the
 * untouched ones shown too, because "the run left four alone" is only reassuring if you can see
 * which four and on what grounds. An update keeps the chapter and changes what went false; a ticked
 * "Keep" writes the chapter anew. (The ticking and the run stay with the panel.) */
export default function WriteAllPlanDialog({
  plan,
  run,
  runNote,
  notice,
  checkSeconds,
  onClose,
  onChosen,
  onReset,
  onRun
}: {
  plan: {
    items: PlanItem[]
    chosen: string[]
    checking: boolean
    progress: { done: number; total: number } | null
  }
  /** What pressing Run really costs — runSize over the current ticks. */
  run: { total: number; translation: number }
  /** The paid translation step's own sentence, when the run has one (languagePlan). */
  runNote: string | null
  /** The failed-check notice — the modal covers the foot that also carries it. */
  notice: { lead: string; detail: string } | null
  checkSeconds: number
  onClose: () => void
  onChosen: (sectionId: string, on: boolean) => void
  onReset: () => void
  onRun: () => void
}): JSX.Element {
  return (
    <Overlay onClose={onClose} className="modal sheet rsec-plan">
      <div className="sheet-head">
        <div className="sheet-head-grow">
          <h3>
            {plan.items.some((i) => i.action === 'write')
              ? 'Write the report'
              : plan.items.some((i) => i.action === 'update')
                ? 'Update the report'
                : 'Rewrite the report'}
          </h3>
          {/* Which models are about to work is a fact of this run, said before Run is pressed. */}
          <p>
            Writes with <code>{writerModel()}</code>; a second model (your Review model) reads every chapter
            before it is stored, and the two settle its points between them. An update keeps the chapter and
            changes only what is no longer true; tick a “Keep” to write that chapter anew.
          </p>
        </div>
        <button className="sheet-x" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="sheet-body">
        {/* The eleventh call. The translation is not a chapter and has no row to tick, so without
                this line the extra one in Run has no name — and it is the one call the author cannot
                point at in the list below (V169). */}
        {run.translation ? <p className="muted">{runNote}</p> : null}
        {/* The check is a full pass over the study's numbers: on an ecoinvent model with several
                variants it takes tens of seconds (on a brand-new report the backend answers at once —
                nothing is written, nothing to compare). Said out loud WITH a running clock, because a
                static sentence over minutes reads as a hang (V121); the ticks stay usable
                the whole time — mergeTicks carries them onto the fresh list — and only Run waits. */}
        {plan.checking ? (
          <div className="rsec-plan-check">
            <p className="settings-hint">
              The list below is the last known state and will re-sort itself; your ticks are kept. Only Run
              waits for the check.
            </p>
            {plan.progress ? (
              <div
                className="rsec-progress working"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={plan.progress.total}
                aria-valuenow={plan.progress.done}
              >
                <span
                  style={{
                    width: `${Math.max(4, Math.round((plan.progress.done / Math.max(1, plan.progress.total)) * 100))}%`
                  }}
                />
              </div>
            ) : null}
          </div>
        ) : null}
        {/* …and when it did not come back at all. The rows below then read "No record of what this
                text was written against", which is what an old hand-written chapter looks like too — so
                without this line a failed check is indistinguishable from a report full of them. The
                foot carries the same sentence, but this modal covers the foot. */}
        {notice && !plan.checking ? (
          <p className="settings-hint">
            {notice.lead} <b>{notice.detail}</b>
          </p>
        ) : null}
        <div className="rsec-plan-list">
          {plan.items.map((item) => {
            const on = plan.chosen.includes(item.section.id)
            // Not gated on `checking`: mergeTicks exists precisely so ticks made while the
            // staleness answer is on its way survive the re-sort — disabling the boxes for the
            // longest stretch the dialog is open made that helper dead code (V121).
            const offerable = item.action !== 'blocked'
            return (
              <label
                key={item.section.id}
                className={`rsec-plan-row${offerable ? '' : ' off'}`}
                title={item.why}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!offerable}
                  onChange={(e) => onChosen(item.section.id, e.target.checked)}
                />
                <span className="rsec-plan-title">{chapterLabel(item.section)}</span>
                <span className={`rsec-plan-tag ${PLAN_LABEL[item.action].tone}`}>
                  {item.action === 'keep' && on ? 'Write anew' : PLAN_LABEL[item.action].label}
                </span>
                <span className="rsec-plan-why">{item.why}</span>
              </label>
            )
          })}
        </div>
      </div>
      <div className="sheet-foot">
        {/* The running clock stands in the foot, beside the Run it holds up. */}
        <span className="meta">
          {plan.checking
            ? plan.progress
              ? `Checking what has changed — ${plan.progress.done} of ${plan.progress.total} chapters checked (${checkSeconds}s)`
              : `Checking what has changed under each chapter (${checkSeconds}s)…`
            : null}
        </span>
        <div className="acts">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={plan.checking} onClick={onReset}>
            Reset the ticks
          </button>
          <button className="btn primary" disabled={plan.checking || !plan.chosen.length} onClick={onRun}>
            {plan.checking ? <Busy label="Checking" /> : run.total ? `Run ${run.total}` : 'Nothing to run'}
          </button>
        </div>
      </div>
    </Overlay>
  )
}
