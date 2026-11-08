import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

/**
 * A model added in Settings reaches the chat panel without a remount: the catalogue-changed event reloads
 * the facts from a fresh list, past the session's shared cache.
 */
const lists = [
  [{ id: 'a/one', provider: 'openrouter', planTool: false, contextTokens: 1000 }],
  [
    { id: 'a/one', provider: 'openrouter', planTool: false, contextTokens: 1000 },
    { id: 'my/new-model', provider: 'openrouter' }
  ]
]
let call = 0
vi.mock('../lib/ai', () => ({
  MODELS_CHANGED_EVENT: 'prism:ai-models-changed',
  aiModels: vi.fn(async () => lists[Math.min(call++, lists.length - 1)])
}))
vi.mock('./ModelPicker', async () => {
  const ai = await import('../lib/ai')
  let cache: ReturnType<typeof ai.aiModels> | null = null
  return { modelCatalogue: () => (cache ??= ai.aiModels()) }
})

describe('useModelFacts', () => {
  it('reads the catalogue on mount and again when it changes', async () => {
    const { useModelFacts } = await import('./useModelFacts')
    const { result, unmount } = renderHook(() => useModelFacts())
    await waitFor(() =>
      expect(result.current.planRows['a/one']).toEqual({ provider: 'openrouter', planTool: false })
    )
    expect(result.current.windows).toEqual({ 'a/one': 1000 })
    expect(result.current.planRows['my/new-model']).toBeUndefined()
    act(() => void window.dispatchEvent(new Event('prism:ai-models-changed')))
    await waitFor(() => expect(result.current.planRows['my/new-model']).toEqual({ provider: 'openrouter' }))
    unmount()
  })
})
