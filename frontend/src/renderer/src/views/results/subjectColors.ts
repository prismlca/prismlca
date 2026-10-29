import { SUBJECT_PALETTE } from '../../lib/palette'
import type { SubjectRef } from '../../lib/subjectKey'
import type { Matrix } from './types'

/**
 * The Results page's subject colours, for the rail, the bars and the radar alike: a user's choice first,
 * then a palette slot by position — the model's own processes, the database activities, other models'
 * processes, then the scenarios, then rows still on screen whose subject or scenario is gone. Moved out of
 * Results.tsx verbatim (pure: same inputs, same colours), so the page can rebuild it in one memo.
 */
export function buildColorMap({
  activeDb,
  acts,
  bgSubjects,
  shownFg,
  scenarios,
  matrix,
  subjectColors,
  keyOf
}: {
  activeDb: string | null
  acts: { code: string }[]
  bgSubjects: SubjectRef[]
  shownFg: SubjectRef[]
  scenarios: { id: string }[]
  matrix: Matrix | null
  subjectColors: Record<string, string>
  keyOf: (s: SubjectRef) => string
}): { subject: (s: SubjectRef) => string; scenario: (id: string) => string } {
  // Other models' subjects count too, and come last so the database activities keep the hues they had:
  // missing here, each of them fell back to the first palette colour — the colour of the model's own
  // first process, so a comparison of two bottles drew both bars in the same blue.
  const allKeys = [
    ...acts.map((a) => keyOf({ database: activeDb ?? '', code: a.code })),
    ...bgSubjects.map(keyOf),
    ...shownFg.map(keyOf)
  ]
  // Rows still on screen whose subject or scenario is gone from the rail (the numbers are marked stale
  // until the next Calculate) keep slots of their own: deleted scenarios past the live ones, removed
  // subjects past those. Falling back to slot 0 drew them in another row's colour.
  const shownRows = matrix?.subjects ?? []
  const goneScenarios = [
    ...new Set(shownRows.map((r) => r.scenario).filter((id): id is string => !!id))
  ].filter((id) => !scenarios.some((s) => s.id === id))
  const goneKeys = shownRows
    .filter((r) => !r.scenario)
    .map(keyOf)
    .filter((k, i, all) => !allKeys.includes(k) && all.indexOf(k) === i)
  // Scenario subjects colour by scenario, so each scenario gets a stable, distinct colour (offset past
  // the model/background hues) with a user override stored under the scenario id — otherwise they all
  // fell back to palette[0] (blue).
  const scenarioColor = (id: string): string => {
    if (subjectColors[id]) return subjectColors[id]
    const si = scenarios.findIndex((s) => s.id === id)
    const slot = si >= 0 ? si : scenarios.length + Math.max(0, goneScenarios.indexOf(id))
    return SUBJECT_PALETTE[(slot + allKeys.length) % SUBJECT_PALETTE.length]
  }
  const subjectColor = (s: SubjectRef): string => {
    const key = keyOf(s)
    if (subjectColors[key]) return subjectColors[key]
    if (s.scenario) return scenarioColor(s.scenario)
    const i = allKeys.indexOf(key)
    if (i < 0 && goneKeys.includes(key)) {
      const slot = allKeys.length + scenarios.length + goneScenarios.length + goneKeys.indexOf(key)
      return SUBJECT_PALETTE[slot % SUBJECT_PALETTE.length]
    }
    return SUBJECT_PALETTE[(i < 0 ? 0 : i) % SUBJECT_PALETTE.length]
  }
  return { subject: subjectColor, scenario: scenarioColor }
}
