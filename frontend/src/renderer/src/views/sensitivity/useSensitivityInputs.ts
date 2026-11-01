import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { SensInputs } from './types'

/**
 * The parameters a run on this model may vary, with their values in one variant (`scenario` '' is the
 * baseline) — read again when the model changes (`rev`), because a new parameter or a new rule changes
 * what the rail offers and what a curve may span.
 */
export function useSensitivityInputs(
  activeDb: string | null,
  scenario: string,
  rev: number
): SensInputs | null {
  const [inputs, setInputs] = useState<SensInputs | null>(null)
  useEffect(() => {
    if (!activeDb) {
      setInputs(null)
      return
    }
    let alive = true
    const q = `database=${encodeURIComponent(activeDb)}${scenario ? `&scenario=${encodeURIComponent(scenario)}` : ''}`
    void api<SensInputs>('GET', `/api/v1/calc/sensitivity/inputs?${q}`)
      .then(
        (r) =>
          alive &&
          // "-" is how a dimensionless parameter's unit is often written; after a number it reads as a minus.
          setInputs({ ...r, inputs: r.inputs.map((x) => (x.unit.trim() === '-' ? { ...x, unit: '' } : x)) })
      )
      .catch(() => alive && setInputs(null))
    return () => {
      alive = false
    }
  }, [activeDb, scenario, rev])
  return inputs
}
