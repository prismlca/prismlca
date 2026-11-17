/**
 * Which of the Results overview's normalized charts have something to compare.
 *
 * The radar, the heatmap and the Normalized bars scale each indicator to its highest subject. Over a single
 * subject every heatmap cell then reads 100 %, every radar axis is full and every bar is 100 % (a credit
 * −100 %): charts that compare nothing. Each of them therefore needs two subjects, and the radar also three
 * indicators to be a shape rather than a line.
 *
 * The radar and the heatmap count the subjects of the shown results, since only results draw them. The
 * Per indicator / Normalized switch sits above the results and is there before the first calculation as
 * well; until then the ticked subjects stand in for the results, so the switch can be preset. The stored
 * choice of view is not touched here: it comes back with the next comparison of two or more subjects.
 */
export interface ComparisonCharts {
  /** The shown results hold two or more subjects: the heatmap is drawn. */
  compared: boolean
  /** Those results and three or more indicators: the radar is drawn. */
  showRadar: boolean
  /** The Per indicator / Normalized switch is offered. */
  canNormalize: boolean
  /** The Normalized chart stands in for the bars per indicator, on screen and in Save charts. */
  normalized: boolean
}

export function comparisonCharts(opts: {
  /** Subjects in the shown results; null before the first calculation. */
  resultSubjects: number | null
  /** Subjects ticked for the comparison. */
  selectedSubjects: number
  indicators: number
  view: 'charts' | 'normalized'
}): ComparisonCharts {
  const compared = (opts.resultSubjects ?? 0) >= 2
  const canNormalize = opts.indicators > 1 && (opts.resultSubjects ?? opts.selectedSubjects) >= 2
  return {
    compared,
    showRadar: compared && opts.indicators >= 3,
    canNormalize,
    normalized: opts.view === 'normalized' && canNormalize
  }
}
