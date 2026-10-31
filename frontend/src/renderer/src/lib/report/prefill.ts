/**
 * What a NEW report starts from (V407, V414).
 *
 * A report created from the model alone came out English, with three indicators, one subject and no
 * breakdown — while the study was documented in German and the Results page beside it already showed
 * sixteen EF indicators, the baseline with two scenarios, and bars stacked by life-cycle phase. Every one
 * of those had to be set a second time, and the ones nobody noticed went into the document wrong.
 *
 * By design a new report is pre-filled from the Results page and the study's language — at
 * creation only. Two floors under it, because a report that inherits a Results page set up for a quick
 * look came out with three indicators and no variant at all — and so with no comparison, radar or
 * heatmap: it always covers the core indicators (`coreMethods`), and with no scenario ticked there it
 * compares the baseline with every scenario the model has. A report is a document that owns its scope from then on; re-synchronising it later
 * would let a click on another page change what a saved report renders, which is the defect the two
 * tabs were separated over in the first place.
 *
 * Pure, so the mapping can be tested without a page: the caller reads the view state and the study.
 */
import { LANGS } from './model'

/** The name suffix per report language — "<process> report" in an English shell read wrong in German. */
export const REPORT_SUFFIX: Record<string, string> = {
  en: 'report',
  de: 'Bericht',
  fr: 'rapport',
  es: 'informe',
  pt: 'relatório'
}

/** A new report's default title, in its own language. Unknown codes fall back to English. */
export const defaultReportName = (subjectName: string | undefined, lang: string): string =>
  `${subjectName || 'LCA'} ${REPORT_SUFFIX[lang] ?? REPORT_SUFFIX.en}`

/**
 * The study's language as the report page reads it (ReportSections `loadScope`): what the author set in
 * Model info, else what the backend reads from the prose. Only a language the report can be written in
 * is taken — anything else, or no study record, starts in English as before.
 */
export function initialReportLang(
  study: { language?: string | null; detected_language?: string | null } | null | undefined
): string {
  const code = ((study?.language || '').trim() || (study?.detected_language || '').trim()).toLowerCase()
  return LANGS.some((l) => l.code === code) ? code : 'en'
}

/** The part of the Results page's per-model view state (section `results`) a report can use. */
export interface ResultsViewState {
  /** The indicators picked there; `method` is the method tuple. */
  picked?: { method?: string[]; key?: string }[]
  /** Ticked scenarios, by id. */
  scenSel?: Record<string, boolean>
  /** What the stacked bars are split by, when chosen (`views/results/splitBy.ts`). */
  stackBy?: string
}

export interface PrefillInput {
  database: string
  /** The reference process, as `/model/reference` resolved it (or the first activity). */
  subject: { code: string; name: string } | undefined
  /** The Results page's view state for this model, or nothing when it has never been opened. */
  results: ResultsViewState | null | undefined
  /** The Results page's chart settings: whether bars are stacked, and by what (`isic`, `cpc`, `tag:<group>`). */
  stacked: boolean
  stackBy: string
  /** The model's scenarios, so a ticked id that no longer exists is not carried into the report. */
  scenarios: { id: string; name: string }[]
  /** Method tuples the catalogue knows — a stale pick is dropped. Empty means "not loaded, trust the picks". */
  known: string[][]
  /** The indicators every new report covers at least; the Results page's picks are added (`defaultReportMethods`). */
  coreMethods: string[][]
  /** The initial language (see `initialReportLang`). */
  lang: string
}

export interface ReportSubject {
  database: string
  code: string
  scenario?: string
  scenario_name?: string
  label?: string
}

export interface Prefill {
  name: string
  lang: string
  subjects: ReportSubject[]
  methods: string[][]
  aggregate_by?: string
  /** One line for the setup, or null when nothing was taken from the Results page. */
  note: string | null
}

const tupleKey = (m: string[]): string => m.join('\u0000')

export function reportPrefill(input: PrefillInput): Prefill {
  const { database, subject, results, scenarios, lang } = input

  // Indicators: the Results page's picks, in its order, deduplicated and checked against the catalogue.
  const known = new Set(input.known.map(tupleKey))
  const seen = new Set<string>()
  const picked: string[][] = []
  for (const p of results?.picked ?? []) {
    const m = Array.isArray(p?.method) ? p.method.filter((x) => typeof x === 'string') : []
    if (!m.length) continue
    const k = tupleKey(m)
    if (seen.has(k) || (known.size && !known.has(k))) continue
    seen.add(k)
    picked.push(m)
  }
  // The core set leads (climate change first: the lead indicator names the report's figures), the
  // Results page's other picks follow in their order. Checked against the catalogue like the picks, and
  // only within one method family: picks from another family (CML, ReCiPe) keep the report to that
  // family — two families in one document print climate change twice, by two methods.
  const families = new Set(picked.map((m) => m[0]))
  const coreFamily = input.coreMethods[0]?.[0]
  const sameFamily = !picked.length || (families.size === 1 && families.has(coreFamily ?? ''))
  const core = sameFamily ? input.coreMethods.filter((m) => !known.size || known.has(tupleKey(m))) : []
  const coreKeys = new Set(core.map(tupleKey))
  const methods = [...core, ...picked.filter((m) => !coreKeys.has(tupleKey(m)))]
  const added = core.filter((m) => !seen.has(tupleKey(m))).length

  // Variants: the reference process plus one subject per ticked scenario — the same shape the report's
  // own "Compare with" ticks write (ReportSections `setSubjects`), so the setup reads them back as ticked.
  // Nothing ticked there takes every scenario: a report of one subject has nothing to compare.
  const tickedThere = scenarios.filter((sc) => results?.scenSel?.[sc.id])
  const allScenarios = !tickedThere.length && scenarios.length > 0
  const ticked = subject ? (allScenarios ? scenarios : tickedThere) : ([] as { id: string; name: string }[])
  const subjects: ReportSubject[] = !subject
    ? []
    : ticked.length
      ? [
          { database, code: subject.code, label: 'Baseline' },
          ...ticked.map((sc) => ({
            database,
            code: subject.code,
            scenario: sc.id,
            scenario_name: sc.name,
            label: sc.name
          }))
        ]
      : [{ database, code: subject.code }]

  // Breakdown: only a tag family. ISIC/CPC are classifications the report's breakdown does not offer,
  // and an unstacked chart has no breakdown to carry over at all.
  const by = (input.stackBy || '').trim()
  const aggregate_by = input.stacked && by.startsWith('tag:') && by.length > 4 ? by : undefined

  const taken: string[] = []
  if (picked.length) taken.push(`${picked.length} indicator${picked.length === 1 ? '' : 's'}`)
  if (ticked.length && !allScenarios) taken.push(`${subjects.length} variants`)
  if (aggregate_by) taken.push(`breakdown by ${aggregate_by.slice(4)}`)
  const parts: string[] = []
  if (taken.length) parts.push(`Taken from the Results page: ${taken.join(', ')}.`)
  if (picked.length && added) parts.push(`Plus ${added} core indicator${added === 1 ? '' : 's'}.`)
  if (subject && allScenarios)
    parts.push(
      `Compares the baseline with all ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'} of the model.`
    )
  if (lang !== 'en')
    parts.push(`Written in ${LANGS.find((l) => l.code === lang)?.label ?? lang}, the study’s language.`)

  return {
    name: defaultReportName(subject?.name, lang),
    lang,
    subjects,
    methods,
    ...(aggregate_by ? { aggregate_by } : {}),
    note: parts.length ? parts.join(' ') : null
  }
}
