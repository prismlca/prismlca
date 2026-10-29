import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { makePrism } from '../test/prism'
import { resetQueryCache } from '../lib/server/useQuery'
import { useCanvasModel, type CanvasModelDeps } from './useCanvasModel'
import { useTagging } from './useTagging'
import type { Graph } from '../lib/api'

/**
 * The inspector's tag list re-reads after a write. It used to be refreshed only because the canvas
 * re-rendered without pause and every render handed it a new selection array; with the selection kept
 * while it is unchanged, the list has to follow `modelRev` — the counter every model mutation bumps.
 */
describe('the inspector’s tags', () => {
  it('re-read after a model change, with the same process still selected', async () => {
    resetQueryCache()
    let tags: { dimension: string; value: string }[] = []
    ;(window as unknown as { prism: unknown }).prism = makePrism({
      'GET /api/v1/model/tag-groups': { groups: [] },
      'GET /api/v1/model/tags/:db/:code': () => tags
    }).prism
    const deps: CanvasModelDeps = {
      run: async (fn) => {
        await fn()
      },
      activeDb: null,
      setConfirm: () => {},
      setError: () => {},
      reloadAudit: vi.fn(async () => {}),
      edgeDigits: 3
    }
    const { result, rerender } = renderHook(
      ({ modelRev }) => {
        const canvas = useCanvasModel(deps)
        const tagging = useTagging({
          run: deps.run,
          activeDb: null,
          modelRev,
          reloadAudit: async () => {},
          setError: () => {},
          setNote: () => {},
          onGrouped: () => {},
          canvas
        })
        return { canvas, tagging }
      },
      { initialProps: { modelRev: 0 } }
    )
    const graph = {
      database: 'm1',
      nodes: [{ id: 'm1/a', name: 'Assembly', location: 'DE', unit: 'unit', external: false }],
      edges: []
    } as unknown as Graph
    act(() => result.current.canvas.buildGraph(graph))
    act(() => result.current.canvas.selectOnly('m1/a'))
    await waitFor(() => expect(result.current.tagging.inspTags).toEqual([]))

    tags = [{ dimension: 'Phase', value: 'Manufacture' }]
    rerender({ modelRev: 1 })
    await waitFor(() => expect(result.current.tagging.inspTags).toEqual(tags))
  })
})
