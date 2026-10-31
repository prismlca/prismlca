import { useCallback, useEffect, useState, type MutableRefObject, useRef } from 'react'
import { api } from '../../lib/api'
import { errMsg } from '../../lib/errors'
import {
  aiCancel,
  aiExpandAbbreviations,
  aiTranslateStudyTexts,
  aiWriteAll,
  aiWriteSection,
  onAiTranslateProgress,
  onAiWriteAllProgress,
  onAiWritePhase
} from '../../lib/ai'
import {
  chapterLabel,
  SUMMARISING,
  WRITABLE,
  writerModel,
  type ReportSection,
  type StoredReportFull
} from '../../lib/report/model'
import {
  defaultTicks,
  followSummaries,
  languagePlan,
  mergeTicks,
  planForChapter,
  runDone,
  runErrors,
  runMode,
  runSize,
  runSummary,
  TRANSLATE_STEP,
  type PlanItem
} from '../../lib/report/plan'
import { failureText, type StaleChapter } from '../../lib/report/staleness'
import { answeredSince, openQuestions } from '../../lib/report/chapterStatus'
import { loadDrafts, saveDrafts } from '../../lib/report/draftCache'
import type { ChapterReview } from '../../../../shared/ipc'
import { type WriteStage } from '../../lib/report/writeStatus'

/**
 * Everything a model does to this report — writing, updating, translating, the dry-run plan, the run
 * itself, and what the author answers the writers — as one hook. The panel wires it to its JSX; this orchestration used
 * to be two thirds of the component. The incident comments travel with their code.
 */
export default function useChapterWriter({
  base,
  database,
  reportLang,
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
  openChapter
}: {
  base: string
  database: string
  reportLang: string
  studyLang: string | null
  studyLangGuessed: boolean
  reportRef: MutableRefObject<StoredReportFull | null>
  stale: Record<string, StaleChapter>
  blocker: (kind: string) => string | null
  load: () => Promise<void>
  loadStaleness: () => Promise<Record<string, StaleChapter> | null>
  setStale: (map: Record<string, StaleChapter>) => void
  setStaleFailure: (failure: string | null) => void
  onChanged?: () => void
  setError: (e: string | null) => void
  /** Jump the editor to a chapter (a stored write opens what it wrote; a refused one its draft). */
  openChapter: (sectionId: string) => void
}) {
  const [writing, setWriting] = useState<string | null>(null)
  /** Which single-chapter write is the current one; a run that finishes after a newer one started stays quiet. */
  const writeSeq = useRef(0)
  /** The report this hook serves NOW. A write started for another report must not paint its findings,
   *  drafts or reload into this one once it finishes. */
  const baseRef = useRef(base)
  baseRef.current = base
  /** Set by `cancelRun`: the whole plan stops at its next step, not only the model calls in flight. */
  const cancelled = useRef(false)

  //: The single Write's commentary and its clock. The bulk run has its counter and its bar; one
  //: chapter on its own had a still spinner for as long as six minutes. Both are cleared with
  //: `writing`, so nothing can be left standing after a run.
  const [stage, setStage] = useState<WriteStage | null>(null)
  //: What each lane of a "Write all" run is doing, by chapter id. A single shared status line cannot
  //: carry four lanes, so these are shown next to the chapter names the foot line already lists.
  const [lanes, setLanes] = useState<Record<string, WriteStage>>({})
  const [writeSeconds, setWriteSeconds] = useState(0)
  useEffect(() => {
    if (!writing) return undefined
    setWriteSeconds(0)
    const t = window.setInterval(() => setWriteSeconds((s) => s + 1), 1000)
    return () => window.clearInterval(t)
  }, [writing])
  /** Progress of a "write the rest" run: {done, total}, or null when none is running. */

  //: A running "Write all": the counter, every step by name, and which of them have landed —
  //: the foot line reads its progress from here ("3 of 10 · writing: …") instead of showing the
  //: stored-state summary ("Every chapter written"), which mid-run was a lie.
  const [writingAll, setWritingAll] = useState<{
    done: number
    total: number
    steps: Array<{ id: string; title: string }>
    finished: string[]
  } | null>(null)
  /** Is anything being written NOW? For code after an await, where the render's own values are stale. */
  const runningRef = useRef(false)
  runningRef.current = writing !== null || writingAll !== null
  /** A run that is waiting for the author to say whether out-of-date chapters may be overwritten. */
  //: `checking` while the fresh staleness answer is still on its way: the list is already drawn from
  //: what the panel knew, but nothing may be run against a guess.
  const [plan, setPlan] = useState<{
    items: PlanItem[]
    chosen: string[]
    checking: boolean
    //: Real per-chapter progress of the staleness check — null while nothing is being counted.
    progress: { done: number; total: number } | null
    //: Open review findings in another language than the report's (V425) — asked only while the study
    //: and the report share a language; otherwise the study step covers them anyway.
    foreign?: number
  } | null>(null)
  //: Seconds the dialog's staleness check has been running — the clock that keeps a long check
  //: from reading as a hang. Reset each time a check starts.
  const [checkSeconds, setCheckSeconds] = useState(0)
  useEffect(() => {
    if (!plan?.checking) return undefined
    setCheckSeconds(0)
    const t = window.setInterval(() => setCheckSeconds((s) => s + 1), 1000)
    return () => window.clearInterval(t)
  }, [plan?.checking])

  //: Both seeded from the per-viewer draft cache (V424a): a refused chapter's text and the gate's reasons
  //: for it survive a reload. Lazily, so the save effect below never writes an empty set over the cache
  //: on mount.
  const [findings, setFindings] = useState<Record<string, { kind: string; detail: string }[]>>(
    () => loadDrafts(base).findings
  )

  /**
   * Chapters the gate refused, held OUTSIDE the report: the text was paid for and the author must see
   * it, but it must be neither storable by an accidental blur (the plain section endpoint knows no
   * gate) nor silently thrown away by the next reload. It only enters the report through the gate.
   */
  const [drafts, setDrafts] = useState<
    Record<
      string,
      { text: string; model?: string; lookups?: unknown[]; figure?: unknown; review?: ChapterReview | null }
    >
  >(() => loadDrafts(base).drafts)
  // Mirrored to the cache on every change. `baseRef`, not `base`: on a report switch this effect does not
  // run (neither map changed in that render), and `reset` below then loads the new report's own set —
  // so one report's drafts can never be written under another's key.
  useEffect(() => {
    saveDrafts(baseRef.current, drafts, findings)
  }, [drafts, findings])
  const [note, setNote] = useState<string | null>(null)

  /**
   * Clear this hook's per-report chatter. MEMOISED ON PURPOSE, and it must stay that way: the panel
   * lists it in the dependency array of the effect that switches reports (`ReportSections`), so a
   * fresh identity per render made that effect fire on every render — it called `setReport(null)`
   * each time, the report never finished loading, and the renderer sat in a render loop at 100 % CPU
   * with the Report page stuck on "Loading…" (observed in practice). The five
   * setters are React state setters and are stable, so the empty dependency list is honest.
   */
  const cancelRun = useCallback((): void => {
    cancelled.current = true
    void aiCancel('report:ai')
  }, [])

  const reset = useCallback((): void => {
    setNote(null)
    // The report now open brings its own drafts and their reasons back from the cache (V424a); the
    // previous report's stay in theirs.
    const cached = loadDrafts(baseRef.current)
    setFindings(cached.findings)
    setDrafts(cached.drafts)
    setPlan(null)
  }, [])

  const storeDraft = useCallback(
    async (sectionId: string) => {
      const draft = drafts[sectionId]
      if (!draft) return
      setWriting(sectionId)
      try {
        const verdict = await api<{
          ok: boolean
          stored: boolean
          findings: { kind: string; detail: string }[]
        }>('POST', `${base}/sections/${sectionId}/proposal`, {
          ...draft,
          store: true,
          // A draft a second model read keeps that reading: the gate then decides on the contract.
          ...(draft.review ? { reviewed_by: draft.review.reviewer } : {})
        })
        setFindings((f) => ({ ...f, [sectionId]: verdict.findings }))
        if (verdict.stored) {
          setDrafts((d) => {
            const next = { ...d }
            delete next[sectionId]
            return next
          })
          setNote('Draft passed the figures-and-placeholders check and was stored — expert review pending.')
          await load()
          await loadStaleness()
          onChanged?.()
        }
      } catch (e) {
        setError(errMsg(e))
      } finally {
        setWriting(null)
      }
    },
    [drafts, base, load, loadStaleness, onChanged, setNote, setError]
  )

  const discardDraft = useCallback((sectionId: string): void => {
    setDrafts((d) => {
      const next = { ...d }
      delete next[sectionId]
      return next
    })
    setFindings((f) => ({ ...f, [sectionId]: [] }))
  }, [])

  /** Errors from an AI run — a cancel is the user's own action, not a failure. */
  const showAiError = useCallback(
    (e: unknown): void => {
      const msg = errMsg(e)
      if (/abort|cancel/i.test(msg)) setNote('Canceled.')
      else setError(msg)
    },
    [setError]
  )

  /**
   * Have a model write this chapter: fetch the brief from the backend, hand it to the model, then post
   * the result back through the gate. Nothing is stored unless the gate is clean — and its findings are
   * shown rather than silently swallowed, because a missing fact often belongs in the study metadata
   * rather than in the bin.
   */
  const writeOne = useCallback(
    async (section: ReportSection, opts?: { quiet?: boolean }) => {
      // Quiet = one of several chapters written at once: the single `writing` marker, the "open the
      // chapter I just wrote" jump and the full reload all belong to ONE chapter being written on its
      // own. Four of them fighting over the same three pieces of state is how a parallel run would look
      // like a bug. The run reloads once at the end instead.
      const quiet = opts?.quiet === true
      const mine = ++writeSeq.current
      const myBase = base
      /** The panel has moved to another report since this write started. */
      const elsewhere = (): boolean => baseRef.current !== myBase
      if (!quiet) setWriting(section.id)
      setError(null)
      // The previous run's receipt — "Canceled." included — would otherwise stand under this run's
      // progress and outlive its result (V355).
      if (!quiet) setNote(null)
      setFindings((f) => ({ ...f, [section.id]: [] }))
      // The wait, made legible. Only for a chapter written on its own: a "Write all" lane stamps its
      // chapter's id on every phase, and four lanes talking over one status line is worse than silence.
      let offPhase: (() => void) | null = null
      if (!quiet) {
        setStage({ phase: 'brief' })
        offPhase = onAiWritePhase((p) => {
          if (!p.id) setStage(p)
        })
      }
      // Kept outside the try: if the storing call below throws (backend restart, transient error),
      // the generated — and paid-for — text is rescued as a draft instead of vanishing into the catch.
      let generated: {
        text: string
        model?: string
        lookups?: unknown[]
        figure?: unknown
        review?: ChapterReview | null
      } | null = null
      try {
        const brief = await api<{ snapshot_id?: string; text_version?: string }>(
          'POST',
          `${base}/sections/${section.id}/brief`,
          {}
        )
        // The report-writing model (Settings → AI → Models), which falls back to the chat model.
        const { text, model, lookups, attempts, figure, findings, incomplete, review } = await aiWriteSection(
          brief,
          writerModel(),
          database,
          // The writer checks against the gate itself and revises what it objected to, so what arrives
          // here has usually already survived the check.
          `${base}/sections/${section.id}/proposal`
        )
        generated = { text, model, lookups, figure, review }
        if (elsewhere()) return false
        if (incomplete) {
          // Not a chapter — no finish signal, cut off, empty, or stopped with text in hand. Held as a
          // draft with the reason under it; nothing goes to the gate.
          if (text.trim()) setDrafts((d) => ({ ...d, [section.id]: { text, model, lookups, figure } }))
          setFindings((f) => ({ ...f, [section.id]: findings }))
          if (!quiet) setNote(findings[0]?.detail ?? 'The answer was incomplete and was not stored.')
          return false
        }
        if (!quiet) setStage({ phase: 'storing' })
        const verdict = await api<{
          ok: boolean
          stored: boolean
          findings: { kind: string; detail: string }[]
        }>(
          'POST',
          `${base}/sections/${section.id}/proposal`,
          // The lookups travel with the text: the gate accepts a fact only if it was handed over, and a
          // process description the writer fetched is exactly such a fact. The figure request travels the
          // same way, to be validated against the whitelist before anything is stored. The brief's
          // snapshot and text version go too: a recalculation or a hand edit since the brief makes the
          // backend refuse, and the text is rescued as a draft below.
          {
            text,
            store: true,
            model,
            lookups,
            figure,
            snapshot_id: brief.snapshot_id,
            expected_text_version: brief.text_version,
            // Read by a second model: the gate decides on the contract alone and keeps the reading.
            ...(review ? { reviewed_by: review.reviewer, review } : {})
          }
        )
        if (elsewhere()) return verdict.stored
        setFindings((f) => ({ ...f, [section.id]: verdict.findings }))
        // Only once the outcome is known: announcing "corrected" next to blocking findings — the
        // attempts counter also rises when a revision *failed* — read as success where there was none.
        if (attempts > 1 && verdict.stored && !quiet) {
          setNote(`Corrected after ${attempts - 1} revision${attempts > 2 ? 's' : ''}.`)
        }
        if (verdict.stored) {
          setDrafts((d) => {
            const next = { ...d }
            delete next[section.id]
            return next
          })
          if (!quiet) {
            await load()
            await loadStaleness()
            onChanged?.()
            openChapter(section.id)
          }
        } else {
          // Not stored, but the author should still see what was written and why it was refused — as
          // a draft, not as the chapter's text: writing it into `report.sections` let the textarea's
          // blur-save persist it past the gate, and any other mutation's reload silently deleted it.
          setDrafts((d) => ({ ...d, [section.id]: { text, model, lookups, figure, review } }))
          if (!quiet) openChapter(section.id)
        }
        return verdict.stored
      } catch (e) {
        // A cancelled run answers late — after the user has already started the next one. Its
        // "Canceled." must not land on that newer run's line.
        if (elsewhere()) return false
        if (writeSeq.current === mine) showAiError(e)
        if (generated) {
          setDrafts((d) => ({ ...d, [section.id]: generated! }))
          if (!quiet) openChapter(section.id)
        }
        return false
      } finally {
        offPhase?.()
        if (!quiet) {
          setWriting(null)
          setStage(null)
        }
      }
    },
    [base, database, load, loadStaleness, showAiError, onChanged, openChapter, setError, setNote]
  )

  /** One chapter, written on its own: the per-row Write button. */
  const write = useCallback((section: ReportSection) => writeOne(section), [writeOne])

  //: What the translate button last said — collection progress, then the counts.
  const [translateNote, setTranslateNote] = useState<string | null>(null)

  /**
   * Carry the study's own prose into the report language (V123, released with "automatische
   * Übersetzung durch AI"). Collecting is the backend's deterministic walk; the model only
   * translates that fixed list, and the backend drops any key that was never a candidate — the
   * same division of labour as the abbreviations. Texts already in the report language are stored
   * as checked, so the next run has nothing open instead of re-asking forever.
   */
  const translateStudy = useCallback(
    async (costRun?: string, scope: 'all' | 'foreign' = 'all') => {
      setWriting('translations')
      setError(null)
      setTranslateNote('Collecting study texts (computes the report data if not cached)…')
      try {
        const found = await api<{
          open: Array<{ key: string; text: string }>
          unchanged: Array<{ key: string; text: string }>
          total: number
          stored: number
          language: string
          /** Open review findings in another language than the report's (V425). */
          foreign?: Array<{ key: string; text: string }>
        }>('POST', `${base}/translations`, {})
        // The unchanged ones ride along on purpose: a stored answer that IS the source is either
        // genuinely in the report language or a lazy model keeping a short scenario name — asking
        // again is cheap, and it is the only way a stuck German label ever gets unstuck.
        // With the study already in the report language only the reviewer's English goes (V425): the
        // rest would come back as it went, paid for.
        const candidates =
          scope === 'foreign' ? (found.foreign ?? []) : [...found.open, ...(found.unchanged ?? [])]
        if (!candidates.length) {
          setTranslateNote(
            found.total ? 'Every study text is already covered.' : 'No study texts to translate.'
          )
          return
        }
        setTranslateNote(`Translating ${candidates.length} study texts…`)
        // This line used to stand unchanged for nine and a half minutes — half of a whole run, with
        // nothing to say whether anything was happening (V171). The main process cuts the translation
        // into batches now, and every batch that lands moves the count.
        const offProgress = onAiTranslateProgress((p) =>
          setTranslateNote(`Translating study texts — ${p.done} of ${p.total}…`)
        )
        const { resolved } = await aiTranslateStudyTexts(
          candidates,
          found.language,
          writerModel(),
          costRun
        ).finally(offProgress)
        const stored = await api<{
          translated: number
          identical: number
          dropped: string[]
          /** Candidates whose translation changed a figure — refused, with the reason. */
          rejected?: Array<{ key: string; text: string; reason: string }>
        }>('POST', `${base}/translations/set`, { resolved })
        const rejected = stored.rejected ?? []
        setTranslateNote(
          `${stored.translated} translated, ${stored.identical} already in the report language` +
            (stored.dropped.length ? `, ${stored.dropped.length} dropped` : '') +
            // Said with the first reason: a translation that changes a number is refused, because a stored
            // translation is a source the check quotes figures from.
            (rejected.length
              ? `, ${rejected.length} refused — ${rejected[0].reason} (“${rejected[0].text.slice(0, 60)}”)`
              : '') +
            '.'
        )
        await load()
        onChanged?.()
      } catch (e) {
        setTranslateNote(null)
        showAiError(e)
      } finally {
        setWriting(null)
      }
    },
    [base, load, onChanged, showAiError, setError]
  )

  /**
   * Resolve the document's abbreviations. The candidates are extracted server-side from the rendered
   * document, the model only supplies meanings, and the backend drops any key that was not a candidate —
   * so this cannot invent an entry for something the report never mentions.
   */
  const resolveAbbreviations = useCallback(
    async (section: ReportSection, costRun?: string) => {
      setWriting(section.id)
      setError(null)
      setFindings((f) => ({ ...f, [section.id]: [] }))
      try {
        const found = await api<{
          candidates: string[]
          language: string
          contexts?: Record<string, string>
        }>('POST', `${base}/abbreviations`, {})
        if (!found.candidates.length) {
          setFindings((f) => ({
            ...f,
            [section.id]: [{ kind: 'none', detail: 'The document uses no abbreviations worth explaining.' }]
          }))
          return
        }
        const { resolved } = await aiExpandAbbreviations(
          found.candidates,
          found.language,
          'Life cycle assessment report',
          writerModel(),
          costRun,
          found.contexts
        )
        const stored = await api<{ resolved: Record<string, string>; dropped: string[] }>(
          'POST',
          `${base}/abbreviations/set`,
          { resolved }
        )
        const count = Object.keys(stored.resolved).length
        setFindings((f) => ({
          ...f,
          [section.id]: [
            {
              kind: 'info',
              detail:
                `${count} of ${found.candidates.length} abbreviations resolved` +
                (stored.dropped.length
                  ? `; ${stored.dropped.length} dropped as not used in the document.`
                  : '.')
            }
          ]
        }))
        await load()
      } catch (e) {
        showAiError(e)
      } finally {
        setWriting(null)
      }
    },
    [base, load, showAiError, setError]
  )

  /** What would happen to each chapter, given what is known about their staleness right now. */
  const planItems = useCallback(
    (known: Record<string, StaleChapter> | null): PlanItem[] => {
      const order = [...(reportRef.current?.sections ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      const candidates = order.filter((s) => !s.locked && WRITABLE.has(s.kind))
      // Whether the freshness check has anything to say about this chapter: no entry at all, or one
      // whose findings carry the "unknown" kind (a chapter written before the record existed).
      const uncomparable = (s: ReportSection): boolean =>
        !known?.[s.id] || Boolean(known[s.id].findings?.some((f) => f.kind === 'unknown'))
      const answers = reportRef.current?.answers
      const items: PlanItem[] = candidates.map((section) =>
        planForChapter(
          section,
          known?.[section.id],
          blocker(section.kind),
          !uncomparable(section),
          answeredSince(section, answers)
        )
      )
      const glossary = order.find((s) => s.kind === 'abbreviations' && !s.locked)
      const planned = followSummaries(items)
      if (glossary)
        planned.push({ section: glossary, action: 'glossary', why: 'Rebuilt from the finished chapters.' })
      return planned
    },
    [blocker, reportRef]
  )

  /**
   * The dry run. Nothing is written and nothing is paid for — the run already knows exactly what it
   * would do, so it says so first, by chapter name, and lets the author take the list apart.
   *
   * It used to ask only when it was about to overwrite something, and then only in numbers ("3 are
   * out of date"). Which three was not sayable, so the choice was all or nothing — and the four
   * categories it silently left alone were invisible unless you read the note afterwards.
   *
   * **The list appears at once and settles a moment later.** Which chapters are out of date is what
   * this run decides on, so it asks the backend rather than trusting whatever the panel happened to
   * load on arrival — but on an ecoinvent model with several variants that answer takes tens of
   * seconds, and waiting for it before drawing anything made the button look dead. So: draw
   * immediately from what is known, say plainly that the check is still running, and keep Run shut
   * until the fresh answer has re-sorted the rows.
   */
  const planAll = useCallback(async () => {
    const provisional = planItems(Object.keys(stale).length ? stale : null)
    // What the check actually compares: the chapters carrying text. Asked for one by one, so the
    // dialog can show real progress ("3 of 10 chapters checked") — the backend shares one data
    // snapshot across the calls, so N small answers cost what one big one did. The first call
    // carries the snapshot build and is the long one; the bar says so instead of a silent stall.
    const written = (reportRef.current?.sections ?? []).filter((s) => (s.text ?? '').trim()).map((s) => s.id)
    setPlan({
      items: provisional,
      chosen: defaultTicks(provisional),
      checking: true,
      progress: written.length ? { done: 0, total: written.length } : null
    })
    let known: Record<string, StaleChapter> | null
    if (!written.length) {
      known = await loadStaleness() // instant: nothing written, the backend answers without computing
    } else {
      try {
        const map: Record<string, StaleChapter> = {}
        for (const [index, id] of written.entries()) {
          const r = await api<{ chapters: StaleChapter[] }>('POST', `${base}/staleness`, {
            section_ids: [id]
          })
          for (const c of r.chapters) map[c.section_id] = c
          setPlan((p) => (p ? { ...p, progress: { done: index + 1, total: written.length } } : p))
        }
        setStale(map)
        setStaleFailure(null)
        known = map
      } catch (e) {
        setStale({})
        // null, not {}: "nothing is out of date" and "could not be checked" are different answers.
        // And the same reason goes to the foot, which outlives this dialog: the author closes it, and
        // whatever the plan said about "no record of what this was written against" goes with it.
        setStaleFailure(failureText(e))
        known = null
      }
    }
    const items = planItems(known)
    // V425: whether the run has review findings to translate although the study needs no translating.
    // Asked of the review log alone, never of the snapshot: with nothing written the check above built
    // none, and building it here held the dialog for the whole calculation. A failure costs the step,
    // never the dialog.
    let foreign = 0
    if (studyLang != null && studyLang === reportLang) {
      try {
        const found = await api<{ foreign?: unknown[] }>('POST', `${base}/translations/foreign`, {})
        foreign = found.foreign?.length ?? 0
      } catch {
        foreign = 0
      }
    }
    // Functional, so a dialog the author cancelled during the check stays cancelled — the plain set
    // reopened it half a minute later, now with Run enabled. And `mergeTicks`, so it does not also
    // throw away the boxes ticked while the check was running.
    setPlan((p) =>
      p
        ? { items, chosen: mergeTicks(p.items, p.chosen, items), checking: false, progress: null, foreign }
        : p
    )
  }, [planItems, loadStaleness, stale, base, reportRef, setStale, setStaleFailure, studyLang, reportLang])

  /**
   * Run exactly what the author ticked.
   *
   * In waves, not one by one, because two things genuinely do depend on what came before:
   *   1. every ordinary chapter, concurrently;
   *   2. the conclusions, which conclude from the rest;
   *   3. the executive summary, which sums up the rest — the conclusions included.
   * The glossary follows, as a call of its own: it can only know an abbreviation once some chapter has
   * used it. A ticked update brings its chapter up to date; a ticked write writes it (anew).
   *
   * A chapter that fails or is refused does not stop the run — it keeps its reason and the rest still
   * get written.
   */
  const execute = useCallback(
    async (current: { items: PlanItem[]; chosen: string[]; foreign?: number }) => {
      const picked = current.items.filter((i) => current.chosen.includes(i.section.id))
      const todo = picked.filter((i) => i.action !== 'glossary')
      const glossary = picked.find((i) => i.action === 'glossary')?.section
      const wave = (kinds: (k: string) => boolean): { id: string; mode: 'write' | 'update' }[] =>
        todo.filter((i) => kinds(i.section.kind)).map((i) => ({ id: i.section.id, mode: runMode(i) }))
      const waves = [
        wave((k) => !SUMMARISING.has(k)),
        wave((k) => k === 'conclusions'),
        wave((k) => SUMMARISING.has(k) && k !== 'conclusions')
      ].filter((w) => w.length)

      if (!todo.length && !glossary) {
        setNote('Nothing to run.')
        return
      }
      // The study is documented in another language than this report: translate its texts FIRST, so
      // every writer sees the translated functional unit, notes and scenario names — that is what
      // makes the document uniform instead of bilingual. Idempotent: covered sources are skipped, and
      // with nothing open no model is called. With study and report in one language only the review
      // findings written in another one are asked for (V425).
      const studyStep = languagePlan(studyLang, reportLang, studyLangGuessed).translate
      const { translation, total } = runSize(
        current.items,
        current.chosen,
        languagePlan(studyLang, reportLang, studyLangGuessed, current.foreign ?? 0).translate
      )
      const translating = translation > 0
      const order = waves.flat().map((w) => w.id)
      const sectionOf = (id: string): ReportSection | undefined =>
        todo.find((i) => i.section.id === id)?.section
      const steps = [
        ...(translating ? [{ id: TRANSLATE_STEP, title: 'Study texts' }] : []),
        ...order.map((id) => ({ id, title: chapterLabel(sectionOf(id)!) })),
        ...(glossary ? [{ id: glossary.id, title: chapterLabel(glossary) }] : [])
      ]
      // Set BEFORE the translation: it is a model call of its own and took four minutes on a German
      // study in an English report, and during it the foot line said nothing at all (V149).
      setWritingAll({ done: 0, total, steps, finished: [] })
      cancelled.current = false
      const myBase = base
      // One cost account for the whole run — translation, chapter block, glossary.
      const costRun = `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
      if (translating) {
        await translateStudy(costRun, studyStep ? 'all' : 'foreign')
        if (cancelled.current || baseRef.current !== myBase) {
          setWritingAll(null)
          return
        }
        setWritingAll((p) => (p ? { ...p, done: p.done + 1, finished: [...p.finished, TRANSLATE_STEP] } : p))
      }
      // The run itself lives in the MAIN process (waves, lanes, abort, progress) — this side sends the
      // plan and paints what comes back. `p.done` counts chapters only; the translation is added back as
      // an offset (V169).
      const offProgress = onAiWriteAllProgress((p) =>
        setWritingAll((prev) =>
          prev
            ? {
                ...prev,
                done: runDone(p.done, translation, total),
                finished: p.outcome?.id ? [...prev.finished, p.outcome.id] : prev.finished
              }
            : prev
        )
      )
      // What each lane is doing, kept apart by the chapter id every phase carries (V269).
      setLanes({})
      const offLane = onAiWritePhase((p) => {
        if (p.id) setLanes((prev) => ({ ...prev, [p.id as string]: p }))
      })
      try {
        const outcomes = waves.length
          ? await aiWriteAll({ base, waves, model: writerModel(), database, costRun })
          : []
        if (baseRef.current !== myBase) return
        for (const outcome of outcomes) {
          setFindings((f) => ({ ...f, [outcome.id]: outcome.stored ? [] : (outcome.findings ?? []) }))
          if (outcome.stored) {
            setDrafts((d) => {
              const next = { ...d }
              delete next[outcome.id]
              return next
            })
          } else if (outcome.text) {
            // The paid-for text survives as a draft where there is one — a cancelled stream has none.
            const draft = {
              text: outcome.text,
              model: outcome.model,
              lookups: outcome.lookups,
              figure: outcome.figure,
              review: outcome.review
            }
            setDrafts((d) => ({ ...d, [outcome.id]: draft }))
          }
        }
        // One reload for the whole run, and one notify upward: the preview pane's stale banner reads the
        // parent's list stamp.
        await load()
        await loadStaleness()
        onChanged?.()
        // A cancelled chapter block must not start the glossary call — one more paid call after Cancel.
        if (glossary && !cancelled.current) {
          const fresh = reportRef.current?.sections.find((x) => x.id === glossary.id)
          if (fresh && !fresh.locked) await resolveAbbreviations(fresh, costRun)
          setWritingAll((prev) =>
            prev ? { ...prev, done: total, finished: [...prev.finished, glossary.id] } : prev
          )
        }
        // Counted from what came back, not from what was asked: a provider refusing every call still read
        // "9 written" over chapters that had no text. The first error is named.
        const stored = outcomes.filter((o) => o.stored)
        const errors = runErrors(outcomes, reportRef.current?.sections ?? [])
        setNote(
          cancelled.current
            ? 'Canceled.'
            : runSummary({
                written: stored.filter((o) => !o.update).length,
                updated: stored.filter((o) => o.update === 'edited').length,
                unchanged: stored.filter((o) => o.update === 'unchanged').length,
                unfinished: outcomes.length - stored.length,
                firstError: errors[0],
                errors: errors.length
              })
        )
      } catch (e) {
        showAiError(e)
      } finally {
        offProgress()
        offLane()
        setLanes({})
        setWritingAll(null)
      }
    },
    [
      resolveAbbreviations,
      load,
      loadStaleness,
      base,
      database,
      showAiError,
      studyLang,
      studyLangGuessed,
      reportLang,
      translateStudy,
      onChanged,
      reportRef
    ]
  )

  /** The dialog's Run: what the author ticked. */
  const runPlan = useCallback(async () => {
    const current = plan
    if (!current) return
    setPlan(null)
    await execute(current)
  }, [plan, execute])

  /** One chapter brought up to date on its own — "Have it fixed" on a point the reader still doubts. */
  const updateOne = useCallback(
    (section: ReportSection) =>
      execute({ items: [{ section, action: 'update', why: '' }], chosen: [section.id], foreign: 0 }),
    [execute]
  )

  /**
   * The author's answer to a question a writer asked. Stored with the report, so every brief from now
   * on carries it — and the chapter that asked is updated with it at once, as soon as none of its
   * questions is open any more: an answer is the go-ahead, and leaving the chapter on "Needs update"
   * made the author start a second run for what they had just settled. While another write is under
   * way, or the chapter is locked or cannot be written, it keeps the badge and the next run takes it.
   */
  const answerQuestion = useCallback(
    async (
      section: ReportSection,
      questionId: string,
      question: string,
      answer: string
    ): Promise<boolean> => {
      setError(null)
      try {
        await api('POST', `${base}/answers`, { question_id: questionId, question, answer })
        await load()
      } catch (e) {
        setError(errMsg(e))
        return false
      }
      const fresh = reportRef.current?.sections.find((s) => s.id === section.id)
      const ready =
        fresh &&
        !fresh.locked &&
        blocker(fresh.kind) === null &&
        !runningRef.current &&
        openQuestions(fresh, reportRef.current?.answers).length === 0
      if (ready) void updateOne(fresh)
      return true
    },
    [base, load, setError, reportRef, blocker, updateOne]
  )

  /** Keep a sentence the second reader still doubted, as written. Free; nothing is rewritten. */
  const keepPoint = useCallback(
    async (section: ReportSection, quote: string): Promise<void> => {
      setError(null)
      try {
        await api('POST', `${base}/sections/${section.id}/keep-point`, { quote })
        await load()
      } catch (e) {
        setError(errMsg(e))
      }
    },
    [base, load, setError]
  )

  return {
    writing,
    stage,
    lanes,
    writeSeconds,
    writingAll,
    plan,
    setPlan,
    checkSeconds,
    findings,
    setFindings,
    drafts,
    // An edited draft is not the text the second reader read: its reading goes, and storing it is
    // judged by the gate alone.
    setDraftText: (id: string, text: string) =>
      setDrafts((d) => ({ ...d, [id]: { ...d[id], text, review: null } })),
    note,
    setNote,
    translateNote,
    storeDraft,
    discardDraft,
    showAiError,
    write,
    translateStudy,
    resolveAbbreviations,
    planAll,
    runPlan,
    updateOne,
    answerQuestion,
    keepPoint,
    /** The Cancel buttons: pulls every report writer in main AND stops the plan here — the next step of
     *  a "Write all" (chapters after the translation, the glossary after the chapters) must not start. */
    cancelRun,
    /** Switching reports must not carry the previous one's chatter along (the panel's switch effect). */
    reset
  }
}
