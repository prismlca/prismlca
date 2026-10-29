import { useState } from 'react'
import { chapterLabel, type ReportSection } from '../../lib/report/model'
import type { ReviewQuestion } from '../../../../shared/ipc'

/**
 * What the writers could not settle from the data and the study, asked once, above the chapters.
 *
 * Each question comes with the options the reader named as buttons, its suggestion, and a free answer.
 * Nothing waits on it: the chapter stands as written until it is answered. An answer is stored with the
 * report — every brief from then on carries it — and the chapter that asked is updated with it straight
 * away once it has no other open question (`useChapterWriter.answerQuestion`). The suggestion is the
 * reader's, made after the chapter was written; it is not what the chapter assumed, so it is said as a
 * suggestion.
 */
export default function QuestionsPanel({
  questions,
  onAnswer
}: {
  questions: Array<{ section: ReportSection; question: ReviewQuestion }>
  onAnswer: (section: ReportSection, question: ReviewQuestion, answer: string) => Promise<boolean>
}): JSX.Element | null {
  const [own, setOwn] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  if (!questions.length) return null

  const answer = async (section: ReportSection, q: ReviewQuestion, text: string): Promise<void> => {
    if (!text.trim()) return
    setBusy(q.id)
    try {
      if (await onAnswer(section, q, text.trim())) setOwn((o) => ({ ...o, [q.id]: '' }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rsec-questions" role="region" aria-label="Questions from the writer">
      <p className="rsec-questions-head">
        {questions.length === 1
          ? 'The writer has a question'
          : `The writers have ${questions.length} questions`}
      </p>
      {questions.map(({ section, question: q }) => {
        // The options are the answers to click; the suggestion is said once as a line — as a button too
        // it repeated the options at greater length.
        const choices = q.options?.length ? q.options : q.proposal ? [q.proposal] : []
        return (
          <div key={`${section.id}-${q.id}`} className="rsec-question">
            <p className="rsec-question-text">
              {q.question} <span className="rsec-question-where">— {chapterLabel(section)}</span>
            </p>
            {q.why ? <p className="rsec-question-why">{q.why}</p> : null}
            {q.proposal && q.options?.length ? (
              <p className="rsec-question-why">Suggested: {q.proposal}</p>
            ) : null}
            <div className="rsec-question-acts">
              {choices.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="btn sm"
                  disabled={busy !== null}
                  onClick={() => void answer(section, q, c)}
                >
                  {c}
                </button>
              ))}
              <input
                className="rsec-question-own"
                aria-label="Your own answer"
                placeholder="Or answer in your own words…"
                value={own[q.id] ?? ''}
                disabled={busy !== null}
                onChange={(e) => setOwn((o) => ({ ...o, [q.id]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void answer(section, q, own[q.id] ?? '')
                }}
              />
              <button
                type="button"
                className="btn sm"
                disabled={busy !== null || !(own[q.id] ?? '').trim()}
                onClick={() => void answer(section, q, own[q.id] ?? '')}
              >
                Answer
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
