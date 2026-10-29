import { OwnAnswerRow, useAskAnswers } from './askAnswers'

/** One question inside a pending ask_user. */
export interface AskQuestion {
  question: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
}

/** What an approve_tool card asks about: the call the run wants to make (uiBridge `approve_tool`). */
export interface ApprovalRequest {
  tool: string
  effect?: string
  args: Record<string, unknown>
  /** What the call acts on, read from its own arguments by main (approval.ts) — the headline. */
  target?: string | null
  database?: string | null
}

/** A pending ask_user (questions) or approve_tool (approval) from the agent: the run pauses until
 *  the user answers — every question, or Allow/Decline. */
export interface PendingAsk {
  reqId: string
  chatId: string
  questions: AskQuestion[]
  approval?: ApprovalRequest
}

/** The approve_tool arguments as the card reads them; null when the request carries no tool name. */
export function approvalOf(args: Record<string, unknown>): ApprovalRequest | null {
  const tool = typeof args.tool === 'string' ? args.tool : ''
  if (!tool) return null
  return {
    tool,
    effect: typeof args.effect === 'string' ? args.effect : undefined,
    args: args.args && typeof args.args === 'object' ? (args.args as Record<string, unknown>) : {},
    target: typeof args.target === 'string' ? args.target : null,
    database: typeof args.database === 'string' ? args.database : null
  }
}

/**
 * The ask_user arguments as a list of questions. main normalises to a list, but the flat shape is
 * tolerated so an older payload still works. Shared by the live request and the restore of a
 * question that arrived while this chat was not on screen.
 */
export function askQuestions(args: Record<string, unknown>): AskQuestion[] {
  const rawQs: any[] = Array.isArray(args.questions)
    ? (args.questions as any[])
    : [{ question: args.question, options: args.options, multi_select: args.multi_select }]
  return rawQs
    .map((q: any) => ({
      question: String(q?.question ?? '').trim(),
      options: (Array.isArray(q?.options) ? (q.options as unknown[]) : [])
        .map((o: any) => ({
          label: String(o?.label ?? o ?? '').trim(),
          description: o?.description ? String(o.description) : undefined
        }))
        .filter((o) => o.label),
      multiSelect: !!q?.multi_select
    }))
    .filter((q) => q.question && q.options.length)
}

/**
 * The question card for ask_user. One question answers on a click, as it always did. Several
 * arrive as a single form with one Answer button: the agent usually knows all its open decisions
 * up front, and asking them one at a time stopped the run to wait for a human each time. Every
 * question also takes an answer in the user's own words (askAnswers.tsx).
 */
export function AskUserCard({
  ask,
  onAnswer
}: {
  ask: PendingAsk
  onAnswer: (answers: string[][], ownWords: boolean[]) => void
}): JSX.Element {
  const form = useAskAnswers(ask.questions)
  const many = ask.questions.length > 1
  const confirmButton = many || !!ask.questions[0]?.multiSelect
  const submit = (): void => {
    if (!form.complete) return
    const { answers, ownWords } = form.answers()
    onAnswer(answers, ownWords)
  }

  return (
    <div className="chat-ask">
      {ask.questions.map((q, qi) => (
        <div key={qi} className={many ? 'chat-ask-item' : undefined}>
          <div className="chat-ask-q">
            {many ? <span className="chat-ask-num">{qi + 1}.</span> : null}
            {q.question}
          </div>
          <div className="chat-ask-opts">
            {q.options.map((o, oi) => (
              <button
                key={oi}
                className={`chat-ask-opt${form.picked(qi, oi) ? ' on' : ''}`}
                onClick={() => {
                  // A single, single-select question keeps answering on the click itself.
                  if (!confirmButton) {
                    onAnswer([[o.label]], [false])
                    return
                  }
                  form.pick(qi, oi)
                }}
              >
                <span className="chat-ask-label">{o.label}</span>
                {o.description ? <span className="chat-ask-desc">{o.description}</span> : null}
              </button>
            ))}
            <OwnAnswerRow
              question={q.question}
              own={form.own(qi)}
              withSend={!confirmButton}
              canSubmit={form.complete}
              onOpen={() => form.openOwn(qi)}
              onChange={(text) => form.setOwnField(qi, { text })}
              onClose={() => form.setOwnField(qi, { open: false })}
              onSubmit={submit}
            />
          </div>
        </div>
      ))}
      {confirmButton ? (
        <button className="chat-ask-confirm" disabled={!form.complete} onClick={submit}>
          Answer
        </button>
      ) : null}
    </div>
  )
}

/**
 * The confirmation card before an irreversible tool action (main/ai/approval.ts). The same card the
 * External-agents drawer shows for an MCP session, in the chat's own dress: what the assistant wants
 * to run, on which model, the arguments folded under a disclosure, Allow or Decline. Nothing here
 * runs the action — main's gate waits for the answer and runs or refuses the call.
 */
export function ChatApprovalCard({
  ask,
  label,
  onAnswer
}: {
  ask: PendingAsk & { approval: ApprovalRequest }
  label: string
  onAnswer: (approved: boolean) => void
}): JSX.Element {
  const a = ask.approval
  const args = JSON.stringify(a.args, null, 1)
  return (
    <div className="chat-ask chat-ask-approval" role="group" aria-label="Confirmation request">
      <div className="chat-ask-q">
        Allow the assistant to run <b>{label}</b>
        {/* The target from the call's own arguments, never the model on screen: a deletion of
            "production" with "scratch" open must say production. */}
        {a.target ? (
          <>
            {' '}
            on <b>{a.target}</b>
          </>
        ) : a.database ? (
          <>
            {' '}
            on <i>{a.database}</i>
          </>
        ) : null}
        ?
      </div>
      {a.effect === 'irreversible' ? <div className="chat-ask-desc">This cannot be undone.</div> : null}
      {args !== '{}' ? (
        <details className="chat-ask-args">
          <summary>Arguments</summary>
          <pre className="chat-trace-pre">{args.length > 1200 ? `${args.slice(0, 1200)}…` : args}</pre>
        </details>
      ) : null}
      <div className="chat-ask-actions">
        <button className="chat-ask-confirm" onClick={() => onAnswer(true)}>
          Allow
        </button>
        <button className="chat-ask-decline" onClick={() => onAnswer(false)}>
          Decline
        </button>
      </div>
    </div>
  )
}
