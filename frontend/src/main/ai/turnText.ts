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
  /** Where the closing answer's own text ended, once its round has; notes come after it. */
  private answerEnd: number | null = null

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
    this.answerEnd = null
  }

  /** The round just streamed is over: what is added from here on (a stop, a cut-off) is a note on it. */
  markAnswerEnd(): void {
    this.answerEnd = this.written.length
  }

  /**
   * The run's text outside the closing answer's own: the record before it and the notes after it. A
   * transport that sends the closing round back as the provider made it sends this beside it — the
   * round's blocks hold only what the model wrote in it.
   */
  get aside(): string {
    const after = this.answerEnd === null ? '' : this.written.slice(this.answerEnd)
    return [this.written.slice(0, this.answerStart), after]
      .map((t) => t.trim())
      .filter(Boolean)
      .join('\n\n')
  }
}
