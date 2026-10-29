import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DatabaseInfo } from '../../lib/api'
import { fetchQuery } from '../../lib/server/useQuery'
import { activitiesRoute } from '../../lib/server/routes'
import { useViewField } from '../../lib/modelView'
import { subjectKey, type SubjectRef } from '../../lib/subjectKey'
import { errMsg } from '../../lib/errors'
import type { BgSubject, CompareSubject, ModelSubject } from './types'
import { useLinkedModels } from './useLinkedModels'

// Stable fallbacks for unset view fields and for another model's process list: a fresh `[]` per render would
// rebuild every memo that reads them (and the charts that read those).
const NO_BG: BgSubject[] = []
const NO_FG: ModelSubject[] = []
const NO_ACTS: { code: string; name: string }[] = []

/**
 * The Results page's subject selection: the model's processes, the stored picks (processes, scenarios,
 * baseline, other models' processes, database activities), the linked comparison models on offer
 * (useLinkedModels) and the subject list the page computes. Moved out
 * of Results.tsx verbatim. It holds no effect that reads or writes the stored results view: those — pre-selection,
 * key migration, inherited indicators, scenario pruning — are in useResultsOpening.ts, which the page calls where the
 * effects always stood. Values and setters are returned one by one; never make a combined object an effect or memo
 * dependency.
 */
export function useSubjectSelection({
  activeDb,
  databases,
  setErr
}: {
  activeDb: string | null
  databases: DatabaseInfo[]
  setErr: (e: string | null) => void
}) {
  // The process list belongs to the model it was loaded for: while the next model's list is on its way the
  // old one stayed in state, and a process of the model just left that shared a code with this model's
  // selection was shown here and computed AS this model's. Another model's list reads empty.
  const [actsFor, setActsFor] = useState<{ db: string | null; list: { code: string; name: string }[] }>({
    db: null,
    list: NO_ACTS
  })
  const acts = actsFor.db === activeDb ? actsFor.list : NO_ACTS
  // Everything that names a process, a scenario or an indicator is stored PER MODEL: under a global
  // key it followed the user into the next study, which is how a fresh apple-juice model opened with
  // `dodecanol production` pre-selected and eleven CML indicators from an unrelated report.
  const [subjSel, setSubjSel] = useViewField<Record<string, boolean>>(activeDb, 'results', 'subjSel', {})
  const [bgSubjects, setBgSubjects] = useViewField<BgSubject[]>(activeDb, 'results', 'bgSubjects', NO_BG)
  const [fgSubjects, setFgSubjects] = useViewField<ModelSubject[]>(activeDb, 'results', 'fgSubjects', NO_FG)
  const [scenarios, setScenarios] = useState<{ id: string; name: string }[]>([])
  const [scenSel, setScenSel] = useViewField<Record<string, boolean>>(activeDb, 'results', 'scenSel', {})
  // The baseline is a variant like any other, and it says so. It used to be implicit — tick a scenario
  // and the unticked model row silently became the thing it was compared against — so a person looking for
  // "baseline" and "scenario" as two choices found only one checkbox. Now it is a row of its own,
  // and switching it off is a real thing to want: the scenario on its own, without its origin beside it.
  const [baselineOn, setBaselineOn] = useViewField(activeDb, 'results', 'baseline', true)

  // Guarded per run: switching the model while its processes load let the late answer — or its error —
  // land in the model now open (a late write showed the old model's processes there).
  useEffect(() => {
    if (!activeDb) {
      setActsFor({ db: null, list: NO_ACTS })
      return
    }
    let alive = true
    void fetchQuery(activitiesRoute(activeDb))
      .then((list) => {
        if (alive) setActsFor({ db: activeDb, list })
      })
      .catch((e) => {
        if (alive) setErr(errMsg(e))
      })
    return () => {
      alive = false
    }
  }, [activeDb, setErr])

  // Other-model subjects: hide entries whose model became the ACTIVE one (those live in the
  // checkbox list) or was deleted/renamed since they were persisted.
  const dbNames = useMemo(() => new Set(databases.map((d) => d.name)), [databases])
  // The user's own library databases — their compare subjects wear the same purple chip as their
  // search hits, because only the source separates them from a background dataset of the same name.
  const libNames = useMemo(
    () => new Set(databases.filter((d) => d.kind === 'library').map((d) => d.name)),
    [databases]
  )
  const shownFg = useMemo(
    () => fgSubjects.filter((f) => f.database !== activeDb && dbNames.has(f.database)),
    [fgSubjects, activeDb, dbNames]
  )
  const { linkedModels, includeLinked } = useLinkedModels({
    activeDb,
    dbNames,
    shownFg,
    setFgSubjects,
    setErr
  })

  const subjects = useMemo((): CompareSubject[] => {
    const chosenActs = activeDb ? acts.filter((a) => subjSel[a.code]) : []
    // Only the PLAIN subjects hang on the baseline switch; the activity selection still decides which
    // processes the scenarios below are applied to.
    const models =
      activeDb && baselineOn
        ? chosenActs.map((a) => ({ database: activeDb, code: a.code, label: a.name }))
        : []
    // Scenario subjects: each selected model activity computed under each selected scenario (the
    // scenario's parameter overrides are applied server-side). Baseline is the plain model subject.
    const scen = activeDb
      ? scenarios
          .filter((s) => scenSel[s.id])
          .flatMap((s) =>
            chosenActs.map((a) => ({
              database: activeDb,
              code: a.code,
              scenario: s.id,
              label: chosenActs.length > 1 ? `${a.name} · ${s.name}` : s.name
            }))
          )
      : []
    const others = shownFg
      .filter((f) => f.enabled !== false)
      .map((f) => ({
        database: f.database,
        code: f.code,
        label: `${f.name} — ${f.database}`
      }))
    const bg = bgSubjects
      .filter((b) => b.enabled !== false)
      .map((b) => ({
        database: b.database,
        code: b.code,
        amount: b.amount,
        label: b.geography ? `${b.name} [${b.geography}]` : b.name
      }))
    return [...models, ...scen, ...others, ...bg]
  }, [acts, subjSel, activeDb, shownFg, bgSubjects, scenarios, scenSel, baselineOn])

  // Calculations run ONLY on the Calculate button (they can take minutes for stacked
  // cross-model comparisons) — selection changes just mark the shown results as stale.
  // Key on database+code+amount — code alone can collide across databases (e.g. a background
  // subject vs a foreground activity), which would miss a real change.
  // A scenario subject shares its code with the baseline, and another model's process may share its
  // code with one of this model's (a bundle import keeps codes) — so every subject's identity is
  // database + code + scenario, and downstream keying (colours, diff reference, chart series) uses it.
  // `keyOf` is the form relative to this model, the one stored in its view (see lib/subjectKey).
  const keyOf = useCallback((s: SubjectRef): string => subjectKey(s, activeDb), [activeDb])
  const subjKey = subjects.map((s) => `${subjectKey(s, null)}@${s.amount ?? 1}`).join(',')

  return {
    acts,
    subjSel,
    setSubjSel,
    bgSubjects,
    setBgSubjects,
    fgSubjects,
    setFgSubjects,
    scenarios,
    setScenarios,
    scenSel,
    setScenSel,
    baselineOn,
    setBaselineOn,
    dbNames,
    libNames,
    shownFg,
    linkedModels,
    includeLinked,
    subjects,
    keyOf,
    subjKey
  }
}
