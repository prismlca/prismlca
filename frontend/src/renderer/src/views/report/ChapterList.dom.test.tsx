import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import ChapterList from './ChapterList'
import type { ReportSection, StoredReportFull } from '../../lib/report/model'
import type { StaleChapter } from '../../lib/report/staleness'

/**
 * A chapter row says one thing at most: what the author should do next, in a word, with the reason in
 * its tooltip — and a click goes where that can be done. Everything a model settled on its own stays
 * out of the row.
 */
const base = {
  id: 'c1',
  kind: 'contribution',
  title: '',
  order: 3,
  locked: false,
  text: 'Production carries {{contribution.groups.0.share_text}}.',
  prompt_override: null,
  extra_instructions: '',
  source: 'ai',
  generated_at: null,
  text_version: 'v1'
} as unknown as ReportSection

const reportOf = (section: ReportSection, extra: Partial<StoredReportFull> = {}): StoredReportFull =>
  ({
    id: 'r',
    name: 'R',
    subtitle: '',
    lang: 'en',
    template: 't',
    sections: [section],
    ...extra
  }) as StoredReportFull

const pending: StaleChapter = {
  section_id: 'c1',
  remedy: 'none',
  findings: [],
  rebindable: 0,
  review: 'pending'
}

const handlers = () => ({
  onTitleDraft: vi.fn(),
  onReorder: vi.fn(),
  onWrite: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onReadDiff: vi.fn(),
  onQuestions: vi.fn(),
  onResolveAbbreviations: vi.fn(),
  onCoverOpen: vi.fn()
})

const list = (
  section: ReportSection,
  opts: {
    stale?: Record<string, StaleChapter>
    drafts?: Record<string, { text: string }>
    reasons?: Record<string, string>
    report?: Partial<StoredReportFull>
  } = {}
) => {
  const h = handlers()
  render(
    <ChapterList
      report={reportOf(section, opts.report)}
      stale={opts.stale ?? {}}
      drafts={opts.drafts ?? {}}
      draftReasons={opts.reasons ?? {}}
      working={{}}
      placeholder={null}
      writing={null}
      runActive={false}
      blocker={() => null}
      mutate={async () => true}
      base="/b"
      {...h}
    />
  )
  return h
}

const review = (over: Record<string, unknown>) => ({
  reviewer: 'reader-m',
  rounds: 1,
  issues: [],
  questions: [],
  hints: {},
  verdict: 'accepted',
  text_version: 'v1',
  at: '2026-10-27T10:00:00+00:00',
  ...over
})

describe('the chapter row', () => {
  it('shows nothing for a chapter that is written, read and approved', () => {
    list(base, { stale: { c1: { ...pending, review: 'released' } } })
    expect(document.querySelector('.rsec-badges')?.textContent).toBe('')
  })

  it('offers no repair buttons of its own any more', () => {
    list(base, { stale: { c1: { ...pending, remedy: 'review' } } })
    for (const name of ['Release', 'Correct…', 'Accept as it is', 'Re-link'])
      expect(screen.queryByRole('button', { name })).toBeNull()
  })

  it('says a chapter needs an update when the model moved under it', () => {
    list(base, { stale: { c1: { ...pending, remedy: 'rewrite' } } })
    expect(screen.getByRole('button', { name: /^Needs update/ })).toBeTruthy()
  })

  it('names a question and takes the author to the questions', () => {
    const section = {
      ...base,
      ai_review: review({ questions: [{ id: 'q-1', question: 'Is end of life in scope?' }] })
    } as ReportSection
    const h = list(section, { stale: { c1: pending } })
    fireEvent.click(screen.getByRole('button', { name: /^Question/ }))
    expect(h.onQuestions).toHaveBeenCalled()
  })

  it('stops naming a question once it is answered — the chapter then wants the answer worked in', () => {
    const section = {
      ...base,
      ai_review: review({ questions: [{ id: 'q-1', question: 'Is end of life in scope?' }] })
    } as ReportSection
    list(section, {
      stale: { c1: pending },
      report: { answers: { 'q-1': { answer: 'No', at: '2026-10-27T11:00:00+00:00' } } }
    })
    expect(screen.queryByRole('button', { name: /^Question/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^Needs update/ })).toBeTruthy()
  })

  it('counts the points the second reader still doubts and opens the chapter', () => {
    const section = {
      ...base,
      ai_review: review({ issues: [{ quote: 'Production carries', problem: 'x', status: 'open' }] })
    } as ReportSection
    const h = list(section, { stale: { c1: pending } })
    fireEvent.click(screen.getByRole('button', { name: /^1 point/ }))
    expect(h.onEdit).toHaveBeenCalledWith('c1')
  })

  it('forgets a reading that no longer describes the text (a hand edit since)', () => {
    const section = {
      ...base,
      ai_review: review({
        text_version: 'old',
        issues: [{ quote: 'Production carries', problem: 'x', status: 'open' }]
      })
    } as ReportSection
    list(section, { stale: { c1: pending } })
    expect(screen.queryByRole('button', { name: /point/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^New/ })).toBeTruthy()
  })

  it('shows what changed since the approval when a new chapter was read before', () => {
    const h = list(base, {
      stale: { c1: { ...pending, changed_since_reviewed: true, reviewed_text: 'The old text.' } }
    })
    fireEvent.click(screen.getByRole('button', { name: /^New/ }))
    expect(h.onReadDiff).toHaveBeenCalledWith(expect.objectContaining({ before: 'The old text.' }))
  })

  it('says a held draft could not be finished, with the reason in its tooltip', () => {
    list({ ...base, text: '' } as ReportSection, {
      drafts: { c1: { text: 'draft' } },
      reasons: { c1: 'a placeholder does not resolve' }
    })
    const chip = screen.getByRole('button', { name: /^Couldn’t finish/ })
    expect(chip.getAttribute('title')).toContain('a placeholder does not resolve')
  })
})
