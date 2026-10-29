import { describe, expect, it } from 'vitest'

import { languagePlan, runSize } from './ReportSections'

/**
 * The study's language has three states, and the panel could hold two of them.
 *
 * `GET /api/v1/study` answers with the declared language, or with the backend's reading of the prose
 * when nobody declared one. When it does not answer at all, the state left standing was the `'en'`
 * default — and which lie that told depended purely on the report's own language (V201). An English
 * report: nothing differs, so no translation step, so ten chapters written from untranslated German
 * prose and a bilingual deliverable, paid for in full. A German report: the panel announced that "the
 * study is documented in English", of a study that plainly is not.
 *
 * Both sentences and the run's step come out of this one function, because deriving them separately is
 * how they came to disagree in the first place.
 */
const de = 'The study is documented in Deutsch'
const unread = 'The study’s language could not be read'

describe('a language that was read', () => {
  it('says nothing at all when it matches the report — the normal case is silent', () => {
    const p = languagePlan('en', 'en', false)
    expect(p).toEqual({ hint: null, runNote: null, translate: false, foot: null })
  })

  it('names both languages when they differ, and plans the translation', () => {
    const p = languagePlan('de', 'en', false)
    expect(p.hint).toContain(de)
    expect(p.hint).toContain('this report is English')
    expect(p.translate).toBe(true)
  })

  it('keeps the declared/guessed distinction — a guess is not a statement', () => {
    // A language nobody set is the app reading function words, and the hint has always hedged about it
    // and said where to settle it. That wording is load-bearing and stays exactly as it was.
    const guessed = languagePlan('de', 'en', true)
    expect(guessed.hint).toContain('This study reads as Deutsch')
    expect(guessed.hint).toContain('Nobody set the study language, so this is read from the text')
    expect(languagePlan('de', 'en', false).hint).not.toContain('Nobody set')
  })

  it('keeps quiet in the foot: a call that answered has nothing to report there', () => {
    expect(languagePlan('de', 'en', false).foot).toBeNull()
    expect(languagePlan('en', 'en', false).foot).toBeNull()
  })

  it('tells the dialog that the extra call is a call', () => {
    // The eleventh call of a "Run 10" (V169). The dialog is where the money is approved, so this is
    // where the step that has no tick box gets named.
    expect(languagePlan('de', 'en', false).runNote).toContain('counted in Run')
  })

  it('keeps the declared sentence in the dialog word for word', () => {
    // The approved wording. Rewrapping the template must not reword it.
    expect(languagePlan('de', 'fr', false).runNote).toBe(
      'The study is documented in Deutsch: its texts are translated into Français first, once, before ' +
        'the first chapter. That is a call of its own and is counted in Run.'
    )
  })

  it('hedges the guess in the dialog too, and still names the call', () => {
    // V204: the card said "reads as" and the dialog said "is documented in", so the assertion nobody
    // could back stood where the money is approved. Both facts the dialog owes the user survive it.
    const note = languagePlan('de', 'fr', true).runNote ?? ''
    expect(note).not.toContain('documented in')
    expect(note).toContain('This study reads as Deutsch')
    expect(note).toContain('read from the prose')
    expect(note).toContain('first, once, before the first chapter')
    expect(note).toContain('counted in Run')
  })

  it('never asserts a guessed language in any report language', () => {
    // The claim is about the study, so no report language may bring it back.
    for (const report of ['en', 'fr', 'es', 'pt'])
      expect(languagePlan('de', report, true).runNote ?? '').not.toContain('is documented in')
  })
})

describe('a language that could not be read', () => {
  const p = languagePlan(null, 'en', false)

  it('never claims the study is English, whatever the report is', () => {
    // The two shapes of V201, in the two report languages that produced them.
    expect(languagePlan(null, 'en', false).hint).not.toContain('documented in English')
    expect(languagePlan(null, 'de', false).hint).not.toContain('documented in English')
  })

  it('says so, rather than falling silent', () => {
    // Silence was the alternative and it is worse now: the run below buys a translation step, and an
    // unexplained step on the bill is the next thing to be mistrusted.
    expect(p.hint).toContain(unread)
    expect(p.hint).toContain('Set the language in Model info')
  })

  it('keeps the translation step — the expensive half of the finding', () => {
    // Not because anything says the texts need it, but because the other way round costs a whole run.
    expect(languagePlan(null, 'en', false).translate).toBe(true)
    expect(languagePlan(null, 'de', false).translate).toBe(true)
  })

  it('admits in the dialog that the step is a precaution and costs a call', () => {
    expect(p.runNote).toContain('as a precaution')
    expect(p.runNote).toContain('counted in Run')
  })

  it('reports the failed call in the always-visible foot, as V200 does for the other one', () => {
    expect(p.foot).toBe('study language: not read')
  })

  it('is not swayed by a stale guess flag', () => {
    // `studyLangGuessed` describes a language we have; with none, it has nothing to qualify.
    expect(languagePlan(null, 'en', true)).toEqual(languagePlan(null, 'en', false))
  })
})

describe('what the run actually does with it', () => {
  const items = [
    { section: { id: 'goal' }, action: 'write' },
    { section: { id: 'gloss' }, action: 'glossary' }
  ] as unknown as Parameters<typeof runSize>[0]

  it('bills the precautionary translation as one step of the run, like a known mismatch', () => {
    const unknown = runSize(items, ['goal'], languagePlan(null, 'en', false).translate)
    const known = runSize(items, ['goal'], languagePlan('de', 'en', false).translate)
    expect(unknown).toEqual(known)
    expect(unknown.total).toBe(2)
  })

  it('still buys nothing when there is no chapter to write', () => {
    // A report with nothing ticked must not grow a translation call out of a failed request: there is
    // nobody to read the translated texts, and `runPlan` calls no translator either.
    expect(runSize(items, [], languagePlan(null, 'en', false).translate).total).toBe(0)
    expect(runSize(items, ['gloss'], languagePlan(null, 'en', false).translate).translation).toBe(0)
  })

  it('costs nothing extra in the normal case', () => {
    expect(runSize(items, ['goal'], languagePlan('en', 'en', false).translate).total).toBe(1)
  })
})

describe('review findings in another language (V425)', () => {
  it('runs the translation step when study and report agree but the reviewer wrote English', () => {
    const p = languagePlan('de', 'de', false, 3)
    expect(p.translate).toBe(true)
    expect(p.runNote).toContain('3 open review findings')
    expect(p.hint).toBeNull()
    expect(runSize([], [], p.translate).translation).toBe(0) // still only with a chapter to write
  })

  it('stays silent without such findings', () => {
    expect(languagePlan('de', 'de', false, 0)).toEqual({
      hint: null,
      runNote: null,
      translate: false,
      foot: null
    })
  })

  it('leaves the study step’s own sentence alone when the languages differ', () => {
    expect(languagePlan('de', 'en', false, 2).runNote).toContain('The study is documented in Deutsch')
  })
})
