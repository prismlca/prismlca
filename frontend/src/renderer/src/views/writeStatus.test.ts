import { describe, expect, it } from 'vitest'

import { elapsedLabel, stageBrief, writeStatus, type WriteStage } from './ReportSections'

/**
 * The line a single chapter's write shows while it runs.
 *
 * The bulk run always had one — "Writing 7 of 11 · still open: …", a bar that fills per chapter. A
 * single chapter had `<Busy label="Writing" />` and nothing else, for 158 s and 385 s in
 * practice. What the panel can say is a pure function of what the writer last
 * reported and of a clock, and it is tested as one: no waiting, no fake timers.
 */
const line = (stage: WriteStage | null, seconds = 12): string => writeStatus('Interpretation', stage, seconds)

describe('the wait for one chapter, in words', () => {
  it('names the chapter, whatever the writer is doing', () => {
    expect(line({ phase: 'sent' })).toContain('Writing “Interpretation”')
    expect(line({ phase: 'checking' })).toContain('Writing “Interpretation”')
  })

  // Two different problems, and the reasoning ticks are the only thing that tells them apart: a
  // minute of "waiting" is a provider queue, a minute of "thinking" is work being done.
  it('separates an open request from a model that is demonstrably thinking', () => {
    expect(line({ phase: 'sent' })).toBe('Writing “Interpretation” — waiting for the model · 12 s')
    expect(line({ phase: 'thinking', chars: 900 })).toBe(
      'Writing “Interpretation” — the model is thinking · 12 s'
    )
  })

  // Deliberately no number here: how many characters of hidden chain-of-thought have arrived is not
  // something an author can act on, and it is the one count in the set that would only ever grow
  // into the tens of thousands. That it is thinking rather than hanging is the whole message.
  it('says so once the thinking has run unusually long, and how to get out', () => {
    const early = writeStatus('Interpretation', { phase: 'thinking', chars: 900 }, 300)
    expect(early).toContain('the model is thinking')
    expect(early).not.toContain('unusually long')
    const late = writeStatus('Interpretation', { phase: 'thinking', chars: 900 }, 360)
    expect(late).toContain('unusually long')
    expect(late).toContain('Cancel')
    expect(late).toContain('6:00')
  })

  it('does not count the reasoning it cannot show', () => {
    expect(line({ phase: 'thinking', chars: 41_200 })).toBe(line({ phase: 'thinking', chars: 3 }))
  })

  it('counts the chapter as it arrives', () => {
    expect(line({ phase: 'writing', chars: 1240 })).toBe(
      'Writing “Interpretation” — 1,240 characters so far · 12 s'
    )
  })

  it('names a lookup and how many of the allowance it has spent', () => {
    expect(line({ phase: 'lookup', name: 'explain_result', spent: 2, allowance: 8 })).toBe(
      'Writing “Interpretation” — looking up explain_result (2 of 8) · 12 s'
    )
  })

  // The invisible minute: a refused first answer is a second full model call, and behind a spinner it
  // was indistinguishable from the first one still running.
  it('says when the check refused the text and a second attempt is under way', () => {
    expect(line({ phase: 'revising', attempt: 2 })).toBe(
      'Writing “Interpretation” — refused by the check, revising (attempt 2) · 12 s'
    )
  })

  it('covers the two steps the writer knows nothing about', () => {
    expect(line({ phase: 'brief' })).toContain('collecting the numbers')
    expect(line({ phase: 'storing' })).toContain('storing')
  })

  // Nothing reported yet reads as the step that is actually running then: the brief, which computes
  // the report data when it is not cached and is minutes of its own on an ecoinvent model.
  it('falls back to the first step rather than to a blank', () => {
    expect(line(null)).toBe(line({ phase: 'brief' }))
  })
})

describe('the clock', () => {
  it('counts seconds up to a minute', () => {
    expect(elapsedLabel(0)).toBe('0 s')
    expect(elapsedLabel(59)).toBe('59 s')
  })

  // "385 s" is a number the reader has to divide before it means anything.
  it('turns into minutes and seconds above that', () => {
    expect(elapsedLabel(60)).toBe('1:00')
    expect(elapsedLabel(158)).toBe('2:38')
    expect(elapsedLabel(385)).toBe('6:25')
  })

  it('never shows a negative or a fractional second', () => {
    expect(elapsedLabel(-3)).toBe('0 s')
    expect(elapsedLabel(12.7)).toBe('12 s')
  })
})

describe('stageBrief — a run with four lanes says what each of them is doing (V269)', () => {
  it('gives the lookup counter, because it is the only number that bounds the wait', () => {
    expect(stageBrief({ phase: 'lookup', name: 'get_process_details', spent: 6, allowance: 13 })).toBe(
      'lookup 6 of 13'
    )
  })

  it('is short enough that three of them fit on the foot line beside the chapter names', () => {
    const all: WriteStage[] = [
      { phase: 'sent' },
      { phase: 'thinking', chars: 900 },
      { phase: 'writing', chars: 4200 },
      { phase: 'checking' },
      { phase: 'revising', attempt: 2 },
      { phase: 'storing' }
    ]
    for (const s of all) expect(stageBrief(s).length).toBeLessThanOrEqual(14)
  })

  it('says nothing for a lane that has not started — a name alone is also the truth', () => {
    expect(stageBrief(null)).toBe('')
    // Since V422 main reports the brief per lane: the first Write-all wave of a
    // silicone report sat 125 s in it, and the foot line said nothing about any of the five.
    expect(stageBrief({ phase: 'brief' })).toBe('collecting the numbers')
  })
})
