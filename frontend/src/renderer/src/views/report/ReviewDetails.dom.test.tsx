import { describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
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
        onReplace={async () => {}}
        onFix={() => {}}
      />
    )
    expect(screen.getByText(/still doubts a sentence/)).toBeTruthy()
    expect(summary()).not.toMatch(/nothing to object to/)
  })

  it('says it when there was nothing', () => {
    render(
      <ReviewDetails
        section={chapter([])}
        busy={false}
        onKeep={async () => {}}
        onReplace={async () => {}}
        onFix={() => {}}
      />
    )
    expect(summary()).toMatch(/3 readings · nothing to object to/)
  })

  it('offers the typed numbers first: replace with a candidate, or keep with a reason (V461)', async () => {
    const kept: Array<[string, string | undefined]> = []
    const replaced: Array<[string, string]> = []
    const section = chapter([])
    section.ai_review!.reviewer = null
    section.ai_review!.issues = [
      {
        quote: 'Packaging carries about 55 % of the impact.',
        problem: '“55” is typed into the text …',
        status: 'open',
        origin: 'typed_number',
        number: '55',
        candidates: [{ path: 'groups.0.share_text', label: 'Packaging', prints: '54.8 %', own_percent: true }]
      }
    ]
    render(
      <ReviewDetails
        section={section}
        busy={false}
        onKeep={async (q, r) => void kept.push([q, r])}
        onReplace={async (q, p) => void replaced.push([q, p])}
        onFix={() => {}}
      />
    )
    expect(screen.getByText(/A number is typed into the text/)).toBeTruthy()
    // No second model read it: no "Read by" line pretending one did.
    expect(document.querySelector('.rsec-review-log')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByText('Replace with “54.8 %” (Packaging)'))
    })
    expect(replaced).toEqual([['Packaging carries about 55 % of the impact.', 'groups.0.share_text']])
    fireEvent.change(screen.getByLabelText('Why the number stays'), {
      target: { value: 'Quoted from the EPD' }
    })
    await act(async () => {
      fireEvent.click(screen.getByText('Keep this number'))
    })
    expect(kept).toEqual([['Packaging carries about 55 % of the impact.', 'Quoted from the EPD']])
  })

  it('says why a draft could not be finished in the author’s words, the check’s under Details', () => {
    render(
      <ReviewDetails
        section={chapter([])}
        draft={[
          { kind: 'repaired_literal', detail: 'bound' },
          { kind: 'unresolved_placeholder', detail: '{{results.9.score}} does not resolve' }
        ]}
        busy={false}
        onKeep={async () => {}}
        onReplace={async () => {}}
        onFix={() => {}}
      />
    )
    expect(screen.getByText(/could not finish this chapter: A placeholder points at a value/)).toBeTruthy()
    expect(screen.getByText('{{results.9.score}} does not resolve')).toBeTruthy()
  })

  it('asks again about a kept number once the results have moved, without the stale candidates', async () => {
    const kept: Array<unknown[]> = []
    const section = chapter([])
    section.ai_review!.issues = [
      {
        quote: 'Each bottle weighs 8.5 kg.',
        problem: 'typed',
        status: 'kept',
        resolution: 'Measured',
        origin: 'typed_number',
        number: '8.5',
        offset: 19,
        candidates: [{ path: 'results.0.score', label: 'x', prints: '8.4', own_percent: false }]
      }
    ]
    render(
      <ReviewDetails
        section={section}
        moved={[{ quote: 'Each bottle weighs 8.5 kg.', offset: 19, occurrence: 0 }]}
        busy={false}
        onKeep={async (...a) => void kept.push(a)}
        onReplace={async () => {}}
        onFix={() => {}}
      />
    )
    expect(screen.getByText(/the results have moved since\. Is it still right\?/)).toBeTruthy()
    expect(screen.queryByText(/Replace with/)).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByText('Still right'))
    })
    expect(kept).toEqual([['Each bottle weighs 8.5 kg.', 'Measured', { offset: 19, occurrence: undefined }]])
  })
})
