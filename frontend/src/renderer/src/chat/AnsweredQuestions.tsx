import type { AskedPair } from './askTranscript'

/** What ask_user writes for a question the user left open (main/ai/tools/groups/canvas.ts). */
const NO_ANSWER = '(no answer)'

/**
 * The questions the assistant asked and what the user answered, as they stand in the transcript once
 * the question card is gone: each pair on a quiet rule, the question small, the answer under it.
 */
export function AnsweredQuestions({ pairs }: { pairs: AskedPair[] }): JSX.Element {
  return (
    <div className="chat-answered" role="group" aria-label="Your answers">
      {pairs.map((p, i) => (
        <div key={i} className="chat-answered-item">
          <div className="chat-answered-q">{p.question}</div>
          {p.answer === NO_ANSWER ? (
            <div className="chat-answered-a none">No answer</div>
          ) : (
            <div className="chat-answered-a">
              <span className="chat-answered-arrow" aria-hidden="true">
                ↳
              </span>
              {p.answer}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
