/**
 * Whether the plan card shows a chat's plan as frozen — the same question the run answers (agent.ts),
 * asked about the same model. Main runs a stored id that belongs to another provider, or one the
 * catalogue does not know, as the active provider's default (findModel), and the user's per-model choice
 * is stored under the id the run actually uses; reading it under any other id shows a plan frozen that
 * the run still updates, or the other way round.
 */
import { defaultChatModelFor, planToolOn, type AiProviderId } from '../../../shared/aiDefaults'

/** What the card needs to know about one catalogue model. */
export interface PlanRow {
  provider: string
  planTool?: boolean
}

/** The id a run started now would use. */
export function planModelFor(
  currentModel: string,
  provider: AiProviderId,
  rows: Record<string, PlanRow>
): string {
  return rows[currentModel]?.provider === provider ? currentModel : defaultChatModelFor(provider)
}

/** True when the run's model has no plan tool — catalogue row or the user's choice. */
export function planFrozen(
  currentModel: string,
  provider: AiProviderId,
  rows: Record<string, PlanRow>,
  overrides: Record<string, boolean> | undefined
): boolean {
  const id = planModelFor(currentModel, provider, rows)
  return !planToolOn(id, rows[id]?.planTool, overrides)
}
