import { describe, expect, it } from 'vitest'

import { stalenessNotice } from './ReportSections'

/**
 * A staleness check has three possible outcomes, and the page could draw only two of them.
 *
 * The case that found this: a parameter that a formula depended on was
 * deleted while a scenario was applied, so the scenario's overrides could not be undone and the backend
 * answered *every* calculation with 400 and a very good message. The report page showed "Every chapter
 * written", no counter, no warning — the message appeared nowhere on it (V200). `loadStaleness` already
 * drew the distinction in its return value ("null, not {}") and then threw it away in the state it
 * displayed, because `{}` and "could not be checked" render identically.
 *
 * So the decision is pulled out here: was there anything to check, and if so, what does the page say.
 */
const refusal =
  'The scenario “Milderes Klima (2500 Kd)” was applied to this model and could not be undone, so its ' +
  'parameters are still overridden. Set them back before trusting any result: dist_distribution, ' +
  'energy_production'

describe('a check that failed over chapters that needed it', () => {
  const notice = stalenessNotice(8, refusal)

  it('is reported rather than drawn as a clean bill of health', () => {
    expect(notice).not.toBeNull()
  })

  it('says the check did not run, and over how much', () => {
    expect(notice?.lead).toContain('did not run')
    expect(notice?.lead).toContain('8 written chapters')
  })

  it("carries the backend's own sentence, word for word", () => {
    // The most valuable part of this finding: it names the scenario and the parameters to set back.
    // A summary of ours ("the check failed") is not something an author can act on.
    expect(notice?.detail).toBe(refusal)
  })

  it('counts one chapter as one', () => {
    expect(stalenessNotice(1, refusal)?.lead).toContain('1 written chapter,')
  })

  it('still says something when the failure arrived without words', () => {
    // Whitespace is truthy, so the guard above lets it through — and an empty <b> would read as no
    // reason at all, which is the very shape being fixed here.
    expect(stalenessNotice(3, '   ')?.detail).toBe('The check gave no reason.')
  })
})

describe('a check that failed with nothing to check', () => {
  it('stays quiet — this is the case the swallowing was built for', () => {
    // A report with no chapter written yet cannot be checked, the backend says so, and an error over it
    // would fire on every freshly created report.
    expect(stalenessNotice(0, refusal)).toBeNull()
  })
})

describe('a check that answered', () => {
  it('says nothing here when it found nothing — the empty badges are its voice', () => {
    expect(stalenessNotice(8, null)).toBeNull()
  })

  it('says nothing here when it found something either — the badges and counters are', () => {
    // Findings have their own row badges and their own two counters in the foot ("3 out of date · 2 to
    // check"). This notice exists only for the answer that never arrived; duplicating the other two
    // would put a second, competing verdict next to them.
    expect(stalenessNotice(8, undefined)).toBeNull()
  })
})

describe('what separates the two', () => {
  it('is the failure itself, not how much it had to say about it', () => {
    // A blank reason is a bad failure, not an absent one — the empty string used to fall on the quiet
    // side of this guard, which is precisely the confusion V200 was.
    expect(stalenessNotice(8, '')).not.toBeNull()
    expect(stalenessNotice(8, '')?.detail).toBe('The check gave no reason.')
  })
})
