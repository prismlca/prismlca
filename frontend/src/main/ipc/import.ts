/**
 * Running the matching model over an import — main-side, because that is where the model lives.
 *
 * The renderer never talks to a model directly; the backend never talks to one at all. So the
 * matcher sits here: it pulls the open rows from the backend, asks the model in batches, and posts
 * the decisions back. Nothing about the decision is invented here — the confidence a decision
 * carries is bounded by `importMatcher`, and the backend still bands it by its own rules.
 */
import { ipcMain } from 'electron'

import { BATCH, matchBatch, type MatchDecision, type MatchRow } from '../ai/importMatcher'
import { providerDefaults } from '../ai/models'
import { recordUsage } from '../ai/usage'
import { getSettings } from '../settings'
import type { AiIpcDeps } from './shared'

export interface MatchProgress {
  done: number
  total: number
  matched: number
  open: number
}

/** How many batches run at once. Four keeps a 1 200-flow import at minutes instead of an hour,
 *  without hammering a provider — each batch is one request, exactly like four chat turns. */
const CONCURRENCY = 4

/** The run currently in flight, so `import:match:stop` can reach it. One import at a time by
 *  construction (the backend holds one session), so a single slot is the honest model. */
let activeRun: AbortController | null = null

/** Whether a matching run is in flight, a stopped one winding down included (main/keepAwake.ts). */
export function importMatchRunning(): boolean {
  return activeRun !== null
}

export function registerImportIpc(deps: AiIpcDeps): void {
  /** The stop button. Batches already paid for are kept — abort only stops what has not started. */
  ipcMain.handle('import:match:stop', () => {
    activeRun?.abort()
  })

  /**
   * Match everything the deterministic pass left open. Progress goes to the renderer as it lands,
   * because a 300-flow import is minutes and a still spinner is indistinguishable from a hang.
   */
  ipcMain.handle('import:match', async (): Promise<MatchProgress & { error?: string }> => {
    const settings = getSettings()
    const model = settings.matchModel || providerDefaults(settings.provider).match
    // One run at a time, by construction of the backend session — a second start used to take the
    // stop handle away from the first, which then ran on unreachable and kept deciding rows the
    // second was deciding too.
    if (activeRun && !activeRun.signal.aborted) {
      return {
        done: 0,
        total: 0,
        matched: 0,
        open: 0,
        error: 'A matching run is still in progress — stop it first, or wait for it to finish.'
      }
    }
    const { status: rowsStatus, body } = await deps.apiRequest('GET', '/api/v1/import/rows?only_open=true')
    if (rowsStatus >= 400) {
      return {
        done: 0,
        total: 0,
        matched: 0,
        open: 0,
        error: `Could not load the open rows (HTTP ${rowsStatus}).`
      }
    }
    // `needs_model`, not "open and has candidates" — the two are not the same, and the difference
    // showed up as a button offering 109 rows while the progress counted 110.
    // A row whose identifier hit but whose unit will not convert is open and HAS a candidate, and
    // the rules deliberately did not hand it over: its one candidate is the wrong unit, so asking
    // the model to choose from it invites exactly the match the rules just refused.
    const rows = ((body as { rows?: (MatchRow & { needs_model?: boolean })[] } | null)?.rows ?? [])
      .filter((r) => r.needs_model !== false)
      .filter((r) => (r.candidates?.length ?? 0) > 0)
    const progress: MatchProgress = { done: 0, total: rows.length, matched: 0, open: 0 }
    if (!rows.length) return progress

    // The same ceiling a chat turn gets (Settings → AI → Limits). An import is one deliberate act,
    // so it counts as one run: 3 000 flows on an expensive model is a bill nobody sees coming, and
    // an import that stops half way is not a loss — the rows it did not reach simply stay open,
    // which is where they were.
    const limit = Number(settings.maxCostUsd) || 0
    let spent = 0

    // Flows and processes are two tasks with two sets of instructions — an elementary flow is
    // judged on substance and compartment, a technosphere input on product and dataset kind. A
    // mixed batch would have to be given one prompt and therefore the wrong one for half of it,
    // so each kind is batched on its own rather than merely sorted: a slice
    // straddling the boundary would mix them again.
    const groups = [
      rows.filter((r) => r.kind === 'biosphere'),
      rows.filter((r) => r.kind !== 'biosphere')
    ].filter((g) => g.length)

    // The batches, in order — a queue the workers drain. Built up front so "parallel" cannot mean
    // "one worker per batch": 60 batches are still at most CONCURRENCY requests in flight.
    const queue: MatchRow[][] = []
    for (const group of groups) {
      for (let start = 0; start < group.length; start += BATCH) {
        queue.push(group.slice(start, start + BATCH))
      }
    }

    const controller = new AbortController()
    activeRun = controller
    let failure: string | undefined
    const halt = (reason?: string): void => {
      if (reason && !failure) failure = reason
      controller.abort()
    }

    const worker = async (): Promise<void> => {
      for (;;) {
        const slice = queue.shift()
        if (!slice || controller.signal.aborted) return
        let decisions: MatchDecision[] = []
        try {
          decisions = await matchBatch(slice, {
            model,
            signal: controller.signal,
            // Read with the rest of the settings at the start of the run, like the cost limit
            // (the import used to send the 50 000 default whatever the user had set).
            maxTokens: settings.maxTokens,
            // `recordUsage`, not `recordCost`: a cost-only entry would hide how big an import is,
            // and the tokens are the honest measure of that. Its own category, so the answer to
            // "what did that import cost" is not buried in the chat spend.
            onCost: (id, sample) => {
              spent += Number(sample.cost) || 0
              recordUsage(id, sample, 'import')
            }
          })
        } catch (e) {
          // A stopped run is not a failed one; anything else halts the sisters too — but never
          // loses the batches already applied: their rows stay decided, the rest stay open.
          if (!controller.signal.aborted) halt(e instanceof Error ? e.message : String(e))
          return
        }
        // A batch the run was stopped in mid-answer never gets here: the matcher throws MatchStopped
        // and the catch above drops it whole, its rows open for the next run. One whose answers
        // had both finished does get here even after a stop or a sister's cost halt — it is paid for
        // and complete, so it is applied and counted.
        // The hand-over is part of the batch: a transport failure here used to escape the worker,
        // reject the whole IPC call and leave the sisters running with no stop handle; a refused
        // hand-over (HTTP 4xx/5xx) counted as progress.
        let applied: { status: number; body: unknown }
        try {
          applied = await deps.apiRequest('POST', '/api/v1/import/decide', { decisions })
        } catch (e) {
          if (!controller.signal.aborted) halt(e instanceof Error ? e.message : String(e))
          return
        }
        if (applied.status >= 400) {
          const detail = (applied.body as { error?: { message?: string } } | null)?.error?.message
          halt(
            `The backend refused a batch of decisions (HTTP ${applied.status}${detail ? `: ${detail}` : ''}).`
          )
          return
        }
        progress.done += slice.length
        progress.matched += decisions.filter((d) => d.code).length
        progress.open += decisions.filter((d) => !d.code).length
        deps.getWindow()?.webContents.send('import:match-progress', { ...progress })
        if (limit > 0 && spent >= limit) {
          // Checked between batches, never inside one: a batch that has been paid for should also
          // be applied. With workers in parallel the limit can overshoot by what was already in
          // flight — bounded by CONCURRENCY batches. Those whose answers had finished are applied;
          // those the halt cut mid-answer are dropped, their rows open for the next run.
          halt(
            `Stopped at the cost limit of $${limit.toFixed(2)} for one run (Settings → AI → ` +
              `Limits). ${progress.done} of ${progress.total} rows were matched; the rest are ` +
              `still open and another run picks up where this one stopped.`
          )
          return
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
    } finally {
      if (activeRun === controller) activeRun = null
    }
    if (failure) return { ...progress, error: failure }
    // A stop that lands after the last row changed nothing — saying "stopped" then would send the
    // user hunting for rows that were in fact all asked (measured: 92/92 done in 35 s, stop at 35).
    if (controller.signal.aborted && progress.done < progress.total) {
      return {
        ...progress,
        error:
          `Stopped by you. ${progress.done} of ${progress.total} rows were asked; their answers ` +
          `are kept, the rest stay open and another run picks up where this one stopped.`
      }
    }
    return progress
  })
}
