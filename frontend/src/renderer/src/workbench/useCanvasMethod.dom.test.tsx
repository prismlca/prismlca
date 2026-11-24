// @vitest-environment jsdom
/**
 * The Model page's method is kept as the method itself, per model. It used to be a row number of the
 * catalogue: a restart brought back row 0 (a "no LT" variant), and deleting a custom method above the
 * chosen one moved the choice to its neighbour, which Calculate then computed with.
 */
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { MethodEntry } from '../lib/methods'

// Each model's view as a plain map, standing in for the backend's view store (prism_meta/views.json):
// it outlives a render, as the file outlives a restart.
const views = new Map<string, unknown>()
vi.mock('../lib/modelView', async (original) => ({
  ...(await original<typeof import('../lib/modelView')>()),
  useViewField: <T,>(db: string | null, section: string, field: string, initial: T) => {
    const key = `${db}/${section}/${field}`
    const [, bump] = useState(0)
    const value = (views.has(key) ? views.get(key) : initial) as T
    return [
      value,
      (next: T) => {
        if (!db) return
        views.set(key, next)
        bump((n) => n + 1)
      }
    ]
  }
}))

import { resolveCanvasMethod, useCanvasMethod } from './useCanvasMethod'

const m = (method: string[], recommended = true): MethodEntry => ({
  method,
  name: method.join(' · '),
  unit: 'kg CO2-Eq',
  recommended
})
const NO_LT = m(
  ['CML v4.8 2016 no LT', 'acidification no LT', 'acidification (incl. fate, average Europe total, A&B)'],
  false
)
const CML_GWP = m(['CML v4.8 2016', 'climate change', 'global warming potential (GWP100)'])
const EF_GWP = m(['EF v3.1', 'climate change', 'global warming potential (GWP100)'])
const AAA = m(['My methods', 'AAA'])
const BBB = m(['My methods', 'BBB'])
const CCC = m(['My methods', 'CCC'])

describe('which method the Model page calculates with', () => {
  it('starts on the default indicator, not on whatever sorts first', () => {
    expect(resolveCanvasMethod([NO_LT, CML_GWP, EF_GWP], null)).toEqual({
      method: EF_GWP.method,
      index: 2,
      gone: null,
      checking: null
    })
    // Without an EF family: the first recommended one.
    expect(resolveCanvasMethod([NO_LT, CML_GWP], undefined).method).toEqual(CML_GWP.method)
  })

  it('keeps the chosen method when a custom method above it is deleted', () => {
    const before = [NO_LT, CML_GWP, AAA, BBB, CCC]
    expect(resolveCanvasMethod(before, BBB.method)).toEqual({
      method: BBB.method,
      index: 3,
      gone: null,
      checking: null
    })
    expect(resolveCanvasMethod([NO_LT, CML_GWP, BBB, CCC], BBB.method)).toEqual({
      method: BBB.method,
      index: 2,
      gone: null,
      checking: null
    })
  })

  it('says the chosen method is gone instead of falling back to another', () => {
    expect(resolveCanvasMethod([NO_LT, CML_GWP, AAA], CCC.method)).toEqual({
      method: null,
      index: -1,
      gone: CCC.method,
      checking: null
    })
  })

  it('reports nothing lost while the catalogue is still empty', () => {
    expect(resolveCanvasMethod([], BBB.method)).toEqual({
      method: null,
      index: -1,
      gone: null,
      checking: BBB.method
    })
    expect(resolveCanvasMethod([], null)).toEqual({ method: null, index: -1, gone: null, checking: null })
  })

  it('does not call a method gone on a catalogue that is being read again', () => {
    // A workspace switch: the new model's view is in, its catalogue not yet — the old one is still on show.
    expect(resolveCanvasMethod([NO_LT, CML_GWP, AAA], BBB.method, false)).toEqual({
      method: null,
      index: -1,
      gone: null,
      checking: BBB.method
    })
    // A stale list that has it is good enough to show and to calculate with: the path is the method.
    expect(resolveCanvasMethod([NO_LT, CML_GWP, BBB], BBB.method, false).method).toEqual(BBB.method)
  })

  it('treats a stored value that is no method path as no choice', () => {
    for (const junk of ['3', 3, [], [1, 2], { method: BBB.method }])
      expect(resolveCanvasMethod([CML_GWP, BBB], junk).method).toEqual(CML_GWP.method)
  })
})

describe('useCanvasMethod', () => {
  it('keeps the choice across a catalogue change and a restart, per model', () => {
    const catalogue = [NO_LT, CML_GWP, AAA, BBB, CCC]
    const { result, rerender, unmount } = renderHook(
      ({ db, methods }) => useCanvasMethod(db, methods, true),
      {
        initialProps: { db: 'bottle' as string | null, methods: catalogue }
      }
    )
    act(() => result.current.choose(BBB.method))
    expect(result.current.method).toEqual(BBB.method)

    // AAA deleted on the LCIA page: BBB stays, CCC is not picked up.
    rerender({ db: 'bottle', methods: [NO_LT, CML_GWP, BBB, CCC] })
    expect(result.current.method).toEqual(BBB.method)

    // Another model has its own choice — none yet, so the default.
    rerender({ db: 'can', methods: [NO_LT, CML_GWP, BBB, CCC] })
    expect(result.current.method).toEqual(CML_GWP.method)
    unmount()

    // A restart: a new page reads what the model's view holds.
    const again = renderHook(() => useCanvasMethod('bottle', [NO_LT, CML_GWP, BBB, CCC], true))
    expect(again.result.current.method).toEqual(BBB.method)
    expect(again.result.current.index).toBe(2)
  })

  it('stays on a deleted method, named as gone, until another is chosen', () => {
    const { result, rerender } = renderHook(({ methods }) => useCanvasMethod('jar', methods, true), {
      initialProps: { methods: [CML_GWP, AAA, BBB] }
    })
    act(() => result.current.choose(BBB.method))
    rerender({ methods: [CML_GWP, AAA] })
    expect(result.current).toMatchObject({ method: null, index: -1, gone: BBB.method, checking: null })
    act(() => result.current.choose(AAA.method))
    expect(result.current).toMatchObject({ method: AAA.method, index: 1, gone: null, checking: null })
  })
})
