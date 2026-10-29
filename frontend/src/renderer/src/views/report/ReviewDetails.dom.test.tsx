import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import ReviewDetails from './ReviewDetails'
import type { ReportSection } from '../../lib/report/model'

const chapter = (issues: Array<{ quote: string; status: string }>): ReportSection =>
  ({
    id: 's1',
    kind: 'prose',
    title: '',
    text: 'Written.',
    text_version: 'v1',
    ai_review: {
      reviewer: 'reader',
      rounds: 3,
      verdict: 'accepted',
      issues: issues.map((i) => ({ ...i, problem: 'p' })),
      questions: [],
      hints: {},
      text_version: 'v1',
      at: '2026-10-28T00:00:00+00:00'
    }
  }) as unknown as ReportSection

const summary = (): string => document.querySelector('.rsec-review-log summary')?.textContent ?? ''

describe('what the second reader made of a chapter', () => {
  it('does not say "nothing to object to" under a point it still doubts', () => {
    render(
      <ReviewDetails
        section={chapter([{ quote: 'A sentence.', status: 'open' }])}
        busy={false}
        onKeep={async () => {}}
        onFix={() => {}}
      />
    )
    expect(screen.getByText(/still doubts a sentence/)).toBeTruthy()
    expect(summary()).not.toMatch(/nothing to object to/)
  })

  it('says it when there was nothing', () => {
    render(<ReviewDetails section={chapter([])} busy={false} onKeep={async () => {}} onFix={() => {}} />)
    expect(summary()).toMatch(/3 readings · nothing to object to/)
  })
})
