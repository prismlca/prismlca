import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { useComparedWith } from '../../lib/comparison'
import { errMsg } from '../../lib/errors'
import { viewLoaded } from '../../lib/modelView'
import type { ModelSubject } from './types'

type Setter<T> = (next: T | ((prev: T) => T)) => void

/**
 * The open model's comparison models (linked both ways in the Info dialog or the chat's "+" menu) as
 * ready rows under "Other models": a linked model that is not in the list yet is offered there unticked,
 * and ticking it adds its reference process — the first candidate of `/model/reference`, as for the open
 * model — like any other model's process. Offered, not added: an added subject would be computed on the
 * next Calculate, and a link says what the study compares, not what this page should spend time on.
 *
 * Read live from the study, so a link made while this page is open shows up here at once, and an unlinked
 * model leaves the offer. A model already in the list (ticked or not) is not offered twice — which is why
 * nothing is offered before the backend has answered for the stored view: an empty cache is not an empty
 * list, and a pick written while the GET is out would win over the stored one and drop its entries.
 */
export function useLinkedModels({
  activeDb,
  dbNames,
  shownFg,
  setFgSubjects,
  setErr
}: {
  activeDb: string | null
  dbNames: Set<string>
  shownFg: ModelSubject[]
  setFgSubjects: Setter<ModelSubject[]>
  setErr: (e: string | null) => void
}): { linkedModels: string[]; includeLinked: (model: string) => void } {
  const linked = useComparedWith(activeDb)
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  useEffect(() => {
    if (!activeDb) return
    let alive = true
    void viewLoaded(activeDb).then((ok) => {
      if (alive && ok) setLoadedFor(activeDb)
    })
    return () => {
      alive = false
    }
  }, [activeDb])
  const linkedModels = useMemo(
    () =>
      loadedFor !== activeDb
        ? []
        : linked.filter((m) => m !== activeDb && dbNames.has(m) && !shownFg.some((f) => f.database === m)),
    [loadedFor, linked, activeDb, dbNames, shownFg]
  )
  // The setter is the view of the model the click happened on, so a model switch while the reference
  // is on its way still files the pick where it was made.
  const includeLinked = useCallback(
    (model: string) => {
      void api<{ candidates?: { code: string; name: string }[] }>(
        'GET',
        `/api/v1/model/reference/${encodeURIComponent(model)}`
      )
        .then((r) => {
          const root = r.candidates?.[0]
          if (!root) {
            setErr(`“${model}” has no processes yet.`)
            return
          }
          setFgSubjects((prev) =>
            prev.some((x) => x.database === model && x.code === root.code)
              ? prev
              : [...prev, { database: model, code: root.code, name: root.name }]
          )
        })
        .catch((e) => setErr(errMsg(e)))
    },
    [setFgSubjects, setErr]
  )
  return { linkedModels, includeLinked }
}
