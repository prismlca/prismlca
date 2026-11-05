/** What an external session's approval card shows: the tool, the operation it will run, and every argument. */
import { ACTION_PARAM, type ToolEffect } from '../ai/tools/effects'
import { approvalTarget } from '../ai/approval'

/** An undo or redo of a step this session did not make: what it would take back or apply again. */
export interface ForeignStep {
  verb: 'undo' | 'redo'
  summary: string
}

/** The `approve_tool` arguments the window's card reads (ExternalAgentsPanel `ApprovalCard`). */
export interface ApprovalRequest {
  tool: string
  /** The operation(s) the call selects, read as the tool reads them; absent for single-action tools. */
  action?: string
  effect: ToolEffect
  /** The call's arguments in full, with the operation's own parameter first. */
  args: Record<string, unknown>
  target: string | null
  database: string | null
  step?: ForeignStep
}

const named = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** The operations one call selects, read as the effects table reads them: its own action, then batch items'. */
export function callActions(tool: string, args: Record<string, unknown>): string[] {
  const param = ACTION_PARAM[tool]
  if (!param) return []
  const found: string[] = []
  const add = (v: unknown): void => {
    const a = named(v)
    if (a && !found.includes(a)) found.push(a)
  }
  add(args[param])
  for (const v of Object.values(args)) {
    if (!Array.isArray(v)) continue
    for (const item of v) if (item && typeof item === 'object') add((item as Record<string, unknown>)[param])
  }
  return found
}

/** The arguments with the operation's parameter first, so it opens the card's listing. */
function actionFirst(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const param = ACTION_PARAM[tool]
  if (!param || !(param in args)) return args
  const { [param]: action, ...rest } = args
  return { [param]: action, ...rest }
}

export function approvalRequest(
  tool: string,
  args: Record<string, unknown>,
  effect: ToolEffect,
  activeDb: string | null,
  step?: ForeignStep
): ApprovalRequest {
  const actions = callActions(tool, args)
  return {
    tool,
    ...(actions.length ? { action: actions.join(', ') } : {}),
    effect,
    args: actionFirst(tool, args),
    target: approvalTarget(tool, args, activeDb),
    database: activeDb,
    ...(step ? { step } : {})
  }
}

/** `history` undo/redo, as the tool dispatches it (trimmed, exact); anything else is not one. */
export function historyVerb(tool: string, args: Record<string, unknown>): 'undo' | 'redo' | null {
  if (tool !== 'history') return null
  const a = named(args.action)
  return a === 'undo' || a === 'redo' ? a : null
}
