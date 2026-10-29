import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useQuery } from '../lib/server/useQuery'
import { fetchQuery } from '../lib/server/useQuery'
import { activitiesRoute, scenariosRoute, studyRoute, type TagGroup } from '../lib/server/routes'

// Stable fallback: `?? []` would be a fresh array each render and rattle every dependent memo.
const NO_GROUPS: TagGroup[] = []
import { readLs, usePersisted } from '../lib/persist'
import { viewFetch, viewSync } from '../lib/modelView'
import { initialReportLang, reportPrefill, type ResultsViewState } from '../lib/report/prefill'
import { resolveSplit } from './results/splitBy'
import ReportSections from './ReportSections'
import ShortReportRail from './report/ShortReportRail'
import { useShortSettings } from './report/useShortSettings'
import ReportPicker, { type StoredReport } from './report/ReportPicker'
import type { Theme } from './ThemeGallery'
import { MaximizeIcon, MinusIcon, PlusIcon } from '../components/icons'
import { methodKey } from '../components/IndicatorPicker'
import { indicatorLabels } from '../lib/methods'
import { bytesFromBase64, deliverBase64, deliverBytes } from '../lib/download'
import { errMsg } from '../lib/errors'

import { figuresFromSnapshot, type MethodReference, type SourcesSnapshot } from '../lib/report/figures'
import { reviewRefusal } from '../lib/report/staleness'

/** Re-exported for the figure editor and the report model, which imported them from here. */
export type { ContributionSubject, ContributionView, FigureSpec } from '../lib/report/figures'

interface MethodInfo {
  method: string[]
  name: string
  unit: string
  recommended?: boolean
}

/**
 * Indicators a new report starts with.
 *
 * The old rule — the first four `recommended` entries of the catalogue — is alphabetical by family, so
 * every report began on CML v4.8 2016 with acidification and two ecotoxicity variants. Nothing was
 * wrong with the mechanism and everything with the result: a study whose scope says EF v3.1 got seven
 * chapters written against a different method family, with no warning anywhere.
 *
 * So: prefer the newest EF family (the European reference method, and the one a footprint study is
 * normally asked for), and within it climate change first, then water and land use — a small, coherent
 * set rather than four indicators that happen to sort first. Falls back to the old behaviour when no EF
 * family is installed.
 */
const PREFERRED_INDICATORS = ['climate change', 'water use', 'land use']

export function defaultReportMethods(methods: MethodInfo[]): string[][] {
  const families = [...new Set(methods.map((m) => m.method[0]))].filter(
    (f) => /^EF v?\d/i.test(f) && !/no LT/i.test(f)
  )
  // Numeric-aware: plain sort() puts "EF v3.10" below "EF v3.9" the day a two-digit minor exists.
  const family = families.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)
  if (family) {
    const inFamily = methods.filter((m) => m.method[0] === family && m.recommended)
    const picked = PREFERRED_INDICATORS.map((want) =>
      inFamily.find((m) => (m.method[1] ?? '').toLowerCase() === want)
    ).filter((m): m is MethodInfo => Boolean(m))
    if (picked.length) return picked.map((m) => m.method)
  }
  const recommended = methods.filter((m) => m.recommended).slice(0, 4)
  return (recommended.length ? recommended : methods.slice(0, 1)).map((m) => m.method)
}

/**
 * Report page: turn the study metadata and the impact results into the document an LCA practitioner
 * hands to a reviewer.
 *
 * This first version drives the report generator that already exists in the backend
 * (`POST /api/v1/report/iso` → self-contained HTML): pick the reference process, the impact
 * indicators and optionally a contribution breakdown, preview it, save it. Structure, Typst
 * typesetting, chapters and AI prose follow in the next stages.
 */
export default function Report({
  activeDb,
  methods,
  active = true
}: {
  activeDb: string | null
  methods: MethodInfo[]
  /** False while the page is mounted but hidden — it stays mounted so a write run is not forgotten
   *  (see Workbench `seenReport`). The false→true edge is what used to be a remount, so it is where
   *  "has the model moved under the chapters?" has to be asked again. */
  active?: boolean
}): JSX.Element {
  /**
   * Two tools, not two views of one — so they get a tab each and share no control.
   *
   * A short report is a look at where the model stands: nothing about it is stored, and its selection is
   * its own. A full report *is* a document — it owns the processes it compares, the indicators, the
   * chapters, the language. Feeding one from the other's dropdowns is what made a saved report's preview
   * depend on a control in a card beside it.
   */
  const [tab, setTab] = usePersisted<string>('prism.report.tab', 'full')
  const [acts, setActs] = useState<{ code: string; name: string }[]>([])
  const [scenarios, setScenarios] = useState<{ id: string; name: string }[]>([])
  /** Tag families with the databases they are actually used in — see `dims` / ReportSections. */
  // Shared cache; `loadScope` no longer refetches this — an edit elsewhere invalidates the key.
  const dimGroups = useQuery('/api/v1/model/tag-groups').data?.groups ?? NO_GROUPS
  const [code, setCode] = usePersisted<string>('prism.report.code', '')
  const [picked, setPicked] = usePersisted<string[]>('prism.report.methods', [])
  /** The short report's settings: its look app-wide, its title and its variants with the open model. */
  const {
    settings: shortSettings,
    update: updateShort,
    head: shortHead,
    setHead: setShortHead
  } = useShortSettings(activeDb)
  /** The themes on offer — the short rail shows the same gallery the full report's Appearance group does. */
  const [templates, setTemplates] = useState<Theme[]>([])
  const loadTemplates = useCallback(async () => {
    try {
      const r = await api<{ templates: Theme[] }>('GET', '/api/v1/report/templates')
      setTemplates(r.templates)
    } catch {
      setTemplates([])
    }
  }, [])
  useEffect(() => {
    void loadTemplates()
  }, [loadTemplates])
  const [stored, setStored] = useState<StoredReport[]>([])
  //: The list as a ref, for async work that must read the CURRENT stamps mid-flight (previewStored
  //: runs for tens of seconds; its closure list would be the one from before the run started).
  const storedRef = useRef<StoredReport[]>([])
  useEffect(() => {
    storedRef.current = stored
  }, [stored])
  const [storedId, setStoredId] = usePersisted<string>('prism.report.storedId', '')
  /** Which model's report list has actually come back — "loaded", as distinct from "not empty". */
  const [listedFor, setListedFor] = useState<string | null>(null)
  const [gaps, setGaps] = useState<string[]>([])
  //: `reportUpdated` is the report's store stamp at typeset time: once the report moves on (a
  //: rewrite, a chapter edit), an open preview shows pages of a document that no longer exists —
  //: the pane says so instead of letting old pages pass as current.
  const [preview, setPreview] = useState<{
    page: number
    pages: number
    src: string
    reportUpdated: string | null
  } | null>(null)
  /**
   * The page's width in pixels while zoomed, or null for "fit one page".
   *
   * Pixels rather than a percentage on purpose. Fit scales the page to the pane's *height*, so a
   * percentage of the pane's *width* made the first click jump by two thirds before behaving. Stepping
   * from the width currently on screen makes every click the same 25%, including the first.
   */
  const [zoom, setZoom] = useState<number | null>(null)
  const pageRef = useRef<HTMLImageElement | null>(null)
  const stepZoom = (factor: number): void =>
    setZoom((current) => {
      const from = current ?? pageRef.current?.getBoundingClientRect().width ?? 600
      return Math.max(200, Math.min(4000, Math.round(from * factor)))
    })
  const [busy, setBusy] = useState(false)
  /** The chapter panel's arithmetic re-check. Typesetting while it runs would use badges that are
   *  still the previous answer — the document then carries moved figures under unmoved wording
   *  (V151). Held back exactly as long as the "Write all" dialog holds its Run button. */
  const [checkingChapters, setCheckingChapters] = useState(false)
  /** Chapters of the open report are being written or corrected — its Delete waits for that. */
  const [writingChapters, setWritingChapters] = useState(false)
  /** Waits for ReportSections' mutation queue — a no-op until the panel registers (or without one). */
  const settleRef = useRef<() => Promise<void>>(() => Promise.resolve())
  const registerSettle = useCallback((settle: () => Promise<void>) => {
    settleRef.current = settle
  }, [])
  /** The PDF the last render handed over, so the preview pane can say so instead of "nothing yet". */
  /** What became of the last file this page handed over. `handoff` is the honest state between the
   *  click and the download's own verdict: the app knows it produced bytes, not that they landed. */
  const [delivered, setDelivered] = useState<{
    filename: string
    kb: number
    state: 'handoff' | 'completed' | 'cancelled' | 'interrupted'
    path?: string
  } | null>(null)
  /**
   * The download's own verdict on the file this page handed over.
   *
   * Announcing "Saved <name>.pdf" the moment `<a download>.click()` returns says three things the app
   * cannot know: that a save dialog was answered, that it was answered with Save, and under which name
   * the bytes ended up. In practice none of them held — the message appeared three times
   * while no file of that name existed on disk (V157). Now the message waits for this, and names the
   * real path when there is one.
   */
  useEffect(
    () =>
      window.prism.onDownload((d) => {
        setDelivered((prev) =>
          // Only our own hand-over: an Excel export or a bundle download from another page must not
          // rewrite what the report pane says.
          prev && prev.state === 'handoff' && prev.filename === d.filename
            ? {
                ...prev,
                state:
                  d.state === 'completed'
                    ? 'completed'
                    : d.state === 'cancelled'
                      ? 'cancelled'
                      : 'interrupted',
                kb: d.bytes ? Math.round(d.bytes / 1024) : prev.kb,
                path: d.path || undefined
              }
            : prev
        )
      }),
    []
  )

  /**
   * What the page is doing, for the reader rather than for the code. A report render computes the whole
   * study — twelve seconds on a three-variant model — and twelve seconds of a dead button is the point
   * at which people click it again.
   */
  const [doing, setDoing] = useState<string | null>(null)
  /** The pager's editable page number, kept as text so a half-typed "1" does not jump to page 1. */
  const [pageInput, setPageInput] = useState('1')
  /**
   * Acronyms the document uses without explaining them. The glossary is built once and then goes stale by
   * itself: delete a chapter and its term keeps being explained, have one written and it brings acronyms
   * nobody has explained. The first half is now fixed at render time (an unused entry is dropped); this is
   * the other half — the report says what is missing and leaves the explaining to an explicit Resolve.
   */
  const [unexplained, setUnexplained] = useState<string[]>([])
  // Which deliverable the export gate refused, and over what — offers the explicit "Export anyway".
  // Two reasons, asked one after the other so one click never answers both: chapters a model wrote
  // that the author has not released (asked here, before the backend is called), and placeholders
  // that would print as gaps (the backend's refusal). `allowReview` carries the first answer into
  // the second ask.
  const [gapExport, setGapExport] = useState<{
    kind: 'pdf' | 'bundle'
    reason: 'gaps' | 'review'
    allowReview: boolean
  } | null>(null)
  /** Model-written chapters still awaiting the author's release, as the chapter panel counts them. */
  const [reviewPending, setReviewPending] = useState(0)
  /** Said after a data hand-out, not before it — see `exportData` on why this is a note, not a refusal. */
  const [dataNote, setDataNote] = useState<string | null>(null)
  /** What a just-created report took over from the Results page and the study (V407) — said once, for
   *  that report only, and gone when another report is picked. */
  const [prefillNote, setPrefillNote] = useState<{ id: string; text: string } | null>(null)
  useEffect(() => {
    setPrefillNote((n) => (n && n.id !== storedId ? null : n))
  }, [storedId])

  // What the preview pane currently belongs to. The report select and the tab buttons stay usable
  // while a render runs, so a 12-second typeset finishing late used to paint report A's page — and its
  // placeholder gaps — into report B's editor. Callbacks capture this at call time and drop their
  // response when it no longer matches.
  const paneRef = useRef({ storedId: '', tab: '' })
  useEffect(() => {
    paneRef.current = { storedId, tab }
  }, [storedId, tab])
  const [error, setError] = useState<string | null>(null)

  // Processes of the open model, and the tag dimensions available for a contribution breakdown.
  // Both effects ignore a response that arrives after the model changed again: without the guard, a
  // slow answer for the previous model could overwrite the new one's list — and the code-reset effect
  // below would then persist a process of the wrong model.
  /**
   * The two lists the Scope card offers to tick: the model's scenarios and its tag families. Both are
   * made on *other* pages, so "loaded once when the model opened" is not enough — a scenario written
   * next door was simply absent from "Compare with" until the page was left and re-entered (V238),
   * and the tag families had it worse still: no dependency at all, so they were the ones seen at
   * app start. Refetched whenever the card is opened, which is exactly when the answer is read.
   */
  const loadScope = useCallback(() => {
    if (!activeDb) {
      setScenarios([])
      return
    }
    void fetchQuery(scenariosRoute(activeDb))
      .then((r) => setScenarios(Array.isArray(r) ? r : []))
      .catch(() => setScenarios([]))
  }, [activeDb])

  useEffect(() => {
    loadScope()
  }, [loadScope])

  useEffect(() => {
    if (!activeDb) {
      setActs([])
      return
    }
    let stale = false
    void fetchQuery(activitiesRoute(activeDb))
      .then((r) => !stale && setActs(r))
      .catch(() => !stale && setActs([]))
    return () => {
      stale = true
    }
  }, [activeDb])

  /**
   * Families worth breaking a contribution down by, for the short report: those in use in the open model.
   * A family is project config from the moment it is created, so this list used to hold every one
   * of them — and a breakdown by a family nobody tagged puts the whole tree in one "untagged" row. The one
   * already chosen stays listed, or the select would show blank and look as if the setting had been lost.
   */
  const dims = useMemo(
    () =>
      dimGroups
        .filter(
          (g) =>
            shortSettings.breakdowns.includes(`tag:${g.name}`) ||
            (g.databases ?? []).some((d) => d === activeDb)
        )
        .map((g) => g.name),
    [dimGroups, activeDb, shortSettings.breakdowns]
  )

  const loadStored = useCallback(async () => {
    if (!activeDb) return
    try {
      const r = await api<{ reports: StoredReport[] }>(
        'GET',
        `/api/v1/report/list/${encodeURIComponent(activeDb)}`
      )
      setStored(r.reports)
    } catch {
      setStored([])
    } finally {
      setListedFor(activeDb)
    }
  }, [activeDb])

  useEffect(() => {
    void loadStored()
  }, [loadStored])

  // The selection is persisted, so it outlives the report it points at — a deleted report (or a model
  // switch) would otherwise leave the editor asking for something that no longer exists. Only once the
  // list has loaded: on mount `stored` is still [], and clearing then would wipe the persisted
  // selection on every visit to this view.
  //
  // "Loaded" is what `listedFor` says, not `stored.length`. Gating on the length meant the one case
  // that cannot self-correct never did: a model whose reports were *all* deleted kept the dead id, and
  // the page opened on "No report 'rep-…' for model '…'" — a 404 the store is right to raise, shown
  // where "no report selected" belongs.
  useEffect(() => {
    if (listedFor === activeDb && storedId && !stored.some((r) => r.id === storedId)) setStoredId('')
  }, [stored, storedId, setStoredId, listedFor, activeDb])

  // Switching reports must not leave the previous document's page on screen — nor its placeholder
  // gaps and glossary warnings, which used to sit under the new report until its next render.
  useEffect(() => {
    setPreview(null)
    setGaps([])
    setUnexplained([])
    setDelivered(null) // and not the file the *previous* report handed over
  }, [storedId])

  // A process from another model must not stay selected after switching models. The first pick is the
  // reference process the backend derives from the graph, not whatever the database lists first: the
  // short report opened on "Bottle — end-of-life" for a bottle model (V352).
  useEffect(() => {
    if (!acts.length || acts.some((a) => a.code === code)) return
    let alive = true
    if (!activeDb) {
      setCode(acts[0]?.code ?? '')
      return
    }
    // Ask first, set once: setting the first activity as a placeholder re-ran this effect (`code` is
    // a dependency), whose cleanup then discarded the reference answer.
    void api<{ candidates: { code: string }[] }>(
      'GET',
      `/api/v1/model/reference/${encodeURIComponent(activeDb)}`
    )
      .then((r) => {
        if (!alive) return
        const ref = r.candidates?.[0]?.code
        setCode(ref && acts.some((a) => a.code === ref) ? ref : (acts[0]?.code ?? ''))
      })
      .catch(() => {
        if (alive) setCode(acts[0]?.code ?? '') // the first activity stands, as before
      })
    return () => {
      alive = false
    }
  }, [acts, code, setCode, activeDb])

  const chosen = useMemo(() => methods.filter((m) => picked.includes(methodKey(m.method))), [methods, picked])
  // What an indicator is called in a figure — over the whole catalogue, so a chart axis says what the
  // table and the chapter heading beside it say (V203, lib/methods).
  const indLabels = useMemo(() => indicatorLabels(methods), [methods])

  /** Switch tools and empty the preview pane: what is in it belongs to the tool that produced it. */
  const showTab = (next: string): void => {
    setTab(next)
    setPreview(null)
    setGaps([])
    setUnexplained([])
    setDelivered(null)
    setError(null)
  }

  /**
   * What the short report is made from — the rail's settings as the backend's `ShortSettings`. Built per
   * call rather than held in state, so a click always sends what the rail shows.
   */
  const shortBody = useCallback(
    () => ({
      database: activeDb ?? '',
      code,
      methods: chosen.map((m) => m.method),
      amount: Number(shortSettings.amount) || 1,
      lang: shortSettings.lang,
      title: shortHead.title,
      subtitle: shortHead.subtitle,
      template: shortSettings.template,
      palette: shortSettings.palette,
      palette_colors: shortSettings.palette_colors,
      compare: shortSettings.compare,
      breakdowns: shortSettings.breakdowns,
      contents: shortSettings.contents,
      heatmap: shortSettings.heatmap,
      radar: shortSettings.radar,
      stacked: shortSettings.stacked,
      per_indicator_charts: shortSettings.per_indicator_charts,
      hotspots: shortSettings.hotspots,
      background_tier: shortSettings.background_tier,
      per_process: shortSettings.per_process,
      colour_by: shortSettings.colour_by || null,
      edge_amounts: shortSettings.edge_amounts
    }),
    [activeDb, code, chosen, shortSettings, shortHead]
  )

  /**
   * The short report's render: the same two steps as a stored report's — the backend computes the study
   * and hands back the snapshot with a token, the renderer draws the figures from it and posts them back
   * for the typeset page. Ephemeral: the definition is built from the rail and never stored.
   */
  const previewShort = useCallback(
    async (page = 1, reuse = false) => {
      if (!activeDb || !code || !chosen.length) return
      setDoing(reuse ? null : 'Computing and typesetting')
      setBusy(true)
      setError(null)
      try {
        const body = shortBody()
        let figures: Record<string, string> = {}
        let references: MethodReference[] = []
        let token: string | undefined
        if (!reuse) {
          const snapshot = await api<SourcesSnapshot>('POST', '/api/v1/report/short/sources', body)
          const drawn = await figuresFromSnapshot(snapshot, indLabels)
          figures = drawn.figures
          references = drawn.references
          token = snapshot.render_token
        }
        const r = await api<{ page: number; pages: number; base64: string }>(
          'POST',
          '/api/v1/report/short/preview',
          {
            ...body,
            figures,
            method_references: references,
            render_token: token,
            page,
            reuse
          }
        )
        if (paneRef.current.tab !== 'short') return // the author has moved on; this page belongs to the old tab
        setPreview({
          page: r.page,
          pages: r.pages,
          src: `data:image/png;base64,${r.base64}`,
          reportUpdated: null
        })
        setPageInput(String(r.page))
      } catch (e) {
        setError(errMsg(e))
      } finally {
        setBusy(false)
        setDoing(null)
      }
    },
    [activeDb, code, chosen, shortBody, indLabels]
  )

  /** Typeset the short report and hand the PDF over — figures drawn here, like the preview's. */
  const savePdfShort = useCallback(async () => {
    if (!activeDb || !code || !chosen.length) return
    setDoing('Typesetting the PDF')
    setBusy(true)
    setError(null)
    setDelivered(null)
    try {
      const body = shortBody()
      const snapshot = await api<SourcesSnapshot>('POST', '/api/v1/report/short/sources', body)
      const { figures, references } = await figuresFromSnapshot(snapshot, indLabels)
      const r = await api<{ filename: string; base64: string }>('POST', '/api/v1/report/short/pdf', {
        ...body,
        figures,
        method_references: references,
        render_token: snapshot.render_token
      })
      const bytes = bytesFromBase64(r.base64)
      deliverBytes(bytes, r.filename, 'application/pdf')
      setDelivered({ filename: r.filename, kb: Math.round(bytes.length / 1024), state: 'handoff' })
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
      setDoing(null)
    }
  }, [activeDb, code, chosen, shortBody, indLabels])

  /** Create a stored report from what is currently selected, so it can be edited and re-rendered. */
  const createStored = useCallback(async () => {
    if (!activeDb) return
    setDoing('Creating the report')
    setBusy(true)
    setError(null)
    try {
      // Deliberately not the short tab's selection: the two tabs share no control, so a new report
      // starts from the model itself and is adjusted in the card below, which is what those controls
      // are for. Which process, though, is not a free choice: `acts[0]` is whatever the database
      // happens to return first, and a report that titles itself "End-of-life — corrugated board
      // report" and reports on that sub-process is wrong before the user has touched anything. The
      // reference process is derived from the graph — the process no other foreground process consumes.
      let subject = acts[0]
      try {
        const r = await api<{ candidates: { code: string; name: string }[] }>(
          'GET',
          `/api/v1/model/reference/${encodeURIComponent(activeDb)}`
        )
        if (r.candidates?.length) subject = r.candidates[0]
      } catch {
        /* fall back to the first activity rather than refuse to create a report */
      }
      // Pre-filled from what the study and the Results page already know (V407) — once, here. The report
      // owns its scope from now on; nothing re-synchronises it later. Every read falls back to today's
      // defaults: a study record or a view that cannot be read must not stop a report being created.
      let study: Parameters<typeof initialReportLang>[0] = null
      try {
        study = await fetchQuery(studyRoute(activeDb))
      } catch {
        /* English, as before */
      }
      let results: ResultsViewState | null = null
      try {
        results = ((await viewFetch(activeDb)).results ?? null) as ResultsViewState | null
      } catch {
        results = (viewSync(activeDb).results ?? null) as ResultsViewState | null
      }
      let scenarioList = scenarios
      try {
        const r = await fetchQuery(scenariosRoute(activeDb))
        if (Array.isArray(r)) scenarioList = r
      } catch {
        /* the list the Scope card last loaded */
      }
      let tagGroups: TagGroup[] = []
      try {
        tagGroups = (await fetchQuery('/api/v1/model/tag-groups')).groups ?? []
      } catch {
        /* no families known: the split resolves to ISIC, which the report does not carry over */
      }
      const pre = reportPrefill({
        database: activeDb,
        subject,
        results,
        // The Results page's chart settings: stacked on/off is app-wide (usePersisted there), the split is
        // the model's, resolved the way that page resolves it.
        stacked: readLs('prism.ov.stacked', false),
        stackBy: resolveSplit(results?.stackBy, tagGroups, activeDb),
        scenarios: scenarioList,
        known: methods.map((m) => m.method),
        fallbackMethods: defaultReportMethods(methods),
        lang: initialReportLang(study)
      })
      const rep = await api<StoredReport>('POST', '/api/v1/report/create', {
        database: activeDb,
        name: pre.name,
        lang: pre.lang,
        amount: 1,
        subjects: pre.subjects,
        methods: pre.methods,
        ...(pre.aggregate_by ? { aggregate_by: pre.aggregate_by } : {})
      })
      await loadStored()
      setStoredId(rep.id)
      setPrefillNote(pre.note ? { id: rep.id, text: pre.note } : null)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
      setDoing(null)
    }
  }, [activeDb, acts, methods, scenarios, loadStored, setStoredId])

  /**
   * Step one of every stored render: ask for the sources, which come back with the data snapshot the
   * render used, and draw the figures from exactly those numbers.
   *
   * Two steps on purpose, and shared between the PDF and the preview: drawing in the backend would mean
   * a second charting stack whose output differs from the on-screen charts, and drawing twice here would
   * mean the preview could show a different chart than the document.
   */
  const figuresFor = useCallback(
    async (
      url: string
    ): Promise<{ figures: Record<string, string>; references: MethodReference[]; token?: string }> => {
      // Deliberately nothing about the contribution dimension: a stored report owns that setting, and
      // passing the left card's dropdown along let a control in another card change what a saved report
      // rendered — its preview could show a different breakdown than its PDF.
      const snapshot = await api<SourcesSnapshot>('POST', `${url}/sources`, {})
      const { figures, references } = await figuresFromSnapshot(snapshot, indLabels)
      return { figures, references, token: snapshot.render_token }
    },
    // Nothing from the left card any more: the figures are drawn from what the stored report itself
    // renders, which is why this no longer changes when that dropdown does. The indicator names are
    // not a card setting — they come from the method catalogue, the same one the document is named from.
    [indLabels]
  )

  /** Typeset the stored definition — its sections, in their order, in its language. */
  const renderStored = useCallback(
    async (allowGaps = false, allowReview = false) => {
      if (!activeDb || !storedId) return
      // The review gate, before anything is computed: a document going to a client with chapters
      // nobody has vouched for is a decision, not a surprise.
      if (!allowReview && reviewPending > 0) {
        setGapExport({ kind: 'pdf', reason: 'review', allowReview: false })
        setError(reviewRefusal(reviewPending))
        return
      }
      // Behind the chapter panel's mutation queue: a blur-save or reorder still in flight would
      // otherwise be typeset from a document that no longer matches.
      await settleRef.current()
      setDoing('Typesetting the PDF')
      setBusy(true)
      setError(null)
      setGaps([])
      setUnexplained([])
      // …and the file the *last* render handed over. Without this the page showed "8 placeholder(s)
      // would print as gaps … Export anyway" and, directly underneath, "Saved … report.pdf (438 kB)"
      // — an announced delivery for a render it had just refused (V157).
      setDelivered(null)
      try {
        const url = `/api/v1/report/one/${encodeURIComponent(activeDb)}/${encodeURIComponent(storedId)}`
        const { figures, references, token } = await figuresFor(url)

        const r = await api<{ filename: string; base64: string; missing_placeholders: string[] }>(
          'POST',
          `${url}/pdf`,
          {
            figures,
            method_references: references,
            render_token: token,
            allow_gaps: allowGaps,
            // Past either gate it is a draft, and every page says so.
            draft: allowGaps || reviewPending > 0
          }
        )
        setGapExport(null)
        if (paneRef.current.storedId === storedId) setGaps(r.missing_placeholders || [])
        const bytes = bytesFromBase64(r.base64)
        deliverBytes(bytes, r.filename, 'application/pdf')
        // Say what went out. The pane shows the *preview*, so after a successful render it kept
        // claiming "Nothing typeset yet" — technically about a different thing, and as an answer to
        // the button just pressed simply wrong (V153).
        setDelivered({ filename: r.filename, kb: Math.round(bytes.length / 1024), state: 'handoff' })
      } catch (e) {
        // The export gate: gaps in a deliverable refuse by default; exporting anyway is a visible choice.
        if (e instanceof ApiError && e.code === 'report_has_gaps')
          setGapExport({ kind: 'pdf', reason: 'gaps', allowReview })
        setError(errMsg(e))
      } finally {
        setBusy(false)
        setDoing(null)
      }
    },
    [activeDb, storedId, figuresFor, reviewPending]
  )

  /**
   * The typeset page in the preview pane. This is what makes reordering chapters honest: page breaks,
   * table widths and caption numbering only exist after typesetting, so an HTML lookalike is wrong
   * exactly where it matters.
   */
  const previewStored = useCallback(
    async (page = 1, reuse = false) => {
      if (!activeDb || !storedId) return
      // Behind the chapter panel's mutation queue, like the PDF — same reasoning, same remnant.
      await settleRef.current()
      // A page turn is a lookup now, so only a fresh render is worth announcing.
      setDoing(reuse ? null : 'Computing and typesetting')
      setBusy(true)
      setError(null)
      try {
        const url = `/api/v1/report/one/${encodeURIComponent(activeDb)}/${encodeURIComponent(storedId)}`
        // Turning a page reuses the document the backend already typeset, so the charts do not have to be
        // redrawn and nothing is recomputed: a page turn used to cost two full runs of the study (every
        // subject's LCA, the contribution tree, the linter) — measured at 14 s on a three-variant report.
        // Pressing Preview always renders fresh, which keeps "are these the current numbers" a decision
        // rather than a timeout.
        const { figures, references, token } = reuse
          ? { figures: {}, references: [] as MethodReference[], token: undefined }
          : await figuresFor(url)
        const r = await api<{
          page: number
          pages: number
          base64: string
          missing_placeholders: string[]
          unexplained_abbreviations?: string[]
        }>('POST', `${url}/preview`, {
          figures,
          method_references: references,
          page,
          reuse,
          render_token: token
        })
        if (paneRef.current.storedId !== storedId) return // the author switched reports mid-render
        if (paneRef.current.tab !== 'full') return // …or moved to the short reports
        setGaps(r.missing_placeholders || [])
        setUnexplained(r.unexplained_abbreviations || [])
        // The stamp this preview was typeset against. A page turn (`reuse`) shows the SAME typeset
        // document, so it keeps the original stamp — turning pages must not clear a stale banner.
        const reportUpdated = storedRef.current.find((s) => s.id === storedId)?.updated ?? null
        setPreview((prev) => ({
          page: r.page,
          pages: r.pages,
          src: `data:image/png;base64,${r.base64}`,
          reportUpdated: reuse && prev ? prev.reportUpdated : reportUpdated
        }))
        setPageInput(String(r.page))
      } catch (e) {
        setError(errMsg(e))
      } finally {
        setBusy(false)
        setDoing(null)
      }
    },
    [activeDb, storedId, figuresFor]
  )

  /** Download something the backend hands back as base64. */
  const saveBase64 = (filename: string, b64: string, mime: string): void => deliverBase64(b64, filename, mime)

  /**
   * Export the report as a Typst project. This is the reason Typst was chosen over printing a PDF:
   * a PDF is an endpoint, these files are a working state. `main.typ` becomes yours — one file, all
   * chapters in it — while `values.json`, `data.json` and `charts/` stay ours to regenerate, so edited
   * prose can still pick up new numbers. It is a split of ownership, not of files.
   */
  const exportBundle = useCallback(
    async (allowGaps = false, allowReview = false) => {
      if (!activeDb || !storedId) return
      // Same review gate as the PDF: the bundle is a deliverable too.
      if (!allowReview && reviewPending > 0) {
        setGapExport({ kind: 'bundle', reason: 'review', allowReview: false })
        setError(reviewRefusal(reviewPending))
        return
      }
      setDoing('Packing the sources')
      setBusy(true)
      setError(null)
      try {
        const url = `/api/v1/report/one/${encodeURIComponent(activeDb)}/${encodeURIComponent(storedId)}`
        // The same two things only the renderer can supply. Without them the exported project had a
        // `charts/` directory with nothing in it and a bibliography that named methods without citing
        // them — precisely the two things the export promises to hand over intact.
        const { figures, references, token } = await figuresFor(url)
        const r = await api<{ filename: string; base64: string }>('POST', `${url}/bundle`, {
          figures,
          method_references: references,
          render_token: token,
          allow_gaps: allowGaps,
          draft: allowGaps || reviewPending > 0
        })
        setGapExport(null)
        saveBase64(r.filename, r.base64, 'application/zip')
      } catch (e) {
        if (e instanceof ApiError && e.code === 'report_has_gaps')
          setGapExport({ kind: 'bundle', reason: 'gaps', allowReview })
        setError(errMsg(e))
      } finally {
        setBusy(false)
        setDoing(null)
      }
    },
    [activeDb, storedId, figuresFor, reviewPending]
  )

  /**
   * The other half of the export, and until now the missing one: today's numbers without the prose.
   *
   * The hand-over note in the ZIP describes exactly this route — drop `values.json`, `data.json` and
   * `charts/` in beside your edited `main.typ`, recompile, and text you have already reviewed states
   * the new figures. The endpoint existed; the button did not, so the only way to walk that route was
   * the HTTP API (found in run 13, when the note was checked against the archive it ships with).
   *
   * No gap gate: this archive prints nothing, and a recipient whose sentence quotes a key that has
   * since gone needs the hand-out in order to see it. A gap is reported instead of refused.
   */
  const exportData = useCallback(async () => {
    if (!activeDb || !storedId) return
    setDoing('Packing the data')
    setBusy(true)
    setError(null)
    setDataNote(null)
    try {
      const url = `/api/v1/report/one/${encodeURIComponent(activeDb)}/${encodeURIComponent(storedId)}`
      const { figures, references, token } = await figuresFor(url)
      const r = await api<{ filename: string; base64: string; missing_placeholders: string[] }>(
        'POST',
        `${url}/data/archive`,
        { figures, method_references: references, render_token: token }
      )
      saveBase64(r.filename, r.base64, 'application/zip')
      const gaps = r.missing_placeholders?.length ?? 0
      setDataNote(
        gaps
          ? `Data written, with ${gaps} figure${gaps === 1 ? '' : 's'} the report can no longer resolve — a sentence citing one of those will compile as [missing: …] until it is corrected here.`
          : null
      )
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
      setDoing(null)
    }
  }, [activeDb, storedId, figuresFor])

  /** A page turn of whichever document the pane shows — the typeset one is reused, nothing recomputed. */
  const turnPage = (page: number): Promise<void> =>
    tab === 'short' ? previewShort(page, true) : previewStored(page, true)

  if (!activeDb) {
    return (
      <div className="view report-view">
        <div className="view-head">
          <h2>Report</h2>
        </div>
        <p className="empty">Open a model first — the report is built from its study metadata and results.</p>
      </div>
    )
  }

  /** The rail's own head: the page's name and the two kinds of report, where the models panel has
   *  "MODELS" and its search. Built once — inside a tab branch TypeScript knows which tab it is, and
   *  the switch has to offer both. */
  const railHead = (
    <>
      <div className="panel-h eyebrow">Report</div>
      {/* Tabs with a rule under the active one — the same idiom as the Results tabs, and the right one
          here: these switch what the whole page is, they are not two settings of one control. */}
      <div className="rtabs rail-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'full'}
          className={`rtab${tab === 'full' ? ' on' : ''}`}
          onClick={() => showTab('full')}
        >
          Full reports (AI)
        </button>
        <button
          role="tab"
          aria-selected={tab === 'short'}
          className={`rtab${tab === 'short' ? ' on' : ''}`}
          onClick={() => showTab('short')}
        >
          Short reports (w/o AI)
        </button>
      </div>
    </>
  )

  /**
   * What you DO with the whole document, pinned to the foot of the rail.
   *
   * At the bottom because that is where a panel's verbs go, and because it is the one place that stays put
   * while the accordion above it opens and closes. Not over the preview: the preview is the *result*, and
   * a bar across it costs the document a strip of the only column that shows it.
   */
  /**
   * The failure and its way out, shared by both rails. This lived only on the short side, so a full
   * report whose typeset failed (a Typst error, a gap refusal) showed *nothing*: busy ended, no PDF
   * appeared, and the author was left staring at "Nothing typeset yet" (a
   * compile error was once invisible through four render attempts).
   */
  const dataNotice = dataNote ? <p className="settings-hint">{dataNote}</p> : null

  const errorNotice = error ? (
    <p className="chat-error">
      {error}
      {gapExport ? (
        <>
          {' '}
          <button
            className="btn sm"
            onClick={() => {
              const ask = gapExport
              setGapExport(null)
              setError(null)
              // Answering the review ask does not answer the gaps ask: the backend may still refuse
              // over gaps, and that gets its own button press with the review answer carried along.
              const gaps = ask.reason === 'gaps'
              const review = gaps ? ask.allowReview : true
              void (ask.kind === 'pdf' ? renderStored(gaps, review) : exportBundle(gaps, review))
            }}
          >
            Export anyway
          </button>
        </>
      ) : null}
    </p>
  ) : null

  const documentActions = (
    <div className="report-actbar">
      {dataNotice}
      {/* No status line here. It said the same thing as the overlay over the preview — `.report-working`,
          named rather than a bare spinner, centred where the result is about to appear — and saying it twice
          cost the one thing this bar must not do: with the three buttons right-aligned in a 348px rail, a
          180px "Typesetting the PDF…" pushed them onto a second line and back the moment it finished, so the
          button under the cursor moved while it was being clicked. The buttons are disabled while the
          work runs, which is this bar's own way of saying it. */}
      {/* Its own row. The three buttons on the right are a 348px rail's worth already, and a fourth one
          beside them pushed them onto a second line and back again while a click was in flight. */}
      <div className="report-actbar-aside">
        <button
          className="btn sm"
          disabled={busy || !storedId}
          title="Today's numbers and charts as a ZIP, without the prose — to refresh an export you have edited"
          onClick={() => void exportData()}
        >
          Update data only
        </button>
      </div>
      <div className="report-actbar-acts">
        <button
          className="btn sm"
          disabled={busy || !storedId}
          title="Typst sources, theme, data and charts as a ZIP — to carry on outside PrismLCA"
          onClick={() => void exportBundle()}
        >
          Export sources
        </button>
        <button
          className="btn sm"
          disabled={busy || checkingChapters || !storedId}
          title={
            checkingChapters
              ? 'Checking what changed under the written chapters — the bar at the foot of the chapter list shows how far it is.'
              : 'Typeset the report and show it page by page — the same renderer the PDF uses'
          }
          onClick={() => void previewStored(1)}
        >
          Preview
        </button>
        <button
          className="btn sm primary"
          disabled={busy || checkingChapters || !storedId}
          title={
            checkingChapters
              ? 'Checking what changed under the written chapters — the bar at the foot of the chapter list shows how far it is.'
              : undefined
          }
          onClick={() => void renderStored()}
        >
          Render PDF
        </button>
      </div>
    </div>
  )

  return (
    <div className="view report-view">
      <div className="report-grid two">
        {tab === 'short' ? (
          <aside className="report-setup report-stored">
            {railHead}
            <ShortReportRail
              code={code}
              setCode={setCode}
              acts={acts}
              scenarios={scenarios}
              families={dims}
              methods={methods}
              picked={picked}
              onPicked={setPicked}
              settings={shortSettings}
              update={updateShort}
              head={shortHead}
              onHead={setShortHead}
              templates={templates}
              onTemplatesChanged={loadTemplates}
              busy={busy}
              onGenerate={() => void previewShort(1, false)}
              onSavePdf={() => void savePdfShort()}
              notices={errorNotice}
            />
          </aside>
        ) : null}

        {/* Hidden, not unmounted, while the short tab shows: the chapter writer's state lives in this
            rail, and a switch to "Short reports" during a run forgot the run — its Cancel and progress
            were gone on return and a second paid write could be started for the same chapter.
            The same reason the Workbench keeps this whole page mounted (V150). */}
        <aside
          className="report-setup report-stored"
          style={tab === 'full' ? undefined : { display: 'none' }}
        >
          {railHead}
          {/* Same as the short side: the tab is the heading, and one line is enough — everything the earlier
              paragraph listed is visible in the groups below it. */}
          <p className="settings-hint">Pick a report to work on, or create one.</p>
          <ReportPicker
            database={activeDb ?? ''}
            reports={stored}
            selected={storedId}
            onSelect={setStoredId}
            onCreate={() => void createStored()}
            canCreate={acts.length > 0}
            busy={busy}
            writing={writingChapters}
            onDeleted={() => void loadStored()}
          />
          {prefillNote && prefillNote.id === storedId ? (
            <p className="settings-hint" role="status">
              {prefillNote.text}
            </p>
          ) : null}
          {storedId ? (
            <ReportSections
              database={activeDb}
              reportId={storedId}
              activities={acts}
              scenarios={scenarios}
              dimensions={dimGroups}
              onScopeOpen={loadScope}
              methods={methods}
              active={active && tab === 'full'}
              onChecking={setCheckingChapters}
              onWriting={setWritingChapters}
              onReviewPending={setReviewPending}
              registerSettle={registerSettle}
              onChanged={() => void loadStored()}
              // Handed in rather than rendered after the component: the chapter foot and this bar
              // stand together in a dock pinned to the rail's bottom edge, and the notices between
              // them stay visible with the buttons they explain.
              actions={
                <>
                  {gaps.length ? (
                    <p className="chat-error">
                      Unresolved placeholders: {gaps.join(', ')} — they appear as “[missing: …]” in the PDF.
                    </p>
                  ) : null}
                  {unexplained.length ? (
                    <p className="settings-hint">
                      Used but not explained: {unexplained.slice(0, 12).join(', ')}
                      {unexplained.length > 12 ? ` and ${unexplained.length - 12} more` : ''} — press{' '}
                      <b>Resolve</b> on the Abbreviations chapter. An entry whose term no longer appears is
                      left out of the document by itself.
                    </p>
                  ) : null}
                  {errorNotice}
                  {documentActions}
                </>
              }
            />
          ) : (
            <>
              {errorNotice}
              {documentActions}
            </>
          )}
        </aside>

        <div className="report-main">
          <div className="report-preview">
            {doing ? (
              <div className="report-working" role="status">
                <span className="spinner" />
                <span>{doing}…</span>
              </div>
            ) : null}
            {preview ? (
              <div className="report-page">
                {/* Typeset before the report last changed (a rewrite, a chapter edit): the pages on
                    screen are of a document that no longer exists, and letting them pass as current
                    is how someone reads yesterday's numbers off today's report. */}
                {preview.reportUpdated &&
                stored.find((s) => s.id === storedId)?.updated &&
                stored.find((s) => s.id === storedId)?.updated !== preview.reportUpdated ? (
                  <div className="report-stale-note" role="status">
                    This preview is out of date — the report has changed since it was typeset. Press{' '}
                    <b>Preview</b> to refresh.
                  </div>
                ) : null}
                <div className={`report-scroll${zoom === null ? ' fit' : ''}`}>
                  <img
                    ref={pageRef}
                    src={preview.src}
                    alt={`Page ${preview.page} of ${preview.pages}`}
                    style={zoom === null ? undefined : { width: `${zoom}px` }}
                  />
                </div>
                {/* Same control as the canvas: zoom in, zoom out, fit one page. */}
                <div className="report-zoom">
                  <button title="Zoom in" aria-label="Zoom in" onClick={() => stepZoom(1.25)}>
                    <PlusIcon />
                  </button>
                  <button title="Zoom out" aria-label="Zoom out" onClick={() => stepZoom(0.8)}>
                    <MinusIcon />
                  </button>
                  <button title="Fit one page" aria-label="Fit one page" onClick={() => setZoom(null)}>
                    <MaximizeIcon />
                  </button>
                </div>
                <div className="report-pager">
                  <button
                    className="btn sm"
                    disabled={busy || preview.page <= 1}
                    onClick={() => void turnPage(preview.page - 1)}
                  >
                    ‹
                  </button>
                  {/* The page number is an input, not a label: paging one arrow at a time through a
                    seventeen-page document to reach chapter six is not navigation. */}
                  <span className="report-pageno">
                    Page
                    <input
                      type="number"
                      min={1}
                      max={preview.pages}
                      value={pageInput}
                      aria-label="Page number"
                      onChange={(e) => setPageInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                      onBlur={() => {
                        const n = Math.max(1, Math.min(preview.pages, Number(pageInput) || preview.page))
                        setPageInput(String(n))
                        // Same gate as the arrows: a page turn racing a running render would let
                        // whichever response lands last win the pane.
                        if (n !== preview.page && !busy) void turnPage(n)
                      }}
                    />
                    of {preview.pages}
                  </span>
                  <button
                    className="btn sm"
                    disabled={busy || preview.page >= preview.pages}
                    onClick={() => void turnPage(preview.page + 1)}
                  >
                    ›
                  </button>
                </div>
              </div>
            ) : doing ? null : delivered ? ( // a render just handed a file over: saying "nothing
              // typeset yet" underneath it is the one answer that cannot be right.
              <p className="empty">
                {delivered.state === 'completed' ? (
                  <>
                    Saved <b>{delivered.path || delivered.filename}</b> ({delivered.kb} kB).
                  </>
                ) : delivered.state === 'handoff' ? (
                  <>
                    <b>{delivered.filename}</b> ({delivered.kb} kB) handed to your browser&apos;s downloads.
                  </>
                ) : (
                  <>
                    <b>{delivered.filename}</b> was not saved — the download was{' '}
                    {delivered.state === 'cancelled' ? 'cancelled' : 'interrupted'}.
                  </>
                )}{' '}
                Press <b>{tab === 'short' ? 'Generate' : 'Preview'}</b> to page through it here.
              </p>
            ) : (
              // the working pill floats mid-pane; "Nothing typeset yet" showing around it while
              // minutes of computing run read as "pressing Preview did nothing"
              // — while something is doing, the empty claim is simply false.
              <p className="empty">
                {tab === 'short'
                  ? 'Nothing typeset yet — pick what the report should carry, then press Generate.'
                  : 'Nothing typeset yet — write the chapters, then press Preview (or Render PDF).'}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
