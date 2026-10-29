/**
 * The query cache against a route that fails. A read that fails must stay failed until something
 * invalidates it: the first version refetched on its own rejection (rejection → version bump → effect →
 * fetch → rejection …), which is a hot loop of requests in the app and, against a fixture that rejects
 * synchronously, a promise chain that never yields — CanvasChat.dom.test hung without a word
 * (2026-09-06, the first `useQuery` on a route the harness did not answer).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { makePrism } from '../../test/prism'
import { invalidate, resetQueryCache, useQuery } from './useQuery'

beforeEach(() => resetQueryCache())

describe('useQuery on a failing route', () => {
  it('asks once, keeps the error, and retries only after an invalidate', async () => {
    const fx = makePrism({ 'GET /api/v1/calc/methods': { status: 500, body: { detail: 'boom' } } })
    ;(window as unknown as { prism: unknown }).prism = fx.prism
    const { result } = renderHook(() => useQuery('/api/v1/calc/methods'))
    await waitFor(() => expect(result.current.error).toBeTruthy())
    // Give a runaway loop every chance to show itself.
    await new Promise((r) => setTimeout(r, 60))
    expect(fx.calls.filter((c) => c.path.startsWith('/api/v1/calc/methods'))).toHaveLength(1)
    expect(result.current.data).toBeUndefined()

    fx.setRoute('GET /api/v1/calc/methods', [{ id: 'm1' }])
    invalidate('/api/v1/calc/methods')
    await waitFor(() => expect(result.current.data).toEqual([{ id: 'm1' }]))
    expect(result.current.error).toBeUndefined()
    expect(fx.calls.filter((c) => c.path.startsWith('/api/v1/calc/methods'))).toHaveLength(2)
  })
})
