/**
 * A chapter writer's lookups: which tools it carries, how often it may look — what a chapter has to
 * explain decides that — and how an answer reads before the writer sees it.
 */
import type { WriteBrief } from '../reportWriter'

/**
 * What a chapter may look up: the read-only tools offered to its writer. One registry with the chat
 * agent (same schemas, same implementations); this only decides which of them a chapter carries.
 *
 * The three that explain a result are every chapter's. The method chapters add the characterisation
 * factors — a Methods chapter that could only repeat an indicator's name was told not to say what the
 * indicator weighs, because it could not see it. Goal & scope adds the parameters, which is where a
 * study's assumptions are recorded. Deliberately no database search: a writer that can *discover*
 * datasets the study never used can furnish a plausible explanation out of the database instead of
 * this model.
 *
 * The web is the one search a writer may have, and only for the two chapters about the world outside
 * the model — the introduction's background, the interpretation's comparison with published studies —
 * and only where the report allows it (`brief.literature`). What it finds is sourced and recorded with
 * the study's research, so the bibliography lists it.
 */
const BASE_TOOLS = ['get_process_details', 'explain_result', 'compare_scenarios']
const METHOD_TOOLS = ['get_method_factors', 'get_characterization_factors']
const KIND_TOOLS: Record<string, string[]> = {
  lcia: [...BASE_TOOLS, ...METHOD_TOOLS],
  methods: ['get_process_details', ...METHOD_TOOLS],
  goal_scope: ['get_process_details', 'list_parameters'],
  introduction: ['get_process_details']
}

/** The tool names this chapter's writer may call; `literature` adds the web research. */
export const writerTools = (kind: string | undefined, literature = false): string[] => [
  ...(KIND_TOOLS[String(kind ?? '')] ?? BASE_TOOLS),
  ...(literature ? ['research_web'] : [])
]

/** How many web research calls one chapter may make. Each is a fan of paid searches taking minutes. */
export const RESEARCH_CALLS = 2

/**
 * Lookups allowed, per chapter and per report.
 *
 * One flat allowance (eight, fourteen with many indicators) was the same number for every chapter, and
 * it fitted none of them: the inventory chapter describes every foreground process and the background
 * behind it (fourteen datasets in a wood-stain model), and eight is not enough to open the markets
 * among them, while a Methods chapter needs a factor or two per indicator and no more.
 *
 * So the allowance follows what the chapter has to explain. The explaining chapters scale with the
 * thing they explain — the foreground for the inventory, the indicators for the result chapters,
 * because a hotspot list exists for the LEADING indicator only and every further one has to be opened.
 * The chapters that summarise get a small reserve. A chapter with an allowance of zero is given no
 * tools at all rather than a budget of zero.
 *
 * The numbers are ceilings, not targets, and they cost time rather than money: every call is a round
 * trip the author waits through, though a model may batch several into one round. `sectionAnswers`
 * turns the allowance into this chapter's deadline, so a higher ceiling also buys patience.
 */
const LOOKUP_PLAN: Record<
  string,
  { base: number; per?: 'foreground' | 'indicators' | 'views'; max: number }
> = {
  inventory: { base: 6, per: 'foreground', max: 19 },
  prose: { base: 6, per: 'indicators', max: 17 },
  lcia: { base: 4, per: 'indicators', max: 17 },
  contribution: { base: 4, per: 'views', max: 14 },
  interpretation_checks: { base: 5, max: 5 },
  limitations: { base: 4, max: 4 },
  summary: { base: 4, max: 4 },
  conclusions: { base: 4, max: 4 },
  // A dataset's geography or a parameter's note — the scope's facts, not the results.
  goal_scope: { base: 4, max: 4 },
  // What the product's datasets are, and the literature when the report allows it (`RESEARCH_CALLS`).
  introduction: { base: 4, max: 4 },
  // A factor or two per indicator: what it weighs and which substances carry it.
  methods: { base: 2, per: 'indicators', max: 8 }
}

/** Chapters with no plan of their own: a deterministic table with a comment under it. */
const LOOKUP_DEFAULT = { base: 3, max: 3 }

/** The widest allowance any chapter can have — the plan-time clock, before a brief is fetched. */
export const MAX_LOOKUPS = Math.max(...Object.values(LOOKUP_PLAN).map((p) => p.max), LOOKUP_DEFAULT.max)

/** The allowance for this chapter: what it has to explain, capped. */
export function lookupBudget(brief: WriteBrief): number {
  const data = (brief.data ?? {}) as Record<string, unknown[]>
  const plan = LOOKUP_PLAN[String(brief.kind ?? '')] ?? LOOKUP_DEFAULT
  const counts: Record<string, number> = {
    foreground: (data.foreground ?? []).length,
    // Two per further indicator: the tree that says which process leads it, the flows that say which
    // emission carries it. The leading indicator already has its hotspots in the brief.
    indicators: Math.max(0, (data.results ?? []).length - 1) * 2,
    views: Math.max(0, (data.contributions ?? []).length - 1) * 2
  }
  const per = 'per' in plan && plan.per ? counts[plan.per] : 0
  return Math.min(plan.base + per, plan.max)
}

/**
 * A lookup answer in the language the document prints.
 *
 * The snapshot a writer is given is translated; the MODEL is not, and `get_process_details` answers
 * out of the model. Measured in the first run that took the lookups seriously: eleven of
 * them in the inventory chapter, and four German process names walked out of their answers into its
 * prose — two chapters after the same table printed them in English (V260). More lookups is the fix
 * working; this is its bill.
 *
 * A rewrite rather than an instruction, because the name in front of a model is the name it writes.
 * Longest source first, so a name that contains another is replaced whole; nothing else in the answer
 * is touched, and a report with no translation (the study is already in the report's language) does
 * no work at all.
 */
export function asPrinted(result: string, brief: WriteBrief): string {
  const pairs = Object.entries((brief.printed_names ?? {}) as Record<string, string>)
  if (!pairs.length) return result
  let out = result
  for (const [stored, printed] of pairs.sort((a, b) => b[0].length - a[0].length)) {
    if (out.includes(stored)) out = out.split(stored).join(printed)
  }
  return out
}
