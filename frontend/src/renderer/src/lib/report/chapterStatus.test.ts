import { describe, expect, it } from 'vitest'
import { chapterState, stateCounts, stateSummary } from './chapterStatus'
import type { ReportSection } from './model'

/**
 * One state per chapter, the most pressing first: a model at work, a draft that could not be
 * finished, a setting it waits on, an update it needs, a question, a doubted sentence, then "New".
 * The foot line counts them into one sentence of what is left to do.
 */
const written = {
  id: 'c',
  kind: 'prose',
  text: 'Text.',
  text_version: 'v1',
  ai_review: {
    reviewer: 'r',
    rounds: 1,
    issues: [{ quote: 'Text', problem: 'p', status: 'open' }],
    questions: [{ id: 'q-1', question: 'Q?' }],
    hints: {},
    verdict: 'open_points',
    text_version: 'v1',
    at: '2026-10-27T10:00:00+00:00'
  }
} as unknown as ReportSection

describe('chapterState', () => {
  it('puts a model at work above everything else', () => {
    expect(chapterState(written, { working: 'update', draftReason: 'x' }).label).toBe('Updating…')
  })

  it('orders an update before a question, a question before a point, a point before New', () => {
    const pending = {
      section_id: 'c',
      remedy: 'none' as const,
      findings: [],
      rebindable: 0,
      review: 'pending' as const
    }
    expect(chapterState(written, { stale: { ...pending, remedy: 'review' } }).kind).toBe('update')
    expect(chapterState(written, { stale: pending }).kind).toBe('input')
    expect(
      chapterState(written, {
        stale: pending,
        answers: { 'q-1': { answer: 'A', at: '2026-10-27T09:00:00+00:00' } }
      }).kind
    ).toBe('check') // answered BEFORE the chapter was written: it already knew
    const noPoints = { ...written, ai_review: { ...written.ai_review!, issues: [], questions: [] } }
    expect(chapterState(noPoints as ReportSection, { stale: pending }).kind).toBe('new')
  })

  it('shows nothing for an empty chapter and nothing for a read one', () => {
    expect(chapterState({ ...written, text: '' }, {}).label).toBe('')
    const read = { ...written, ai_review: null }
    expect(
      chapterState(read as ReportSection, {
        stale: { section_id: 'c', remedy: 'none', findings: [], rebindable: 0, review: 'released' }
      }).kind
    ).toBe('ready')
  })
})

describe('stateSummary', () => {
  it('says what is left in the order the author does it', () => {
    const counts = stateCounts([
      { kind: 'new', label: 'New', title: '' },
      { kind: 'empty', label: '', title: '' },
      { kind: 'empty', label: '', title: '' },
      { kind: 'update', label: '', title: '' }
    ])
    expect(stateSummary(counts)).toBe(
      '2 chapters to write · 1 needs an update · 1 new for you — approve the report once you have read it'
    )
  })

  it('says so when nothing is left', () => {
    expect(stateSummary({ ready: 4 })).toBe('Up to date and approved')
  })
})

describe('typed numbers left for the author (V461)', () => {
  const withNumber = {
    ...written,
    ai_review: {
      ...written.ai_review!,
      questions: [],
      issues: [
        {
          quote: 'It weighs 8.5 kg.',
          problem: 'typed',
          status: 'open',
          origin: 'typed_number',
          number: '8.5'
        }
      ]
    }
  } as unknown as ReportSection

  it('names the numbers to check instead of a doubted sentence, and the foot line counts them', () => {
    const state = chapterState(withNumber, {})
    expect(state.kind).toBe('numbers')
    expect(state.label).toBe('1 number to check')
    expect(stateSummary(stateCounts([state]))).toBe('1 with typed numbers to check')
  })
})
