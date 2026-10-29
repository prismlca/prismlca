import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, isSuperseded, type DatabaseInfo } from '../lib/api'
import { useQuery } from '../lib/server/useQuery'
import { scenariosRoute, type TagGroup } from '../lib/server/routes'

// Stable fallback: `?? []` would be a fresh array each render and rattle every dependent memo.
const NO_GROUPS: TagGroup[] = []
import { useSettings, fmtSig } from '../lib/settings'
import { usePersisted } from '../lib/persist'
import { useViewField } from '../lib/modelView'
import { AGG_PALETTE, NEUTRAL_GREY } from '../lib/palette'
import { groupMethodsByFamily } from '../lib/methods'
import { CalculatorIcon, ExcelIcon, SaveIcon } from '../components/icons'
import FlowSortControl, { type FlowSort, sortRanked } from './FlowSort'
import ActivityPickDialog from '../components/ActivityPickDialog'
import SearchDialog from './SearchDialog'
import { AccordionGroup, useSingleOpen } from '../components/Accordion'
import { deliverBase64, deliverDataUrl, XLSX_MIME } from '../lib/download'
import { errMsg } from '../lib/errors'
import { useEChart, type ChartRegistry } from '../lib/charts/useEChart'
import { barOption, groupedContributionOption } from '../lib/charts/reportFigures'
import { figureInk, PRISM_PALETTE } from '../lib/reportColors'
import { NumberInput } from '../components/NumberInput'
import {
  isicColor,
  renderContribTree,
  type ContribResponse,
  type ContribTreeControls,
  type ContribTreeHandlers,
  type TreeNode
} from '../lib/contribTree'

/**
 * Detailed results: a single-subject, single-indicator contribution tree rendered as an
 * interactive D3 collapsible tree — the same visualisation the ecoinvent-bw MCP
 * contribution-tree skill produces (ISIC-coloured nodes, size ∝ √share, pan/zoom, hover
 * tooltip), consuming the meta+lookups+tree JSON from POST /calc/contribution.
 */
interface MethodInfo {
  method: string[]
  name: string
  unit: string
  recommended?: boolean // standard reporting indicator (vs specialist variant)
}
interface ElemFlow {
  flow: string
  categories: string[]
  unit: string
  impact: number
  share: number
}
interface ElemFlowsResponse {
  unit: string
  total: number
  /** How many characterised flows there are, which is not how many came back — see FLOWS_TOP. */
  count: number
  flows: ElemFlow[]
}
/** How many flows the side panel shows before the "show all" button at the foot of the list. An ecoinvent
 *  process characterises a few thousand of them: fine to export, poor to scroll. */
const FLOWS_TOP = 25

// Palette for aggregation segments (per tag value); "(untagged)" gets a muted grey.
const aggColor = (key: string, i: number): string =>
  key === '(untagged)' ? NEUTRAL_GREY : AGG_PALETTE[i % AGG_PALETTE.length]
interface Subject {
  database: string
  code: string
  label: string
  scenario?: string // scenario id whose parameter overrides to apply (model activities only)
  scenarioName?: string
}

// Inlined into the exported SVG so the PNG renders with the right colours/fonts
// (external stylesheet isn't available once the SVG is serialized into an image).
/* Frozen LIGHT palette on purpose, not theme tokens: this styles the exported PNG (white canvas,
   report picture), and an export must not depend on whoever exported it having dark mode on. The
   on-screen tree is styled by index.css with theme tokens; keep the two in the same shape. */
const TREE_EXPORT_CSS = `
.ctree3-svg { font-family: "Noto Sans", system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
.ctree3-svg .link { fill:none; stroke:#cbd2d7; }
.ctree3-svg .cnode .cnode-card { fill:#ffffff; stroke:#cfd5cb; stroke-width:1px; }
.ctree3-svg .cnode.collapsed .cnode-card { stroke:#b7bec4; }
.ctree3-svg .cnode.root .cnode-card { fill:#2f4e66; stroke:#2f4e66; }
.ctree3-svg .cnode .nm { font-size:12px; font-weight:600; fill:#26313a; }
.ctree3-svg .cnode .meta { font-size:10px; fill:#8b968f; }
.ctree3-svg .cnode .val { font-size:10.5px; fill:#5f6b6f; }
.ctree3-svg .cnode .pct { font-size:12px; font-weight:700; fill:#26313a; }
.ctree3-svg .cnode .bar-track { fill:#eef1ec; }
.ctree3-svg .cnode.root .nm { fill:#ffffff; }
.ctree3-svg .cnode.root .meta, .ctree3-svg .cnode.root .val { fill:rgba(255,255,255,0.72); }
.ctree3-svg .cnode.root .pct { fill:#ffffff; }
.ctree3-svg .cnode.root .bar-track { fill:rgba(255,255,255,0.18); }
.ctree3-svg .cnode .chev-zone { fill:#eef1f3; stroke:#cfd5cb; stroke-width:1px; }
.ctree3-svg .cnode.collapsed .chev-zone { stroke:#b7bec4; }
.ctree3-svg .cnode.root .chev-zone { fill:#3d5f7a; stroke:#2f4e66; }
.ctree3-svg .cnode .chev { font-size:14px; fill:#5f6b6f; }
.ctree3-svg .cnode .chev-n { font-size:9.5px; fill:#5f6b6f; }
/* The ⓘ is a control, and the export is a picture for a report: it has no business in one. It also
   never had a style here, so it printed as a black disc — visible the moment the card turned white. */
.ctree3-svg .cnode .cnode-info { display:none; }
.ctree3-svg .cnode.root .chev, .ctree3-svg .cnode.root .chev-n { fill:rgba(255,255,255,0.92); }
`

/**
 * Several variants side by side: grouped bars per tag group when the breakdown is on (the same drawing
 * the report's contribution chapter makes, so the screen and the PDF agree), plain bars of the totals
 * when it is off. On-screen lifecycle via useEChart; the PNG button hands over what the registry renders.
 */
function VariantsChart({
  variants,
  groupBy,
  unit,
  registry,
  digits
}: {
  variants: { id: string; name: string; res: ContribResponse }[]
  groupBy: string
  unit: string
  registry: ChartRegistry
  digits: number
}): JSX.Element {
  const themeKey = document.documentElement.getAttribute('data-theme') ?? 'light'
  const grouped = Boolean(groupBy) && variants.some((v) => v.res.aggregation?.groups.length)
  const ref = useEChart(
    'dr-variants',
    registry,
    () => {
      const ink = figureInk(themeKey === 'dark')
      if (grouped) {
        return groupedContributionOption(
          variants.map((v) => ({
            label: v.name,
            groups: (v.res.aggregation?.groups ?? []).map((g) => ({
              key: g.key,
              label: g.key,
              impact: g.impact,
              share: g.share
            }))
          })),
          unit,
          PRISM_PALETTE,
          ink
        )
      }
      return barOption(
        variants.map((v) => v.name),
        variants.map((v) => v.res.meta.total),
        unit,
        PRISM_PALETTE,
        true,
        ink
      )
    },
    [variants, groupBy, unit, themeKey, grouped]
  )
  const savePng = (): void => {
    const get = registry.current.get('dr-variants')
    if (get) deliverDataUrl(get(), 'prism-contribution-variants.png')
  }
  return (
    <div className="dr-agg">
      <div className="dr-agg-head">
        <div className="dr-agg-title">
          {grouped ? (
            <>
              Contribution by <b>{groupBy}</b> — {variants.length} variants
            </>
          ) : (
            <>Totals of {variants.length} variants — group by a tag family for the breakdown</>
          )}
          {' · '}
          {variants.map((v) => `${v.name}: ${fmtSig(v.res.meta.total, digits)} ${unit}`).join(' · ')}
        </div>
        <button className="btn sm icon" title="Save chart as PNG" onClick={savePng}>
          <SaveIcon />
        </button>
      </div>
      <div className="dr-agg-chart" ref={ref} />
    </div>
  )
}

/** D3 collapsible contribution tree — PrismLCA-styled process cards on a white canvas. */
function ContribTree({
  data,
  digits,
  seconds,
  onSelect,
  onShowDetails,
  onExportError,
  sidePanel
}: {
  data: ContribResponse
  digits: number
  seconds: number | null
  onSelect?: (node: TreeNode | null) => void
  /** Opens the process-details window (same one the model search uses). */
  onShowDetails?: (target: { database: string; code: string }) => void
  /** A failed PNG export used to go to the console only — the user clicked Save and nothing said why
   *  nothing happened. The parent owns the error line, so the message goes up. */
  onExportError?: (message: string) => void
  sidePanel?: ReactNode // rendered right of the canvas, exactly host-height (flows panel)
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const infoRef = useRef<HTMLDivElement | null>(null)
  // Kept in a ref box so selection/click handling never forces the (expensive) rebuild — the
  // controller reads it at click time (see lib/contribTree.ts).
  const handlersRef = useRef<ContribTreeHandlers>({})
  handlersRef.current = { onSelect, onShowDetails }
  const ctrl = useRef<ContribTreeControls | null>(null)

  /**
   * The canvas now takes whatever height the stage has left, so its height is no longer something
   * the layout decides once. The tree is drawn into a viewBox measured from the host, and a viewBox
   * that no longer matches its box letterboxes the drawing — a tall window would show the tree in a
   * band with white above and below. So the host is watched, and the tree is drawn again when the
   * box really changes size.
   *
   * Debounced, because a ResizeObserver fires on every frame of a window drag and this redraws a
   * hundred-node layout; and thresholded, because a one-pixel wobble from a scrollbar appearing is
   * not a resize.
   */
  const [hostSize, setHostSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const host = hostRef.current
    if (!host || typeof ResizeObserver === 'undefined') return
    let timer: number | undefined
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const w = host.clientWidth
        const h = host.clientHeight
        setHostSize((prev) => (Math.abs(prev.w - w) < 4 && Math.abs(prev.h - h) < 4 ? prev : { w, h }))
      }, 150)
    })
    ro.observe(host)
    return () => {
      window.clearTimeout(timer)
      ro.disconnect()
    }
  }, [])

  useEffect(() => {
    const host = hostRef.current
    const svgEl = svgRef.current
    const infoEl = infoRef.current
    if (!host || !svgEl || !infoEl) return
    const tree = renderContribTree({ host, svg: svgEl, info: infoEl, data, digits, handlers: handlersRef })
    ctrl.current = tree.controls
    return () => {
      ctrl.current = null
      tree.destroy()
    }
    // `hostSize` is not read in here — the controller measures fresh. It is in the list to say
    // "redraw when the box changes", which is exactly what it is for.
  }, [data, digits, hostSize])

  // Export the whole (currently expanded) tree as a PNG, like the other result charts.
  const saveTreePng = (): void => {
    const svgEl = svgRef.current
    const gInner = svgEl?.querySelector('g') as SVGGElement | null
    if (!svgEl || !gInner) return
    const b = gInner.getBBox()
    if (!b.width || !b.height) return
    const pad = 24
    const vx = b.x - pad
    const vy = b.y - pad
    const vw = b.width + pad * 2
    const vh = b.height + pad * 2
    const svgns = 'http://www.w3.org/2000/svg'
    const clone = svgEl.cloneNode(true) as SVGSVGElement
    clone.setAttribute('xmlns', svgns)
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
    clone.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`)
    clone.setAttribute('width', String(vw))
    clone.setAttribute('height', String(vh))
    clone.querySelector('g')?.removeAttribute('transform') // drop pan/zoom; frame via viewBox
    const style = document.createElementNS(svgns, 'style')
    style.textContent = TREE_EXPORT_CSS
    clone.insertBefore(style, clone.firstChild)
    const bg = document.createElementNS(svgns, 'rect')
    bg.setAttribute('x', String(vx))
    bg.setAttribute('y', String(vy))
    bg.setAttribute('width', String(vw))
    bg.setAttribute('height', String(vh))
    bg.setAttribute('fill', '#ffffff')
    clone.insertBefore(bg, clone.firstChild)
    const xml = new XMLSerializer().serializeToString(clone)
    const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }))
    const scale = 2
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(vw * scale)
      canvas.height = Math.ceil(vh * scale)
      const cx = canvas.getContext('2d')
      if (cx) {
        cx.scale(scale, scale)
        cx.drawImage(img, 0, 0)
        deliverDataUrl(canvas.toDataURL('image/png'), 'contribution_tree.png')
      }
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      onExportError?.('The contribution tree image could not be rendered for export.')
    }
    img.src = url
  }

  // Legend from the ISIC sections actually present in the tree.
  const usedIsic = useMemo(() => {
    const set = new Set<string>()
    const walk = (n: TreeNode): void => {
      if (n.isic) set.add(n.isic)
      ;(n.ch ?? []).forEach(walk)
    }
    walk(data.tree)
    return [...set].sort()
  }, [data])

  return (
    <div className="ctree3">
      <div className="ctree3-toolbar">
        <button className="btn sm" onClick={() => ctrl.current?.expandAll()}>
          Expand all
        </button>
        <button className="btn sm" onClick={() => ctrl.current?.collapseAll()}>
          Collapse all
        </button>
        <button className="btn sm" onClick={saveTreePng} title="Save the contribution tree as a PNG image">
          Save image
        </button>
        <span className="ctree3-meta">
          {data.meta.n_nodes} nodes · cutoff {(data.meta.cutoff * 100).toFixed(2)}% · depth{' '}
          {data.meta.max_depth}
          {seconds != null ? ` · ${seconds.toFixed(1)} s` : ''}
        </span>
      </div>
      {usedIsic.length ? (
        <div className="ctree3-legend">
          {usedIsic.map((code) => (
            <span key={code}>
              <span className="sw" style={{ background: isicColor(code) }} />
              {code} — {data.lookups?.isic?.[code] ?? code}
            </span>
          ))}
        </div>
      ) : null}
      <div className="ctree3-mid">
        <div className="ctree3-host" ref={hostRef}>
          <button className="chart-save" title="Save this chart as PNG" onClick={saveTreePng}>
            <SaveIcon />
          </button>
          <svg className="ctree3-svg" ref={svgRef} />
          <div className="ctree3-controls">
            <button
              className="react-flow__controls-button"
              onClick={() => ctrl.current?.zoomIn()}
              title="Zoom in"
              aria-label="Zoom in"
            >
              <svg viewBox="0 0 32 32">
                <path d="M32 18.133H18.133V32h-4.266V18.133H0v-4.266h13.867V0h4.266v13.867H32z" />
              </svg>
            </button>
            <button
              className="react-flow__controls-button"
              onClick={() => ctrl.current?.zoomOut()}
              title="Zoom out"
              aria-label="Zoom out"
            >
              <svg viewBox="0 0 32 5">
                <path d="M0 0h32v4.2H0z" />
              </svg>
            </button>
            <button
              className="react-flow__controls-button"
              onClick={() => ctrl.current?.fit()}
              title="Fit to view"
              aria-label="Fit to view"
            >
              <svg viewBox="0 0 32 30">
                <path d="M3.692 4.63c0-.53.4-.938.939-.938h5.215V0H4.708C2.13 0 0 2.054 0 4.63v5.216h3.692V4.631zM27.354 0h-5.2v3.692h5.17c.53 0 .984.4.984.939v5.215H32V4.631A4.624 4.624 0 0027.354 0zm.954 24.83c0 .532-.4.94-.939.94h-5.215v3.768h5.215c2.577 0 4.631-2.13 4.631-4.707v-5.139h-3.692v5.139zm-23.677.94c-.531 0-.939-.4-.939-.94v-5.138H0v5.139c0 2.577 2.13 4.707 4.708 4.707h5.138V25.77H4.631z" />
              </svg>
            </button>
          </div>
          <div className="ctree3-info" ref={infoRef}>
            <div className="name">Hover a node</div>
          </div>
        </div>
        {sidePanel}
      </div>
      <div className="ctree3-foot">
        click card = flows breakdown · click ▸ = expand / collapse · scroll = zoom · drag = pan
      </div>
    </div>
  )
}

export default function DetailedResults({
  activeDb,
  methods,
  databases,
  rev,
  onShowDetails,
  onTab,
  searchDbs,
  onSearchDbs
}: {
  /** See Results: the model revision that marks the shown tree stale after an edit. */
  rev?: number
  activeDb: string | null
  methods: MethodInfo[]
  databases: DatabaseInfo[]
  /** The ticked databases of the model view's search panel, when the caller shares them: one set of
   *  checkboxes for the whole app — a box ticked here is ticked there. */
  searchDbs?: string[]
  onSearchDbs?: (dbs: string[]) => void
  /** Opens the process-details window (owned by the Workbench, shared with the model search). */
  onShowDetails?: (target: { database: string; code: string }) => void
  /** Switch to the other kind of result. The tabs live in this page's rail; the state stays with the
   *  Workbench, because it also decides which of the two views is mounted. */
  onTab?: (tab: 'overview' | 'detail') => void
}): JSX.Element {
  const { round } = useSettings()
  // One group of the rail open at a time. Subject first: nothing on this page means anything until it
  // knows what it is looking at.
  const [grp] = useSingleOpen('prism.dr.grp', 'subject')
  const [acts, setActs] = useState<{ code: string; name: string }[]>([])
  const [scenarios, setScenarios] = useState<{ id: string; name: string }[]>([])
  // Per model: a subject is a process of one model, and a persisted one from another study made the
  // tree open on an activity that does not exist here.
  const [subject, setSubject] = useViewField<Subject | null>(activeDb, 'detailed', 'subject', null)
  // Which variants of the subject are computed: '' is the baseline, everything else a scenario id. Several
  // can be ticked at once: the tree shows the first ticked one, and with two or more the
  // breakdown is drawn as grouped bars — one bar per variant within each group, the shape the report's
  // contribution chapter uses — so "where does the difference come from" has a picture.
  const [variants, setVariants] = useViewField<string[]>(activeDb, 'detailed', 'variants', [''])
  const [variantData, setVariantData] = useState<{ id: string; name: string; res: ContribResponse }[]>([])
  const chartRegistry = useRef<Map<string, () => string>>(new Map()) as ChartRegistry
  // Which of this model's processes are offered, not which is chosen. Overview learnt the same lesson:
  // listing all fifteen sub-processes makes the reader pick the product out of its own parts every time.
  // The root is on the list from the start, the rest are added on purpose.
  const [shown, setShown] = useViewField<Record<string, boolean>>(activeDb, 'detailed', 'shown', {})
  const [showActPick, setShowActPick] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [family, setFamily] = usePersisted('prism.dr.family', '')
  const [methodKey, setMethodKey] = useViewField(activeDb, 'detailed', 'methodKey', '')
  const [cutoffPct, setCutoffPct] = useViewField(activeDb, 'detailed', 'cutoff', 0.5)
  const [maxDepth, setMaxDepth] = useViewField(activeDb, 'detailed', 'maxDepth', 8)
  // Shared cache — tag-group edits elsewhere invalidate the key, so this picker never goes stale.
  const tagGroups = useQuery('/api/v1/model/tag-groups').data?.groups ?? NO_GROUPS
  const [groupBy, setGroupBy] = useViewField(activeDb, 'detailed', 'groupBy', '') // tag group to aggregate by, '' = off
  const [flowsMode, setFlowsMode] = usePersisted('prism.dr.flows', true) // elementary-flows side panel (default on)
  const [data, setData] = useState<ContribResponse | null>(null)
  const [calcSeconds, setCalcSeconds] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!activeDb) {
      setActs([])
      return
    }
    void api<{ code: string; name: string }[]>(
      'GET',
      `/api/v1/model/activities/${encodeURIComponent(activeDb)}`
    )
      .then((rows) => setActs(rows.map((r) => ({ code: r.code, name: r.name }))))
      .catch(() => setActs([]))
  }, [activeDb])

  // With no subject chosen yet, open on the model's reference process rather than on nothing: the tree
  // is the answer to "where does this product's impact come from", and picking that product by hand
  // out of a list of fifteen sub-processes every time is a step with no decision in it.
  useEffect(() => {
    // Seeded when there is no subject *or* no list: a report from before this change has a persisted
    // subject and no list, and would otherwise come back to a panel offering nothing.
    if (!activeDb || (subject && Object.keys(shown).length)) return
    let alive = true
    void api<{ candidates: { code: string; name: string }[] }>(
      'GET',
      `/api/v1/model/reference/${encodeURIComponent(activeDb)}`
    )
      .then((r) => {
        const root = r.candidates?.[0]
        if (!alive || !root) return
        setSubject({ database: activeDb, code: root.code, label: root.name })
        setShown((v) => (Object.keys(v).length ? v : { [root.code]: true }))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // Only on a model change: re-running whenever `subject` changes would re-select it after the user
    // deliberately cleared it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDb])

  // Scenarios are model-scoped, read as a subscription: the editor invalidates the key on writes.
  const scenarioRows = useQuery(activeDb ? scenariosRoute(activeDb) : null).data
  useEffect(() => {
    if (!activeDb || !scenarioRows) {
      if (!activeDb) setScenarios([])
      return
    }
    setScenarios(scenarioRows.map((r) => ({ id: r.id, name: r.name })))
    // Drop a persisted scenario that no longer belongs to this model.
    setSubject((s) =>
      s && s.scenario && !scenarioRows.some((r) => r.id === s.scenario)
        ? { ...s, scenario: undefined, scenarioName: undefined }
        : s
    )
    // Only when something is actually dropped: every write to the view re-renders its readers, and the
    // default `['']` is a fresh literal per render — writing it back unconditionally was an endless loop.
    const kept = variants.filter((id) => id === '' || scenarioRows.some((r) => r.id === id))
    if (kept.length !== variants.length) setVariants(kept.length ? kept : [''])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDb, scenarioRows, setSubject, setVariants, variants.join('\u0000')])

  /** The ticked variants in display order — baseline first, then the scenarios as the model lists them. */
  // Keyed by content, not identity: the view field hands back a fresh default array per render.
  const variantsKey = variants.join('\u0000')
  const ticked = useMemo(
    () => ['', ...scenarios.map((s) => s.id)].filter((id) => variantsKey.split('\u0000').includes(id)),
    [scenarios, variantsKey]
  )
  const variantName = useCallback(
    (id: string): string => (id ? (scenarios.find((s) => s.id === id)?.name ?? id) : 'Baseline'),
    [scenarios]
  )
  // The tree — and the flows panel, the chip, the PNG — stand on the FIRST ticked variant. Kept on the
  // subject, where every reader of it already looks.
  useEffect(() => {
    const primary = ticked[0] ?? ''
    // Checked before writing, never inside the updater: a view write re-renders every reader whether or
    // not the value moved, so an unconditional setSubject here ran this effect for ever.
    if (!subject || subject.database !== activeDb || (subject.scenario ?? '') === primary) return
    setSubject(
      primary
        ? { ...subject, scenario: primary, scenarioName: variantName(primary) }
        : { ...subject, scenario: undefined, scenarioName: undefined }
    )
  }, [ticked, subject, activeDb, setSubject, variantName])
  const toggleVariant = (id: string, on: boolean): void =>
    setVariants((v) => {
      const next = on ? [...v.filter((x) => x !== id), id] : v.filter((x) => x !== id)
      return next.length ? next : ['']
    })

  /**
   * The families worth grouping by: those in use in the database of the subject on screen. Same
   * reasoning as on the Overview tab — a family nobody has tagged here aggregates the whole tree into one
   * "untagged" group. An ecoinvent process contributes none, which is right: nobody tags the background.
   * The family in use stays listed even if the subject moves away from it, or the select would show blank.
   */
  const groupFamilies = useMemo(
    () =>
      tagGroups.filter((g) => g.name === groupBy || (g.databases ?? []).some((d) => d === subject?.database)),
    [tagGroups, subject?.database, groupBy]
  )

  const familyMap = useMemo(() => groupMethodsByFamily(methods), [methods])
  const families = useMemo(() => [...familyMap.keys()].sort((a, b) => a.localeCompare(b)), [familyMap])
  const familyMethods = useMemo(() => familyMap.get(family) ?? [], [familyMap, family])

  useEffect(() => {
    if (!family && families.length) setFamily(families[0])
  }, [families, family, setFamily])
  useEffect(() => {
    if (familyMethods.length && !familyMethods.some((m) => m.method.join(' · ') === methodKey)) {
      setMethodKey(familyMethods[0].method.join(' · '))
    }
  }, [familyMethods, methodKey, setMethodKey])

  const method = useMemo(
    () => methods.find((m) => m.method.join(' · ') === methodKey) ?? null,
    [methods, methodKey]
  )

  const genRef = useRef(0)
  /** The scenario id the shown tree was computed under (undefined = baseline). */
  const computedScenario = useRef<string | undefined>(undefined)
  const [stale, setStale] = useState(false)
  const compute = useCallback(async () => {
    if (!subject || !method) {
      setData(null)
      return
    }
    const myGen = ++genRef.current // bump so a stale response can be recognised & ignored
    setLoading(true)
    setStale(false)
    setErr(null)
    const t0 = Date.now()
    try {
      // One tree per ticked variant, the first of them being the one on screen. Scenarios only apply to
      // the model's own processes; a background subject has exactly the baseline.
      const runs = subject.database === activeDb ? ticked : ['']
      const results: { id: string; name: string; res: ContribResponse }[] = []
      for (const [i, id] of runs.entries()) {
        setProgress(runs.length > 1 ? `${i + 1}/${runs.length}` : null)
        const res = await api<ContribResponse>('POST', '/api/v1/calc/contribution', {
          database: subject.database,
          code: subject.code,
          method: method.method,
          amount: 1,
          cutoff: Math.max(0, cutoffPct) / 100,
          max_depth: maxDepth,
          aggregate_by: groupBy ? `tag:${groupBy}` : undefined,
          scenario: id || undefined
        })
        if (genRef.current !== myGen) return // superseded by a newer request — ignore
        results.push({ id, name: variantName(id), res })
      }
      setCalcSeconds((Date.now() - t0) / 1000)
      // The scenario THIS tree stands on. The flows panel and its export read it from here, not from
      // the current selection — a scenario ticked after Calculate used to reach them.
      computedScenario.current = results[0]?.id || undefined
      setData(results[0]?.res ?? null)
      setVariantData(results)
    } catch (e) {
      if (genRef.current !== myGen || isSuperseded(e)) return // stale / cancelled — ignore quietly
      setErr(errMsg(e))
      setData(null)
      setVariantData([])
    } finally {
      if (genRef.current === myGen) {
        setLoading(false)
        setProgress(null)
      }
    }
  }, [subject, method, cutoffPct, maxDepth, groupBy, ticked, activeDb, variantName])
  const [progress, setProgress] = useState<string | null>(null)

  // No auto-recompute: changed settings only mark the shown tree as stale — the run starts
  // on the Calculate button (contribution trees can take a while on big systems).
  useEffect(() => {
    setStale(true)
  }, [compute, rev])

  const cancelCalc = (): void => {
    genRef.current++ // the in-flight response becomes a no-op
    setLoading(false)
    setStale(true)
    void api('POST', '/api/v1/calc/cancel', { channel: 'contribution' }).catch(() => {})
  }

  // Elementary-flows side panel: scoped to the clicked tree node (null = whole system).
  const [selNode, setSelNode] = useState<TreeNode | null>(null)
  const [flows, setFlows] = useState<ElemFlowsResponse | null>(null)
  // Off: the largest FLOWS_TOP flows. On: every one of them, after the button at the foot of the list.
  const [flowsAll, setFlowsAll] = useState(false)
  const [flowSort, setFlowSort] = useState<FlowSort>('9–1') // 9–1 = the backend's order, largest impact first
  const [flowsLoading, setFlowsLoading] = useState(false)
  const [flowsErr, setFlowsErr] = useState<string | null>(null)
  const flowsGen = useRef(0)
  useEffect(() => {
    setSelNode(null) // a recalculated tree invalidates any node selection
  }, [data])
  useEffect(() => {
    if (!flowsMode || !data) {
      setFlows(null)
      setFlowsErr(null)
      return
    }
    const target = selNode ?? data.tree
    const myGen = ++flowsGen.current
    setFlowsLoading(true)
    setFlowsErr(null)
    // Tree amounts are matrix demands (sign already normalised by the tree build), hence
    // raw_demand — the scoped total then matches the node's cumulative impact exactly.
    void api<ElemFlowsResponse>('POST', '/api/v1/calc/elementary-flows', {
      database: target.db,
      code: target.c,
      method: data.meta.method,
      amount: target.a,
      raw_demand: true,
      top_n: flowsAll ? 0 : FLOWS_TOP,
      scenario: computedScenario.current
    })
      .then((r) => {
        if (flowsGen.current === myGen) setFlows(r)
      })
      .catch((e) => {
        if (flowsGen.current !== myGen) return
        setFlows(null)
        setFlowsErr(errMsg(e))
      })
      .finally(() => {
        if (flowsGen.current === myGen) setFlowsLoading(false)
      })
    // The scenario comes from `computedScenario` (set when the tree lands), so the flows stay in sync
    // with the computed `data` — a scenario ticked after Calculate must not reach them.
  }, [flowsMode, data, selNode, flowsAll])

  // "All" is a decision about the list in front of you, not a mode: scoping to another node goes back to the
  // largest ones, or one click would make every card you touch load a few thousand rows.
  useEffect(() => setFlowsAll(false), [selNode, data])

  // Excel export of the flows list, in the currently displayed sort order — same base64→blob
  // download mechanism as the Results matrix export.
  const exportFlowsXlsx = (): void => {
    if (!flows || !data) return
    void (async () => {
      try {
        // Everything, not the 25 on screen: a spreadsheet is where the long tail is actually usable, and a
        // sheet that quietly stops at the panel's cap is a sheet whose rows do not add up to its own total.
        const target = selNode ?? data.tree
        const full =
          flowsAll || flows.count <= flows.flows.length
            ? flows
            : await api<ElemFlowsResponse>('POST', '/api/v1/calc/elementary-flows', {
                database: target.db,
                code: target.c,
                method: data.meta.method,
                amount: target.a,
                raw_demand: true,
                top_n: 0,
                scenario: computedScenario.current
              })
        const shown = sortRanked(full.flows, flowSort, (f) => f.flow)
        const r = await api<{ filename: string; base64: string }>('POST', '/api/v1/export/elementary-flows', {
          scope: selNode ? selNode.n : 'Whole system',
          method: data.meta.method,
          unit: full.unit,
          total: full.total,
          flows: shown.map((f) => ({
            flow: f.flow,
            categories: f.categories,
            impact: f.impact,
            share: f.share
          })),
          filename: 'prism-elementary-flows'
        })
        deliverBase64(r.base64, r.filename, XLSX_MIME)
      } catch (e) {
        setFlowsErr(errMsg(e))
      }
    })()
  }

  const bgOnly = databases.filter((d) => d.kind !== 'biosphere' && d.read_only)

  /** The rail's head: the page and its two kinds of result, as on the Report rail. */
  const railHead = (
    <>
      <div className="panel-h eyebrow">Results</div>
      <div className="rtabs rail-tabs" role="tablist">
        <button role="tab" aria-selected={false} className="rtab" onClick={() => onTab?.('overview')}>
          Overview results
        </button>
        <button role="tab" aria-selected={true} className="rtab on">
          Detailed results
        </button>
      </div>
    </>
  )

  return (
    <div className="view dr results-view">
      <div className="results-grid">
        <aside className="results-rail">
          {railHead}

          <AccordionGroup
            title="Subject"
            summary={subject ? subject.label : 'nothing yet'}
            {...grp('subject')}
          >
            <div className="subj-subhead">Your models</div>
            {acts.length ? (
              <div className="subjpick">
                {acts
                  .filter((a) => shown[a.code])
                  .map((a) => (
                    <label key={a.code} className="subjrow">
                      <input
                        type="radio"
                        name="dr-subject"
                        checked={!!subject && subject.database === activeDb && subject.code === a.code}
                        onChange={() =>
                          activeDb &&
                          setSubject((s) => ({
                            database: activeDb,
                            code: a.code,
                            label: a.name,
                            // keep the chosen scenario when switching between activities of this model
                            scenario: s?.database === activeDb ? s?.scenario : undefined,
                            scenarioName: s?.database === activeDb ? s?.scenarioName : undefined
                          }))
                        }
                      />
                      <span title={a.name}>{a.name}</span>
                      <button
                        className="bg-rm"
                        title="Take off the list"
                        onClick={(e) => {
                          e.preventDefault()
                          setShown((v) => {
                            const next = { ...v }
                            delete next[a.code]
                            return next
                          })
                          // The tree cannot stand on a process that is no longer offered.
                          if (subject?.code === a.code) setSubject(null)
                        }}
                      >
                        ×
                      </button>
                    </label>
                  ))}
                {acts.some((a) => !shown[a.code]) ? (
                  <button className="add-flow-btn inline" onClick={() => setShowActPick(true)}>
                    + Add from this model
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="empty">No models in this workspace yet.</p>
            )}
            {scenarios.length ? (
              <>
                <div className="subj-subhead">Variants</div>
                {/* Tick as many as you like: the tree shows the first, and from the second on the breakdown
                    below the tree becomes grouped bars — one bar per variant within each group. */}
                <div className="subjpick">
                  <label className="subjrow">
                    <input
                      type="checkbox"
                      name="dr-variant"
                      disabled={!(subject && subject.database === activeDb)}
                      checked={variants.includes('')}
                      onChange={(e) => toggleVariant('', e.target.checked)}
                    />
                    <span>Baseline</span>
                  </label>
                  {scenarios.map((s) => (
                    <label key={s.id} className="subjrow">
                      <input
                        type="checkbox"
                        name="dr-variant"
                        disabled={!(subject && subject.database === activeDb)}
                        checked={variants.includes(s.id)}
                        onChange={(e) => toggleVariant(s.id, e.target.checked)}
                      />
                      <span title={s.name}>{s.name}</span>
                    </label>
                  ))}
                </div>
              </>
            ) : null}
            <div className="subj-subhead">From a database</div>
            <div className="dr-bgrow">
              <button
                className="add-flow-btn inline"
                onClick={() => setShowSearch(true)}
                disabled={!bgOnly.length}
              >
                + Add from database
              </button>
            </div>
            {subject && subject.database !== activeDb ? (
              // Same chip look as the background subjects on the main Results page.
              <div className="subjpick">
                {(() => {
                  const m = subject.label.match(/^(.*) \[([^\]]+)\]$/)
                  return (
                    <span className="subjrow bg-subj" title={`${subject.label} · ${subject.database}`}>
                      <span>
                        {m ? m[1] : subject.label}
                        {m ? <span className="flow-geo">{m[2]}</span> : null}
                      </span>
                      <button className="bg-rm" title="Clear" onClick={() => setSubject(null)}>
                        ×
                      </button>
                    </span>
                  )
                })()}
              </div>
            ) : null}
          </AccordionGroup>

          <AccordionGroup
            title="Impact category"
            summary={method ? method.name.split(' · ').slice(1).join(' · ') || method.name : 'nothing yet'}
            {...grp('category')}
          >
            <div className="dr-ind-row">
              <label className="dr-sel">
                <span className="subj-subhead">Method family</span>
                <select
                  className="search-sel dr-full"
                  value={family}
                  onChange={(e) => setFamily(e.target.value)}
                >
                  {families.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
              <label className="dr-sel">
                <span className="subj-subhead">Indicator</span>
                <select
                  className="search-sel dr-full"
                  value={methodKey}
                  onChange={(e) => setMethodKey(e.target.value)}
                >
                  {familyMethods.map((m) => {
                    const key = m.method.join(' · ')
                    const label = m.method.slice(1).join(' · ') || m.method[0]
                    return (
                      <option key={key} value={key}>
                        {m.recommended ? '★ ' : ''}
                        {label} [{m.unit}]
                      </option>
                    )
                  })}
                </select>
              </label>
            </div>
          </AccordionGroup>

          <AccordionGroup
            title="Calculation"
            summary={flowsMode ? 'by elementary flow' : 'by process'}
            {...grp('calculation')}
          >
            <label className="dr-field">
              <span>Breakdown by elementary flows</span>
              <input
                type="checkbox"
                checked={flowsMode}
                onChange={(e) => setFlowsMode(e.target.checked)}
                title="Show a side panel with the contribution by elementary flows (gases etc.) — click a tree node to scope it to that node"
              />
            </label>
            <label className="dr-field">
              <span>Cutoff (%)</span>
              <NumberInput
                min={0}
                step={0.1}
                value={cutoffPct}
                onValue={(raw) => setCutoffPct(Number(raw))}
                title="Hide branches below this share of the total"
              />
            </label>
            <label className="dr-field">
              <span>Max depth</span>
              <NumberInput
                min={1}
                max={20}
                step={1}
                value={maxDepth}
                onValue={(raw) => setMaxDepth(Math.max(1, Math.min(20, Math.round(Number(raw)) || 1)))}
              />
            </label>
            <label className="dr-field">
              <span>Group by</span>
              <select className="search-sel" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                <option value="">— off —</option>
                {groupFamilies.map((g) => (
                  <option key={g.name} value={g.name}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            {subject ? (
              <div className="dr-total">
                <span className="dr-total-val">
                  {data && !loading ? fmtSig(data.meta.total, round.results) : '—'}
                </span>
                <span className="dr-total-unit">{(!loading && data?.meta.unit) || method?.unit || ''}</span>
              </div>
            ) : (
              <p className="hint-sm">Pick a subject and an indicator.</p>
            )}
          </AccordionGroup>

          {/* Pinned to the foot of the rail: the verb of this page, with its progress and Cancel. */}
          {subject && method ? (
            <div className="results-actbar">
              <div className="calcbar">
                {loading ? (
                  <>
                    <span className="spinner" />
                    <div className="calc-progress-bar">
                      <span className="indeterminate" />
                    </div>
                    <button className="btn sm" onClick={cancelCalc}>
                      Cancel
                    </button>
                    {/* Its own line, like on the Overview tab: the subject's name is the informative half of
                        this sentence and it is the half that was being cut off. */}
                    <span className="calc-progress-label">
                      Computing contribution tree{progress ? ` (${progress})` : ''} — {subject.label}…
                    </span>
                  </>
                ) : (
                  <>
                    <button className="btn primary" onClick={() => void compute()}>
                      <CalculatorIcon /> Calculate
                    </button>
                    {stale && data ? (
                      <span className="calc-stale">Settings changed — the shown tree is outdated.</span>
                    ) : null}
                    {!data ? <span className="calc-stale">Ready — click Calculate.</span> : null}
                    {!stale && data && calcSeconds != null ? (
                      <span className="calc-stale">Computed in {calcSeconds.toFixed(1)} s.</span>
                    ) : null}
                    {subject?.scenario && subject.scenarioName ? (
                      <span
                        className="ind-chip"
                        title="The tree reflects this scenario's parameter overrides"
                      >
                        Scenario: {subject.scenarioName}
                      </span>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          ) : null}
        </aside>

        <div className="results-main">
          {err ? (
            <div className="wb-error" onClick={() => setErr(null)}>
              {err}
            </div>
          ) : null}

          {stale && data && !loading ? (
            <div className="stale-banner">
              ⚠ The selection or settings changed after this calculation — the results below do not reflect
              them. Click <b>Calculate</b> to refresh.
            </div>
          ) : null}

          {!loading && variantData.length > 1 ? (
            <VariantsChart
              variants={variantData}
              groupBy={groupBy}
              unit={data?.meta.unit ?? method?.unit ?? ''}
              registry={chartRegistry}
              digits={round.results}
            />
          ) : null}
          {!loading && variantData.length <= 1 && data?.aggregation && data.aggregation.groups.length
            ? (() => {
                const gs = data.aggregation.groups
                const sumAbs = gs.reduce((s, g) => s + Math.abs(g.impact), 0) || 1
                return (
                  <div className="dr-agg">
                    <div className="dr-agg-title">
                      Contribution by <b>{groupBy}</b> — {fmtSig(data.meta.total, round.results)}{' '}
                      {data.meta.unit}
                    </div>
                    <div className="dr-agg-bar" title="Share of total impact per tag value">
                      {gs.map((g, i) => (
                        <span
                          key={g.key}
                          className="dr-agg-seg"
                          style={{
                            width: `${(Math.abs(g.impact) / sumAbs) * 100}%`,
                            background: aggColor(g.key, i)
                          }}
                          title={`${g.key}: ${(g.share * 100).toFixed(1)}%`}
                        />
                      ))}
                    </div>
                    <div className="dr-agg-legend">
                      {gs.map((g, i) => (
                        <span key={g.key} className="dr-agg-item">
                          <span className="dr-agg-dot" style={{ background: aggColor(g.key, i) }} />
                          {g.key} <b>{(g.share * 100).toFixed(1)}%</b>
                          <span className="dr-agg-val">
                            {fmtSig(g.impact, round.results)} {data.meta.unit}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                )
              })()
            : null}

          <div className={`dr-tree-wrap${flowsMode ? ' flows-on' : ''}`}>
            {loading ? null : !data ? (
              <p className="empty">Choose a subject and an indicator, then click Calculate.</p>
            ) : (
              <ContribTree
                data={data}
                digits={round.results}
                seconds={calcSeconds}
                onSelect={setSelNode}
                onShowDetails={onShowDetails}
                onExportError={setErr}
                sidePanel={
                  flowsMode ? (
                    <aside className="dr-flows-panel">
                      <div className="dr-flows-head">
                        <div className="rp-title">Elementary flows</div>
                        {/* The list arrives ranked by impact, so that order is home: the third click
                            on a label comes back to 9–1 rather than to an unsorted list. */}
                        <FlowSortControl
                          value={flowSort}
                          onChange={(v) => setFlowSort(v ?? '9–1')}
                          measure="impact"
                          origin="Back to largest impact first"
                        />
                        <button
                          className="flow-sort-btn dr-flows-save"
                          title="Export this list as Excel"
                          onClick={exportFlowsXlsx}
                          disabled={!flows || flowsLoading}
                        >
                          <ExcelIcon />
                        </button>
                      </div>
                      <div className="dr-flows-scope">
                        {selNode ? (
                          <>
                            <span className="dr-flows-scope-name" title={selNode.n}>
                              {selNode.n}
                            </span>
                            <button
                              className="bg-rm"
                              title="Back to the whole system"
                              onClick={() => setSelNode(null)}
                            >
                              ×
                            </button>
                          </>
                        ) : (
                          'Whole system'
                        )}
                      </div>
                      {flowsErr ? (
                        <p className="empty">{flowsErr}</p>
                      ) : flowsLoading ? (
                        <p className="empty">
                          <span className="spinner" /> Computing…
                        </p>
                      ) : flows ? (
                        <>
                          <div className="dr-flows-total">
                            {fmtSig(flows.total, round.results)} <span>{flows.unit}</span>
                          </div>
                          <div className="dr-flows-list">
                            {sortRanked(flows.flows, flowSort, (f) => f.flow).map((f, i) => (
                              <div
                                key={i}
                                className="dr-flow"
                                title={`${f.flow}${f.categories.length ? ` — ${f.categories.join(' / ')}` : ''}`}
                              >
                                <div className="dr-flow-top">
                                  <span className="dr-flow-name">{f.flow}</span>
                                  <span className="dr-flow-share">{(f.share * 100).toFixed(1)}%</span>
                                </div>
                                {f.categories.length ? (
                                  <div className="dr-flow-cat">{f.categories.join(' / ')}</div>
                                ) : null}
                                <div className="dr-flow-bar">
                                  <span style={{ width: `${Math.min(100, Math.abs(f.share) * 100)}%` }} />
                                </div>
                                <div className="dr-flow-val">
                                  {fmtSig(f.impact, round.results)} {flows.unit}
                                </div>
                              </div>
                            ))}
                            {/* At the foot of the list, where you arrive having read the ones that matter. The count is
                          the honest part: the total above the list is the whole score, so 25 rows out of 1 800 do
                          not add up to it and nothing else on the panel would say so. */}
                            {!flowsAll && flows.count > flows.flows.length ? (
                              <button className="btn sm dr-flows-more" onClick={() => setFlowsAll(true)}>
                                Show all {flows.count}
                              </button>
                            ) : null}
                          </div>
                        </>
                      ) : null}
                      <div className="dr-flows-hint">
                        Click a card to scope the list; click it again (or the root) to reset.
                      </div>
                    </aside>
                  ) : null
                }
              />
            )}
          </div>

          {showActPick ? (
            <ActivityPickDialog
              activities={acts.filter((a) => !shown[a.code])}
              onClose={() => setShowActPick(false)}
              onPick={(code) => setShown((v) => ({ ...v, [code]: true }))}
            />
          ) : null}
          {showSearch ? (
            <SearchDialog
              databases={databases}
              searchDbs={searchDbs}
              onSearchDbs={onSearchDbs}
              title="Pick a dataset as the subject"
              onClose={() => setShowSearch(false)}
              onPick={(a) => {
                setSubject({
                  database: a.database,
                  code: a.code,
                  label: `${a.name}${a.geography ? ` [${a.geography}]` : ''}`
                })
                setShowSearch(false)
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
