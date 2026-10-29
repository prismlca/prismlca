import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import useChapterWriter from './useChapterWriter'
import type { ReportSection, StoredReportFull } from '../../lib/report/model'
import { renderWithPrism } from '../../test/render'

const BASE = '/api/v1/report/one/db/rep-1'

const chapter = (id: string, questions: string[]): ReportSection =>
  ({
    id,
    kind: 'inventory',
    title: '',
    text: 'Written.',
    text_version: 'v1',
    locked: false,
    ai_review: {
      reviewer: 'reader',
      verdict: 'accepted',
      issues: [],
      questions: questions.map((q) => ({ id: q, question: `Question ${q}?` })),
      hints: {},
      text_version: 'v1',
      at: '2026-10-28T00:00:00+00:00'
    }
  }) as unknown as ReportSection

/**
 * An answer is the go-ahead: the chapter that asked is updated with it at once, instead of standing on
 * "Needs update" until the author starts a second run for what they had just settled. Only once none
 * of its questions is open, though — a rewrite after the first of two answers would be asked again.
 */
describe('answering a question the writer asked', () => {
  function setup(questions: string[]) {
    const report = {
      id: 'rep-1',
      lang: 'en',
      answers: {},
      sections: [chapter('s1', questions)]
    } as unknown as StoredReportFull
    const reportRef = { current: report }
    const writeAll = vi.fn(async (_payload: { waves: unknown }) => [])
    function Host(): JSX.Element {
      const writer = useChapterWriter({
        base: BASE,
        database: 'db',
        reportLang: 'en',
        studyLang: 'en',
        studyLangGuessed: false,
        reportRef,
        stale: {},
        blocker: () => null,
        // The reload after the answer: the store now holds it.
        load: async () => {
          reportRef.current = {
            ...reportRef.current,
            answers: {
              ...reportRef.current.answers,
              q1: { question: 'Question q1?', answer: 'Yes', at: 'z' }
            }
          } as StoredReportFull
        },
        loadStaleness: async () => ({}),
        setStale: vi.fn(),
        setStaleFailure: vi.fn(),
        setError: vi.fn(),
        openChapter: vi.fn()
      })
      return (
        <button onClick={() => void writer.answerQuestion(report.sections[0], 'q1', 'Question q1?', 'Yes')}>
          answer
        </button>
      )
    }
    const { prism } = renderWithPrism(<Host />, {
      routes: { [`POST ${BASE}/answers`]: {} },
      overrides: { ai: { writeAll } }
    })
    return { prism, writeAll }
  }

  it('updates the chapter that asked as soon as its last question is answered', async () => {
    const { prism, writeAll } = setup(['q1'])
    await userEvent.setup().click(screen.getByRole('button', { name: 'answer' }))
    await waitFor(() => expect(writeAll).toHaveBeenCalledTimes(1))
    expect(prism.calls.some((c) => c.path === `${BASE}/answers`)).toBe(true)
    expect(writeAll.mock.calls[0][0]).toMatchObject({ waves: [[{ id: 's1', mode: 'update' }]] })
  })

  it('waits while the chapter still has a question open', async () => {
    const { prism, writeAll } = setup(['q1', 'q2'])
    await userEvent.setup().click(screen.getByRole('button', { name: 'answer' }))
    await waitFor(() => expect(prism.calls.some((c) => c.path === `${BASE}/answers`)).toBe(true))
    await new Promise((r) => setTimeout(r, 50))
    expect(writeAll).not.toHaveBeenCalled()
  })
})
