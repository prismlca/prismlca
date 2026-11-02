import { SaveIcon } from '../../components/icons'
import type { ChartRegistry } from '../../lib/charts/useEChart'
import { indicatorLabel } from '../../lib/methods'
import { CURVE_PALETTE } from '../../lib/palette'
import { CurveChart } from './CurveChart'
import { RunBar } from './RunBar'
import { type RunState, fmtValue } from './helpers'
import type { CurveResult, JobSnapshot, StoredRun } from './types'

/**
 * The parameter-curve card: its run bar, a legend of the variants and the chart. The large dot on each line
 * is the value the parameter has in that variant — the point a reader looks for first.
 */
export function CurveCard({
  stored,
  state,
  job,
  error,
  canRun,
  hint,
  onRun,
  onCancel,
  paramUnit,
  subjectLabel,
  labels,
  registry,
  themeKey,
  onSave
}: {
  stored: StoredRun<CurveResult> | null
  state: RunState
  job: JobSnapshot<unknown> | null
  error: string | null
  canRun: boolean
  hint: string
  onRun: () => void
  onCancel: () => void
  paramUnit: string
  /** The process the shown curve was computed for. */
  subjectLabel: string
  labels: Map<string, string>
  registry: ChartRegistry
  themeKey: string
  onSave: (id: string, name: string) => void
}): JSX.Element {
  const result = stored?.result ?? null
  const colors = (result?.curves ?? []).map((_, i) => CURVE_PALETTE[i % CURVE_PALETTE.length])
  const x = result?.values ?? []
  return (
    <section className="sens-card">
      <div className="sens-h">
        <div className="sens-h-text">
          <p className="sens-title">
            Parameter curve{result ? ' — ' : ''}
            {result ? result.param : null}
          </p>
          {result ? (
            <p className="sens-sub">
              {subjectLabel ? `${subjectLabel} · ` : ''}
              {indicatorLabel(result.method, labels) || result.method[1]} · {fmtValue(x[0])}–
              {fmtValue(x[x.length - 1])}
              {paramUnit ? ` ${paramUnit}` : ''} in {x.length} points · large dot = the variant&apos;s own
              value
            </p>
          ) : null}
        </div>
      </div>
      {result ? (
        <>
          <div className="sens-legend">
            {result.curves.map((c, i) => (
              <span key={`${c.scenario ?? ''}`}>
                <span className="sens-sw" style={{ background: colors[i] }} />
                {c.name}
              </span>
            ))}
          </div>
          <div className="sens-chart-host grow">
            <button
              className="chart-save"
              title="Save this chart as PNG"
              onClick={() => onSave('curve', 'parameter_curve')}
            >
              <SaveIcon />
            </button>
            <CurveChart
              regId="curve"
              registry={registry}
              themeKey={themeKey}
              result={result}
              paramUnit={paramUnit}
              colors={colors}
            />
          </div>
          {result.curves.some((c) => c.breaks?.length) ? (
            <div className="sens-foot">
              {result.curves
                .filter((c) => c.breaks?.length)
                .map((c) => (
                  <p key={c.scenario ?? ''}>
                    <span className="sens-ast">!</span>
                    {c.name}: outside the allowed values of another parameter at{' '}
                    {(c.breaks ?? [])
                      .slice(0, 4)
                      .map(
                        (b) =>
                          `${result.param} = ${fmtValue(b.at)} (${b.param} ${fmtValue(b.value)}, allowed: ${b.allowed})`
                      )
                      .join('; ')}
                    {(c.breaks ?? []).length > 4 ? ` and ${(c.breaks ?? []).length - 4} more points` : ''}.
                    Those points describe a model its rules exclude.
                  </p>
                ))}
            </div>
          ) : null}
          {result.replaces_formula ? (
            <div className="sens-foot">
              <p>
                <b>{result.param}</b> has the formula <code>{result.replaces_formula}</code>; the curve sets
                it directly, against that formula.
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <p className="sens-empty">
          No curve yet. Pick a parameter and its range on the left, or click a bar of the tornado, then click
          Calculate.
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
