import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'

/** One unit as the backend lists it for a database: how many indexed rows carry it. */
interface UnitCount {
  unit: string
  count: number
}

/** Units of several databases as one list: counts added up, most frequent first, ties by name. */
export function mergeUnitCounts(lists: UnitCount[][]): string[] {
  const total = new Map<string, number>()
  for (const list of lists)
    for (const { unit, count } of list) total.set(unit, (total.get(unit) ?? 0) + count)
  return [...total.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([u]) => u)
}

/**
 * What the search's region and unit filters suggest: whatever the ticked databases' indexes hold.
 *
 * Loaded when the ticked databases change AND again whenever a field is opened. Loading ahead alone went
 * stale in two ways nothing else signals: a library import extends an index without any tick changing, and
 * two workspaces can name their databases alike, so the list of names stays the same across a switch.
 * A late answer never overwrites a newer one, and with nothing ticked the lists are empty.
 */
export function useFilterOptions(dbs: string[]): {
  regionOptions: string[]
  unitOptions: string[]
  loadRegions: () => void
  loadUnits: () => void
} {
  // JSON, not join: a database name may contain any character.
  const dbKey = JSON.stringify(dbs)
  const [regionOptions, setRegionOptions] = useState<string[]>([])
  const [unitOptions, setUnitOptions] = useState<string[]>([])
  const regionRun = useRef(0)
  const unitRun = useRef(0)

  const loadRegions = useCallback((): void => {
    const run = ++regionRun.current
    const names = JSON.parse(dbKey) as string[]
    if (!names.length) {
      setRegionOptions([])
      return
    }
    void (async () => {
      // Silent per database: one without an index simply adds nothing.
      const lists = await Promise.all(
        names.map((db) =>
          api<string[]>('GET', `/api/v1/search/geographies/${encodeURIComponent(db)}`).catch(() => [])
        )
      )
      if (run === regionRun.current) setRegionOptions([...new Set(lists.flat())].sort())
    })()
  }, [dbKey])

  const loadUnits = useCallback((): void => {
    const run = ++unitRun.current
    const names = JSON.parse(dbKey) as string[]
    if (!names.length) {
      setUnitOptions([])
      return
    }
    void (async () => {
      const lists = await Promise.all(
        names.map((db) =>
          api<UnitCount[]>('GET', `/api/v1/search/units/${encodeURIComponent(db)}`).catch(() => [])
        )
      )
      if (run === unitRun.current) setUnitOptions(mergeUnitCounts(lists))
    })()
  }, [dbKey])

  useEffect(() => {
    loadRegions()
    loadUnits()
  }, [loadRegions, loadUnits])

  return { regionOptions, unitOptions, loadRegions, loadUnits }
}
