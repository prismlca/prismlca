// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Each request for a unit list waits here until the test answers it, so the order of answers is the test's. */
const pending: { path: string; answer: (value: unknown) => void }[] = []

vi.mock('./api', async (actual) => ({
  ...(await actual<typeof import('./api')>()),
  api: vi.fn((_method: string, path: string) =>
    path.startsWith('/api/v1/search/units/')
      ? new Promise((resolve) => pending.push({ path, answer: resolve }))
      : Promise.resolve([])
  )
}))

import { mergeUnitCounts, useFilterOptions } from './useFilterOptions'

beforeEach(() => {
  pending.length = 0
})

describe('mergeUnitCounts', () => {
  it('adds the counts of several databases and puts the most frequent unit first', () => {
    const ecoinvent = [
      { unit: 'kilogram', count: 10 },
      { unit: 'kilowatt hour', count: 4 }
    ]
    const library = [
      { unit: 'kilowatt hour', count: 7 },
      { unit: 'unit', count: 1 }
    ]
    expect(mergeUnitCounts([ecoinvent, library])).toEqual(['kilowatt hour', 'kilogram', 'unit'])
  })

  it('orders equal counts by name, so the list does not shuffle between loads', () => {
    expect(mergeUnitCounts([[{ unit: 'megajoule', count: 2 }], [{ unit: 'hectare', count: 2 }]])).toEqual([
      'hectare',
      'megajoule'
    ])
  })
})

describe('useFilterOptions', () => {
  it('keeps the newest list when an older answer arrives late', async () => {
    const { result } = renderHook(() => useFilterOptions(['ecoinvent']))
    await waitFor(() => expect(pending).toHaveLength(1)) // the load when the databases were set
    act(() => result.current.loadUnits()) // the field opens: a second, newer load
    expect(pending).toHaveLength(2)

    await act(async () => pending[1].answer([{ unit: 'kilogram', count: 3 }]))
    await act(async () => pending[0].answer([{ unit: 'litre', count: 1 }]))
    expect(result.current.unitOptions).toEqual(['kilogram'])
  })

  it('offers nothing when no database is ticked, and asks for nothing', async () => {
    const { result, rerender } = renderHook(({ dbs }) => useFilterOptions(dbs), {
      initialProps: { dbs: ['ecoinvent'] }
    })
    await waitFor(() => expect(pending).toHaveLength(1))
    await act(async () => pending[0].answer([{ unit: 'kilogram', count: 3 }]))
    expect(result.current.unitOptions).toEqual(['kilogram'])

    rerender({ dbs: [] })
    expect(result.current.unitOptions).toEqual([])
    expect(pending).toHaveLength(1)
  })
})
