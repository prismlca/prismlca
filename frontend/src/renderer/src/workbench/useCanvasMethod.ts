/**
 * The LCIA method the Model page calculates with: which one it is, where it is kept, and what the page
 * shows when it is gone.
 *
 * Kept as the method itself — its path, `['EF v3.1', 'climate change', …]` — in the model's view
 * (`canvas.method` in `prism_meta/views.json`), not as a row number of the catalogue. A row number came
 * back as 0 after every restart, which is whatever sorts first (a "no LT" variant, not a recommended
 * indicator), and it moved to another method whenever a custom method above it was deleted. Per model,
 * because a model's method belongs to its study and a workspace's catalogue is its own (an ecoinvent
 * workspace and a BAFU one share no families).
 *
 * Only a choice is stored — the chooser, the assistant's `calculate_in_canvas`, a chat run that
 * calculated. Until there is one the page offers the default (`defaultReportMethods`), worked out anew
 * from the catalogue, never written. A stored method the catalogue no longer has stays the choice: the
 * chooser names it as gone and Calculate waits for another. Replacing it silently with a neighbour is
 * exactly what computed with a method nobody had chosen.
 */
import { useCallback, useMemo } from 'react'

import { useViewField } from '../lib/modelView'
import { defaultReportMethods, type MethodEntry } from '../lib/methods'

export interface CanvasMethod {
  /** What Calculate computes with; null while the catalogue is empty or lacks the chosen method. */
  method: string[] | null
  /** Its row in the catalogue, for the chooser; -1 when there is none. */
  index: number
  /** The chosen method the current catalogue does not have (deleted, renamed, another catalogue). */
  gone: string[] | null
  /** The chosen method missing from a catalogue that is being read again — it may be in the new one
   *  (a workspace switch shows the new model before its catalogue arrives). Not gone yet, not usable. */
  checking: string[] | null
}

const isPath = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === 'string')

const samePath = (a: string[], b: string[]): boolean => a.length === b.length && a.every((p, i) => p === b[i])

/**
 * The method the page calculates with, given the catalogue and what the model's view holds. `fresh`: the
 * catalogue is the answer to a read made after its last invalidation (`useQuery`), so a method missing
 * from it is really missing; a list kept on show while the next read is out only says "not yet".
 */
export function resolveCanvasMethod(methods: MethodEntry[], stored: unknown, fresh = true): CanvasMethod {
  const wanted = isPath(stored) ? stored : (defaultReportMethods(methods)[0] ?? null)
  const index = wanted ? methods.findIndex((m) => samePath(m.method, wanted)) : -1
  if (index >= 0) return { method: methods[index].method, index, gone: null, checking: null }
  const missing = isPath(stored) ? stored : null
  // No catalogue yet (still loading, or nothing imported) is not a lost method: nothing to say then.
  const gone = missing && methods.length && fresh ? missing : null
  return { method: null, index: -1, gone, checking: gone ? null : missing }
}

export function useCanvasMethod(
  activeDb: string | null,
  methods: MethodEntry[],
  fresh: boolean
): CanvasMethod & { choose: (method: string[]) => void } {
  // `unknown`, not `string[]`: the view file is also written by other versions and by hand.
  const [stored, setStored] = useViewField<unknown>(activeDb, 'canvas', 'method', null)
  const resolved = useMemo(() => resolveCanvasMethod(methods, stored, fresh), [methods, stored, fresh])
  const choose = useCallback((method: string[]) => setStored(method), [setStored])
  return useMemo(() => ({ ...resolved, choose }), [resolved, choose])
}
