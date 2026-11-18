/**
 * The text one run writes for the user, and where its closing answer begins.
 *
 * Everything the run adds — the model's prose, a question and its answer, a line the user sent while it
 * worked, a stop note — goes through `add`, which appends it and streams it as written, so the live view
 * and the stored message are the same text. `markAnswerStart` is moved behind every tool round, every line
 * the user sent and the notice of a request sent again, so what follows is what the model wrote last, and
 * the stop note when the run did not finish. The text before `answerFrom` is the turn's record (answered
 * questions, notes between tool rounds), kept in the message; a reader with one line to show starts there.
 */
export class TurnText {
  private written = ''
  private answerStart = 0

  constructor(private readonly stream: (text: string) => void) {}

  /** The run's text so far: what the message keeps. */
  get text(): string {
    return this.written
  }

  /** Where the closing answer begins in `text`. */
  get answerFrom(): number {
    return this.answerStart
  }

  /** Appends `text` and streams it as written. */
  add(text: string): void {
    this.written += text
    this.stream(text)
  }

  /** Everything written so far is the turn's record: the closing answer begins after it. */
  markAnswerStart(): void {
    this.answerStart = this.written.length
  }
}
