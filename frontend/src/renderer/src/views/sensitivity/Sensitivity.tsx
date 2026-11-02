import { useEffect, useMemo, useRef, useState } from 'react'
import { AccordionGroup, useSingleOpen } from '../../components/Accordion'
import { api } from '../../lib/api'
import { deliverDataUrl } from '../../lib/download'
import { useThemeKey } from '../../lib/charts/useThemeKey'
import { viewLoaded } from '../../lib/modelView'
import { scenariosRoute } from '../../lib/server/routes'
import { useQuery } from '../../lib/server/useQuery'
import { pngName } from '../results/chartUtils'
import { ResultsRailHead, type ResultsTab } from '../results/ResultsTabs'
import type { MethodInfo } from '../results/types'
import { useIndicatorPicking } from '../results/useIndicatorPicking'
import { CurveCard } from './CurveCard'
import { CurveSettings } from './CurveSettings'
import { curveValues, defaultRange, fmtValue, runKey, runState } from './helpers'
import { TornadoCard } from './TornadoCard'
import { TornadoSettings } from './TornadoSettings'
import type { CurveResult, TornadoResult } from './types'
import { useRunChanged } from './useRunChanged'
import { useSensitivityInputs } from './useSensitivityInputs'
import { useSensitivityJob } from './useSensitivityJob'
import { useSensitivitySetup } from './useSensitivitySetup'

const NO_SCENARIOS: { id: string; name: string }[] = []

/**
 * The Sensitivity analysis tab of Results: a one-at-a-time tornado over the model's parameters and a curve
 * of one parameter across a range, side by side, for one subject of the open model.
 *
 * The rail holds the subject and each chart's settings; each card holds its own Calculate, progress and
 * Cancel, because the two runs are independent and either can take a while. Both runs are backend jobs
 * (engine/sensitivity_jobs.py), and both results are kept with the model's view.
 */
export default function Sensitivity({
  activeDb,
  methods,
  rev,
  onTab
}: {
  activeDb: string | null
  methods: MethodInfo[]
  rev: number
  onTab: (tab: ResultsTab) => void
}): JSX.Element {
  const [grp, setOpen] = useSingleOpen('prism.sens.grp', 'subject')
  const setup = useSensitivitySetup(activeDb)
  const { subject, setSubject, tornado, patchTornado, curve, patchCurve } = setup
  const [acts, setActs] = useState<{ code: string; name: string }[]>([])
  const scenarioQuery = useQuery(activeDb ? scenariosRoute(activeDb) : null)
  const scenarioRows = scenarioQuery.data
  const scenarios = useMemo(
    () => scenarioRows?.map((s) => ({ id: s.id, name: s.name })) ?? NO_SCENARIOS,
    [scenarioRows]
  )
  // A scenario deleted on the Scenarios page drops out of both cards' settings once the list has loaded:
  // the curve's checkboxes only show existing scenarios, so a stale id could never be unticked again.
  useEffect(() => {
    // Only on a list fetched after the last change: a cached one may lack a scenario restored meanwhile.
    if (!scenarioRows || !scenarioQuery.fresh) return
    const ids = new Set(scenarioRows.map((s) => s.id))
    if (tornado.scenario && !ids.has(tornado.scenario)) patchTornado({ scenario: '' })
    const kept = curve.variants.filter((v) => v === '' || ids.has(v))
    if (kept.length !== curve.variants.length) patchCurve({ variants: kept })
  }, [scenarioRows, scenarioQuery.fresh, tornado.scenario, curve.variants, patchTornado, patchCurve])
  const baseInputs = useSensitivityInputs(activeDb, '', rev)
  const variantInputs = useSensitivityInputs(activeDb, tornado.scenario, rev)
  const charts = useRef<Map<string, () => string>>(new Map())
  const themeKey = useThemeKey()
  const picking = useIndicatorPicking(methods, tornado.methods, 'prism.sens.family')

  // The model's processes, and — while nothing is chosen — its reference process as the subject.
  useEffect(() => {
    if (!activeDb) return setActs([])
    let alive = true
    void api<{ code: string; name: string }[]>(
      'GET',
      `/api/v1/model/activities/${encodeURIComponent(activeDb)}`
    )
      .then((rows) => alive && setActs(rows.map((r) => ({ code: r.code, name: r.name }))))
      .catch(() => alive && setActs([]))
    return () => {
      alive = false
    }
  }, [activeDb, rev])
  useEffect(() => {
    if (!activeDb || subject || !acts.length) return
    let alive = true
    void Promise.all([
      viewLoaded(activeDb),
      api<{ candidates: { code: string }[] }>(
        'GET',
        `/api/v1/model/reference/${encodeURIComponent(activeDb)}`
      )
    ])
      .then(([loaded, r]) => {
        // A view the backend never answered for is unknown, not empty: a default now would replace it.
        const code = r.candidates?.[0]?.code
        if (alive && loaded && code)
          setSubject({ code, label: acts.find((a) => a.code === code)?.name ?? code })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [activeDb, subject, acts, setSubject])

  const units = useMemo(
    () => Object.fromEntries((baseInputs?.inputs ?? []).map((i) => [i.name, i.unit])),
    [baseInputs]
  )
  const tornadoBody =
    activeDb && subject
      ? {
          database: activeDb,
          code: subject.code,
          methods: tornado.methods.map((p) => p.method),
          delta: tornado.delta,
          // A chosen parameter the model no longer has would stop the run; it simply drops out.
          params:
            tornado.mode === 'pick'
              ? variantInputs
                ? tornado.params.filter((p) => variantInputs.inputs.some((i) => i.name === p))
                : tornado.params
              : null,
          scenario: tornado.scenario || null
        }
      : null
  const tornadoKey = runKey(tornadoBody)
  const tornadoHint = !subject
    ? 'Pick a subject first.'
    : !tornado.methods.length
      ? 'Pick an indicator first.'
      : tornado.mode === 'pick' && !tornado.params.length
        ? 'Choose at least one parameter.'
        : ''
  const curveInput = baseInputs?.inputs.find((i) => i.name === curve.param)
  const { values: curvePoints, error: curveError } = curveValues(
    curveInput,
    curve.from,
    curve.to,
    curve.points
  )
  const curveBody =
    activeDb && subject && curvePoints && curve.method
      ? {
          database: activeDb,
          code: subject.code,
          method: curve.method,
          param: curve.param,
          values: curvePoints,
          scenarios: curve.variants.map((v) => v || null)
        }
      : null
  const curveKey = runKey(curveBody)
  const curveHint = !subject
    ? 'Pick a subject first.'
    : !curve.param
      ? 'Pick a parameter, or click a tornado bar.'
      : curveError
        ? curveError
        : !curve.method
          ? 'Pick an indicator first.'
          : !curve.variants.length
            ? 'Tick at least one variant.'
            : ''

  const nameOf = (code: string): string => acts.find((a) => a.code === code)?.name ?? ''
  const tornadoJob = useSensitivityJob<TornadoResult>(activeDb, 'tornado', (result, snap, key) =>
    setup.setLastTornado({
      result,
      startedAt: snap.started_at,
      seconds: snap.seconds,
      key,
      subject: snap.activity.code,
      subjectLabel: nameOf(snap.activity.code)
    })
  )
  const curveJob = useSensitivityJob<CurveResult>(activeDb, 'curve', (result, snap, key) =>
    setup.setLastCurve({
      result,
      startedAt: snap.started_at,
      seconds: snap.seconds,
      key,
      subject: snap.activity.code,
      subjectLabel: nameOf(snap.activity.code)
    })
  )
  // A stored run names the process it was computed for — never the one selected now, which may be another.
  const labelOf = (run: { subject?: string; subjectLabel?: string } | null): string =>
    run?.subject ? nameOf(run.subject) || run.subjectLabel || run.subject : ''
  const tornadoSubject = labelOf(setup.lastTornado)
  const curveSubject = labelOf(setup.lastCurve)
  const saveChart = (id: string, name: string): void => {
    const fn = charts.current.get(id)
    if (fn) deliverDataUrl(fn(), pngName(`${name}_${id === 'curve' ? curveSubject : tornadoSubject}`))
  }
  const tornadoFresh = useRunChanged(
    activeDb,
    setup.lastTornado?.startedAt ?? null,
    setup.lastTornado?.result.methods ?? [],
    rev
  )
  const curveFresh = useRunChanged(
    activeDb,
    setup.lastCurve?.startedAt ?? null,
    setup.lastCurve ? [setup.lastCurve.result.method] : [],
    rev
  )
  // A click on a tornado bar plots that parameter, on a range around its value that its rule allows
  // (`defaultRange`), and opens the curve's group so the choice can be checked before calculating.
  const pick = (param: string): void => {
    const input = baseInputs?.inputs.find((i) => i.name === param)
    if (!input) return
    patchCurve({ param, ...defaultRange(input), method: curve.method ?? tornado.methods[0]?.method ?? null })
    setOpen('curve')
  }

  if (!activeDb) {
    return (
      <div className="view results-view">
        <p className="sens-empty">Open a model to analyse its sensitivity.</p>
      </div>
    )
  }
  const variantName = tornado.scenario
    ? (scenarios.find((s) => s.id === tornado.scenario)?.name ?? '?')
    : 'Baseline'
  return (
    <div className="view results-view sens-view">
      <div className="results-grid">
        <aside className="results-rail">
          <ResultsRailHead tab="sensitivity" onTab={onTab} />
          <AccordionGroup title="Subject" summary={subject?.label ?? 'nothing yet'} {...grp('subject')}>
            <div className="subj-subhead">This model</div>
            <div className="subjpick sens-subjects">
              {acts.map((a) => (
                <label key={a.code} className="subjrow">
                  <input
                    type="radio"
                    name="sens-subject"
                    checked={subject?.code === a.code}
                    onChange={() => setSubject({ code: a.code, label: a.name })}
                  />
                  <span title={a.name}>{a.name}</span>
                </label>
              ))}
            </div>
            <p className="rail-hint">Only processes of the open model: the parameters belong to it.</p>
          </AccordionGroup>
          <AccordionGroup
            title="Tornado"
            summary={`${tornado.mode === 'all' ? 'Top 10' : `${tornado.params.length} chosen`} · ±${fmtValue(
              tornado.delta * 100
            )} % · ${variantName} · ${tornado.methods.length} indicator${tornado.methods.length === 1 ? '' : 's'}`}
            {...grp('tornado')}
          >
            <TornadoSettings
              setup={tornado}
              patch={patchTornado}
              inputs={variantInputs?.inputs ?? null}
              derived={(variantInputs?.derived ?? []).map((d) => d.name)}
              scenarios={scenarios}
              picker={{
                ...picking,
                picked: tornado.methods,
                setPicked: (next) =>
                  patchTornado({ methods: typeof next === 'function' ? next(tornado.methods) : next })
              }}
            />
          </AccordionGroup>
          <AccordionGroup
            title="Parameter curve"
            summary={
              curve.param
                ? `${curve.param} · ${curvePoints ? `${curvePoints.length} points` : 'incomplete'} · ${curve.variants.length} variant${curve.variants.length === 1 ? '' : 's'}`
                : 'no parameter yet'
            }
            {...grp('curve')}
          >
            <CurveSettings
              setup={curve}
              patch={patchCurve}
              inputs={baseInputs?.inputs ?? null}
              scenarios={scenarios}
              families={picking.families}
              familyNames={picking.familyNames}
              error={curveError}
            />
          </AccordionGroup>
        </aside>
        <div className="results-main">
          <div className="sens-grid">
            <TornadoCard
              stored={setup.lastTornado}
              state={runState(setup.lastTornado, tornadoKey, tornadoFresh.changed, tornadoFresh.failed)}
              job={tornadoJob.job}
              error={tornadoJob.error}
              canRun={!tornadoHint && !!tornadoBody}
              hint={tornadoHint}
              onRun={() => tornadoBody && void tornadoJob.start(tornadoBody, tornadoKey)}
              onCancel={tornadoJob.cancel}
              onPick={pick}
              units={units}
              labels={picking.labels}
              subjectLabel={setup.lastTornado ? tornadoSubject : (subject?.label ?? '')}
              registry={charts}
              themeKey={themeKey}
              onSave={saveChart}
            />
            <CurveCard
              stored={setup.lastCurve}
              state={runState(setup.lastCurve, curveKey, curveFresh.changed, curveFresh.failed)}
              job={curveJob.job}
              error={curveJob.error}
              canRun={!curveHint && !!curveBody}
              hint={curveHint}
              onRun={() => curveBody && void curveJob.start(curveBody, curveKey)}
              onCancel={curveJob.cancel}
              paramUnit={units[setup.lastCurve?.result.param ?? curve.param] ?? ''}
              subjectLabel={curveSubject}
              labels={picking.labels}
              registry={charts}
              themeKey={themeKey}
              onSave={saveChart}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
