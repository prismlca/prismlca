import type { BgSubject, CompareSubject, ModelSubject } from './types'

/**
 * The rows the Results page computes, from what is selected: every ticked process of the model (while the
 * baseline is on), every ticked process under every ticked scenario, the enabled processes of other models and
 * the enabled database activities. One function, read by the page and by the assistant's `setup_results`, so
 * the number of rows the assistant is told is the number the page draws — a model that sent a baseline and
 * seven scenarios could not tell whether the page held eight rows.
 */
export function subjectRows({
  activeDb,
  acts,
  subjSel,
  baselineOn,
  scenarios,
  scenSel,
  otherModels,
  bgSubjects
}: {
  activeDb: string | null
  acts: { code: string; name: string }[]
  subjSel: Record<string, boolean>
  baselineOn: boolean
  scenarios: { id: string; name: string }[]
  scenSel: Record<string, boolean>
  /** Processes of other models, already narrowed to those still there. */
  otherModels: ModelSubject[]
  bgSubjects: BgSubject[]
}): CompareSubject[] {
  const chosenActs = activeDb ? acts.filter((a) => subjSel[a.code]) : []
  // Only the PLAIN subjects hang on the baseline switch; the activity selection still decides which
  // processes the scenarios below are applied to.
  const models =
    activeDb && baselineOn ? chosenActs.map((a) => ({ database: activeDb, code: a.code, label: a.name })) : []
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
  const others = otherModels
    .filter((f) => f.enabled !== false)
    .map((f) => ({ database: f.database, code: f.code, label: `${f.name} — ${f.database}` }))
  const bg = bgSubjects
    .filter((b) => b.enabled !== false)
    .map((b) => ({
      database: b.database,
      code: b.code,
      amount: b.amount,
      label: b.geography ? `${b.name} [${b.geography}]` : b.name
    }))
  return [...models, ...scen, ...others, ...bg]
}
