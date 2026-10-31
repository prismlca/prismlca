/** The report's shape as this side knows it: section/report types, chapter kinds and names.
 *
 * Moved out of views/ReportSections.tsx (wave 3.1): these are pure helpers that lived in a view
 * file only because nobody had moved them — eleven test files already covered them from outside.
 * ReportSections re-exports every name, so those tests keep their import path.
 */
import { getAS } from '../appSettings'
import type { FigureSpec } from '../../views/Report'
import type { ChapterReview, ReviewIssue } from '../../../../shared/ipc'

/** The second reading as it is stored with a chapter (engine/report_review.record). `kept` is an open
 *  point the author read and kept as written. No reviewer: no second model read the chapter, and the
 *  record holds only the numbers the writer left typed out (engine/report_typed_numbers). */
export interface StoredReview extends Omit<ChapterReview, 'issues' | 'reviewer'> {
  reviewer: string | null
  issues: Array<Omit<ReviewIssue, 'status'> & { status: ReviewIssue['status'] | 'kept' }>
  verdict: 'accepted' | 'open_points'
  /** The text version the reading was formed against — it describes the chapter only while they match. */
  text_version: string
  at: string
}

/** One chapter of a stored report. Mirrors the section shape in engine/report_store.py. */
export interface ReportSection {
  id: string
  kind: string
  title: string
  order: number
  locked: boolean
  text: string
  prompt_override: string | null
  extra_instructions: string
  source: string | null
  generated_at: string | null
  /** Which LLM wrote this chapter's text — stored per chapter when it is written, updated only when
   *  THAT chapter is rewritten, so a mixed run honestly reads "written by" several models. */
  model?: string | null
  /** Appendix only: rows in its inventory table. 0 = every characterised flow, undefined = the default 25. */
  inventory_rows?: number | null
  /** Inventory chapter: which parts it shows — processes | datasets | parameters | flows. */
  inventory_parts?: string[] | null
  /** Inventory chapter: how much of each process note — "full" | "short" | "list". */
  inventory_detail?: string | null
  /** Results chapter: "auto" | "indicators" | "subjects" — which way round the comparison matrix is set. */
  table_layout?: string | null
  /** Results chapter: "all" | "lead" | "none" — how many indicators get a bar chart of their own. */
  per_indicator_charts?: string | null
  /** Contribution chapter: indicators it leaves out, by method label. Empty means all of them. */
  hidden_indicators?: string[]
  /** What this chapter draws, in drawing order — see FigureEditor. */
  figures?: FigureSpec[]
  /** The writer's single proposal, drawn while the list above is empty. */
  figure?: FigureSpec | null
  /** The wording this chapter had before its last change — the safety net under a rewrite. */
  previous?: { text: string; at: string } | null
  /** The version of `text` as the backend hands it out (GET report). Echoed as `expected_text_version`
   *  on a text write, so a write over a wording that moved in between is refused, not applied. */
  text_version?: string
  /** What the second reader checked when a model last wrote this chapter, and how each point ended. */
  ai_review?: StoredReview | null
  /** Introduction and interpretation: false once the author unticked the literature search. Absent = on. */
  literature_search?: boolean | null
}

export interface StoredReportFull {
  id: string
  name: string
  subtitle: string
  lang: string
  template: string
  /** Id of the colour set every theme is typeset in. Absent on reports written before palettes existed —
   *  the backend then renders them in the default, which is the values the themes used to hard-code. */
  palette?: string
  /** Accent, deep tone and paper tried by hand on this report, replacing the set's three. */
  palette_colors?: { accent?: string; deep?: string; paper?: string }
  options?: {
    intended_public?: boolean
    outlines?: Record<string, boolean>
    figures?: { heatmap?: boolean; radar?: boolean; stacked?: boolean }
    /** Below this relative difference the check advises against calling one variant better. */
    significance_percent?: number
  }
  amount?: number
  aggregate_by?: string
  /** What the report compares, and with which indicators — decides which comparison figures are possible. */
  subjects?: {
    database?: string
    code?: string
    scenario?: string | null
    scenario_name?: string
    label?: string
  }[]
  methods?: string[][]
  /** The author's answers to the writers' questions, by question id. */
  answers?: Record<string, { answer: string; question?: string; at: string }>
  /** Base64 PNG/JPEG for the title page; absent means the cover uses its no-image layout. */
  cover_image?: string
  /** The commissioning party's mark, drawn opposite the author's own on the title page. */
  client_logo?: string
  sections: ReportSection[]
}

/**
 * The study metadata an ISO 14044 §5.2 report is expected to state, with the words the user sees.
 *
 * `goal` and `scope` are not here: a study that has neither has nothing to report on at all, and the
 * report page says so in a dozen other ways. These are the ones that are quietly missable — the first
 * real report had all six empty and only page 26 mentioned it.
 */
/** Mirrors `study.REPORTABLE` — the same list the model-health linter names, so the panel and the
 *  assistant tell the author the same thing about the same study. The third column is the Model info
 *  section the field sits in (`components/ModelInfo.tsx`), so the notice can say where to fill it in. */
export const REPORTABLE_SCOPE: [string, string, string][] = [
  ['functional_unit', 'functional unit', 'Object of study'],
  ['geography', 'geography', 'Object of study'],
  ['reference_year', 'reference year', 'Object of study'],
  ['system_boundaries', 'system boundaries', 'Object of study'],
  ['cutoff_criteria', 'cut-off criteria', 'Rules & allocation'],
  ['allocation', 'process allocation', 'Rules & allocation'],
  ['system_allocation', 'system allocation (end of life)', 'Rules & allocation'],
  ['critical_review', 'critical review', 'Who and when']
]

/**
 * The REPORTABLE_SCOPE entries this study leaves unanswered — the rule of `study.unrecorded_scope`, which
 * the health check applies. A field counts once it has text; the critical review also once its yes/no
 * is answered, because "no review" is a complete answer and authors give it in the choice, not in prose.
 */
export function unrecordedScope(study: Record<string, unknown> | null | undefined): typeof REPORTABLE_SCOPE {
  const answered = ['yes', 'no'].includes(String(study?.critical_review_done ?? ''))
  return REPORTABLE_SCOPE.filter(
    ([key]) => !String(study?.[key] ?? '').trim() && !(key === 'critical_review' && answered)
  )
}

/**
 * The inventory chapter's parts, in the order they are printed.
 *
 * The list mirrors `report_render.LCI_PARTS`; the two defaults mirror `LCI_DEFAULT_PARTS`. Parameters
 * and flows start off because the annex already carries both — moving them here (and deleting them
 * there) is the other legitimate shape of the same report, which is why it is a choice.
 */
export const LCI_PARTS: [string, string, string][] = [
  ['processes', 'The processes', 'Every foreground process with its reference product, unit and location'],
  ['datasets', 'Background datasets', 'The datasets the model links to directly — not their upstream tree'],
  ['parameters', 'Parameters', 'The named parameters with their values and the note recorded against each'],
  ['flows', 'Elementary flows', 'The characterised flows carrying the leading indicator']
]
export const LCI_DEFAULT_PARTS = ['processes', 'datasets']

/**
 * Chapters a deterministic table can carry a *comment* on: the tables stay the source and the paragraph
 * goes underneath them, which is the order ISO 14044 §4.5 expects (finding first, judgement second).
 * Mirrors the prompts the backend ships for these kinds (report_prompts.DEFAULT_PROMPTS).
 */
export const COMMENTABLE = new Set([
  'goal_scope',
  'inventory',
  'methods',
  'lcia',
  'contribution',
  'interpretation_checks',
  'appendix'
])

/**
 * Chapters written at once during "Write all chapters".
 *
 * Four rather than all of them: OpenRouter puts no hard ceiling on concurrency for paid models, but the
 * provider behind one does, and every chapter also asks the backend for a brief and a gate verdict. Four
 * turns a 24-minute run into something under ten and keeps the failure mode boring. The client retries a
 * rate limit with backoff now, which is what makes any of this safe to do at all.
 *
 * The lanes themselves live in the MAIN process now (reportWriter.writeAll, WRITE_LANES there): this
 * panel sends the plan and paints the outcomes.
 */

/** Chapters that sum up the others, and therefore go in a later wave than the chapters they summarise. */
export const SUMMARISING = new Set(['summary', 'conclusions'])

/** Everything with a text field: the written chapters plus the commentable ones. */
export const WRITABLE = new Set(['prose', 'summary', 'conclusions', 'introduction', ...COMMENTABLE])

/** The chapters whose writer may search the literature — mirrors `report_kinds.LITERATURE_KINDS`. */
export const LITERATURE_KINDS = new Set(['introduction', 'prose'])

/** Section kinds and what fills them. Deterministic kinds are built from the data; prose is written. */
export const KINDS: { kind: string; label: string; hint: string }[] = [
  {
    kind: 'summary',
    label: 'Executive summary',
    hint: 'Written last; summarises the report and adds nothing'
  },
  {
    kind: 'introduction',
    label: 'Introduction',
    hint: 'The background: the product, why it is studied, what published work says — the writer looks it up unless you untick “Search the literature”'
  },
  { kind: 'goal_scope', label: 'Goal and scope', hint: 'The study metadata, as prose' },
  {
    kind: 'system_model',
    label: 'System model',
    hint: 'The process network: your processes and the datasets they draw on directly, drawn from the model'
  },
  {
    kind: 'inventory',
    label: 'Life cycle inventory',
    hint: 'What was modelled and where its data came from — written from the process notes'
  },
  { kind: 'methods', label: 'Methods', hint: 'Which indicators, from which method family — and why' },
  { kind: 'lcia', label: 'Impact assessment', hint: 'Results table; a matrix when several subjects' },
  { kind: 'contribution', label: 'Contribution', hint: 'Breakdown by tag dimension or location' },
  {
    kind: 'interpretation_checks',
    label: 'Interpretation checks',
    hint: 'ISO 14044 §4.5: completeness, sensitivity, consistency — all from the model'
  },
  {
    kind: 'limitations',
    label: 'Limitations',
    hint: 'States what the study did not do — add it only if you want those sentences'
  },
  {
    kind: 'prose',
    label: 'Written chapter',
    hint: 'Your text, or the assistant’s — the interpretation, by default'
  },
  {
    kind: 'conclusions',
    label: 'Conclusions',
    hint: 'What the study concludes, and how far it reaches — recommendations belong here, sparingly'
  },
  { kind: 'appendix', label: 'Annex', hint: 'Parameters and scenario definitions' },
  {
    kind: 'datasets',
    label: 'Background datasets',
    hint: 'The datasets the model uses directly — top level only'
  },
  { kind: 'references', label: 'References', hint: 'Datasets, methods and the standards used' },
  { kind: 'abbreviations', label: 'Abbreviations', hint: 'Acronyms the document uses, explained' },
  { kind: 'provenance', label: 'Reproducibility', hint: 'Versions, model state, timestamp' }
]

/** What a section kind is called on screen. Falls back to the raw kind, which only a kind this list
 *  does not know can reach — everything shipped has a label. */
export const kindLabel = (kind: string): string => KINDS.find((k) => k.kind === kind)?.label || kind

/**
 * What a chapter is called wherever the author reads its name.
 *
 * A chapter carries a title only once it has been renamed, so an untouched one has an empty string
 * there and a bare `title || kind` puts the internal slug on screen: the correction dialog offered
 * to correct "interpretation_checks", and the multi-chapter one headed its blocks LCIA and
 * CONTRIBUTION (the CSS upper-cases them). The list of chapters had the full chain and the dialogs
 * did not, so the same chapter was called two different things two clicks apart (V173). One
 * function, used everywhere a chapter is named to the author.
 */
export const chapterLabel = (section: { kind: string; title?: string }): string =>
  (section.title ?? '').trim() || untitledName(section.kind)

/** What an untitled chapter is headed in the document. A written chapter without a title prints as
 *  "Interpretation" (`report_kinds`: prose → interpretation.title), and a new report starts with one —
 *  "Written chapter" is the type it is added as, which named it in the list while the PDF said otherwise. */
export const untitledName = (kind: string): string => (kind === 'prose' ? 'Interpretation' : kindLabel(kind))

export const LANGS = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' }
]

export const langLabel = (code: string): string => LANGS.find((l) => l.code === code)?.label ?? code

/**
 * The model that writes report text: the dedicated setting if there is one, else the chat model.
 *
 * Two settings because the jobs differ — tool work is long and mechanical and a cheap model is fine at
 * it, while a chapter is read by the user's client. They used to be one, and the settings hint even said
 * it applied to the chat only, so moving the chat to a cheap model quietly moved the client's report
 * with it.
 */
export const writerModel = (): string => getAS().writerModel || getAS().model

/**
 * A chapter's text, cut into the author's words and its resolved placeholders (engine/report_data
 * `explain`). `member` says which row of a ranked list the number belongs to, and `pinned` whether
 * the sentence is tied to that member or merely to its position.
 */
export interface ResolvedPart {
  kind: 'text' | 'value' | 'ref'
  text: string
  token?: string
  member?: string
  pinned?: boolean
  missing?: boolean
}
