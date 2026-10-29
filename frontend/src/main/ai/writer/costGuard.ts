/** Why a report writer stopped — its deadline, its spend ceiling or a Stop — and the guards that stop it. */
import type { CostSink } from '../subagent'

/**
 * Why a report writer stopped: the backstop's clock ran out, or somebody pressed Stop.
 *
 * The two are told apart by the abort *reason*, never by reading an error message — the message is
 * the thing that was wrong (V178): a lapsed ten-minute backstop was reported to the author as "The
 * correction was cancelled", so a run nobody had touched blamed the author for stopping it. Same
 * separation `runResearch` keeps for its research legs, and for the same reason: the two need
 * different words, because they suggest different next steps.
 */
export const DEADLINE_REASON = { deadline: true } as const

/**
 * What the author reads when a backstop fired. It says what happened and what to do about it — the
 * one lever that actually helps here is asking for less at a time, because "Correct all" and "Write
 * all" start every chapter at once and the calls then queue against each other at the provider.
 */
export const DEADLINE_NOTE =
  'The request ran past its time limit and was stopped. Try again, or run fewer chapters at once.'

/**
 * Why a report writer stopped: the run reached the spend ceiling from Settings → AI.
 *
 * The third reason a signal can be aborted, and it needs its own words for the reason the deadline
 * does: "the correction was cancelled" sends the author back to the button, while this one is only
 * answered in Settings. It carries the figures because a limit the author cannot see is a limit they
 * cannot act on — the chat agent names them in its own stop note for the same reason.
 */
export type CostReason = { cost: true; limit: number; spent: number }
export const costReason = (limit: number, spent: number): CostReason => ({ cost: true, limit, spent })
const isCostReason = (r: unknown): r is CostReason =>
  typeof r === 'object' && r !== null && (r as { cost?: unknown }).cost === true

/** What the author reads when the spend ceiling stopped the run. Chapters already finished are
 *  stored and stay stored — `writeAll` returns the outcomes it has, so the sentence is about what
 *  is left to do, not about losing what is done. */
export const costNote = (r: CostReason): string =>
  `The run stopped at its cost limit of $${r.limit.toFixed(2)} (spent $${r.spent.toFixed(2)}). ` +
  'Chapters already written were kept. Raise the limit in Settings → AI, or write fewer chapters at once.'

/**
 * The spend ceiling for one report run, wrapped around the cost sink the writers already report to.
 *
 * The report writers were the half of the app the "Cost limit per run" setting never reached: they
 * booked every call into the ledger and were bounded by a DEADLINE instead, so a "Write all" over a
 * long document could spend whatever it took and only a clock could stop it. A time limit is not a
 * cost limit — a cheap model runs into it and an expensive one finishes well inside it.
 *
 * It rides on the reporting channel rather than counting the same numbers a second time, and it
 * stops the run through its own abort signal, which is where a deadline and a Stop click already
 * land. That matters for what survives: `writeAll` returns the outcomes it has, and a chapter is
 * stored as it finishes, so the ceiling ends the run without taking the finished work with it.
 *
 * A single-answer helper cannot be stopped by this and is not meant to be — the cost of an answer is
 * only known once it has arrived, so the guard bites where there is more work to stop. Same property
 * the chat agent's breaker has, which settles up between rounds.
 *
 * `limit` of 0 means no limit, as everywhere else.
 */
export function costGuard(limit: number, controller: AbortController, book: CostSink): CostSink {
  return accountGuard({ limit, spent: 0, stopped: false }, controller, book)
}

/**
 * One run's spend, shared by every IPC call that belongs to it.
 *
 * A "Write all" run is three IPC calls — the study translation, the chapter block, the glossary — and
 * each used to start its own guard at zero, so the ceiling was per call and not per run: after the
 * chapter block had stopped at the limit, the glossary call started and paid once more.
 * The renderer names the run (`costRun`), the account lives here across the calls, and a call that
 * arrives for a stopped account is refused before it costs anything — the only moment a ceiling can
 * actually hold, since an answer in flight is paid for when its cost arrives.
 */
export interface CostAccount {
  limit: number
  spent: number
  stopped: boolean
  /** When the account was opened; stale accounts are swept so a renderer that never closes them
   *  cannot grow the map without bound. */
  openedAt?: number
}

const ACCOUNTS = new Map<string, CostAccount>()
const ACCOUNT_TTL_MS = 2 * 60 * 60 * 1000

/** The account for a named run, opened with the limit in force at its first call. */
export function costAccount(runId: string, limit: number, now = Date.now()): CostAccount {
  for (const [id, account] of ACCOUNTS) {
    if (now - (account.openedAt ?? now) > ACCOUNT_TTL_MS) ACCOUNTS.delete(id)
  }
  let account = ACCOUNTS.get(runId)
  if (!account) {
    account = { limit, spent: 0, stopped: false, openedAt: now }
    ACCOUNTS.set(runId, account)
  }
  return account
}

/** For the tests: forget every account. */
export function resetCostAccounts(): void {
  ACCOUNTS.clear()
}

/** A guard over an existing account: books every call, stops the controller once the account is over
 *  its limit, and marks the account stopped so the run's next call is refused up front. */
export function accountGuard(account: CostAccount, controller: AbortController, book: CostSink): CostSink {
  return (model, usage) => {
    book(model, usage)
    account.spent += Number(usage?.cost) || 0
    if (account.limit > 0 && account.spent >= account.limit) {
      account.stopped = true
      if (!controller.signal.aborted) controller.abort(costReason(account.limit, account.spent))
    }
  }
}

/** The wording for an aborted signal: the backstop's, the cost ceiling's, or the caller's own
 *  "you pressed Stop" line. */
export function stopNote(signal: AbortSignal | undefined, cancelled: string): string {
  if (signal?.reason === DEADLINE_REASON) return DEADLINE_NOTE
  if (isCostReason(signal?.reason)) return costNote(signal.reason as CostReason)
  return cancelled
}

/**
 * One model answer's worth of wall clock.
 *
 * Not a performance target — `streamChat` already abandons a stream that has been silent for three
 * minutes, so a hung request dies well before this. What is left for the outer clock is the request
 * that keeps trickling forever while nobody watches, which means it may be generous, and it must be
 * generous *per answer*: a call that waits for two answers in sequence and is given one answer's
 * budget fires on healthy work.
 */
export const ANSWER_BUDGET_MS = 600_000

/**
 * The backstop for a report helper that waits for `answers` model answers one after another.
 *
 * The same arithmetic `writeAll` does over its plan, on the unit the short helpers are made of.
 * Answers that run in parallel lanes do not count twice — the wait is the longest lane, not the sum.
 */
export function reportDeadlineMs(answers: number): number {
  return ANSWER_BUDGET_MS * Math.max(1, Math.ceil(answers))
}
