/**
 * The panel for external agents (MCP): who is connected, what they did, and the cards they are
 * waiting on — a question (`ask_user`) or a "may this run?" card from the session's approval mode.
 *
 * The cards resolve main's pending UI requests (`uiResult`), the same channel the chat's question
 * card uses; the record of open questions is main's (`ai:pendingAsks`), so a reload does not lose
 * one. Rendered as a drawer over the workbench, not inside the chat: an external session has no chat.
 */
import { useState } from 'react'
import type { PendingAsk } from '../lib/ai'
import { uiResult } from '../lib/ai'
import {
  APPROVAL_LABELS,
  mcpDisconnect,
  mcpSetApproval,
  type McpApprovalMode,
  type McpSessionSnapshot
} from '../lib/mcp'
import EscapeCloser from '../components/EscapeCloser'
import { isUnclaimedBridgeLaunch, useBridgeState } from '../lib/bridgeState'
import { askQuestions } from '../chat/askCards'
import { OwnAnswerRow, useAskAnswers } from '../chat/askAnswers'

const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`)

function AskCard({ ask }: { ask: PendingAsk }): JSX.Element {
  const questions = askQuestions(ask.args)
  const form = useAskAnswers(questions)
  // One flag per question, as from the chat's card: main marks those answers as the user's words.
  const answer = (): void => {
    if (!form.complete) return
    const { answers, ownWords } = form.answers()
    uiResult(ask.reqId, true, { answers, freeText: ownWords })
  }
  return (
    <div className="xa-card" role="group" aria-label="Question from an external agent">
      <div className="xa-card-head">
        <b>{ask.clientName || 'An external agent'}</b> has a question
        {ask.database ? (
          <>
            {' '}
            about <i>{ask.database}</i>
          </>
        ) : null}
        .
      </div>
      {questions.map((q, qi) => (
        <div key={qi} className="xa-q">
          <div className="xa-q-text">{q.question}</div>
          <div className="xa-q-opts">
            {q.options.map((o, oi) => (
              <button
                key={oi}
                type="button"
                className={`btn sm${form.picked(qi, oi) ? ' primary' : ''}`}
                title={o.description}
                onClick={() => form.pick(qi, oi)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <OwnAnswerRow
            question={q.question}
            own={form.own(qi)}
            withSend={false}
            canSubmit={form.complete}
            onOpen={() => form.openOwn(qi)}
            onChange={(text) => form.setOwnField(qi, { text })}
            onClose={() => form.setOwnField(qi, { open: false })}
            onSubmit={answer}
          />
        </div>
      ))}
      <div className="xa-card-actions">
        <button type="button" className="btn sm primary" disabled={!form.complete} onClick={answer}>
          Answer
        </button>
      </div>
    </div>
  )
}

function ApprovalCard({ ask }: { ask: PendingAsk }): JSX.Element {
  const a = ask.args as {
    tool?: string
    effect?: string
    args?: Record<string, unknown>
    database?: string
    /** What the call acts on, from its own arguments (main/ai/approval.ts) — shown over the model name. */
    target?: string | null
  }
  const args = JSON.stringify(a.args ?? {})
  return (
    <div className="xa-card xa-approval" role="group" aria-label="Approval request from an external agent">
      <div className="xa-card-head">
        <b>{ask.clientName || 'An external agent'}</b> wants to run <code>{a.tool}</code>
        {a.effect === 'irreversible' ? (
          <>
            {' '}
            — <b>cannot be undone</b>
          </>
        ) : null}
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
        .
      </div>
      <pre className="xa-args">{args.length > 600 ? `${args.slice(0, 600)}…` : args}</pre>
      <div className="xa-card-actions">
        <button
          type="button"
          className="btn sm primary"
          onClick={() => uiResult(ask.reqId, true, { approved: true })}
        >
          Allow
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() => uiResult(ask.reqId, true, { approved: false })}
        >
          Decline
        </button>
      </div>
    </div>
  )
}

function SessionRow({ s }: { s: McpSessionSnapshot }): JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <div className="xa-session">
      <div className="xa-session-head">
        <b>
          {s.clientName}
          {s.clientVersion ? ` ${s.clientVersion}` : ''}
        </b>
        <span className="xa-muted">
          {s.activeDb ? `model ${s.activeDb}` : 'no model'} · {s.calls} call{s.calls === 1 ? '' : 's'} · since{' '}
          {new Date(s.startedAt).toLocaleTimeString()}
        </span>
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void mcpDisconnect(s.id).finally(() => setBusy(false))
          }}
        >
          Disconnect
        </button>
      </div>
      <label className="xa-approval-mode">
        <span>Before it changes something</span>
        <select
          className="search-sel"
          value={s.approval}
          onChange={(e) => void mcpSetApproval(s.id, e.target.value as McpApprovalMode)}
          aria-label="Approval mode"
        >
          {(Object.keys(APPROVAL_LABELS) as McpApprovalMode[]).map((m) => (
            <option key={m} value={m}>
              {APPROVAL_LABELS[m]}
            </option>
          ))}
        </select>
      </label>
      {s.recent.length ? (
        <ol className="xa-calls" reversed>
          {[...s.recent].reverse().map((c) => (
            // The call's own number: `recent` holds only the last few, so the list's index said "1." for
            // what was the session's 9th call.
            <li key={c.n} value={c.n} className={c.ok ? (c.soft ? 'soft' : 'ok') : 'err'} title={c.args}>
              <code>{c.tool}</code> <span className="xa-effect">{c.effect}</span>{' '}
              <span className="xa-muted">{fmtMs(c.ms)}</span>
              {!c.ok ? <div className="xa-detail">{c.error}</div> : null}
              {c.ok && c.soft ? <div className="xa-detail">refused: {c.soft}</div> : null}
            </li>
          ))}
        </ol>
      ) : (
        <div className="xa-muted">No calls yet.</div>
      )}
    </div>
  )
}

export default function ExternalAgentsPanel(props: {
  sessions: McpSessionSnapshot[]
  /** Open questions and approval cards of external sessions (origin 'mcp'). */
  asks: PendingAsk[]
  running: boolean
  onClose: () => void
}): JSX.Element {
  const { sessions, asks, running, onClose } = props
  const launch = useBridgeState()
  return (
    <aside className="xa-panel" role="dialog" aria-label="External agents">
      <EscapeCloser onClose={onClose} />
      <div className="xa-head">
        <h3>External agents</h3>
        <button type="button" className="btn sm" onClick={onClose}>
          Close
        </button>
      </div>
      {isUnclaimedBridgeLaunch(launch) ? (
        <p className="xa-muted xa-launch">
          Started by the bridge · quits after {launch.idleMinutes} idle minute
          {launch.idleMinutes === 1 ? '' : 's'} unless someone uses this window
        </p>
      ) : null}
      {asks.map((a) =>
        a.kind === 'approval' ? <ApprovalCard key={a.reqId} ask={a} /> : <AskCard key={a.reqId} ask={a} />
      )}
      {sessions.length ? (
        sessions.map((s) => <SessionRow key={s.id} s={s} />)
      ) : (
        <p className="xa-muted">
          {running
            ? 'The MCP server is on; no client is connected right now.'
            : 'The MCP server is off. Switch it on under Settings → AI → MCP to let an external agent connect.'}
        </p>
      )}
    </aside>
  )
}
