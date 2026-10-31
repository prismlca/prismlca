import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { fetchQuery, useQuery } from '../lib/server/useQuery'
import { studyRoute } from '../lib/server/routes'
import ConfirmDialog, { type ConfirmSpec } from './ConfirmDialog'
import { CoverOverlay } from './CoverSettings'
import { AccordionGroup, useSingleOpen } from '../components/Accordion'
import IndicatorPicker, { methodKey, type PickerMethod } from '../components/IndicatorPicker'
import { indicatorLabels } from '../lib/methods'
import { errMsg } from '../lib/errors'
import Busy, { BusyClock } from '../components/Busy'
import { SparkleIcon } from '../components/icons'
import WriteAllPlanDialog from './report/WriteAllPlanDialog'
import QuestionsPanel from './report/QuestionsPanel'
import ReadDiffDialog from './report/ReadDiffDialog'
import ChapterEditorSheet from './report/ChapterEditorSheet'
import ChapterList from './report/ChapterList'
import AddChapterControl from './report/AddChapterControl'
import { HeatmapPreview, RadarPreview } from './report/FigurePreview'
import ReportHeadGroup from './report/ReportHeadGroup'
import ReportAppearanceGroup from './report/ReportAppearanceGroup'
import ReportDefaultsGroup from './report/ReportDefaultsGroup'
import useChapterWriter from './report/useChapterWriter'
import { useReviewPoints } from './report/useReviewPoints'
import {
  chapterLabel,
  REPORTABLE_SCOPE,
  unrecordedScope,
  WRITABLE,
  type ReportSection,
  type ResolvedPart,
  type StoredReportFull
} from '../lib/report/model'
import { defaultTicks, languagePlan, runSize } from '../lib/report/plan'
import { chapterState, openQuestions, stateCounts, stateSummary } from '../lib/report/chapterStatus'
import { plainReason } from '../lib/report/findingText'
import {
  checkProgressText,
  failureText,
  reviewPendingCount,
  stalenessNotice,
  type CheckProgress,
  type StaleChapter
} from '../lib/report/staleness'
import { stageBrief, writeConfirmSpec, writeStatus } from '../lib/report/writeStatus'
import { reportBase } from '../lib/report/writeAllRuns'
import { NumberInput, shownNumber } from '../components/NumberInput'

// The helpers this view grew live in lib/report/*.
// Re-exported wholesale: eleven test files and the sibling views import them from here, and this
// path staying valid keeps them working.
export * from '../lib/report/model'
export * from '../lib/report/plan'
export * from '../lib/report/staleness'
export * from '../lib/report/writeStatus'

/**
 * Chapter management for a stored report: reorder by dragging, rename, add, delete, lock, and write
 * the prose.
 *
 * Anatomy after the wave-3.1 split: the pure helpers live in lib/report/*, the dialogs and the
 * chapter list in views/report/*, the model-facing orchestration in useChapterWriter. What stays
 * here on purpose: the Scope & indicators group (a form over this panel's own mutate closures),
 * the Chapters shell, and the dock — the dock is this panel's voice (every note, notice and run
 * status lands there), and moving the voice away from the state it reports earns nothing.
 *
 * Two things worth knowing while using it. Reordering is safe — chapter numbers and cross-references
 * are placeholders resolved when the report is typeset, so a "see Table 1" follows the move by itself.
 * And locking is what protects reviewed text: a locked chapter refuses content changes, including
 * from a regeneration, until it is unlocked.
 */
export default function ReportSections({
  database,
  reportId,
  activities,
  scenarios,
  dimensions,
  methods,
  active = true,
  onChanged,
  onChecking,
  onReviewPending,
  onWriting,
  onScopeOpen,
  registerSettle,
  actions
}: {
  database: string
  reportId: string
  /** The model's foreground processes — what a report can be about. */
  activities: { code: string; name: string }[]
  /** Named parameter sets; each one ticked becomes a variant the report compares. */
  scenarios: { id: string; name: string }[]
  /** Tag families that exist, each with the databases some activity of it is actually tagged in. */
  dimensions: { name: string; databases?: string[] }[]
  methods: PickerMethod[]
  /** False while the page is hidden. See the effect on it: the page no longer unmounts, so the
   *  false→true edge is what re-asks whether the model moved under the written chapters. */
  active?: boolean
  onChanged?: () => void
  /** Raised while the staleness re-check is in flight, so the page can hold Preview and Render PDF
   *  back: typesetting against badges that are still the previous answer is how a document goes out
   *  with moved figures under unmoved wording (V151). */
  onChecking?: (busy: boolean) => void
  /** How many model-written chapters still await the author's release — the export asks about them. */
  onReviewPending?: (count: number) => void
  /** Raised while chapters are being written or corrected — the report must not be deleted under it. */
  onWriting?: (busy: boolean) => void
  /** Raised when the Scope card is opened: `scenarios` and `dimensions` are made on other pages, so
   *  the page refetches them at the moment they are about to be read (V238). */
  onScopeOpen?: () => void
  /** Hands the parent a way to WAIT for this panel's mutation queue (see `mutate`): a Preview or a
   *  PDF started while a blur-save or a reorder is still in flight would typeset the report from
   *  before that change — the document then shows a state the author has already left.
   *  Called once with a stable function. */
  registerSettle?: (settle: () => Promise<void>) => void
  /** The document-level bar (Export sources, Preview, Render PDF) from the parent — rendered inside
   *  this component's pinned dock so the chapter foot and the document verbs stand together at the
   *  rail's bottom edge instead of the foot scrolling away with the accordion. */
  actions?: ReactNode
}): JSX.Element {
  const [report, setReport] = useState<StoredReportFull | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [templates, setTemplates] = useState<
    { name: string; label?: string; builtin?: boolean; cover_image?: boolean; client_logo?: boolean }[]
  >([])
  /** The picture shipped with the app, for the thumbnail: a report that uses it stores only the word. */
  const [placeholder, setPlaceholder] = useState<string | null>(null)
  /**
   * Cover-image errors are shown at the control, not in the card's general error line at the very
   * bottom: "The cover image could not be read" a screen away from the Upload button you just pressed
   * reads as a problem with something else entirely.
   */
  const [coverOpen, setCoverOpen] = useState(false)
  const [stale, setStale] = useState<Record<string, StaleChapter>>({})
  /**
   * Why the last staleness check did not answer, in the backend's words — null when it did.
   *
   * Kept beside `stale` rather than folded into it, because the empty map is a legitimate answer
   * ("nothing is out of date") and this is the absence of one. `stale` alone cannot hold both, which
   * is the whole of V200: the catch set `{}` and the foot read it as green. See `stalenessNotice`.
   */
  const [staleFailure, setStaleFailure] = useState<string | null>(null)
  /** Reportable §5.2 fields this study leaves empty — named before a chapter is written from them. */
  const [missingScope, setMissingScope] = useState<typeof REPORTABLE_SCOPE>([])
  //: The language the study is documented in (Model info, default 'en') — a report whose own
  //: language differs translates the study texts before writing, and says so. `null` means the study
  //: record could not be read at all, which is not the same as English (V201); see `languagePlan`.
  const [studyLang, setStudyLang] = useState<string | null>('en')
  /** True when `studyLang` is the app's reading of the prose rather than the author's declaration. */
  const [studyLangGuessed, setStudyLangGuessed] = useState(false)
  /** A yes/no the panel is waiting on — currently only "may this chapter's text be replaced?". */
  const [confirming, setConfirming] = useState<ConfirmSpec | null>(null)
  /**
   * Per chapter: its text with the placeholders worked out, while the author has asked to see it —
   * or why it could not be. The reason is kept here rather than in the card's error line, which the
   * chapter dialog covers: pressing the button on a report that cannot be computed yet did exactly
   * nothing, visibly.
   */
  const [resolved, setResolved] = useState<Record<string, { parts?: ResolvedPart[]; error?: string }>>({})
  /**
   * The arithmetic re-check is in flight, so what the badges say is the *previous* answer.
   *
   * It takes 24–31 s on an ecoinvent model with variants, and during it the page showed "Every chapter
   * written" with no badge and an eager "Render PDF" — so a render started in that window produced a
   * document whose figures had moved while its wording still claimed the old ranking (V151). The
   * "Write all" dialog already handles this honestly ("the check is still running"); the page did not.
   *
   * Deliberately NOT raised for a check that *failed* (`staleFailure`), which is the same blindness made
   * permanent. Two reasons. A render sealed off for good over a failure in an advisory side-check takes
   * the deliverable away for something that may not be about the deliverable at all — an older backend
   * without the endpoint fails this check and renders perfectly. And where the failure *is* about the
   * model, the render's own gate refuses it with the same sentence from the same backend: pressing
   * Render is how the author learns the truth first-hand, and replacing that with a disabled button and
   * our vaguer note would be a downgrade. So the failure is said, loudly and permanently, and the button
   * is left alone.
   */
  const [checking, setChecking] = useState(false)
  /** The study behind a running check, as the backend counts it — null until it has said anything. */
  const [checkProgress, setCheckProgress] = useState<CheckProgress | null>(null)
  /** A chapter whose wording moved since it was released, opened to see exactly how. */
  //: `kind` says which question the diff answers: what moved since the author marked the chapter
  //: read, or what its last change did to it. Same rendering, different offer underneath.
  const [readDiff, setReadDiff] = useState<{
    section: ReportSection
    before: string
    kind?: 'reviewed' | 'previous'
  } | null>(null)
  /**
   * Which single group is open. Chapters to begin with — it is the one you come to the page for — except
   * while no indicator is picked, when Covers is what needs attention first (see `load`).
   */
  const [grp, setOpenGrp] = useSingleOpen('prism.rep.grp', 'chapters')
  /** The Scope card, with its opening turned into a refetch of the two lists it offers (V238). */
  const scopeCard = grp('covers')
  const scopeGrp = {
    ...scopeCard,
    onToggle: () => {
      if (!scopeCard.open) onScopeOpen?.()
      scopeCard.onToggle()
    }
  }

  // The Covers group's own open state lives in `Group` now, persisted per model: same rule as before —
  // it starts open while nothing is picked and the user's toggle wins from then on — but the panel can
  // no longer slam shut when the first indicator is ticked, because `defaultOpen` is only an initial
  // value and never a controlled one.
  const [prompts, setPrompts] = useState<Record<string, string>>({})
  /** Whether that map is an answer or a failure. See `loadPrompts`. */
  const [promptsRead, setPromptsRead] = useState(true)
  /** The freshest loaded report, for payloads computed at execution time (see `mutate`). */
  const reportRef = useRef<StoredReportFull | null>(null)
  /** Mutations run strictly one after another — see `mutate`. */
  const mutateQueue = useRef<Promise<unknown>>(Promise.resolve())

  // The parent's Preview/Render wait on this queue rather than racing it — registered once; the
  // function reads the ref at CALL time, so it always waits on the queue as it is then.
  useEffect(() => {
    registerSettle?.(() => mutateQueue.current.then(() => undefined))
  }, [registerSettle])

  const base = reportBase(database, reportId)
  /** The chapter the overlay is editing, resolved from the list so it cannot drift out of step. */
  const open = report?.sections.find((s) => s.id === openId) ?? null
  /** The process every variant of this report is about (they only differ by scenario). */
  const baseCode = report?.subjects?.[0]?.code ?? ''
  const scenarioIds = (report?.subjects ?? []).map((s) => s.scenario).filter((x): x is string => Boolean(x))
  /** What each indicator is called, judged against the whole catalogue rather than this report's own
   *  selection — the picker, the chapter sub-headings and the document all read it (V203). */
  const indicatorNames = useMemo(() => indicatorLabels(methods), [methods])

  /**
   * Rewrite the variant list: the baseline plus one entry per ticked scenario.
   *
   * Labels are set here rather than left to the backend so the document names what the reader picked —
   * and the baseline keeps the neutral name, because "Baseline · Baseline" is what happened when both
   * sides tried to add one. The scenario list is read from the freshest report at execution time
   * (`change` is a toggle, not a full list), so two quick ticks apply cumulatively instead of the
   * second one overwriting the first from stale state.
   */
  const setSubjects = async (code: string, change?: { scenario: string; on: boolean }): Promise<void> => {
    if (!code) return
    await mutate('POST', base, (current) => {
      let ids = (current?.subjects ?? []).map((s) => s.scenario).filter((x): x is string => Boolean(x))
      if (change) {
        ids = change.on
          ? ids.includes(change.scenario)
            ? ids
            : [...ids, change.scenario]
          : ids.filter((x) => x !== change.scenario)
      }
      const subjects = [
        { database, code, label: 'Baseline' },
        ...ids
          .map((id) => scenarios.find((sc) => sc.id === id))
          .filter((sc): sc is { id: string; name: string } => Boolean(sc))
          .map((sc) => ({ database, code, scenario: sc.id, scenario_name: sc.name, label: sc.name }))
      ]
      return { subjects }
    })
  }

  const patchOpen = (patch: Partial<ReportSection>): void =>
    setReport((r) =>
      r && openId ? { ...r, sections: r.sections.map((x) => (x.id === openId ? { ...x, ...patch } : x)) } : r
    )

  /** The report on screen — a load that started for another one must not land here. */
  const baseRef = useRef(base)
  baseRef.current = base
  const load = useCallback(async () => {
    try {
      const fresh = await api<StoredReportFull>('GET', base)
      if (baseRef.current !== base) return
      reportRef.current = fresh
      setReport(fresh)
      // A report with no indicator cannot render at all, so that is the group to be looking at — the same
      // rule the old collapsible had. Only on the way in: once anything is picked, the choice is yours.
      if (!(fresh.methods?.length ?? 0)) setOpenGrp((g) => (g === 'chapters' ? 'covers' : g))
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }, [base, setOpenGrp])

  const loadTemplates = useCallback(async () => {
    try {
      const r = await api<{
        templates: {
          name: string
          label?: string
          builtin?: boolean
          cover_image?: boolean
          client_logo?: boolean
        }[]
      }>('GET', '/api/v1/report/templates')
      setTemplates(r.templates)
    } catch {
      setTemplates([])
    }
  }, [])

  /**
   * What changed under each written chapter, and what it costs to put right. Deliberately arithmetic
   * rather than a question to a model: it costs nothing, cannot be wrong, and only *reports* — the
   * text is never touched.
   *
   * Three remedies, because the cheap cases are the common ones. `none` means the numbers moved and
   * the placeholders already resolve them, so the prose is still true; `review` means a figure left
   * its size class or a ranking swapped, so a word like "dominates" wants reading; `rewrite` means
   * the text asserts something that is no longer so — a method family it names, or a value it points
   * at that has gone.
   */
  const loadStaleness = useCallback(async (): Promise<Record<string, StaleChapter> | null> => {
    setChecking(true)
    // The check waits for the whole study — minutes on a comparison over ecoinvent — so the page asks
    // where it stands and draws a bar, like the import wizard does for its read. A null answer keeps
    // the last one: it means the build has finished and the check is doing its arithmetic.
    const poll = window.setInterval(() => {
      void api<{ build: CheckProgress | null }>('GET', `${base}/progress`)
        .then((r) => {
          if (r.build && baseRef.current === base) setCheckProgress(r.build)
        })
        .catch(() => {})
    }, 1000)
    try {
      let r = await api<{ chapters: StaleChapter[] }>('POST', `${base}/staleness`, {})
      if (baseRef.current !== base) return null
      // A value a chapter points at that was only renamed is re-linked on the way, for nothing: no
      // model, no word changed — there is nothing for anyone to decide about it.
      const relink = r.chapters.filter((c) => c.rebindable > 0 && !(c as { locked?: boolean }).locked)
      if (relink.length) {
        for (const c of relink)
          await api('POST', `${base}/sections/${c.section_id}/rebind`, {}).catch(() => undefined)
        r = await api<{ chapters: StaleChapter[] }>('POST', `${base}/staleness`, {})
        if (baseRef.current !== base) return null
      }
      const map = Object.fromEntries(r.chapters.map((c) => [c.section_id, c]))
      setStale(map)
      setStaleFailure(null)
      return map
    } catch (e) {
      setStale({}) // an incomplete report cannot be checked yet — not worth an error here
      // …but the *page* has to be able to tell the two apart too, not just the return value. `{}` alone
      // rendered as "nothing is out of date" and the foot said "Every chapter written" over a model
      // whose every calculation was answering 400 (V200). The reason is kept verbatim: the backend's
      // sentence names what to put right, ours would only name that something went wrong.
      setStaleFailure(failureText(e))
      // null, not {}: "nothing is out of date" and "could not be checked" are different answers, and
      // Write all must not present the second as the first.
      return null
    } finally {
      window.clearInterval(poll)
      setCheckProgress(null)
      setChecking(false)
    }
  }, [base])

  /** The built-in prompts. Needed to show what a chapter is being asked to do — and, once it is
   *  overridden, what the override departs from. */
  const loadPlaceholder = useCallback(async () => {
    try {
      const r = await api<{ base64: string }>('GET', '/api/v1/report/cover-placeholder')
      setPlaceholder(r.base64)
    } catch {
      setPlaceholder(null) // no thumbnail is better than an error over a missing decoration
    }
  }, [])

  /**
   * The §5.2 fields this study has not recorded.
   *
   * Read once when the panel opens rather than derived from a render: it has to be answerable before
   * anything is written, and a render needs a computable report — which a study this incomplete often
   * is not yet.
   */
  const loadScope = useCallback(async () => {
    try {
      const s = (await fetchQuery(studyRoute(database))) as Record<string, string>
      // The language the study is DOCUMENTED in (Model info). A report in another language knows it
      // has to translate the study texts — see translateStudy and runPlan.
      //
      // `detected_language` fills in when nobody set the field, which is the normal case: a model
      // built without opening Model info reads as English, so an English report of a thoroughly
      // German study translated nothing, showed no translation step, and printed a page of German
      // under "Declared by the study" (V158). The guess is deterministic (function words, backend
      // side) and it is not written to the study — it only makes the app say what it is assuming.
      setStudyLang((s?.language || '').trim() || (s?.detected_language || '').trim() || 'en')
      setStudyLangGuessed(!(s?.language || '').trim() && !!(s?.detected_language || '').trim())
      setMissingScope(unrecordedScope(s))
    } catch {
      setMissingScope([]) // no metadata endpoint, no claim
      // And no claim about the language either. Leaving the `'en'` default standing here was a claim:
      // it silently dropped the translation step out of an English report's run and, in a German one,
      // printed "The study is documented in English" (V201). The reason itself is not carried the way
      // `staleFailure` carries the staleness refusal — that one named a scenario and the parameters to
      // set back, while a failed GET on the study record yields a transport error, and the one thing
      // the author can act on ("set it in Model info") is the same however it failed.
      setStudyLang(null)
      setStudyLangGuessed(false)
    }
  }, [database])

  const loadPrompts = useCallback(async () => {
    try {
      const r = await api<{ prompts: Record<string, string> }>('GET', '/api/v1/report/prompts')
      setPrompts(r.prompts)
      setPromptsRead(true)
    } catch {
      // An empty map and a failed request look identical from here, and the instruction box reads the
      // difference out loud: an empty box under "What this chapter is asked to do." says this chapter has
      // no built-in instruction. Same family as V200/V201 — a failure that arrives looking like a fact.
      setPrompts({})
      setPromptsRead(false)
    }
  }, [])

  useEffect(() => {
    void load()
    void loadTemplates()
    void loadStaleness()
    void loadPrompts()
    void loadPlaceholder()
    void loadScope()
  }, [load, loadTemplates, loadStaleness, loadPrompts, loadPlaceholder, loadScope])

  /**
   * Coming back to the page re-asks whether the model moved under the chapters.
   *
   * This used to happen for free, because leaving the page unmounted the whole view — which is also
   * how a running write run was forgotten and paid for twice (V150). Now the page stays, so the
   * question has to be asked deliberately, on the hidden→visible edge and nowhere else: a parameter
   * edit lives on another page, and there is no cheaper signal than the author walking back in.
   */
  useEffect(() => {
    onChecking?.(checking)
  }, [checking, onChecking])
  /** Counted here, before the early returns below, because the parent's export gate needs it whether
   *  or not the list has rendered yet. */
  const reviewPending = reviewPendingCount(report?.sections ?? [], stale)
  useEffect(() => {
    onReviewPending?.(reviewPending)
  }, [reviewPending, onReviewPending])

  const wasActive = useRef(active)
  useEffect(() => {
    const returned = active && !wasActive.current
    wasActive.current = active
    if (returned) {
      void load()
      void loadStaleness()
      void loadScope()
    }
  }, [active, load, loadStaleness, loadScope])
  // Model info opens over this page (the toolbar's Model button), and saving it invalidates the study
  // record: read it again, or the notice the author has just answered stays up until they leave.
  const studyRecord = useQuery(studyRoute(database)).data
  useEffect(() => {
    if (studyRecord) void loadScope()
  }, [studyRecord, loadScope])

  /** Every mutation reloads from the store: it owns the order and the numbering, not this component. */
  /**
   * Every mutation runs strictly after the previous one *and its reload*, and a payload may be a
   * function of the freshest report. Both together are what make quick successive clicks safe: two
   * scenario ticks used to build the second payload from the pre-first `report` state and silently
   * drop the first change. A function payload returning null means "nothing to do any more".
   */
  const mutate = useCallback(
    async (
      method: string,
      path: string,
      body?: object | ((current: StoredReportFull | null) => object | null)
    ): Promise<boolean> => {
      const run = async (): Promise<boolean> => {
        try {
          const payload = typeof body === 'function' ? body(reportRef.current) : body
          if (payload === null) return true
          const answer = await api<{ affects_staleness?: boolean } | unknown>(method, path, payload)
          await load()
          // Whether a mutation moves the "numbers moved" badges is the backend's judgement now — the
          // update endpoints say so in their response. This used to be a hand-kept list of field
          // names here, which is exactly the kind of mirror that drifts (a hand text edit was missed
          // for weeks). Endpoints without the flag (delete, reorder) change no staleness.
          if ((answer as { affects_staleness?: boolean } | null)?.affects_staleness) {
            void loadStaleness()
          }
          onChanged?.()
          setError(null)
          return true
        } catch (e) {
          setError(errMsg(e))
          return false
        }
      }
      const turn = mutateQueue.current.then(run)
      // The queue must survive a failed mutation — `run` never throws, but keep it airtight.
      mutateQueue.current = turn.catch(() => undefined)
      return turn
    },
    [load, loadStaleness, onChanged]
  )

  const blocker = useCallback(
    (kind: string): string | null =>
      kind === 'contribution' && !(report?.aggregate_by ?? '')
        ? 'Choose a “Contribution breakdown” above first — without a dimension this chapter has no groups to tabulate and would render empty.'
        : null,
    [report?.aggregate_by]
  )

  //: Everything a model does to this report lives in the hook; this panel wires it.
  const writer = useChapterWriter({
    base,
    database,
    reportLang: report?.lang ?? 'en',
    studyLang,
    studyLangGuessed,
    reportRef,
    stale,
    blocker,
    load,
    loadStaleness,
    setStale,
    setStaleFailure,
    onChanged,
    setError,
    openChapter: setOpenId
  })
  const {
    writing,
    stage,
    lanes,
    writeSeconds,
    writingAll,
    plan,
    setPlan,
    checkSeconds,
    findings,
    drafts,
    setDraftText,
    note,
    setNote,
    translateNote,
    storeDraft,
    discardDraft,
    write,
    translateStudy,
    resolveAbbreviations,
    planAll,
    runPlan,
    updateOne,
    answerQuestion,
    cancelRun,
    reset: resetWriter
  } = writer
  const { keepPoint, replaceNumber } = useReviewPoints({ base, load, loadStaleness, onChanged, setError })
  // A report deleted under a running write leaves the run posting chapters to a 404, so the page's Delete
  // waits for this.
  const busyWriting = writing !== null || writingAll !== null
  useEffect(() => {
    onWriting?.(busyWriting)
  }, [busyWriting, onWriting])

  // Switching reports must not carry the previous one's chatter along: a stale note, findings for
  // section ids that no longer exist, an edit overlay over the wrong report — and the previous
  // chapter list stays visible until `load()` resolves, so clicking into it would post the old
  // report's section ids against the new report's URL.
  useEffect(() => {
    reportRef.current = null
    setReport(null)
    resetWriter()
    // The groups' open state is deliberately NOT reset with the report: which panels you keep open is a
    // working habit, and having them snap back on every report switch was the reason to persist it.
    setStale({})
    // The other report's failure is not this one's — and a note about a scenario left applied there
    // would be read as a verdict on the report just opened.
    setStaleFailure(null)
    setResolved({})
    setOpenId(null)
  }, [reportId, resetWriter])

  /**
   * Fetch (or put away) the chapter as the document will read it.
   *
   * Fetched every time it is opened rather than cached in the panel: the numbers under a chapter move,
   * and a stale "this is what it says" is worse than no answer. The call itself is arithmetic on a
   * snapshot the analysis endpoints already share, so it costs a round trip and nothing else.
   */
  const toggleResolved = useCallback(
    async (section: ReportSection) => {
      if (resolved[section.id]) {
        setResolved((r) => {
          const next = { ...r }
          delete next[section.id]
          return next
        })
        return
      }
      try {
        const r = await api<{ parts: ResolvedPart[] }>('POST', `${base}/sections/${section.id}/resolved`, {})
        setResolved((prev) => ({ ...prev, [section.id]: { parts: r.parts ?? [] } }))
      } catch (e) {
        setResolved((prev) => ({
          ...prev,
          [section.id]: { error: errMsg(e) }
        }))
      }
    },
    [base, resolved]
  )

  /**
   * The author's release: they have read these chapters and stand behind what they say. Records the
   * wording, so "what changed since?" has an answer — and it is also the one
   * verdict about *meaning* a chapter can carry; the check only ever verifies figures. Without ids,
   * every written chapter.
   */
  const release = useCallback(
    async (sectionIds?: string[]) => {
      setError(null)
      try {
        const out = await api<{ marked: string[] }>('POST', `${base}/reviewed`, {
          section_ids: sectionIds
        })
        setNote(
          sectionIds
            ? `Approved ${out.marked.length} chapter${out.marked.length === 1 ? '' : 's'}.`
            : `Report approved — ${out.marked.length} chapter${out.marked.length === 1 ? '' : 's'} as you read them.`
        )
        await loadStaleness()
      } catch (e) {
        setError(errMsg(e))
      }
    },
    [base, loadStaleness, setNote]
  )

  /**
   * The per-row and in-modal Write button, with the one question the bulk path already asks in its
   * plan dialog: an empty chapter is written straight away, a chapter holding text is not replaced
   * until the author says so. Locked chapters never get here — the button is disabled for them.
   */
  const askWrite = useCallback(
    (section: ReportSection) => {
      const spec = writeConfirmSpec(
        section,
        Boolean(stale[section.id]?.reviewed_at),
        () => void write(section)
      )
      if (spec) setConfirming(spec)
      else void write(section)
    },
    [stale, write]
  )

  /**
   * Deleting a chapter, with its consequence said out loud.
   *
   * Reports deliberately bypass the undo bus (engine/report_audit documents why), so there is no
   * "undo" to offer — and pretending otherwise would be worse than the ask. A chapter with text gets
   * the question with the honest consequence; an empty one is deleted without ceremony, because a
   * box in front of the ordinary action is noise (same rule as writeConfirmSpec).
   */
  const askDelete = useCallback(
    (section: ReportSection) => {
      const doDelete = (): void => void mutate('POST', `${base}/sections/${section.id}/delete`)
      if (!(section.text ?? '').trim()) return doDelete()
      setConfirming({
        title: 'Delete this chapter?',
        message:
          `“${chapterLabel(section)}” holds written text, and reports keep no undo: what is deleted is ` +
          'gone, and a new chapter of the same kind starts empty. To keep the text safe without ' +
          'deleting, close this and lock the chapter instead — a locked chapter refuses every change.',
        confirmLabel: 'Delete the chapter',
        danger: true,
        onConfirm: doDelete
      })
    },
    [base, mutate]
  )

  if (error && !report) return <p className="chat-error">{error}</p>
  if (!report) return <p className="empty">Loading…</p>

  // What the group summaries and the footer say in words. Only the kinds that HAVE text count —
  // a references or annex chapter is built from the data, so counting it as unwritten would make a
  // finished report look unfinished.
  /**
   * Families worth breaking this report's contribution down by: those in use in a database one of its
   * subjects comes from (this is the page where it matters most, because the choice is stored
   * and every contribution chapter is written from it). A family nobody tagged puts the whole tree in one
   * "untagged" row, and a chapter written against that says nothing.
   *
   * The stored choice stays listed even when the subjects move away from it: a select whose value is not
   * among its options shows blank, which would read as "the report lost its breakdown".
   */
  const breakdownFamilies = (() => {
    const dbs = new Set((report.subjects ?? []).map((s) => s.database).filter(Boolean))
    const chosen = (report.aggregate_by ?? '').startsWith('tag:') ? (report.aggregate_by ?? '').slice(4) : ''
    return dimensions
      .filter((d) => d.name === chosen || (d.databases ?? []).some((db) => dbs.has(db)))
      .map((d) => d.name)
  })()
  const writableSecs = report.sections.filter((s) => WRITABLE.has(s.kind))
  /** The chapter a single Write is running on, if that is what `writing` holds — it also carries the
   *  study translation and the glossary resolve, neither of which reports phases. */
  const writingOne = writing ? writableSecs.find((s) => s.id === writing) : undefined
  const written = writableSecs.filter((s) => (s.text ?? '').trim()).length
  /** Why a held draft could not be finished, in one sentence: the first reason the run gave. */
  const draftReasons: Record<string, string> = Object.fromEntries(
    Object.keys(drafts).map((id) => [id, findings[id]?.length ? plainReason(findings[id]) : ''])
  )
  /** The chapters a model is working on right now — the single Write, or the run's open steps. */
  const working: Record<string, 'write' | 'update'> = {}
  const busyIds = writingAll
    ? writingAll.steps.filter((s) => !writingAll.finished.includes(s.id)).map((s) => s.id)
    : writing
      ? [writing]
      : []
  for (const id of busyIds) {
    const s = report.sections.find((x) => x.id === id)
    if (s) working[id] = (s.text ?? '').trim() ? 'update' : 'write'
  }
  /** One state per writable chapter — what the list shows, the foot counts and the buttons offer. */
  const stateOf = (s: ReportSection): ReturnType<typeof chapterState> =>
    chapterState(s, {
      stale: stale[s.id],
      draftReason: drafts[s.id] ? (draftReasons[s.id] ?? '') : null,
      working: working[s.id] ?? null,
      blocker: blocker(s.kind),
      answers: report.answers
    })
  // Locked chapters count for what the author does — they can be new since the approval like any other
  // — but not for what a run does: it leaves them alone, so they do not name the run button.
  const counts = stateCounts(writableSecs.map(stateOf))
  const runCounts = stateCounts(writableSecs.filter((s) => !s.locked).map(stateOf))
  /** The questions the writers asked that nobody has answered, in document order. */
  const questions = writableSecs.flatMap((s) =>
    openQuestions(s, report.answers).map((question) => ({ section: s, question }))
  )
  /**
   * Whether the last check answered — and if it did not, what it said. All three counters above read
   * a `stale` that a failed check leaves empty, so all three come out zero, and the foot omits zeros:
   * the line collapses to "Every chapter written" and reads like a clean bill of health (V200).
   *
   * Counted over every section carrying text, not just the writable ones, because that is the set the
   * check itself compares (`planAll` sends exactly this list) — the question is whether it had work.
   */
  const notice = stalenessNotice(report.sections.filter((s) => (s.text ?? '').trim()).length, staleFailure)

  /** The study's language as far as this panel knows it: what may be said about it, and whether the
   *  run translates. One reading, used by the hint, the dialog and the foot. */
  const lang = languagePlan(studyLang, report.lang ?? 'en', studyLangGuessed, plan?.foreign ?? 0)

  /** What the dry run would cost if it were run now — the button says this, not the tick count. */
  const planRun = plan ? runSize(plan.items, plan.chosen, lang.translate) : null

  //: Which LLMs the written chapters came from, in first-use order — one entry per model, so a
  //: report whose rewrites mixed models reads "written by" both.
  const writtenBy = [
    ...new Set(report.sections.filter((s) => (s.text ?? '').trim() && s.model).map((s) => String(s.model)))
  ]

  return (
    <div className="rsec">
      {writtenBy.length ? (
        <p
          className="rsec-writtenby"
          title="Per chapter: set when a chapter is written, changed only when that chapter is rewritten — a mixed run names every model involved."
        >
          Written by <code>{writtenBy.join(', ')}</code>
        </p>
      ) : null}
      <ReportHeadGroup
        report={report}
        grp={grp('document')}
        writing={writing}
        runActive={writingAll !== null}
        translateNote={translateNote}
        langHint={lang.hint}
        onDraft={(patch) => setReport((r) => (r ? { ...r, ...patch } : r))}
        mutate={mutate}
        base={base}
        onTranslate={() => void translateStudy()}
      />

      {/*
        What this report is *about*. It used to live in the card beside this one, which meant a full
        report's content depended on controls belonging to the short one — and there was no way to change
        it afterwards at all: you deleted the report and made a new one. Every field here writes straight
        through to the stored report, so what you see is what it will render.
      */}
      <AccordionGroup
        // "Scope & indicators", not "Covers". "Covers" was meant as *what the report covers* and read
        // as *cover pages* — with an actual "Title page" row three lines below it in Chapters. The new name
        // also borrows the vocabulary the Results rail already uses (Subjects, Indicators). Id unchanged.
        title="Scope & indicators"
        summary={
          ((report.subjects?.length ?? 0) > 1
            ? `${report.subjects?.length} variants`
            : baseCode
              ? (activities.find((a) => a.code === baseCode)?.name ?? '1 process')
              : 'nothing yet') + ` · ${report.methods?.length ?? 0} indicators`
        }
        {...scopeGrp}
      >
        {/* What ISO 14044 §5.2 expects a report to state, and what this study has not recorded. It was
            findable before — the consistency check says "Functional unit defined: no" — but on page 26
            of the finished document, which is the wrong end of the process: these fields are what the
            chapters are written *from*, so an empty one becomes a vague sentence nobody can fix
            afterwards without rewriting the chapter. The notice names the Model info section each field
            sits in — none of them is under "Goal & scope", the section people look in first. */}
        {missingScope.length ? (
          <p className="rsec-findings" style={{ margin: '0 0 10px' }}>
            Missing from the model info: <b>{missingScope.map(([, label]) => label).join(', ')}</b>. ISO 14044
            expects the report to state this, and the report can only use what the model info says — otherwise
            it will read “not specified”. Fill in under <b>Model</b> (top bar) →{' '}
            <b>{[...new Set(missingScope.map(([, , section]) => section))].join(', ')}</b>.
          </p>
        ) : null}

        <label className="settings-field">
          <span>Reference process</span>
          <select value={baseCode} onChange={(e) => void setSubjects(e.target.value)}>
            <option value="">—</option>
            {activities.map((a) => (
              <option key={a.code} value={a.code}>
                {a.name}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-field">
          <span>Amount (functional unit)</span>
          <NumberInput
            min={0}
            step="any"
            value={report.amount ?? 1}
            onValue={(raw) => setReport({ ...report, amount: Number(raw) })}
            onBlur={(e) => {
              // What the field shows, not `report` — see shownNumber.
              const shown = shownNumber(e.currentTarget)
              const amount = shown === null ? Number(report.amount) : Number(shown)
              if (shown !== null) setReport({ ...report, amount })
              void mutate('POST', base, { amount: amount || 1 })
            }}
          />
        </label>

        <label className="settings-field">
          <span>Contribution breakdown</span>
          <select
            value={report.aggregate_by ?? ''}
            onChange={(e) => void mutate('POST', base, { aggregate_by: e.target.value })}
          >
            <option value="">None</option>
            <option value="geo">By location</option>
            {breakdownFamilies.map((d) => (
              <option key={d} value={`tag:${d}`}>
                By {d}
              </option>
            ))}
          </select>
        </label>
        {/* How the breakdown is drawn, beside the breakdown itself rather than with the comparison
            figures. Two readings of the same numbers: grouped puts the phases on the axis and answers
            "which variant is worse here"; stacked puts the variants on the axis and answers "what is
            this one made of". Grouped carries the totals as a last group, so the switch is a choice of
            emphasis and not a choice between having the totals or not.

            A switch rather than a tick, because there is no "neither" — and it stays visible when it
            cannot be used, with the reason in the tooltip, since a control that is simply absent is one
            people go looking for. */}
        {report.aggregate_by ? (
          <label className="settings-field">
            <span>Contribution chart</span>
            <span
              className="seg"
              title={
                (report.subjects?.length ?? 0) > 1
                  ? undefined
                  : 'Stacking needs a second variant. With one, a bar per group is easier to read: every group stands at the axis, while a stack only gives you the total.'
              }
            >
              {(
                [
                  ['Grouped', false],
                  ['Stacked', true]
                ] as const
              ).map(([label, on]) => (
                <button
                  key={label}
                  // What will actually be drawn, not what is stored: with one variant the renderer falls
                  // back to grouped, and a switch that says "Stacked" while the document shows grouped
                  // bars is worse than no switch. The stored choice comes back when a second variant does.
                  className={`seg-btn${(Boolean(report.options?.figures?.stacked) && (report.subjects?.length ?? 0) > 1) === on ? ' on' : ''}`}
                  disabled={on && (report.subjects?.length ?? 0) < 2}
                  onClick={() =>
                    void mutate('POST', base, (r) => ({
                      options: {
                        ...(r?.options ?? {}),
                        figures: { ...(r?.options?.figures ?? {}), stacked: on }
                      }
                    }))
                  }
                >
                  {label}
                </button>
              ))}
            </span>
          </label>
        ) : null}

        {/* Ticking a scenario adds it as a variant beside the baseline — which is what turns the report
            into a comparison: the matrix table, the heatmap, the radar and the sensitivity check all
            appear from the second variant onwards. */}
        {scenarios.length ? (
          <div className="rsec-figopts rsec-figlist">
            <span className="modal-h">Compare with</span>
            {scenarios.map((sc) => (
              <label key={sc.id}>
                <input
                  type="checkbox"
                  disabled={!baseCode}
                  checked={scenarioIds.includes(sc.id)}
                  onChange={(e) => void setSubjects(baseCode, { scenario: sc.id, on: e.target.checked })}
                />
                <span>{sc.name}</span>
              </label>
            ))}
          </div>
        ) : null}

        <IndicatorPicker
          methods={methods}
          picked={(report.methods ?? []).map((m) => methodKey(m))}
          onChange={(next) => {
            // The picker hands over a full list built from the rendered (possibly stale) state, so
            // the *delta* is taken now and applied to the freshest report at execution time — two
            // quick picks accumulate instead of the second overwriting the first.
            const before = new Set((report.methods ?? []).map((m) => methodKey(m)))
            const after = new Set(next)
            const added = next.filter((k) => !before.has(k))
            const removed = [...before].filter((k) => !after.has(k))
            void mutate('POST', base, (r) => {
              const fresh = (r?.methods ?? []).map((m) => methodKey(m)).filter((k) => !removed.includes(k))
              const keys = [...fresh, ...added.filter((k) => !fresh.includes(k))]
              return {
                methods: keys
                  .map((key) => methods.find((m) => methodKey(m.method) === key)?.method)
                  .filter((m): m is string[] => Boolean(m))
              }
            })
          }}
        />
        {!(report.methods?.length ?? 0) ? (
          <p className="settings-hint">
            Pick at least one impact indicator — without one there is nothing to report.
          </p>
        ) : null}
        {/* Comparison figures. Offered only where they say something: a heatmap or a radar over one subject
            compares nothing, and a radar with three axes is a triangle rather than a profile. */}
        {(report.subjects?.length ?? 0) > 1 ? (
          <div className="rsec-figopts">
            <label className="figpre">
              <input
                type="checkbox"
                checked={Boolean(report.options?.figures?.heatmap)}
                onChange={(e) => {
                  // Read the box *now*. The patch is a callback that runs a microtask later, off the write
                  // queue, and by then React has already reset this controlled input to its old value —
                  // so reading `e.target.checked` in there posted the state we were trying to leave.
                  const on = e.target.checked
                  void mutate('POST', base, (r) => ({
                    options: {
                      ...(r?.options ?? {}),
                      figures: { ...(r?.options?.figures ?? {}), heatmap: on }
                    }
                  }))
                }}
              />
              <span>Heatmap of every indicator</span>
              {/* Both names describe a SHAPE, and the words alone do not say which shape. The
                  thumbnail does, on hover or keyboard focus — see FigurePreview for why its numbers
                  are invented. */}
              <span className="figpre-pop" aria-hidden="true">
                <HeatmapPreview />
              </span>
            </label>
            <label
              className="figpre"
              title={
                (report.methods?.length ?? 0) > 3
                  ? 'One closed line per subject across the indicator axes'
                  : 'Needs more than three indicators — with fewer, a radar is a triangle rather than a profile'
              }
            >
              <input
                type="checkbox"
                disabled={(report.methods?.length ?? 0) <= 3}
                checked={Boolean(report.options?.figures?.radar)}
                onChange={(e) => {
                  // Read the box *now*. The patch is a callback that runs a microtask later, off the write
                  // queue, and by then React has already reset this controlled input to its old value —
                  // so reading `e.target.checked` in there posted the state we were trying to leave.
                  const on = e.target.checked
                  void mutate('POST', base, (r) => ({
                    options: {
                      ...(r?.options ?? {}),
                      figures: { ...(r?.options?.figures ?? {}), radar: on }
                    }
                  }))
                }}
              />
              <span>Radar across the indicators</span>
              <span className="figpre-pop" aria-hidden="true">
                <RadarPreview />
              </span>
            </label>
            {/* The threshold below which the check advises against calling one variant better. A
                convention, not a measurement — 5 % is defensible for climate change and energy and far too
                tight for toxicity — so it belongs to the report rather than to the code. */}
            <label
              className="rsec-threshold"
              title="Below this, the check advises against calling one variant better — a convention, not a measurement"
            >
              <span>Difference worth reporting</span>
              <NumberInput
                min={0.1}
                max={100}
                step={0.5}
                value={report.options?.significance_percent ?? 5}
                onValue={(raw) => {
                  // Read NOW: the queued callback ran after React had reset the controlled input to its
                  // prop, and wrote the old threshold back.
                  const percent = Number(raw) || 5
                  void mutate('POST', base, (r) => ({
                    options: {
                      ...(r?.options ?? {}),
                      significance_percent: percent
                    }
                  }))
                }}
              />
              <span>%</span>
            </label>
          </div>
        ) : null}
      </AccordionGroup>

      <ReportAppearanceGroup
        report={report}
        grp={grp('appearance')}
        templates={templates}
        mutate={mutate}
        base={base}
        onTemplatesChanged={async () => {
          await loadTemplates()
          await load()
        }}
      />

      <AccordionGroup
        title="Chapters"
        summary={`${written} of ${writableSecs.length} written`}
        {...grp('chapters')}
      >
        {writing !== null ? (
          <p className="settings-hint">
            <Busy label="Working on a chapter" />{' '}
            {/* The one exit when a stream stalls — without it every AI button stays disabled until restart. */}
            <button className="btn sm" onClick={cancelRun}>
              Cancel
            </button>
          </p>
        ) : null}
        {/* One line: everything above the chapter list eats into the list's own scroll area. */}
        <p className="settings-hint">
          Drag to reorder — numbering and references follow. Locking protects reviewed text.
        </p>

        <QuestionsPanel
          questions={questions}
          onAnswer={(section, q, answer) => answerQuestion(section, q.id, q.question, answer)}
        />

        <ChapterList
          report={report}
          stale={stale}
          drafts={drafts}
          draftReasons={draftReasons}
          working={working}
          placeholder={placeholder}
          writing={writing}
          runActive={writingAll !== null}
          blocker={blocker}
          mutate={mutate}
          base={base}
          onTitleDraft={(id, title) =>
            setReport((r) =>
              r ? { ...r, sections: r.sections.map((x) => (x.id === id ? { ...x, title } : x)) } : r
            )
          }
          onReorder={(ids) => void mutate('POST', `${base}/reorder`, { order: ids })}
          onWrite={askWrite}
          onEdit={setOpenId}
          onDelete={askDelete}
          onReadDiff={setReadDiff}
          onQuestions={() => document.querySelector('.rsec-questions')?.scrollIntoView({ block: 'nearest' })}
          onResolveAbbreviations={(s) => void resolveAbbreviations(s)}
          onCoverOpen={() => setCoverOpen(true)}
        />
        <AddChapterControl onAdd={(kind) => void mutate('POST', `${base}/sections`, { kind })} />
      </AccordionGroup>

      <ReportDefaultsGroup report={report} grp={grp('defaults')} mutate={mutate} />

      {/* Always visible, whichever group is open: how much is left to write, and the button that
          writes it. Inside the chapter group it was reachable only by scrolling past the list it
          acts on, which on a fifteen-chapter report is most of the panel. The dock pins it — and the
          document bar handed in as `actions` — to the rail's bottom edge, so neither scrolls away
          with the accordion. */}
      <div className="rsec-dock">
        <div className="rsec-foot">
          {/* What the last action did, here rather than inside the chapter group. Every `setNote` in this
            panel — a correction applied, a re-link, a cancel — lands in this one
            line, and the group that used to draw it is closed whenever the author has just come out of
            a modal: the "Apply" of a correction run reported "Refused by the check: Impact assessment"
            into a collapsed panel, so three lost corrections looked exactly like three applied ones
            (V174). Opening the group instead would have moved the chapter list
            out from under the author for a message about a dialog they had already left; the foot is
            the one part of this panel that stands whichever group is open, and it is already where the
            panel reports what it is doing. */}
          {note ? <p className="settings-hint rsec-note">{note}</p> : null}
          {/* The check that did not run, in the same always-visible line and for the same reason as the
            note above it (V174): the badges it would have set live in a group the author may have
            closed, and the counter beside it is only a handful of words wide. The frame is ours, the
            sentence after it is the backend's — it named the applied scenario and the parameters to set
            back, and no wording of ours could have. `<b>` on the reason, not on the frame: what is worth
            reading twice is what to do about it. */}
          {notice ? (
            <p className="settings-hint rsec-note">
              {notice.lead} <b>{notice.detail}</b>
            </p>
          ) : null}
          {/* The run's pulse, above the buttons it belongs to: a bar that fills per finished chapter
            and shimmers while one is being written — the counter alone read as a hang between two
            completions, which on a reasoning model is minutes apart. */}
          {writingAll ? (
            <div
              className="rsec-progress working"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={writingAll.total}
              aria-valuenow={writingAll.done}
            >
              <span
                style={{
                  width: `${Math.max(4, Math.round((writingAll.done / Math.max(1, writingAll.total)) * 100))}%`
                }}
              />
            </div>
          ) : checking && checkProgress && checkProgress.total > 0 ? (
            // The check's study, counted solve by solve — the same bar as the run above, because it is
            // the same kind of wait: long, and with a count the backend can give.
            <div
              className="rsec-progress working"
              role="progressbar"
              aria-label="Checking what changed"
              aria-valuemin={0}
              aria-valuemax={checkProgress.total}
              aria-valuenow={checkProgress.done}
            >
              <span
                style={{
                  width: `${Math.max(4, Math.round((Math.min(checkProgress.done, checkProgress.total) / checkProgress.total) * 100))}%`
                }}
              />
            </div>
          ) : null}
          <span className="p">
            {writingAll
              ? // The run's own words, not the stored-state summary: "Every chapter written" under a
                // running bar read as if the run were already over. Count plus
                // the chapters still open, so the wait has names.
                `Writing ${writingAll.done} of ${writingAll.total}` +
                (() => {
                  const open = writingAll.steps.filter((s) => !writingAll.finished.includes(s.id))
                  if (!open.length) return ' — finishing up…'
                  // With what each is doing, where a lane has said. A chapter deep in its lookups shows
                  // its counter, which is the only number that says how much of the wait is left; one
                  // that has not started yet shows its name alone, which is also the truth (V269).
                  const shown = open.slice(0, 3).map((s) => {
                    const what = stageBrief(lanes[s.id] ?? null)
                    return what ? `${s.title} (${what})` : s.title
                  })
                  return ` · still open: ${shown.join(', ')}${open.length > 3 ? ` +${open.length - 3} more` : ''}`
                })()
              : writingOne && stage
                ? // One chapter on its own: the same idea as the run's line, for the case that had none.
                  // `stage` is the gate, not `writing` alone — storing a refused draft also holds that
                  // marker, and it is neither a model call nor minutes long.
                  writeStatus(chapterLabel(writingOne), stage, writeSeconds)
                : (() => {
                    const parts = [
                      // What is left to do, in the order the author does it: write, update, answer, check,
                      // read and approve. Everything a model settled on its own stays out of this line.
                      stateSummary(counts),
                      // The check that did not come through (V200): without it the line above would read as
                      // a clean bill of health. Not while a fresh check is running: the next item says that.
                      notice && !checking ? 'out of date: not checked' : '',
                      // A language the panel could not read is a fact about the run *ahead* (V201).
                      lang.foot ?? ''
                    ]
                      .filter(Boolean)
                      .join(' · ')
                    // The check runs for minutes on a cold cache, and a still "checking…" read as a hang.
                    // The animated dots were the first answer and too quiet in a line of foot text, then
                    // a spinner and a seconds counter — which still could not say whether it was moving or
                    // how long was left. The count from the backend says both; the clock stands in until the
                    // build has reported.
                    return (
                      <>
                        {parts}
                        {checking ? (
                          <>
                            {parts ? ' · ' : ''}
                            {checkProgress && checkProgress.total > 0 ? (
                              <span role="status" aria-live="polite">
                                {checkProgressText(checkProgress)}
                              </span>
                            ) : (
                              <BusyClock label="checking what changed" />
                            )}
                          </>
                        ) : null}
                      </>
                    )
                  })()}
          </span>
          <div className="r">
            {/* One approval for the report, not one per chapter: you have read it and it goes out under
                your name. A chapter that changes afterwards shows "New" until you approve again. */}
            <button
              className="btn sm"
              disabled={writing !== null || writingAll !== null || !counts.new || !!counts.numbers}
              title={
                counts.numbers
                  ? 'Numbers are still typed into the text — keep or replace each one in its chapter first.'
                  : counts.new
                    ? 'You have read the chapters marked “New” and the report says what you want it to say. A chapter that changes afterwards is marked “New” again.'
                    : 'Nothing new since your last approval.'
              }
              onClick={() => void release()}
            >
              Approve report
            </button>
            <button
              className="btn sm primary"
              disabled={writing !== null || writingAll !== null}
              title="Show what the run would do, chapter by chapter — write the empty ones, update the ones the model moved under — and let you change the list before anything is written. Locked chapters are left alone; the executive summary is written last."
              onClick={() => void planAll()}
            >
              {/* The label says what the run is for; it stays put while a run writes — the count lives in
                the foot line and the bar. */}
              <SparkleIcon />
              {runCounts.empty || runCounts.unfinished
                ? 'Write report'
                : runCounts.update
                  ? 'Update report'
                  : 'Rewrite report'}
            </button>
            {writingAll ? (
              // The run's only exit. The single-chapter Cancel hangs off `writing`, which the quiet lanes
              // never set — a stalled stream in one of four lanes left every AI button disabled with
              // nothing to click until an app restart. 'report:ai' pulls every lane at once.
              <button className="btn sm" onClick={cancelRun}>
                Cancel
              </button>
            ) : null}
          </div>
        </div>
        {actions}
      </div>
      {plan ? (
        <WriteAllPlanDialog
          plan={plan}
          run={planRun ?? { total: 0, translation: 0 }}
          runNote={lang.runNote}
          notice={notice}
          checkSeconds={checkSeconds}
          onClose={() => setPlan(null)}
          onChosen={(id, on) =>
            setPlan((p) =>
              p ? { ...p, chosen: on ? [...p.chosen, id] : p.chosen.filter((x) => x !== id) } : p
            )
          }
          onReset={() => setPlan((p) => (p ? { ...p, chosen: defaultTicks(p.items) } : p))}
          onRun={() => void runPlan()}
        />
      ) : null}

      {readDiff ? (
        <ReadDiffDialog
          diff={readDiff}
          onClose={() => setReadDiff(null)}
          onPutBack={() => {
            const back = readDiff.before
            const target = readDiff.section
            setReadDiff(null)
            void mutate('POST', `${base}/sections/${target.id}`, { kind: target.kind, text: back })
          }}
          onMarkRead={() => {
            const target = readDiff.section
            setReadDiff(null)
            void release([target.id])
          }}
        />
      ) : null}

      {coverOpen ? (
        <CoverOverlay
          base={base}
          report={report}
          templates={templates}
          placeholder={placeholder}
          onClose={() => setCoverOpen(false)}
          onChanged={() => {
            void load()
            onChanged?.()
          }}
        />
      ) : null}

      {open ? (
        <ChapterEditorSheet
          open={open}
          report={report}
          base={base}
          error={error}
          drafts={drafts}
          findings={findings}
          resolved={resolved}
          prompts={prompts}
          promptsRead={promptsRead}
          writing={writing}
          runActive={writingAll !== null}
          stage={stage}
          writeSeconds={writeSeconds}
          indicatorNames={indicatorNames}
          mutate={mutate}
          patchOpen={patchOpen}
          clearResolved={(id) =>
            setResolved((r) => {
              const next = { ...r }
              delete next[id]
              return next
            })
          }
          setDraftText={setDraftText}
          storeDraft={storeDraft}
          discardDraft={discardDraft}
          toggleResolved={toggleResolved}
          askWrite={askWrite}
          loadPrompts={loadPrompts}
          onKeepPoint={keepPoint}
          onReplaceNumber={replaceNumber}
          movedNumbers={(stale[open.id]?.findings ?? [])
            .filter((f) => f.kind === 'kept_numbers')
            .flatMap((f) => f.points ?? [])}
          onEarlier={(s) => {
            setOpenId(null)
            setReadDiff({ section: s, before: s.previous?.text ?? '', kind: 'previous' })
          }}
          onFix={(s) => {
            setOpenId(null)
            void updateOne(s)
          }}
          onClose={() => setOpenId(null)}
        />
      ) : null}
      {/* Last, so it draws over the chapter modal the second Write button sits in. */}
      {confirming ? <ConfirmDialog spec={confirming} onClose={() => setConfirming(null)} /> : null}
      {error ? <p className="chat-error">{error}</p> : null}
    </div>
  )
}
