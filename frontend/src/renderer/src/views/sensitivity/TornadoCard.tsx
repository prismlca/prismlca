import { useMemo, useState } from 'react'
import { SaveIcon } from '../../components/icons'
import type { ChartRegistry } from '../../lib/charts/useEChart'
import { indicatorLabel } from '../../lib/methods'
import { RunBar } from './RunBar'
import { TornadoChart } from './TornadoChart'
import {
  type RunState,
  TOP,
  breakNote,
  fmtValue,
  limitedNote,
  pctLabel,
  signedPct,
  sortedEntries,
  swing
} from './helpers'
import type { JobSnapshot, StoredRun, TornadoResult } from './types'

const SKIP_TEXT: Record<string, string> = {
  has_formula: 'calculated from other parameters',
  zero_value: 'value is 0',
  fixed: 'fixed by its rule'
}

/**
 * The tornado card: its run bar, the indicator switch (buttons up to three, a list beyond), the chart with
 * the top ten bars and the rest behind "+ N more", and the footnotes — the parameters a rule held back (*)
 * and the ones not varied at all, so an absent bar is never read as a zero one.
 */
export function TornadoCard({
  stored,
  state,
  job,
  error,
  canRun,
  hint,
  onRun,
  onCancel,
  onPick,
  units,
  labels,
  subjectLabel,
  registry,
  themeKey,
  onSave
}: {
  stored: StoredRun<TornadoResult> | null
  state: RunState
  job: JobSnapshot<unknown> | null
  error: string | null
  canRun: boolean
  hint: string
  onRun: () => void
  onCancel: () => void
  onPick: (param: string) => void
  units: Record<string, string>
  labels: Map<string, string>
  subjectLabel: string
  registry: ChartRegistry
  themeKey: string
  onSave: (id: string, name: string) => void
}): JSX.Element {
  const [mi, setMi] = useState(0)
  const [all, setAll] = useState(false)
  const result = stored?.result ?? null
  const m = result && mi < result.methods.length ? mi : 0
  const sorted = useMemo(() => (result ? sortedEntries(result, m) : []), [result, m])
  const shown = all ? sorted : sorted.slice(0, TOP)
  const pct = result ? `±${pctLabel(result.delta)} %` : ''
  const name = (i: number): string =>
    result ? indicatorLabel(result.methods[i], labels) || result.methods[i][1] : ''
  const restMax = result && sorted.length > TOP ? swing(sorted[TOP], m, result.baseline[m]) : 0
  const limited = sorted.filter((e) => e.limited)
  const broke = sorted.filter((e) => e.breaks)
  const skipped = result?.skipped ?? []

  return (
    <section className="sens-card">
      <div className="sens-h">
        <div className="sens-h-text">
          <p className="sens-title">Tornado{subjectLabel ? ` — ${subjectLabel}` : ''}</p>
          {result ? (
            <p className="sens-sub">
              {result.scenario ? result.scenario.name : 'Baseline'} · each input {pct} on its own ·{' '}
              {all || sorted.length <= TOP ? sorted.length : `top ${TOP} of ${sorted.length}`} inputs
            </p>
          ) : null}
        </div>
        {result && result.methods.length > 1 ? (
          result.methods.length <= 3 ? (
            <span className="seg">
              {result.methods.map((_, i) => (
                <button key={i} className={`seg-btn${i === m ? ' on' : ''}`} onClick={() => setMi(i)}>
                  {name(i)}
                </button>
              ))}
            </span>
          ) : (
            <select className="search-sel" value={m} onChange={(e) => setMi(Number(e.target.value))}>
              {result.methods.map((_, i) => (
                <option key={i} value={i}>
                  {name(i)}
                </option>
              ))}
            </select>
          )
        ) : null}
      </div>
      {result && sorted.length ? (
        <>
          <p className="sens-state">
            Result {fmtValue(result.baseline[m])} {result.units[m]} · {name(m)}
          </p>
          <div className="sens-legend">
            <span>
              <span className="sens-sw lo" />
              Input −{pctLabel(result.delta)} %
            </span>
            <span>
              <span className="sens-sw hi" />
              Input +{pctLabel(result.delta)} %
            </span>
            <span className="sens-legend-note">Click a bar to plot it as a curve</span>
          </div>
          <div className="sens-chart-host">
            <button
              className="chart-save"
              title="Save this chart as PNG"
              onClick={() => onSave('tornado', 'tornado')}
            >
              <SaveIcon />
            </button>
            <TornadoChart
              regId="tornado"
              registry={registry}
              themeKey={themeKey}
              entries={shown}
              mi={m}
              baseline={result.baseline[m]}
              unit={result.units[m]}
              delta={result.delta}
              units={units}
              onPick={onPick}
            />
          </div>
          {sorted.length > TOP ? (
            <button className="sens-more" onClick={() => setAll((v) => !v)}>
              {all
                ? `Show the top ${TOP} only`
                : `+ ${sorted.length - TOP} more inputs, each moving the result by ${
                    result.baseline[m]
                      ? signedPct((restMax / Math.abs(result.baseline[m])) * 100).replace('+', '')
                      : `${fmtValue(restMax)} ${result.units[m]}`
                  } or less`}
            </button>
          ) : null}
          {limited.length || broke.length || skipped.length ? (
            <div className="sens-foot">
              {limited.length ? (
                <p>
                  <span className="sens-ast">*</span>Moved less than {pct} because the parameter&apos;s rule
                  says so: {limited.map(limitedNote).join('; ')}.
                </p>
              ) : null}
              {broke.length ? (
                <p>
                  <span className="sens-ast">!</span>The step leaves another parameter outside its allowed
                  values, so the bar shows a model its rules exclude:{' '}
                  {broke.map((e) => breakNote(e, result.delta)).join('; ')}.
                </p>
              ) : null}
              {Object.entries(SKIP_TEXT).map(([reason, text]) => {
                const names = skipped.filter((s) => s.reason === reason).map((s) => s.param)
                return names.length ? (
                  <p key={reason}>
                    Not varied — {text}: {names.map((n, i) => [i ? ', ' : '', <b key={n}>{n}</b>])}.
                  </p>
                ) : null
              })}
            </div>
          ) : null}
        </>
      ) : result ? (
        <p className="sens-empty">This model has no parameter the tornado could vary.</p>
      ) : (
        <p className="sens-empty">
          No tornado yet. Choose its settings on the left and click Calculate. A run usually takes a few
          seconds.
        </p>
      )}
      <RunBar
        job={job}
        canRun={canRun}
        hint={hint}
        state={state}
        stored={stored}
        error={error}
        onRun={onRun}
        onCancel={onCancel}
      />
    </section>
  )
}
