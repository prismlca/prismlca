import { useCallback } from 'react'
import { useViewField } from '../../lib/modelView'
import type { Picked } from '../results/types'
import { DEFAULT_POINTS } from './sensitivity'
import type { CurveResult, StoredRun, TornadoResult } from './types'

/** The tornado's settings. `scenario` '' is the baseline. */
export interface TornadoSetup {
  mode: 'all' | 'pick'
  params: string[]
  delta: number
  scenario: string
  methods: Picked[]
}

/** The curve's settings. `variants`: '' for the baseline, else scenario ids. */
export interface CurveSetup {
  param: string
  from: number | null
  to: number | null
  points: number
  method: string[] | null
  variants: string[]
}

const TORNADO: TornadoSetup = { mode: 'all', params: [], delta: 0.1, scenario: '', methods: [] }
const CURVE: CurveSetup = {
  param: '',
  from: null,
  to: null,
  points: DEFAULT_POINTS,
  method: null,
  variants: ['']
}

/**
 * What the Sensitivity analysis tab remembers per model, in the model's view (prism_meta/views.json): the
 * subject, both cards' settings, and both cards' last finished run. The runs are kept because they cost
 * minutes — a restart or a model switch must not throw one away — and each carries the settings it was
 * computed with and when it started, so the card can say when it no longer answers what is asked.
 */
export function useSensitivitySetup(activeDb: string | null): {
  subject: { code: string; label: string } | null
  setSubject: (s: { code: string; label: string } | null) => void
  tornado: TornadoSetup
  patchTornado: (patch: Partial<TornadoSetup>) => void
  curve: CurveSetup
  patchCurve: (patch: Partial<CurveSetup>) => void
  lastTornado: StoredRun<TornadoResult> | null
  setLastTornado: (run: StoredRun<TornadoResult> | null) => void
  lastCurve: StoredRun<CurveResult> | null
  setLastCurve: (run: StoredRun<CurveResult> | null) => void
} {
  const [subject, setSubject] = useViewField<{ code: string; label: string } | null>(
    activeDb,
    'sensitivity',
    'subject',
    null
  )
  const [storedTornado, setTornado] = useViewField<TornadoSetup>(activeDb, 'sensitivity', 'tornado', TORNADO)
  const [storedCurve, setCurve] = useViewField<CurveSetup>(activeDb, 'sensitivity', 'curve', CURVE)
  const [lastTornado, setLastTornado] = useViewField<StoredRun<TornadoResult> | null>(
    activeDb,
    'sensitivity',
    'lastTornado',
    null
  )
  const [lastCurve, setLastCurve] = useViewField<StoredRun<CurveResult> | null>(
    activeDb,
    'sensitivity',
    'lastCurve',
    null
  )
  // Defaults under what was stored: a field added later must not arrive as undefined in an old view.
  const tornado = { ...TORNADO, ...storedTornado }
  const curve = { ...CURVE, ...storedCurve }
  const patchTornado = useCallback(
    (patch: Partial<TornadoSetup>) => setTornado((prev) => ({ ...TORNADO, ...prev, ...patch })),
    [setTornado]
  )
  const patchCurve = useCallback(
    (patch: Partial<CurveSetup>) => setCurve((prev) => ({ ...CURVE, ...prev, ...patch })),
    [setCurve]
  )
  return {
    subject,
    setSubject,
    tornado,
    patchTornado,
    curve,
    patchCurve,
    lastTornado,
    setLastTornado,
    lastCurve,
    setLastCurve
  }
}
