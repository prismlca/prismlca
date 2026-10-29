import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type DatabaseInfo } from '../lib/api'
import { useQuery } from '../lib/server/useQuery'
import { type TagGroup } from '../lib/server/routes'

// Stable fallback: `?? []` would be a fresh array each render and rattle every dependent memo.
const NO_GROUPS: TagGroup[] = []
// The same for unset view fields that feed the chart memos (colours, the subject lists): each handed
// out a fresh `{}`/`[]` on every render, so the colour memos recomputed every time and every chart was
// torn down and rebuilt — on each keystroke in the indicator filter.
const NO_COLORS: Record<string, string> = {}
import { usePersisted } from '../lib/persist'
import { useViewField } from '../lib/modelView'
import { subjectKey } from '../lib/subjectKey'
import { groupMethodsByFamily, indicatorLabel, indicatorLabels } from '../lib/methods'
import { AUTO_DECIMALS, autoDecimals, labelNum } from '../lib/numberFormat'
import { CalculatorIcon, ChartIcon, ExcelIcon, MaximizeIcon, SaveIcon } from '../components/icons'
import SearchDialog from './SearchDialog'
import ActivityPickDialog from '../components/ActivityPickDialog'
import { AccordionGroup, useSingleOpen } from '../components/Accordion'
import { useSortState } from '../lib/useSortState'
import { deliverBase64, deliverDataUrl, XLSX_MIME } from '../lib/download'
import { errMsg } from '../lib/errors'
import EscapeCloser from '../components/EscapeCloser'
import ModelPickDialog from './results/ModelPickDialog'
import { Heatmap, HeatScale } from './results/Heatmap'
import type { Matrix, MethodInfo, Picked, StackedRow } from './results/types'
import { useCompareRun } from './results/useCompareRun'
import { IndicatorPicker } from './results/IndicatorPicker'
import { SubjectsPanel } from './results/SubjectsPanel'
import { useSubjectSelection } from './results/useSubjectSelection'
import { useResultsOpening } from './results/useResultsOpening'
import { buildColorMap } from './results/subjectColors'
import { familiesInUse, resolveSplit } from './results/splitBy'
import { fmtPct, pngName, ZOOM_SCALE } from './results/chartUtils'
import { copyNumber } from '../lib/copyNumber'
import {
  IndicatorChart,
  NormalizedChart,
  RadarChart,
  StackedIndicatorChart,
  StackLegend
} from './results/charts'

/**
 * Results page: compare any number of foreground subjects across any number of LCIA indicators at
 * once. Indicators are picked family → detail; the matrix + charts recompute automatically whenever
 * the subject or indicator selection changes.
 */

export default function Results({
  activeDb,
  methods,
  databases,
  rev,
  onTab,
  searchDbs,
  onSearchDbs
}: {
  activeDb: string | null
  methods: MethodInfo[]
  databases: DatabaseInfo[]
  /** The workbench's model revision: bumped by every model, parameter and scenario write, so results
   *  computed before an edit are marked stale instead of standing as current. */
  rev?: number
  /** The ticked databases of the model view's search panel, when the caller shares them: one set of
   *  checkboxes for the whole app — a box ticked here is ticked there. */
  searchDbs?: string[]
  onSearchDbs?: (dbs: string[]) => void
  /** Switch to the other kind of result. The tabs live in this page's rail; the state stays with the
   *  Workbench, because it also decides which of the two views is mounted. */
  onTab?: (tab: 'overview' | 'detail') => void
}): JSX.Element {
  const [err, setErr] = useState<string | null>(null)
  const {
    acts,
    subjSel,
    setSubjSel,
    bgSubjects,
    setBgSubjects,
    fgSubjects,
    setFgSubjects,
    scenarios,
    setScenarios,
    scenSel,
    setScenSel,
    baselineOn,
    setBaselineOn,
    libNames,
    shownFg,
    linkedModels,
    includeLinked,
    subjects,
    keyOf,
    subjKey
  } = useSubjectSelection({ activeDb, databases, setErr })
  const [showSearch, setShowSearch] = useState(false)
  const [showModelPick, setShowModelPick] = useState(false)
  const [showActPick, setShowActPick] = useState(false)
  // Indicators are per model too, but seeded from the set last used anywhere: picking them again for
  // every new model would be pointless friction, while inheriting another study's set is a defect.
  const [picked, setPicked] = useViewField<Picked[]>(activeDb, 'results', 'picked', [])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [family, setFamily] = usePersisted('prism.ov.family', '')
  const [indQuery, setIndQuery] = useState('')
  const [view, setView] = usePersisted<'charts' | 'normalized'>('prism.ov.view', 'charts')
  // Chart display settings (persisted).
  const [subjectColors, setSubjectColors] = useViewField<Record<string, string>>(
    activeDb,
    'results',
    'colors',
    NO_COLORS
  )
  const [showValues, setShowValues] = usePersisted('prism.ov.showValues', false)
  // Auto by default: a fixed six decimals printed digits the data cannot support.
  const [valueDecimals, setValueDecimals] = usePersisted('prism.ov.decimals', AUTO_DECIMALS)
  const [diffMode, setDiffMode] = usePersisted('prism.ov.diffMode', false)
  const [refCode, setRefCode] = useViewField(activeDb, 'results', 'refCode', '')
  // Stacked bars: split each subject's bar by a classification. The same switch splits the Excel
  // export — see `exportXlsx`. On/off is app-wide; what to split by is the model's (results/splitBy.ts):
  // '' until chosen, and then the model's first tag family, else ISIC.
  const [stacked, setStacked] = usePersisted('prism.ov.stacked', false)
  const [chosenSplit, setStackBy] = useViewField(activeDb, 'results', 'stackBy', '')
  // Shared cache: Workbench's tag-group edits invalidate this key, so the picker here is never a
  // stale copy from mount time (it used to be — one fetch per view, no cross-view refresh).
  const tagQuery = useQuery('/api/v1/model/tag-groups')
  const tagGroups = tagQuery.data?.groups ?? NO_GROUPS
  const stackBy = resolveSplit(chosenSplit, tagGroups, activeDb) // 'isic'|'cpc'|'tag:<group>'
  // One group of the rail open at a time. Subjects first: nothing else means anything until this page
  // knows what it is comparing.
  const [grp] = useSingleOpen('prism.res.grp', 'subjects')
  // themeKey re-inits charts when light/dark flips (so axis colours follow the theme)
  const themeKey = document.documentElement.getAttribute('data-theme') ?? 'light'
  // Each chart registers a getDataURL() here so we can save one or all of them as PNGs.
  const charts = useRef<Map<string, () => string>>(new Map())
  const saveChart = (id: string, name: string): void => {
    const fn = charts.current.get(id)
    if (fn) deliverDataUrl(fn(), pngName(name))
  }
  // Enlarge overlay: renders the LIVE chart component big (tooltips/hover keep working) —
  // id is 'radar' | 'normalized' | 'heatmap' or an indicator key. Overlay charts register
  // into their own registry so they don't clobber the small charts' PNG renderers.
  const [zoomed, setZoomed] = useState<{ id: string; title: string } | null>(null)
  const zoomCharts = useRef<Map<string, () => string>>(new Map())
  const zoomChart = (id: string, title: string): void => setZoomed({ id, title })

  // Everything that keeps the stored Results setup in step with the model on opening: pre-selection, key migration,
  // inherited indicators, scenario pruning — one hook, called where these effects always stood.
  const { scenarioRows, scenarioOverridesKey } = useResultsOpening({
    activeDb,
    databases,
    setSubjSel,
    picked,
    setPicked,
    setScenarios,
    setScenSel,
    setBaselineOn
  })

  // Group methods into families for the family → detail picker.
  const families = useMemo(() => groupMethodsByFamily(methods), [methods])
  const familyNames = useMemo(() => [...families.keys()].sort((a, b) => a.localeCompare(b)), [families])
  // What an indicator is called everywhere on this page — rows, chips, headers, chart titles.
  // `method[1]` where that names one indicator, the path below the family where it does not
  // (ReCiPe endpoint names its damage category second — V203).
  const labels = useMemo(() => indicatorLabels(methods), [methods])
  useEffect(() => {
    if (!family && familyNames.length) setFamily(familyNames[0])
  }, [familyNames, family, setFamily])

  const pickedKeys = useMemo(() => new Set(picked.map((p) => p.key)), [picked])
  // Group the picked indicators by method family (contiguous), for grouped headers + charts.
  const groups = useMemo(() => {
    const order: string[] = []
    const map = new Map<string, Picked[]>()
    for (const p of picked) {
      if (!map.has(p.family)) {
        map.set(p.family, [])
        order.push(p.family)
      }
      // The stored label is whatever was written when the indicator was picked; the name is decided
      // here, against the current catalogue, so an old selection heals with the rule.
      map.get(p.family)!.push({ ...p, label: indicatorLabel(p.method, labels) || p.label })
    }
    return order.map((f) => ({ family: f, items: map.get(f)! }))
  }, [picked, labels])
  const orderedPicked = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const methKey = picked.map((p) => p.key).join('|')
  /**
   * Tag families worth splitting by: those some activity of a selected subject's database actually
   * carries. A family is project config from the moment it is created, so the picker used to
   * offer every one of them whatever was selected — and splitting by an untagged family draws a single
   * bar called "untagged", which reads as a broken chart rather than as an empty answer.
   *
   * "Of a selected subject's database" covers all four kinds at once: the model, its scenarios (an
   * overlay on the same database), another model, and an ecoinvent process — the last simply contributes
   * no family of its own, which is right, because nobody tags the background.
   *
   * The family currently chosen stays listed even when it drops out of the selection: a select whose
   * value is not among its options shows blank, and that looks like the setting was lost.
   */
  const splitFamilies = useMemo(() => {
    const inUse = familiesInUse(tagGroups, new Set(subjects.map((s) => s.database)))
    const chosen = stackBy.startsWith('tag:') ? stackBy.slice(4) : ''
    return tagGroups.filter((g) => g.name === chosen || inUse.includes(g))
  }, [tagGroups, subjects, stackBy])
  // All split dimensions the UI can show (computed in ONE backend pass, so switching 'split by'
  // is instant — no recompute). ISIC/CPC + one per tag family that is actually in use.
  const stackDims = useMemo(
    () => ['isic', 'cpc', ...splitFamilies.map((g) => `tag:${g.name}`)],
    [splitFamilies]
  )
  const dimsKey = stackDims.join('|')

  // Scenario rows have answered (even if empty) and every ticked scenario is a subject: before that,
  // "subjects ready" means the baseline alone and the token would be spent on half the request.
  const scenariosReady =
    scenarioRows !== undefined &&
    Object.keys(scenSel)
      .filter((id) => scenSel[id])
      .every((id) => subjects.some((s) => s.scenario === id))
  // And the tag families have answered: an unchosen split defaults to one of them, and a run started
  // before would compute the split without the family the chart then switches to.
  const inputsReady = scenariosReady && (tagQuery.data !== undefined || tagQuery.error != null)
  const { matrix, stackData, busy, stackBusy, stale, progress, lastSecs, calculate, cancelCalc } =
    useCompareRun({
      activeDb,
      subjects,
      picked,
      stacked,
      stackDims,
      subjKey,
      methKey,
      dimsKey,
      rev,
      scenarioOverridesKey,
      inputsReady,
      setErr
    })

  // Keep the difference-reference valid (default to the first subject).
  useEffect(() => {
    if (!diffMode || !matrix) return
    if (!refCode || !matrix.subjects.some((s) => keyOf(s) === refCode)) {
      setRefCode(matrix.subjects[0] ? keyOf(matrix.subjects[0]) : '')
    }
  }, [diffMode, matrix, refCode, setRefCode, keyOf])

  const refSubject = matrix?.subjects.find((s) => keyOf(s) === refCode)
  const useDiff = diffMode && !!refSubject
  // One colour resolver for the rail, the bars and the radar, rebuilt exactly when what it reads changes; the
  // slot order (own processes, database activities, other models, scenarios, rows gone from the rail) and the
  // keying against the active model live in results/subjectColors.ts.
  const colorMap = useMemo(
    () => buildColorMap({ activeDb, acts, bgSubjects, shownFg, scenarios, matrix, subjectColors, keyOf }),
    [activeDb, acts, bgSubjects, shownFg, scenarios, matrix, subjectColors, keyOf]
  )
  const scenarioColor = colorMap.scenario
  const subjectColor = colorMap.subject
  // Bars always show the ABSOLUTE score; the reference difference is only an extra % annotation.
  // All per-chart arrays are memoised as one map so their identities only change when the
  // underlying data/settings change — otherwise every unrelated re-render (typing in the
  // indicator filter, toggling the picker) would tear down and re-init every ECharts instance.
  const chartData = useMemo(() => {
    const subjects = matrix?.subjects ?? []
    const map = new Map<string, { values: number[]; labels: string[] }>()
    for (const p of orderedPicked) {
      const values = subjects.map((s) => s.scores[p.key] ?? 0)
      // Per indicator, not per bar: one precision for the whole series.
      const decimals = valueDecimals === AUTO_DECIMALS ? autoDecimals(values) : valueDecimals
      const labels = subjects.map((s) => {
        const v = s.scores[p.key] ?? 0
        const parts: string[] = []
        if (showValues) parts.push(labelNum(v, decimals))
        if (useDiff) {
          if (keyOf(s) === refCode) parts.push('ref')
          else {
            const rv = refSubject!.scores[p.key] ?? 0
            parts.push(rv ? fmtPct(((v - rv) / rv) * 100) : '—')
          }
        }
        return parts.join('\n')
      })
      map.set(p.key, { values, labels })
    }
    return map
  }, [matrix, orderedPicked, showValues, valueDecimals, useDiff, refCode, refSubject, keyOf])
  const chartColorsArr = useMemo(
    () => (matrix?.subjects ?? []).map((s) => colorMap.subject(s)),
    [matrix, colorMap]
  )
  const chartValues = (p: Picked): number[] => chartData.get(p.key)?.values ?? []
  const chartColors = (): string[] => chartColorsArr
  const chartLabels = (p: Picked): string[] => chartData.get(p.key)?.labels ?? []
  const showLabel = showValues || useDiff

  // Keys for the currently selected split dimension (client-side; no refetch on split-by change).
  const stackKeys = stackData?.keys[stackBy] ?? []
  const stackLabels = stackData?.labels?.[stackBy] ?? {}
  const stackLabel = (k: string): string => stackLabels[k] ?? k
  // Stacked segments for one indicator (selected dimension): per key, the per-subject impact.
  // Memoised per indicator so unrelated re-renders keep the array identities (see chartData).
  const stackChartData = useMemo(() => {
    const map = new Map<string, { subs: string[]; valuesByKey: Record<string, number[]> }>()
    if (!stackData) return map
    const subs = stackData.subjects.map((s) => s.label ?? keyOf(s))
    const keys = stackData.keys[stackBy] ?? []
    for (const p of orderedPicked) {
      const valuesByKey: Record<string, number[]> = {}
      for (const k of keys) {
        valuesByKey[k] = stackData.subjects.map(
          (s) => (s.methods[p.key]?.dims[stackBy] ?? []).find((g) => g.key === k)?.impact ?? 0
        )
      }
      map.set(p.key, { subs, valuesByKey })
    }
    return map
  }, [stackData, stackBy, orderedPicked, keyOf])
  // How much each split key matters across everything on the page: the summed |share| over every
  // subject and every indicator. A folded legend shows the heaviest keys — the ones a reader looks for.
  const stackWeights = useMemo(() => {
    const w = new Map<string, number>()
    if (!stackData) return w
    for (const s of stackData.subjects)
      for (const m of Object.values(s.methods))
        for (const g of m.dims[stackBy] ?? []) w.set(g.key, (w.get(g.key) ?? 0) + Math.abs(g.share))
    return w
  }, [stackData, stackBy])
  const [legendOpen, setLegendOpen] = useState(false)
  const stackFor = (pKey: string): { subs: string[]; valuesByKey: Record<string, number[]> } =>
    stackChartData.get(pKey) ?? { subs: [], valuesByKey: {} }
  // Per-bar annotation for stacked mode: the subject's total value (values-on-bar) and/or its
  // % difference vs the reference subject's total — mirrors the non-stacked bar labels.
  const stackTopLabelMap = useMemo(() => {
    const map = new Map<string, string[]>()
    if (!stackData) return map
    for (const p of orderedPicked) {
      const totalOf = (s: StackedRow): number => s.methods[p.key]?.total ?? 0
      const stackDecimals =
        valueDecimals === AUTO_DECIMALS ? autoDecimals(stackData.subjects.map(totalOf)) : valueDecimals
      const refTotal = useDiff
        ? (stackData.subjects.filter((s) => keyOf(s) === refCode).map(totalOf)[0] ?? null)
        : null
      map.set(
        p.key,
        stackData.subjects.map((s) => {
          const parts: string[] = []
          if (showValues) parts.push(labelNum(totalOf(s), stackDecimals))
          if (useDiff) {
            if (keyOf(s) === refCode) parts.push('ref')
            else parts.push(refTotal ? fmtPct(((totalOf(s) - refTotal) / refTotal) * 100) : '—')
          }
          return parts.join('  ')
        })
      )
    }
    return map
  }, [stackData, orderedPicked, showValues, valueDecimals, useDiff, refCode, keyOf])
  const stackTopLabels = (pKey: string): string[] => stackTopLabelMap.get(pKey) ?? []

  /** What the "Split by" choice is called in a document — the sheet's group column is headed with it. */
  const splitLabel = (): string =>
    stackBy === 'isic'
      ? 'ISIC classification'
      : stackBy === 'cpc'
        ? 'CPC classification'
        : stackBy.startsWith('tag:')
          ? stackBy.slice(4)
          : stackBy

  const exportXlsx = (): void => {
    if (!matrix) return
    const columns = orderedPicked.map((p) => ({ key: p.key, family: p.family, label: p.label, unit: p.unit }))
    // Disaggregated when the stacked switch is on and the split has actually been computed: one row
    // per part of each subject, then the row that adds them up. The parts come from the stacked
    // calculation the chart already made, so the export costs nothing extra and can never disagree
    // with the bars beside it.
    const split = stacked && stackData ? stackKeys : null
    const rows =
      split && split.length
        ? stackData!.subjects.flatMap((s) => {
            const label = s.label ?? keyOf(s)
            const part = (k: string): Record<string, number | null> =>
              Object.fromEntries(
                orderedPicked.map((p) => [
                  p.key,
                  (s.methods[p.key]?.dims[stackBy] ?? []).find((g) => g.key === k)?.impact ?? 0
                ])
              )
            // A part that is zero across every indicator for THIS subject is not its part at all —
            // the key list is the union over all subjects, and printing forty empty rows per subject
            // is how a disaggregated sheet stops being readable.
            const used = split.filter((k) => Object.values(part(k)).some((v) => v !== 0))
            return [
              ...used.map((k) => ({ label, group: stackLabel(k), scores: part(k) })),
              {
                label,
                group: 'Total',
                total: true,
                scores: Object.fromEntries(orderedPicked.map((p) => [p.key, s.methods[p.key]?.total ?? null]))
              }
            ]
          })
        : matrix.subjects.map((s) => ({
            label: s.label,
            scores: Object.fromEntries(orderedPicked.map((p) => [p.key, s.scores[p.key] ?? null]))
          }))
    void (async () => {
      try {
        const r = await api<{ filename: string; base64: string }>('POST', '/api/v1/export/compare-matrix', {
          columns,
          subjects: rows,
          group_header: split && split.length ? splitLabel() : null,
          filename: 'prism-results'
        })
        deliverBase64(r.base64, r.filename, XLSX_MIME)
      } catch (e) {
        setErr(errMsg(e))
      }
    })()
  }

  // Save every currently-shown chart as its own PNG into ONE folder the user picks once. Handing
  // each PNG to the browser's downloads opened one save dialog per chart — twelve at a time for a
  // full indicator set — so the bytes go to the main process, which asks for a
  // folder and writes them all.
  const [savedNote, setSavedNote] = useState<string | null>(null)
  // The note describes the charts that WERE saved; a new calculation makes it stale.
  useEffect(() => setSavedNote(null), [matrix])
  const saveAllCharts = async (): Promise<void> => {
    const entries: [string, string][] =
      view === 'normalized' && picked.length > 1
        ? [['normalized', 'normalized comparison']]
        : orderedPicked.map((p) => [p.key, `${p.family} ${p.label}`])
    if (picked.length >= 3) entries.push(['radar', 'radar_chart'])
    entries.push(['heatmap', 'heatmap'])
    const files = entries.flatMap(([id, name]) => {
      const fn = charts.current.get(id)
      return fn ? [{ name: pngName(name), dataUrl: fn() }] : []
    })
    if (!files.length) return
    setSavedNote(null)
    try {
      const r = await window.prism.saveFilesTo(files)
      if (!r) return
      if (r.errors.length) setErr(`Some charts were not saved: ${r.errors.join('; ')}`)
      setSavedNote(
        r.written.length
          ? `Saved ${r.written.length} chart${r.written.length === 1 ? '' : 's'} to ${r.dir}`
          : null
      )
    } catch (e) {
      setErr(errMsg(e))
    }
  }

  const subjLabels = useMemo(() => (matrix ? matrix.subjects.map((s) => s.label) : []), [matrix])
  // Table sorting: click a column header to sort asc → desc → back to calculation order.
  // '' sorts by subject label; anything else is a method key.
  const { sort, sortClick, sortMark } = useSortState<string>()
  const tableRows = useMemo(() => {
    const rows = matrix ? [...matrix.subjects] : []
    if (sort) {
      rows.sort((a, b) => {
        const cmp =
          sort.key === ''
            ? a.label.localeCompare(b.label)
            : (a.scores[sort.key] ?? Number.NEGATIVE_INFINITY) -
              (b.scores[sort.key] ?? Number.NEGATIVE_INFINITY)
        return cmp * sort.dir
      })
    }
    return rows
  }, [matrix, sort])
  // Radar props must be identity-stable: the chart effect tears down and re-inits ECharts when
  // they change, so inline-built arrays made the radar visibly redraw on every unrelated
  // re-render of this component.
  const radarSubjects = useMemo(
    () =>
      matrix
        ? matrix.subjects.map((s) => ({
            label: s.label,
            id: subjectKey(s, null),
            color: colorMap.subject(s)
          }))
        : [],
    [matrix, colorMap]
  )
  const radarColumns = useMemo(
    () => orderedPicked.map((p) => ({ key: p.key, label: p.label })),
    [orderedPicked]
  )

  /**
   * Decimals for the matrix table, resolved PER COLUMN when the setting is auto.
   *
   * The table used to hand `valueDecimals` straight to `labelNum`, sentinel and all: on auto that
   * is −1, which clamped to zero decimals and printed every value below 1 in one-digit scientific
   * notation — "1e-1" where the column meant 0.105. Even resolved once for the whole table it would
   * be wrong, because a row spans indicators with different units and magnitudes, and the largest of
   * them (kg 1,4-DCB in the hundreds) would decide the precision of the smallest (kg CFC-11-Eq at
   * 1e-9). A column has one unit, so a column is what the precision belongs to — the same rule the
   * report's own tables follow (`report_i18n.fmt_column`).
   */
  const columnDecimals = useMemo(() => {
    if (valueDecimals !== AUTO_DECIMALS) return null
    const out: Record<string, number> = {}
    for (const p of orderedPicked) {
      const col = tableRows
        .map((r) => r.scores[p.key])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      out[p.key] = autoDecimals(col)
    }
    return out
  }, [valueDecimals, orderedPicked, tableRows])

  // The chart kinds as the grid and the zoom overlay draw them: only the registry, the type scale and (for the
  // per-indicator charts) the registry id differ. Plain functions, not components — the same element types at
  // the same places as before, read from this render's closure.
  const summaryChart = (id: 'radar' | 'normalized' | 'heatmap', m: Matrix, zoom: boolean): JSX.Element => {
    const registry = zoom ? zoomCharts : charts
    const scale = zoom ? ZOOM_SCALE : undefined
    if (id === 'radar')
      return (
        <RadarChart
          subjects={radarSubjects}
          columns={radarColumns}
          matrix={m}
          themeKey={themeKey}
          registry={registry}
          scale={scale}
        />
      )
    if (id === 'normalized')
      return (
        <NormalizedChart
          subjects={subjLabels}
          groups={groups}
          matrix={m}
          showValues={showValues}
          themeKey={themeKey}
          registry={registry}
          scale={scale}
        />
      )
    return <Heatmap groups={groups} columns={orderedPicked} matrix={m} registry={registry} />
  }
  const indicatorChart = (p: Picked, zoom: boolean): JSX.Element | null => {
    const registry = zoom ? zoomCharts : charts
    const scale = zoom ? ZOOM_SCALE : undefined
    const regId = zoom ? `zoom-${p.key}` : p.key
    if (stacked && stackData && !stackBusy) {
      const { subs, valuesByKey } = stackFor(p.key)
      return (
        <StackedIndicatorChart
          subjects={subs}
          keys={stackKeys}
          keyLabels={stackLabels}
          valuesByKey={valuesByKey}
          topLabels={stackTopLabels(p.key)}
          unit={p.unit}
          themeKey={themeKey}
          regId={regId}
          registry={registry}
          scale={scale}
        />
      )
    }
    // Stacked but not (yet) split: the grid draws nothing here (its outer branch shows a hint instead, so this
    // is not reached there); the zoom overlay falls back to the plain bars. Kept as it was.
    if (stacked && !zoom) return null
    return (
      <IndicatorChart
        subjects={subjLabels}
        values={chartValues(p)}
        colors={chartColors()}
        labels={chartLabels(p)}
        showLabel={showLabel}
        unit={p.unit}
        themeKey={themeKey}
        regId={regId}
        registry={registry}
        scale={scale}
      />
    )
  }

  /** The rail's head: the page and its two kinds of result, the way the Report rail carries its own. */
  const railHead = (
    <>
      <div className="panel-h eyebrow">Results</div>
      <div className="rtabs rail-tabs" role="tablist">
        <button role="tab" aria-selected={true} className="rtab on" onClick={() => onTab?.('overview')}>
          Overview results
        </button>
        <button role="tab" aria-selected={false} className="rtab" onClick={() => onTab?.('detail')}>
          Detailed results
        </button>
      </div>
    </>
  )

  return (
    <div className="view results-view">
      <div className="results-grid">
        <aside className="results-rail">
          {railHead}

          <AccordionGroup title="Subjects" summary={`${subjects.length} selected`} {...grp('subjects')}>
            <SubjectsPanel
              selection={{
                acts,
                subjSel,
                setSubjSel,
                scenarios,
                scenSel,
                setScenSel,
                baselineOn,
                setBaselineOn,
                shownFg,
                setFgSubjects,
                linkedModels,
                includeLinked,
                bgSubjects,
                setBgSubjects
              }}
              colors={{ subjectColor, scenarioColor, setSubjectColors, keyOf }}
              open={{
                addProcess: () => setShowActPick(true),
                addOtherModel: () => setShowModelPick(true),
                addDatabase: () => setShowSearch(true)
              }}
              libNames={libNames}
              activeDb={activeDb}
            />
          </AccordionGroup>

          <AccordionGroup
            title="Chart display"
            summary={`${stacked ? 'stacked' : 'plain'} bars${diffMode ? ' · differences' : ''}`}
            {...grp('chart')}
          >
            <div className="chart-settings">
              <label className="cs-item">
                <input
                  type="checkbox"
                  checked={showValues}
                  onChange={(e) => setShowValues(e.target.checked)}
                />
                <span>Show values on bars</span>
              </label>
              <label className="cs-item">
                <span>Decimals</span>
                <select
                  className="cs-decimals"
                  value={valueDecimals}
                  title="Auto follows the largest value in each series, and switches to scientific notation below 0.0001"
                  onChange={(e) => setValueDecimals(Number(e.target.value))}
                >
                  <option value={AUTO_DECIMALS}>Auto</option>
                  {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cs-item">
                <input type="checkbox" checked={diffMode} onChange={(e) => setDiffMode(e.target.checked)} />
                <span>Difference to reference (%)</span>
              </label>
              {diffMode ? (
                <label className="cs-item">
                  <span>Reference</span>
                  <select value={refCode} onChange={(e) => setRefCode(e.target.value)}>
                    {(matrix?.subjects ?? subjects).map((s) => (
                      <option key={keyOf(s)} value={keyOf(s)}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="cs-item">
                <input type="checkbox" checked={stacked} onChange={(e) => setStacked(e.target.checked)} />
                {/* No "slower" warning any more: it still runs a contribution tree per subject ×
                      indicator, but one factorisation now feeds them all and the wait is no longer worth
                      a caution. The busy ellipsis is enough. */}
                {/* The switch does two things now, so it says both: the bars come apart on screen,
                    and the Excel export comes apart with them — a row per part plus a total. */}
                <span>Stacked bars / disaggregated exports {stackBusy ? '…' : ''}</span>
              </label>
              {stacked ? (
                <label className="cs-item">
                  <span>Split by</span>
                  <select value={stackBy} onChange={(e) => setStackBy(e.target.value)}>
                    <option value="isic">ISIC classification</option>
                    <option value="cpc">CPC classification</option>
                    {splitFamilies.map((g) => (
                      <option key={g.name} value={`tag:${g.name}`}>
                        Tag: {g.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          </AccordionGroup>

          <AccordionGroup title="Indicators" summary={`${picked.length} selected`} {...grp('indicators')}>
            <IndicatorPicker
              picked={picked}
              setPicked={setPicked}
              groups={groups}
              pickedKeys={pickedKeys}
              families={families}
              familyNames={familyNames}
              labels={labels}
              family={family}
              setFamily={setFamily}
              indQuery={indQuery}
              setIndQuery={setIndQuery}
              pickerOpen={pickerOpen}
              setPickerOpen={setPickerOpen}
            />
          </AccordionGroup>

          {/* Pinned to the foot of the rail: the verb of this page, and the only place that stays put
              while the groups above it open and close. Progress and Cancel take the same row, because
              a run that cannot be stopped from where it was started is a run you go looking for. */}
          {/* Always there, greyed while the selection is incomplete: a button that only EXISTS once
              everything is picked reads as a missing feature, and the hint beside it says what is
              left to do. */}
          {!subjects.length || !picked.length ? (
            <div className="results-actbar">
              <div className="calcbar">
                <button className="btn primary" disabled>
                  <CalculatorIcon /> Calculate
                </button>
                <span className="calc-stale">
                  {!subjects.length && !picked.length
                    ? 'Pick a subject and an LCIA indicator first.'
                    : !subjects.length
                      ? 'Pick a subject first.'
                      : 'Pick an LCIA indicator first.'}
                </span>
              </div>
            </div>
          ) : (
            <div className="results-actbar">
              <div className="calcbar">
                {busy || stackBusy ? (
                  <>
                    <span className="spinner" />
                    <div className="calc-progress-bar">
                      <span
                        style={{
                          width: `${progress ? Math.round((progress.done / progress.total) * 100) : 0}%`
                        }}
                      />
                    </div>
                    <button className="btn sm" onClick={cancelCalc}>
                      Cancel
                    </button>
                    {/* Its own line under the bar (see `.calc-progress-label`): beside it, a 384px rail left the
                    text about 140px, so "Stacked breakdown — market for electricity…" was cut after three
                    words. Across the rail it fits whole. */}
                    <span className="calc-progress-label">
                      {progress ? `${progress.label} · ${progress.done}/${progress.total}` : 'Calculating…'}
                    </span>
                  </>
                ) : (
                  <>
                    <button className="btn primary" onClick={calculate}>
                      <CalculatorIcon /> Calculate
                    </button>
                    {stale && matrix ? (
                      <span className="calc-stale">Selection changed — shown results are outdated.</span>
                    ) : null}
                    {!matrix ? <span className="calc-stale">Ready — click Calculate.</span> : null}
                    {!stale && matrix && lastSecs != null ? (
                      <span className="calc-stale">Computed in {lastSecs.toFixed(1)} s.</span>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          )}
        </aside>

        <div className="results-main">
          {/* What acts on the RESULTS stays with them: how the charts are drawn, and taking them out
              of the app. Only Calculate belongs to the rail, because only it acts on the selection. */}
          <div className="results-mainhead">
            <span className="calc-stale" title={savedNote ?? undefined}>
              {savedNote}
            </span>
            <span className="srow">
              {picked.length > 1 ? (
                <span className="seg">
                  <button
                    className={`seg-btn${view === 'charts' ? ' on' : ''}`}
                    onClick={() => setView('charts')}
                  >
                    Per indicator
                  </button>
                  <button
                    className={`seg-btn${view === 'normalized' ? ' on' : ''}`}
                    onClick={() => setView('normalized')}
                  >
                    Normalized
                  </button>
                </span>
              ) : null}
              <button className="btn sm" onClick={() => void saveAllCharts()} disabled={!matrix}>
                <ChartIcon /> Save charts
              </button>
              <button className="btn sm" onClick={exportXlsx} disabled={!matrix}>
                <ExcelIcon /> Export Excel
              </button>
            </span>
          </div>
          {err ? (
            <div className="wb-error" onClick={() => setErr(null)}>
              {err}
            </div>
          ) : null}
          {!subjects.length || !picked.length ? (
            <p className="hint">Select one or more subjects and indicators, then click Calculate.</p>
          ) : busy ? null : matrix ? ( // hide stale results while the main recompute runs
            <>
              {stale ? (
                <div className="stale-banner">
                  ⚠ The selection or settings changed after this calculation — the results below do not
                  reflect them. Click <b>Calculate</b> to refresh.
                </div>
              ) : null}
              <div className="results-table-wrap">
                <table className="results-table">
                  <thead>
                    <tr>
                      <th
                        rowSpan={2}
                        className="th-sortable"
                        title="Sort by subject"
                        onClick={() => sortClick('')}
                      >
                        Subject{sortMark('')}
                      </th>
                      {groups.map((g) => (
                        <th key={g.family} className="th-family" colSpan={g.items.length} title={g.family}>
                          {g.family}
                        </th>
                      ))}
                    </tr>
                    <tr>
                      {orderedPicked.map((p, i) => (
                        <th
                          key={p.key}
                          title={`${p.family} · ${p.detail || p.label} — click to sort`}
                          onClick={() => sortClick(p.key)}
                          className={`th-sortable${i > 0 && orderedPicked[i - 1].family !== p.family ? ' fam-start' : ''}`}
                        >
                          <span className="th-ind">
                            {p.label}
                            {sortMark(p.key)}
                          </span>
                          <span className="th-unit">{p.unit}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((s) => (
                      <tr key={subjectKey(s, null)}>
                        <td className="td-subj" title={s.label}>
                          {s.label}
                        </td>
                        {orderedPicked.map((p, i) => (
                          <td
                            key={p.key}
                            className={`td-score${i > 0 && orderedPicked[i - 1].family !== p.family ? ' fam-start' : ''}`}
                            // The full score, unrounded, to the clipboard (lib/copyNumber).
                            onDoubleClick={(e) => {
                              const v = s.scores[p.key]
                              if (v != null) void copyNumber(v, e)
                            }}
                          >
                            {s.scores[p.key] == null
                              ? ''
                              : labelNum(s.scores[p.key], columnDecimals?.[p.key] ?? valueDecimals)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="results-charts-top">
                {picked.length >= 3 ? (
                  <section className="ind-fam-section res-card res-radar radar-wrap">
                    <div className="ind-fam-head has-sub">Radar</div>
                    <div className="chart-sub-row">
                      <span className="chart-sub">normalized to each indicator&rsquo;s maximum</span>
                    </div>
                    <button
                      className="chart-save zoom"
                      title="Enlarge"
                      onClick={() => zoomChart('radar', 'Radar — normalized')}
                    >
                      <MaximizeIcon />
                    </button>
                    <button
                      className="chart-save"
                      title="Save this chart as PNG"
                      onClick={() => saveChart('radar', 'radar_chart')}
                    >
                      <SaveIcon />
                    </button>
                    {summaryChart('radar', matrix, false)}
                  </section>
                ) : null}
                <section className="ind-fam-section res-card res-heat radar-wrap">
                  <div className="ind-fam-head has-sub">Heatmap</div>
                  <div className="chart-sub-row">
                    <span className="chart-sub">normalized per indicator (100% = highest subject)</span>
                    <HeatScale />
                  </div>
                  <button
                    className="chart-save zoom"
                    title="Enlarge"
                    onClick={() => zoomChart('heatmap', 'Heatmap — normalized per indicator')}
                  >
                    <MaximizeIcon />
                  </button>
                  <button
                    className="chart-save"
                    title="Save this chart as PNG"
                    onClick={() => saveChart('heatmap', 'heatmap')}
                  >
                    <SaveIcon />
                  </button>
                  {summaryChart('heatmap', matrix, false)}
                </section>
              </div>

              {view === 'normalized' && picked.length > 1 ? (
                <section className="ind-fam-section res-card res-norm norm-wrap">
                  <div className="ind-fam-head has-sub">Normalized</div>
                  <div className="chart-sub-row">
                    <span className="chart-sub">every indicator as % of its highest subject</span>
                  </div>
                  <button
                    className="chart-save zoom"
                    title="Enlarge"
                    onClick={() => zoomChart('normalized', 'Normalized comparison')}
                  >
                    <MaximizeIcon />
                  </button>
                  <button
                    className="chart-save"
                    title="Save this chart as PNG"
                    onClick={() => saveChart('normalized', 'normalized comparison')}
                  >
                    <SaveIcon />
                  </button>
                  {summaryChart('normalized', matrix, false)}
                </section>
              ) : stacked && (!stackData || stackBusy) ? (
                /* Stacked bars asked for but not computed: draw nothing rather than the frames they would go
                   in. Each chart box carries its own title, zoom and save button, so an empty grid was a page
                   of headings above buttons that saved nothing.
                   The Calculate line above already says what to press. */
                <p className="hint">
                  {stackBusy ? 'Splitting the bars…' : 'Stacked bars are not computed yet — click Calculate.'}
                </p>
              ) : (
                <>
                  {groups.map((g) => (
                    <section className="ind-fam-section" key={g.family}>
                      <div className="ind-fam-head">{g.family}</div>
                      {stacked && stackData && !stackBusy ? (
                        <StackLegend
                          keys={stackKeys}
                          label={stackLabel}
                          weights={stackWeights}
                          open={legendOpen}
                          onToggle={() => setLegendOpen((v) => !v)}
                        />
                      ) : null}
                      <div className="ind-chart-grid">
                        {g.items.map((p) => (
                          <div className="ind-chart" key={p.key}>
                            <button
                              className="chart-save zoom"
                              title="Enlarge"
                              onClick={() => zoomChart(p.key, `${p.label} — ${p.unit} (${p.family})`)}
                            >
                              <MaximizeIcon />
                            </button>
                            <button
                              className="chart-save"
                              title="Save this chart as PNG"
                              onClick={() => saveChart(p.key, `${p.family} ${p.label}`)}
                            >
                              <SaveIcon />
                            </button>
                            <div className="ind-chart-title" title={`${p.family} · ${p.detail || p.label}`}>
                              {p.label} <span className="th-unit">{p.unit}</span>
                              {useDiff ? <span className="th-unit"> · % vs {refSubject!.label}</span> : null}
                            </div>
                            {indicatorChart(p, false)}
                          </div>
                        ))}
                      </div>
                    </section>
                  ))}
                </>
              )}
            </>
          ) : null}

          {showSearch ? (
            <SearchDialog
              databases={databases}
              searchDbs={searchDbs}
              onSearchDbs={onSearchDbs}
              title="Add datasets to the comparison"
              onClose={() => setShowSearch(false)}
              onPick={(a) =>
                setBgSubjects((s) =>
                  s.some((x) => x.database === a.database && x.code === a.code) ? s : [...s, a]
                )
              }
            />
          ) : null}

          {zoomed && matrix ? (
            <div
              className="modal-backdrop"
              onMouseDown={(e) => e.target === e.currentTarget && setZoomed(null)}
            >
              <EscapeCloser onClose={() => setZoomed(null)} />
              <div className="chart-zoom-box">
                <div className="chart-zoom-head">
                  <span>{zoomed.title}</span>
                  {zoomed.id === 'heatmap' ? <HeatScale /> : null}
                  <button className="btn sm" onClick={() => setZoomed(null)}>
                    Close
                  </button>
                </div>
                <div className="chart-zoom-live">
                  {/* `scale`: the same chart, half again the type. A 1400×800 drawing with the 10px labels of a
                      300px panel is a big picture nobody can read. */}
                  {zoomed.id === 'radar' || zoomed.id === 'normalized' || zoomed.id === 'heatmap'
                    ? summaryChart(zoomed.id, matrix, true)
                    : (() => {
                        const p = orderedPicked.find((x) => x.key === zoomed.id)
                        return p ? indicatorChart(p, true) : null
                      })()}
                </div>
              </div>
            </div>
          ) : null}

          {showModelPick ? (
            <ModelPickDialog
              databases={databases}
              activeDb={activeDb}
              existing={fgSubjects}
              onClose={() => setShowModelPick(false)}
              onPick={(s) =>
                setFgSubjects((prev) =>
                  prev.some((x) => x.database === s.database && x.code === s.code) ? prev : [...prev, s]
                )
              }
            />
          ) : null}
          {showActPick ? (
            <ActivityPickDialog
              activities={acts.filter((a) => !(a.code in subjSel))}
              onClose={() => setShowActPick(false)}
              onPick={(code) => setSubjSel((sel) => ({ ...sel, [code]: true }))}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
