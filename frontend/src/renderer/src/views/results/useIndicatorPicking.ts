import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { usePersisted } from '../../lib/persist'
import { groupMethodsByFamily, indicatorLabel, indicatorLabels } from '../../lib/methods'
import type { MethodInfo, Picked } from './types'

/**
 * Everything `IndicatorPicker` needs beside the picked list itself: the method families, the label each
 * indicator goes by, the family the picker shows, its search and open state, and the picked indicators
 * grouped by family.
 *
 * Held by the page rather than the picker, because the rail's accordion unmounts a closed group and the
 * picker's state has to outlive that. `familyKey` is where the page remembers the family it showed last.
 */
export function useIndicatorPicking(
  methods: MethodInfo[],
  picked: Picked[],
  familyKey: string
): {
  families: Map<string, MethodInfo[]>
  familyNames: string[]
  labels: Map<string, string>
  family: string
  setFamily: Dispatch<SetStateAction<string>>
  indQuery: string
  setIndQuery: Dispatch<SetStateAction<string>>
  pickerOpen: boolean
  setPickerOpen: Dispatch<SetStateAction<boolean>>
  pickedKeys: Set<string>
  groups: { family: string; items: Picked[] }[]
} {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [family, setFamily] = usePersisted(familyKey, '')
  const [indQuery, setIndQuery] = useState('')
  const families = useMemo(() => groupMethodsByFamily(methods), [methods])
  const familyNames = useMemo(() => [...families.keys()].sort((a, b) => a.localeCompare(b)), [families])
  // What an indicator is called everywhere on the page — rows, chips, headers, chart titles.
  // `method[1]` where that names one indicator, the path below the family where it does not
  // (ReCiPe endpoint names its damage category second — V203).
  const labels = useMemo(() => indicatorLabels(methods), [methods])
  useEffect(() => {
    if (!family && familyNames.length) setFamily(familyNames[0])
  }, [familyNames, family, setFamily])
  const pickedKeys = useMemo(() => new Set(picked.map((p) => p.key)), [picked])
  // The picked indicators grouped by method family (contiguous), for grouped headers and charts.
  const groups = useMemo(() => {
    const order: string[] = []
    const map = new Map<string, Picked[]>()
    for (const p of picked) {
      if (!map.has(p.family)) {
        map.set(p.family, [])
        order.push(p.family)
      }
      // The stored label is whatever was written when the indicator was picked; the name is decided
      // here, against the current catalogue, so an old selection heals with the rule.
      map.get(p.family)!.push({ ...p, label: indicatorLabel(p.method, labels) || p.label })
    }
    return order.map((f) => ({ family: f, items: map.get(f)! }))
  }, [picked, labels])
  return {
    families,
    familyNames,
    labels,
    family,
    setFamily,
    indQuery,
    setIndQuery,
    pickerOpen,
    setPickerOpen,
    pickedKeys,
    groups
  }
}
