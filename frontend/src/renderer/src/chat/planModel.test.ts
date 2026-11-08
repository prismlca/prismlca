/**
 * The plan card answers for the model a run really uses — the same resolution as main's findModel — and
 * reads the user's choice under that id.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GOOGLE_MODEL_ID,
  DEFAULT_MODEL_ID,
  DEFAULT_OPENAI_MODEL_ID
} from '../../../shared/aiDefaults'
import { planFrozen, planModelFor, type PlanRow } from './planModel'

const rows: Record<string, PlanRow> = {
  [DEFAULT_MODEL_ID]: { provider: 'openrouter', planTool: false },
  'z-ai/glm-5.3': { provider: 'openrouter', planTool: true },
  'my/new-model': { provider: 'openrouter' },
  [DEFAULT_OPENAI_MODEL_ID]: { provider: 'openai', planTool: false },
  [DEFAULT_GOOGLE_MODEL_ID]: { provider: 'google', planTool: true }
}

describe('the model the plan card answers for', () => {
  it('is the chosen model when it belongs to the active provider', () => {
    expect(planModelFor('z-ai/glm-5.3', 'openrouter', rows)).toBe('z-ai/glm-5.3')
  })

  it('is the provider default for an id of another provider, or one the catalogue does not know', () => {
    expect(planModelFor('z-ai/glm-5.3', 'openai', rows)).toBe(DEFAULT_OPENAI_MODEL_ID)
    expect(planModelFor('not/in-catalogue', 'openrouter', rows)).toBe(DEFAULT_MODEL_ID)
  })

  it('reads the user’s choice under the id the run uses', () => {
    // Sol direct switched on, Sol via OpenRouter left off: under OpenAI the card follows the direct one.
    const overrides = { [DEFAULT_OPENAI_MODEL_ID]: true }
    expect(planFrozen(DEFAULT_OPENAI_MODEL_ID, 'openai', rows, overrides)).toBe(false)
    expect(planFrozen(DEFAULT_MODEL_ID, 'openrouter', rows, overrides)).toBe(true)
  })

  it('treats a freshly added model without a planTool row as on — once the catalogue lists it', () => {
    expect(planFrozen('my/new-model', 'openrouter', rows, {})).toBe(false)
    expect(planFrozen('my/new-model', 'openrouter', rows, { 'my/new-model': false })).toBe(true)
  })
})
