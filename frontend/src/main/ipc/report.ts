/**
 * The report writers' IPC surface: one chapter, the whole "Write all" run, the outline proposal,
 * abbreviations, study translation and the staleness patch. Every call registers its lane in the
 * shared run registry under `report:ai:<uuid>`, so `ai:cancel('report:ai')` pulls them all.
 */
import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'

import {
  DEADLINE_REASON,
  accountGuard,
  costAccount,
  costGuard,
  costNote,
  costReason,
  expandAbbreviations,
  reportDeadlineMs,
  sectionAnswers,
  translateStudyTexts,
  translationAnswers,
  writeAll,
  writeAllAnswers,
  writeSection,
  type WriteBrief,
  type WriteSectionOpts
} from '../ai/reportWriter'
import { providerDefaults } from '../ai/models'
import { getActiveProvider } from '../ai/providers/state'
import { recordUsage } from '../ai/usage'
import { researchWeb, type CostSink } from '../ai/subagent'
import { getSettings } from '../settings'
import { apiError } from '../../shared/backendError'
import { modelForActive, type AiIpcDeps, type RunControllers } from './shared'
import { chapterKey, claimChapters } from './chapterClaims'

export function registerReportIpc(deps: AiIpcDeps, controllers: RunControllers): void {
  // Every report writer books under 'reporting', the chat agent under 'modelling' (the default),
  // speech under 'speech' — the split the ledger shows in Settings (V127).
  const reportCost = (
    m: string,
    u: { cost?: number; prompt?: number; cached?: number; completion?: number }
  ): void => recordUsage(m, u, 'reporting')

  /**
   * The spend ceiling from Settings → AI, bound to one report run.
   *
   * A run is one IPC call, which is what "per run" already means for the chat: one Write, one Write
   * all, one translation. The ceiling is read once per run — raising it mid-run must not move the
   * line the run is being measured against — and `costGuard` carries the rest.
   */
  const costLimited = (controller: AbortController, costRun?: string): CostSink => {
    if (!costRun) return costGuard(getSettings().maxCostUsd, controller, reportCost)
    // The renderer's run (translation → chapters → glossary) is one account across its IPC calls
    // Opened with the limit in force at its first call, like the single guard.
    const account = costAccount(costRun, getSettings().maxCostUsd)
    if (account.stopped) {
      // Refused before it costs anything: the ceiling can only ever hold against the NEXT call.
      throw new Error(costNote(costReason(account.limit, account.spent)))
    }
    return accountGuard(account, controller, reportCost)
  }

  /**
   * The second reader for a write: the Review model of the active provider, its default when none is
   * chosen. Always one — the gate deciding alone is what happens only when the reader fails.
   */
  const secondReader = (): string =>
    modelForActive(getSettings().reviewModel) || providerDefaults(getActiveProvider()).review

  /**
   * The web research a literature chapter may do (writer/lookups.ts): the chat's research sub-agent, on
   * the Research model, under this write's own signal and cost account — a search is billed like the
   * writing it serves, and a Stop or the spend ceiling ends it with the rest.
   */
  const researcher =
    (signal: AbortSignal, onCost: CostSink): NonNullable<WriteSectionOpts['researchWeb']> =>
    (o) =>
      researchWeb({ ...o, model: modelForActive(getSettings().researchModel) || undefined, signal, onCost })
  /** Questions per research call: the chat's setting, at most four for one chapter's background. */
  const researchWidth = (): number => Math.min(getSettings().maxResearchQuestions ?? 4, 4)

  // Read-only backend client for the report writers — the same unwrapping the agent gives its tools,
  // so an error reaches the model as a sentence rather than as a rejected promise.
  const backendApi = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const { status, body: b } = await deps.apiRequest(method, path, body)
    // The shared unwrapper, not a local dialect: this path used to keep only message and hint, so a
    // FastAPI 422 reached a paid chapter run as a bare "HTTP 422" with the field names dropped.
    const failure = apiError(status, b)
    if (failure) throw failure
    return b
  }

  // Renderer → main: write one report chapter. A button in the Report page, not an agent tool — the
  // author sees the text before the backend gate decides whether it may be stored.
  ipcMain.handle(
    'ai:writeSection',
    async (
      e,
      payload: { brief: WriteBrief; model?: string; database?: string | null; checkPath?: string }
    ) => {
      // One key PER CALL, under the 'report:ai:' prefix so `ai:cancel('report:ai')` still pulls every
      // report writer at once. The previous fixed key aborted the *previous registrant* on each call —
      // correct for a lone Write button pressed twice, fatal for "Write all": its four lanes arrive
      // within seconds of each other, so every lane killed the one before it and only the newest
      // stream survived. The hard timeout is the backstop for a stalled stream when nobody is
      // watching — the backend's apiRequest has its 10 minutes too. It aborts with `DEADLINE_REASON`,
      // so the chapter's error says the clock ran out rather than accusing the author of pressing Stop.
      // Its length is the chapter's own: `sectionAnswers` counts the answers this brief can make the
      // writer wait for in turn. Flat ten minutes was one answer's worth for a call that makes a
      // dozen, and one long chapter spent 324 s of them (V185).
      const key = `report:ai:${randomUUID()}`
      const controller = new AbortController()
      controllers.set(key, controller)
      const deadline = setTimeout(
        () => controller.abort(DEADLINE_REASON),
        reportDeadlineMs(sectionAnswers(payload.brief))
      )
      let release = (): void => {}
      try {
        // The chapter's route, as the run's below names it: one writer per chapter (chapterClaims.ts).
        const chapter = payload.checkPath?.replace(/\/proposal$/, '')
        if (chapter) release = claimChapters([chapter])
        // Inside the try: a cost account already spent refuses here, and the finally must still run.
        const onCost = costLimited(controller)
        return await writeSection({
          brief: payload.brief,
          model: modelForActive(payload.model),
          signal: controller.signal,
          onCost,
          maxTokens: getSettings().writerMaxTokens,
          api: backendApi,
          activeDb: payload.database ?? null,
          // Given the section's proposal endpoint, the writer asks the gate before handing the text
          // over and revises what it objected to, instead of leaving the author to press Write again.
          checkPath: payload.checkPath,
          // The reader's brief sits beside the proposal route of the same section.
          reviewModel: secondReader(),
          reviewPath: payload.checkPath?.replace(/\/proposal$/, '/review-brief'),
          researchWeb: researcher(controller.signal, onCost),
          maxResearchQuestions: researchWidth(),
          // One chapter can take minutes, so the wait gets a running commentary — same one-way
          // channel the "Write all" run and the study translation already use.
          onPhase: (p) => {
            try {
              e.sender.send('ai:writePhase', p)
            } catch {
              // The window may be gone mid-write; the chapter finishes and the result still returns.
            }
          }
        })
      } finally {
        release()
        clearTimeout(deadline)
        if (controllers.get(key) === controller) controllers.delete(key)
      }
    }
  )

  // Renderer → main: the whole "Write all" run. The main process owns the waves, the lanes, the one
  // abort signal and the progress stream: the renderer
  // sends the plan and paints the outcomes — cancellation and errors no longer cross two process
  // boundaries. `ai:cancel('report:ai')` aborts the run like any other report writer.
  ipcMain.handle(
    'ai:writeAll',
    async (
      e,
      payload: {
        base: string
        waves: { id: string; mode?: 'write' | 'update' }[][]
        model?: string
        database?: string | null
        /** The renderer's run id, shared with the translation and glossary calls of the same run. */
        costRun?: string
      }
    ) => {
      const key = `report:ai:${randomUUID()}`
      const controller = new AbortController()
      controllers.set(key, controller)
      // The same per-chapter backstop the single write has — scaled by the plan, so a stalled stream
      // cannot pin the run forever while nobody is watching. Scaled by what a chapter actually is,
      // now: `writeAllAnswers` counts a chapter's answers, then the waves, then divides by the lanes,
      // because four chapters written at once are one wait and not four.
      const deadline = setTimeout(
        () => controller.abort(DEADLINE_REASON),
        reportDeadlineMs(writeAllAnswers(payload.waves))
      )
      let release = (): void => {}
      try {
        release = claimChapters(payload.waves.flat().map((c) => chapterKey(payload.base, c.id)))
        // Inside the try, like the single write: the run's account may already be spent by the
        // translation before it, and the deadline and the controller must still be cleared.
        const onCost = costLimited(controller, payload.costRun)
        return await writeAll({
          base: payload.base,
          waves: payload.waves,
          model: modelForActive(payload.model),
          signal: controller.signal,
          api: backendApi,
          activeDb: payload.database ?? null,
          onCost,
          maxTokens: getSettings().writerMaxTokens,
          reviewModel: secondReader(),
          researchWeb: researcher(controller.signal, onCost),
          maxResearchQuestions: researchWidth(),
          onProgress: (p) => {
            try {
              e.sender.send('ai:writeAllProgress', p)
            } catch {
              // The window may be gone mid-run; the run finishes and the result still returns.
            }
          },
          // The inside of each chapter, on the same channel a single Write uses — the payload carries
          // the chapter's id, which is what keeps four lanes from all claiming the same status line.
          onPhase: (p) => {
            try {
              e.sender.send('ai:writePhase', p)
            } catch {
              // As above: a closed window must not take the run down with it.
            }
          }
        })
      } finally {
        release()
        clearTimeout(deadline)
        if (controllers.get(key) === controller) controllers.delete(key)
      }
    }
  )

  /**
   * Cancellation + timeout wrapper for the shorter report helpers — same contract as writeSection.
   *
   * `deadlineMs` is the caller's, because the helpers are not all one model answer long: a flat ten
   * minutes cut a correction off mid-run and reported it as "The correction was cancelled" (V178).
   * `reportDeadlineMs` turns "how many answers does this call wait for in sequence" into the clock,
   * the same arithmetic `writeAll` does over its plan; the abort reason keeps the two apart at the
   * far end, so a lapsed clock never reaches the author as somebody's Stop click.
   */
  const reportAiCall = async <T>(
    // The sink is handed in rather than closed over: it is bound to THIS run's controller, so a
    // helper that overruns the ceiling aborts itself and not whichever run registered last.
    run: (signal: AbortSignal, onCost: ReturnType<typeof costLimited>) => Promise<T>,
    deadlineMs: number,
    costRun?: string
  ): Promise<T> => {
    const key = `report:ai:${randomUUID()}`
    const controller = new AbortController()
    controllers.set(key, controller)
    const deadline = setTimeout(() => controller.abort(DEADLINE_REASON), deadlineMs)
    try {
      return await run(controller.signal, costLimited(controller, costRun))
    } finally {
      clearTimeout(deadline)
      if (controllers.get(key) === controller) controllers.delete(key)
    }
  }

  // Renderer → main: expand a list of abbreviations the backend extracted from the document.
  ipcMain.handle(
    'ai:expandAbbreviations',
    async (
      _e,
      payload: {
        candidates: string[]
        language?: string
        context?: string
        contexts?: Record<string, string>
        model?: string
        costRun?: string
      }
    ) =>
      // Also a single answer, however long the list of abbreviations is.
      reportAiCall(
        (signal, onCost) =>
          expandAbbreviations({
            ...payload,
            model: modelForActive(payload.model),
            signal,
            onCost,
            maxTokens: getSettings().writerMaxTokens
          }),
        reportDeadlineMs(1),
        payload.costRun
      )
  )

  // Renderer → main: translate the study's own prose into the report language (V123). It runs in
  // batches now, so it has a progress to report — same one-way channel the "Write all" run uses.
  ipcMain.handle(
    'ai:translateStudyTexts',
    async (
      e,
      payload: {
        candidates: Array<{ key: string; text: string }>
        language?: string
        model?: string
        costRun?: string
      }
    ) =>
      reportAiCall(
        (signal, onCost) =>
          translateStudyTexts({
            ...payload,
            model: modelForActive(payload.model),
            signal,
            onCost,
            maxTokens: getSettings().writerMaxTokens,
            onProgress: (p) => {
              try {
                e.sender.send('ai:translateProgress', p)
              } catch {
                // The window may be gone mid-run; the translation finishes and the result still returns.
              }
            }
          }),
        // Batched and lane-parallel, so the wait grows with the study's prose rather than staying at
        // one answer: fifty texts are a dozen batches, and only the lanes shorten that wait.
        reportDeadlineMs(translationAnswers(payload.candidates ?? [])),
        payload.costRun
      )
  )
}
