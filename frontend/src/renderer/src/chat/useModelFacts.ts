import { useEffect, useState } from 'react'
import { aiModels, MODELS_CHANGED_EVENT, type AiModelInfo } from '../lib/ai'
import { modelCatalogue } from './ModelPicker'
import type { PlanRow } from './planModel'

/** What the chat panel reads from the catalogue, per model id. */
export interface ModelFacts {
  /** Provider and `planTool` row, for the plan card (chat/planModel.ts). */
  planRows: Record<string, PlanRow>
  /** Context window, for the meter's 100 % (absent = the catalogue does not know). */
  windows: Record<string, number>
}

const facts = (list: AiModelInfo[]): ModelFacts => ({
  planRows: Object.fromEntries(
    list.map((m) => [m.id, { provider: m.provider ?? 'openrouter', planTool: m.planTool }])
  ),
  windows: Object.fromEntries(list.filter((m) => m.contextTokens).map((m) => [m.id, m.contextTokens!]))
})

/**
 * The catalogue facts the chat panel needs, kept current with the catalogue: loaded once from the
 * session's shared cache, and again from a fresh list whenever a model is added or removed in Settings.
 * A model picked right after it was added must not be read as unknown, or the plan card would answer for
 * the provider's default instead of for it.
 */
export function useModelFacts(): ModelFacts {
  const [state, setState] = useState<ModelFacts>({ planRows: {}, windows: {} })
  useEffect(() => {
    let stale = false
    const load = (list: Promise<AiModelInfo[]>): void => {
      void list.then((l) => !stale && setState(facts(l))).catch(() => {})
    }
    load(modelCatalogue())
    const changed = (): void => load(aiModels())
    window.addEventListener(MODELS_CHANGED_EVENT, changed)
    return () => {
      stale = true
      window.removeEventListener(MODELS_CHANGED_EVENT, changed)
    }
  }, [])
  return state
}
