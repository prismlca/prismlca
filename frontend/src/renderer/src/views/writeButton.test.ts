import { describe, expect, it, vi } from 'vitest'

import { writeConfirmSpec, writeTooltip } from './ReportSections'

/**
 * The single-chapter Write button, which for a long time was the one paid, destructive action in the
 * report page that asked nothing and warned nothing.
 *
 * The bulk path had been fixed for exactly this: the foot button reads "Rewrite all chapters" once
 * every chapter holds text, and it opens a plan dialog listing every chapter with what would happen
 * to it. The per-row button replaced an approved text on one click, with a tooltip that promised
 * "Let a model write this chapter from the study metadata and the numbers" — no word about the
 * replacement, and no word about the fact that it can be undone.
 */
const empty = { kind: 'prose', title: 'Interpretation', text: '' }
const written = { kind: 'prose', title: 'Interpretation', text: 'The study finds…' }
const comment = { kind: 'lcia', title: '', text: 'The table above shows…' }

describe('the confirmation before a chapter is rewritten', () => {
  it('is not asked for an empty chapter — a box in front of the ordinary action is noise', () => {
    expect(writeConfirmSpec(empty, false, () => {})).toBeNull()
    // Whitespace is not text: a chapter someone cleared has nothing to lose either.
    expect(writeConfirmSpec({ ...empty, text: '  \n ' }, false, () => {})).toBeNull()
  })

  it('is asked for a chapter that holds text', () => {
    const spec = writeConfirmSpec(written, false, () => {})
    expect(spec?.title).toBe('Replace this chapter?')
    expect(spec?.confirmLabel).toBe('Replace the chapter')
  })

  it('says that the present text is replaced, and that a model call is paid for', () => {
    const spec = writeConfirmSpec(written, false, () => {})
    expect(spec?.message).toContain('already holds text')
    expect(spec?.message).toContain('in place of what is there')
    expect(spec?.message).toContain('a paid call')
  })

  // This is why it can be a confirmation and not a warning — and why it is not `danger`.
  it('names the way back, by the words the row and the diff dialog actually use', () => {
    const spec = writeConfirmSpec(written, false, () => {})
    expect(spec?.message).toContain('“before” on the chapter’s row')
    expect(spec?.message).toContain('Put it back')
    expect(spec?.danger).toBeUndefined()
  })

  it('says so when the wording being replaced is one the author signed off', () => {
    const spec = writeConfirmSpec(written, true, () => {})
    expect(spec?.message).toContain('you have released')
    expect(spec?.message).toContain('wording you approved')
  })

  // A commentable chapter's text is the paragraph under its tables, and the dialog calls it that:
  // "Replace this chapter?" over a table nobody is touching would misdescribe what is at stake.
  it('calls a comment a comment', () => {
    const spec = writeConfirmSpec(comment, false, () => {})
    expect(spec?.title).toBe('Replace this comment?')
    expect(spec?.confirmLabel).toBe('Replace the comment')
    expect(spec?.message).toContain('already holds a comment')
  })

  it('writes only once the author confirms', () => {
    const write = vi.fn()
    const spec = writeConfirmSpec(written, false, write)
    // Building the question must not do the thing being asked about.
    expect(write).not.toHaveBeenCalled()
    spec?.onConfirm()
    expect(write).toHaveBeenCalledTimes(1)
  })
})

describe('the Write button’s tooltip', () => {
  it('promises a fresh chapter only where there is nothing to lose', () => {
    expect(writeTooltip(empty, null)).toBe(
      'Let a model write this chapter from the study metadata and the numbers'
    )
    expect(writeTooltip({ ...empty, kind: 'lcia' }, null)).toBe(
      'Let a model write the comment under this chapter’s tables'
    )
  })

  it('says it replaces, and that the replacement can be undone, once the chapter holds text', () => {
    const tip = writeTooltip(written, null)
    expect(tip).not.toBe(writeTooltip(empty, null))
    expect(tip).toContain('replaces the present wording')
    expect(tip).toContain('recoverable')
  })

  // The two states the button cannot be pressed in keep the reasons they had: they explain a disabled
  // control, which is the more useful thing to say, and no dialog is ever reached from them.
  it('keeps naming the reason where the button is disabled', () => {
    expect(writeTooltip({ ...written, locked: true }, null)).toBe('Locked — unlock it first')
    expect(writeTooltip(written, 'Choose a “Contribution breakdown” above first')).toBe(
      'Choose a “Contribution breakdown” above first'
    )
  })
})
