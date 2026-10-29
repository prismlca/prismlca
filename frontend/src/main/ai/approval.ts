/**
 * When the in-app chat shows the user a confirmation card before a tool runs.
 *
 * The chat once had no gate of its own: `delete_model`, a custom-method delete, a rename
 * ran the moment the model called them, and "confirm intent with the user first" was a sentence in
 * the prompt. The MCP sessions had the card from day one (sessions.ts `beforeRun`, three modes), on
 * the effects table that classifies every tool and action. The chat now runs on the same table and
 * the same card, with one rule:
 *
 *   - only `irreversible` effects ask — a process delete is on the undo stack and stays free, as does
 *     every ordinary edit;
 *   - `history` (undo/redo) is exempt in the chat although the table marks it irreversible: in the
 *     conversation the user is present and asked for the step, and the undo of an undo is a redo. The
 *     table keeps its verdict for the MCP, where an external client's undo lands on whatever a person
 *     did last in the window;
 *   - the setting can switch the card off (`'never'`), and then the prompt goes back to telling the
 *     model to confirm with the user itself (systemPrompt.ts `approvalGate`).
 *
 * The wording the model gets when the card says no, or nobody answers it, lives here too, so the
 * three places that need it (the chat gate, its test, the model test) read one copy.
 */
import type { ToolEffect } from './tools/effects'

export type ChatApprovalMode = 'irreversible' | 'never'

/** Tools whose irreversible actions run without a card in the chat (see the header). */
export const CHAT_APPROVAL_EXEMPT: ReadonlySet<string> = new Set(['history'])

export function needsChatApproval(
  mode: ChatApprovalMode | undefined,
  tool: string,
  effect: ToolEffect
): boolean {
  if ((mode ?? 'irreversible') === 'never') return false
  if (effect !== 'irreversible') return false
  return !CHAT_APPROVAL_EXEMPT.has(tool)
}

/** The tool's error when the user pressed Decline on the card. */
export const APPROVAL_DECLINED =
  'The user declined this action on the confirmation card, so it did not run. Do not call it again — ' +
  'carry on without it, or ask the user what they would like instead.'

/** The tool's error when the card waited its full time and nobody answered. */
export const APPROVAL_UNANSWERED =
  'Nobody answered the confirmation card in time, so this action did not run. Do not call it again now — ' +
  'carry on with what does not need it, and say that this step is waiting for the user.'

/**
 * What the card must name: the thing the call acts ON, read from the call's own arguments — never
 * the model that happens to be open. `delete_model {"database": "production"}` with "scratch" on
 * screen used to produce a card saying "on scratch" above a deletion of production.
 * Null when the arguments name nothing a person would recognise.
 */
export function approvalTarget(
  tool: string,
  args: Record<string, unknown>,
  activeDb: string | null
): string | null {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const db = str(args.database) ?? activeDb
  switch (tool) {
    case 'delete_model':
      return db ? `model "${db}"` : null
    case 'manage_model': {
      const name = str(args.name)
      return db && name ? `model "${db}" → "${name}"` : db ? `model "${db}"` : null
    }
    case 'edit_lcia_method': {
      const m = Array.isArray(args.method) ? args.method.map(String).join(' · ') : str(args.method)
      return m ? `method "${m}"` : null
    }
    case 'manage_method_family': {
      // The same precedence as the implementation (`a.old ?? a.family`, impl.ts edit_method_family):
      // a call carrying both must be named by the one the backend will act on.
      const f = str(args.old) ?? str(args.family)
      return f ? `family "${f}"` : null
    }
    default:
      return db ? `model "${db}"` : null
  }
}
