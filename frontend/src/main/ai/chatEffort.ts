/**
 * The chat role's effort floor (`minChatEffort` on a catalogue row): which level a chat run sends, and
 * the one-time lift of stored choices that sit below a model's floor.
 *
 * The rule itself — stored choice, or the floor when it is lower or Default — is `chatEffort` in
 * shared/aiDefaults.ts, so the pickers show exactly what main sends. Only the chat applies it: research
 * legs, the reviewer, the writer and the import matcher never send the stored choice at all.
 */
import {
  chatEffort,
  REASONING_EFFORT_SHORT,
  REASONING_EFFORTS,
  type ReasoningEffort
} from '../../shared/aiDefaults'
import type { AiModel } from './models'
import { aiLog } from './aiLog'
import { AiProviderError } from './providers/types'

type FloorRow = Pick<AiModel, 'id' | 'label' | 'reasoningEfforts' | 'minChatEffort' | 'minChatEffortNote'>

/** The effort a chat run on `model` sends: the user's choice for it, lifted to the model's floor;
 *  undefined = send nothing (the API's default), which a model with a floor never gets. */
export function chatRunEffort(
  model: Pick<AiModel, 'id' | 'reasoningEfforts' | 'minChatEffort'>,
  stored: Record<string, ReasoningEffort>
): ReasoningEffort | undefined {
  return chatEffort(stored[model.id], model) || undefined
}

/**
 * The level a chat run retries with after the API refused `rejected`: the model's floor when the refused
 * level sat above it, else nothing (the API's default). So a refused `max` on Luna continues at `high`,
 * never at its default below it; only a refused floor itself leaves the default as the way to go on.
 */
export function effortAfterRejection(
  rejected: ReasoningEffort,
  model: Pick<AiModel, 'minChatEffort'>
): ReasoningEffort | undefined {
  const floor = model.minChatEffort
  return floor && floor !== rejected ? floor : undefined
}

/**
 * A round that failed because the model's API does not take the reasoning level it was sent (a 400
 * naming it): the level to send the round again with (`effortAfterRejection`) and the note the chat shows.
 * Null for every other failure. A lost run is the wrong price for a setting.
 */
export function effortRejectionRetry(
  e: unknown,
  sent: ReasoningEffort | undefined,
  model: Pick<AiModel, 'id' | 'minChatEffort'>
): { next: ReasoningEffort | undefined; note: string } | null {
  if (!sent || !(e instanceof AiProviderError) || e.code !== 'http') return null
  if (!/reason|effort|thinking/i.test(e.message)) return null
  const next = effortAfterRejection(sent, model)
  const on = next ? `"${next}"` : 'its default'
  aiLog(`${model.id} rejected reasoning effort "${sent}" — retrying on ${on}`)
  return {
    next,
    note: `\n\n_The model's API rejected the reasoning effort "${sent}" — continuing on ${on}. Pick another level under Settings → AI → Models._`
  }
}

const known = (v: unknown): v is ReasoningEffort =>
  typeof v === 'string' && (REASONING_EFFORTS as readonly string[]).includes(v)

/**
 * Raise stored choices below a model's chat floor to the floor, for a settings file written before the
 * floor existed. A choice below it is lifted wherever it is stored; Default (nothing stored) only for the
 * model that IS the stored chat model, the one place where it changes what runs. Anything unreadable is
 * left to the sanitiser, which drops it, and the run applies the floor anyway.
 *
 * Returns the new map (the input is not touched) and the sentence that tells the user — '' when nothing
 * moved, and then the map is a plain copy the caller need not write back.
 */
export function liftChatEffortFloors(
  stored: unknown,
  chatModel: unknown,
  models: readonly FloorRow[]
): { efforts: Record<string, unknown>; notice: string } {
  const efforts: Record<string, unknown> =
    stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...(stored as object) } : {}
  const lifted: FloorRow[] = []
  for (const m of models) {
    const floor = m.minChatEffort
    if (!floor) continue
    const v = efforts[m.id]
    const below = known(v) ? chatEffort(v, m) !== v : v === undefined && m.id === chatModel
    if (!below) continue
    efforts[m.id] = floor
    lifted.push(m)
  }
  if (!lifted.length) return { efforts, notice: '' }
  // Both routes to one model share its label; say each once.
  const lines = new Set<string>()
  for (const m of lifted)
    lines.add(`${m.label} now chats at ${REASONING_EFFORT_SHORT[m.minChatEffort!]} reasoning effort.`)
  for (const m of lifted) if (m.minChatEffortNote) lines.add(m.minChatEffortNote)
  return { efforts, notice: [...lines].join(' ') }
}
