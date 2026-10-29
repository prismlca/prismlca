// @vitest-environment jsdom
/**
 * The short report's setup from its two homes: the variants it compares belong to the open model, the look
 * of the report to the app. Held app-wide, the variants travelled to the next model, where its rail could
 * not show them and nobody could untick them.
 */
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

// Each model's view as a plain map, standing in for the backend's view store.
const views = new Map<string, Record<string, unknown>>()
vi.mock('../../lib/modelView', async (original) => ({
  ...(await original<typeof import('../../lib/modelView')>()),
  useViewField: <T,>(db: string | null, section: string, field: string, initial: T) => {
    const key = `${db}/${section}/${field}`
    const [, bump] = useState(0)
    const value = (views.has(key) ? views.get(key) : initial) as T
    return [
      value,
      (next: T) => {
        views.set(key, next as Record<string, unknown>)
        bump((n) => n + 1)
      }
    ]
  }
}))
vi.mock('../../lib/persist', async (original) => ({
  ...(await original<typeof import('../../lib/persist')>()),
  usePersisted: <T,>(_key: string, initial: T) => useState<T>(initial)
}))

import { useShortSettings } from './useShortSettings'

describe('the short report settings', () => {
  it('keeps the variants with the model and the look with the app', () => {
    const { result, rerender } = renderHook(({ db }) => useShortSettings(db), {
      initialProps: { db: 'Model A' as string | null }
    })
    act(() => result.current.update({ compare: [{ scenario: 'a-only' }], template: 'prism-facets' }))
    expect(result.current.settings.compare).toEqual([{ scenario: 'a-only' }])
    expect(result.current.settings.template).toBe('prism-facets')

    // Another model: none of A's variants, the same theme.
    rerender({ db: 'Model B' })
    expect(result.current.settings.compare).toEqual([])
    expect(result.current.settings.template).toBe('prism-facets')

    // And back: A's variants are where they were left.
    rerender({ db: 'Model A' })
    expect(result.current.settings.compare).toEqual([{ scenario: 'a-only' }])
  })

  it('drops a process variant the rail has no checkbox for', () => {
    // An older view: a process of the model, and a scenario on another process, beside a scenario.
    views.set('Model C/short_report/compare', [
      { code: 'spout' },
      { scenario: 'recycled' },
      { scenario: 'thin', code: 'spout' }
    ] as unknown as Record<string, unknown>)
    const { result } = renderHook(() => useShortSettings('Model C'))
    // Neither counted by the rail nor sent with a render.
    expect(result.current.settings.compare).toEqual([{ scenario: 'recycled' }])

    // The next tick writes the list the rail shows, and the stale entries are gone from the view too.
    act(() => result.current.update({ compare: [...result.current.settings.compare, { scenario: 'other' }] }))
    expect(views.get('Model C/short_report/compare')).toEqual([
      { scenario: 'recycled' },
      { scenario: 'other' }
    ])
    expect(result.current.settings.compare).toEqual([{ scenario: 'recycled' }, { scenario: 'other' }])
  })
})
