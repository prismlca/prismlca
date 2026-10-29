/** What "Write all" would do and cost: the dry-run plan, its ticks and its arithmetic.
 *
 * Moved out of views/ReportSections.tsx (wave 3.1): these are pure helpers that lived in a view
 * file only because nobody had moved them — eleven test files already covered them from outside.
 * ReportSections re-exports every name, so those tests keep their import path.
 */
import { langLabel, SUMMARISING, type ReportSection } from './model'
import type { StaleChapter } from './staleness'

/** The study-translation step of a run. Not a section id — no chapter can collide with it. */
export const TRANSLATE_STEP = '__translate__'

/**
 * What a run would do to one chapter, and why — the dry run, before anything is paid for.
 *
 * `update` brings a written chapter up to date with replacements (main/ai/writer/update.ts); `keep`
 * leaves it as it is, and ticking it writes it anew.
 */
export type PlanAction = 'write' | 'update' | 'keep' | 'blocked' | 'glossary'

export interface PlanItem {
  section: ReportSection
  action: PlanAction
  why: string
}

/**
 * What a run would do to one chapter, and why.
 *
 * Its own function because it is the decision the dialog is *for*. `blocked` and `checked` are the two
 * facts the loop knows and one chapter does not — the setting a kind is waiting on, and whether the
 * freshness check answered for this chapter at all; `answered` counts the questions this chapter asked
 * that the author has answered since it was written.
 */
export function planForChapter(
  section: ReportSection,
  entry: StaleChapter | undefined,
  blocked: string | null,
  checked: boolean,
  answered = 0
): PlanItem {
  if (blocked) return { section, action: 'blocked', why: blocked }
  if (!(section.text ?? '').trim()) return { section, action: 'write', why: 'No text yet.' }
  if (entry?.remedy === 'rewrite' || entry?.remedy === 'review')
    return { section, action: 'update', why: entry.findings.map((f) => f.message).join('; ') }
  if (answered) return { section, action: 'update', why: 'You answered a question this chapter asked.' }
  // A chapter written by hand before the record existed has nothing to compare against — saying it is
  // up to date would be a claim the run cannot make.
  if (!checked)
    return {
      section,
      action: 'keep',
      why: 'Not compared with the numbers — no record of what it was written against. Tick to write it anew.'
    }
  return { section, action: 'keep', why: 'Up to date. Tick to write it anew.' }
}

/**
 * The chapters that sum up the others go along when something they sum up changes in this run.
 *
 * At plan time a summary reads "up to date": its sources only move once the run has rewritten them.
 * Left out, it turned "Needs update" the moment the run finished, and the author had to start a second
 * run for the one chapter the first was obviously going to make stale. It runs last anyway (its own
 * wave), so its update reads the chapters as they now are.
 */
export function followSummaries(items: PlanItem[]): PlanItem[] {
  const changing = items.some(
    (i) => (i.action === 'write' || i.action === 'update') && !SUMMARISING.has(i.section.kind)
  )
  if (!changing) return items
  return items.map((i) =>
    i.action === 'keep' && SUMMARISING.has(i.section.kind) && (i.section.text ?? '').trim()
      ? { ...i, action: 'update', why: 'The chapters it sums up change in this run.' }
      : i
  )
}

/** Ticked when the dialog opens. The rest are shown so the author can see they were considered. */
const PLAN_DEFAULT = new Set<PlanAction>(['write', 'update', 'glossary'])

export const defaultTicks = (items: PlanItem[]): string[] =>
  items.filter((i) => PLAN_DEFAULT.has(i.action)).map((i) => i.section.id)

/**
 * Carry the author's ticks from the provisional plan onto the fresh one.
 *
 * The dry run draws immediately and re-sorts itself when the staleness check lands, which takes
 * tens of seconds on an ecoinvent model — most of the time the dialog is open, since Run stays
 * disabled until then. Replacing the choices with the fresh defaults at that moment threw away
 * every box that had been touched in the meantime: ticking all ten chapters and watching the run
 * start with three is how this was found.
 *
 * A chapter that was already on screen keeps whatever was decided about it, including *un*ticking
 * one the defaults want. A chapter the fresh plan brought in was never decided on, so it takes the
 * default.
 */
export function mergeTicks(seenItems: PlanItem[], chosen: string[], freshItems: PlanItem[]): string[] {
  const seen = new Set(seenItems.map((i) => i.section.id))
  const picked = new Set(chosen)
  const fresh = new Set(defaultTicks(freshItems))
  return freshItems.map((i) => i.section.id).filter((id) => (seen.has(id) ? picked.has(id) : fresh.has(id)))
}

/**
 * What pressing Run really costs, in model calls.
 *
 * Three sources, and the third one used to fall out of the sum the author was shown: every ticked
 * chapter is a call, the glossary is a call, and a study documented in another language than the
 * report is translated first — its own paid call, before the first chapter is written. The button
 * counted the ticks alone, so a German study in an English report offered "Run 10" and billed
 * eleven, while the foot line (which did count the translation, in the denominator) ran a step
 * behind for the whole run (V169). One arithmetic, used by the button, the dialog and the bar, so
 * the three cannot drift apart again.
 */
export function runSize(
  items: PlanItem[],
  chosen: string[],
  otherLanguage: boolean
): { chapters: number; glossary: number; translation: number; total: number } {
  const picked = items.filter((i) => chosen.includes(i.section.id))
  const chapters = picked.filter((i) => i.action !== 'glossary').length
  const glossary = picked.some((i) => i.action === 'glossary') ? 1 : 0
  // The study texts are translated so that the writers see them — with no chapter to write there is
  // nobody to see them, and `runPlan` calls no translator either.
  const translation = chapters > 0 && otherLanguage ? 1 : 0
  return { chapters, glossary, translation, total: chapters + glossary + translation }
}

/**
 * How far the run is, in the same units the button promised.
 *
 * `mainDone` is what the main process reports, and it counts chapters and nothing else — it never
 * saw the translation. Adding rather than replacing is the whole fix: the renderer runs the
 * translation itself, counts it, and then had it overwritten by the next chapter's progress event.
 */
export const runDone = (mainDone: number, translation: number, total: number): number =>
  Math.min(translation + mainDone, total)

/** How each outcome is labelled and coloured in the dry run. A ticked `keep` is a fresh write. */
export const PLAN_LABEL: Record<PlanAction, { label: string; tone: string }> = {
  write: { label: 'Write', tone: 'go' },
  update: { label: 'Update', tone: 'warn' },
  glossary: { label: 'Rebuild glossary', tone: 'go' },
  keep: { label: 'Keep', tone: '' },
  blocked: { label: 'Waiting on a setting', tone: 'warn' }
}

/** What a ticked item does: a ticked `keep` writes the chapter anew. */
export const runMode = (item: PlanItem): 'write' | 'update' => (item.action === 'update' ? 'update' : 'write')

/**
 * What a finished run did, in one line — counted from what came back, not from what was asked.
 * `unchanged` are updates whose chapter was still right as it stood.
 */
export function runSummary(o: {
  written: number
  updated: number
  unchanged: number
  unfinished: number
  firstError?: string
  errors?: number
}): string {
  const parts = [
    o.written ? `${o.written} written` : '',
    o.updated ? `${o.updated} updated` : '',
    o.unchanged ? `${o.unchanged} still right as they stood` : '',
    o.unfinished
      ? `${o.unfinished} could not be finished` +
        (o.firstError
          ? ` — ${o.firstError}${(o.errors ?? 0) > 1 ? ` (+${(o.errors ?? 0) - 1} more)` : ''}`
          : '')
      : ''
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Nothing was written.'
}

/**
 * What this panel may say about the study's language, and whether the run pays for a translation.
 *
 * `studyLang` was a plain string defaulting to `'en'`, and a failed `GET /study` left that default
 * standing — which is not an omission but a claim, and which of its two lies you got depended only on
 * the report's own language. An English report was told there was nothing to translate, so the step
 * dropped out of the run and every chapter was written from untranslated German prose: V158 again, this
 * time through a failed request instead of an empty field. A German report was told, in those words,
 * that "the study is documented in English" — of a study that demonstrably is not.
 *
 * So `null` is a language of its own here, and the hint, the dialog's sentence and the run's step are
 * decided in one place, because deriving them separately is how they came to disagree.
 *
 * With the language unknown the run keeps the translation step. That is the cheaper mistake by a wide
 * margin: one counted call whose worst case is a few study labels coming back reworded, against a whole
 * run of chapters written from prose in the wrong language and a bilingual deliverable that only a full
 * rewrite fixes. It is safe rather than free — `translateStudyTexts` is told the *target* language only
 * and instructs the model to return text already in it unchanged, and `translations/set` drops any key
 * that was not a candidate, so nothing can be corrupted by asking. But `POST …/translations` hands back
 * every candidate (as `open` while no map is stored, as `unchanged` once one is), so a study that really
 * was in the report language pays for one round of the model repeating what it was given. A step that
 * costs something is named out loud in the dialog rather than slipped into the count.
 */
export function languagePlan(
  /** The language the study is documented in — `null` when the study record could not be read. */
  studyLang: string | null,
  /** The report's own language. */
  reportLang: string,
  /** True when `studyLang` is the app's reading of the prose rather than the author's declaration. */
  guessed: boolean,
  /** Review findings still printed in another language than the report's (`POST …/translations/foreign`,
   *  V425). Counted only while study and report share a language — otherwise the study step translates
   *  them along with everything else. */
  foreign = 0
): { hint: string | null; runNote: string | null; translate: boolean; foot: string | null } {
  const target = langLabel(reportLang)
  // Silence was the other candidate for the unknown case, and it is the worse one: the run below now
  // buys a translation step, and a step nobody explained is the next thing to be mistrusted.
  if (studyLang == null)
    return {
      hint:
        `The study’s language could not be read, so nothing here knows whether its texts need ` +
        `translating. They are translated into ${target} before “Write all” anyway — one call, ` +
        `and text that is already in ${target} comes back as it was — because the alternative is a ` +
        `document half in another language. Set the language in Model info to settle it.`,
      runNote:
        `The study’s language could not be read, so its texts are translated into ${target} first, once, ` +
        `before the first chapter — as a precaution, not because anything says they need it. That is a ` +
        `call of its own and is counted in Run.`,
      translate: true,
      foot: 'study language: not read'
    }
  if (studyLang === reportLang) {
    // V425: the reviewer writes English whatever the study speaks, so a German study in a German report
    // printed its open findings' English titles in chapter 8.3 — the translation step was off because the
    // two languages matched. Those texts alone are translated then, and the step says so.
    if (foreign > 0)
      return {
        hint: null,
        runNote:
          `${foreign === 1 ? 'One open review finding is' : `${foreign} open review findings are`} ` +
          `written in another language than this ${target} report: ${foreign === 1 ? 'it is' : 'they are'} ` +
          `translated into ${target} first, once, before the first chapter. That is a call of its own and ` +
          `is counted in Run.`,
        translate: true,
        foot: null
      }
    return { hint: null, runNote: null, translate: false, foot: null }
  }
  // The card hedged a guessed language and the dialog did not, so the more assertive of the two
  // sentences stood exactly where the money is approved (V204). The dialog keeps the two facts it has to
  // carry either way — the translation happens first and once, and it is a call counted in Run — and
  // borrows the card's voice for the rest, because a reading of the prose is not a declaration.
  return {
    hint:
      (guessed ? 'This study reads as ' : 'The study is documented in ') +
      `${langLabel(studyLang)}; this report is ${target}. Study texts — process names, scenario names, ` +
      `the functional unit — translate here, and automatically before “Write all”.` +
      (guessed
        ? ' Nobody set the study language, so this is read from the text — set it in Model info to be sure.'
        : ''),
    runNote: guessed
      ? `This study reads as ${langLabel(studyLang)} — nobody set its language, so that is read from ` +
        `the prose: its texts are translated into ${target} first, once, before the first chapter. That ` +
        `is a call of its own and is counted in Run.`
      : `The study is documented in ${langLabel(studyLang)}: its texts are translated into ${target} ` +
        `first, once, before the first chapter. That is a call of its own and is counted in Run.`,
    translate: true,
    foot: null
  }
}
