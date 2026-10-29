/**
 * Settings → AI → MCP: the switch for the MCP server and the way to connect each client.
 *
 * The switch is the consent (CLAUDE.md privacy rule: a new channel needs a switch with default off
 * and one sentence saying what leaves the computer). Below it, per client: the snippet to copy, or
 * "Configure", which shows the change to that client's configuration file before writing it — the
 * JetBrains pattern, with the rule that another program's file is written only after a
 * look and a click, with a backup beside it. "Test connection" spawns
 * our own bridge exactly as a client would, so "connected but not working" (the Figma forum's most
 * frequent report) is a thing the user can check here.
 */
import { useEffect, useState } from 'react'
import {
  mcpClients,
  mcpConfigureClient,
  mcpRegenerateToken,
  mcpSetEnabled,
  mcpStatus,
  mcpTestConnection,
  onMcpEvent,
  type McpClientConfig,
  type McpStatusFull,
  type McpTestResult
} from '../lib/mcp'
import PrivacyLink from './overview/PrivacyLink'

/** A configuration text with "Copy all" in its top-right corner — every code box here has one. */
function CodeBlock({
  text,
  label,
  className
}: {
  text: string
  label: string
  className?: string
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <div className="settings-mcp-code">
      <pre className={`settings-mcp-cmd${className ? ` ${className}` : ''}`} aria-label={label}>
        {text}
      </pre>
      <button
        type="button"
        className="btn sm settings-mcp-copy"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        {copied ? 'Copied' : 'Copy all'}
      </button>
    </div>
  )
}

function ClientRow({ c, onConfigured }: { c: McpClientConfig; onConfigured: () => void }): JSX.Element {
  const [open, setOpen] = useState<'snippet' | 'preview' | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const write = (): void => {
    setBusy(true)
    void mcpConfigureClient(c.id)
      .then((r) => {
        setNote(
          r.ok
            ? `Written to ${r.path}${r.backup ? ` (backup: ${r.backup})` : ''}. Restart ${c.label} to pick it up.`
            : `Not written: ${r.error}`
        )
        if (r.ok) {
          setOpen(null)
          onConfigured()
        }
      })
      .catch((e: unknown) => setNote(`Not written: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setBusy(false))
  }
  return (
    <div className="settings-mcp-client">
      <div className="settings-mcp-client-head">
        <b>{c.label}</b>
        <span className="settings-hint">
          {c.configured ? 'configured' : c.exists ? 'not configured' : 'no configuration file found'} ·{' '}
          {c.configHint}
        </span>
        <span className="settings-mcp-client-actions">
          <button
            type="button"
            className="btn sm"
            onClick={() => setOpen(open === 'snippet' ? null : 'snippet')}
          >
            {open === 'snippet' ? 'Hide' : 'Show snippet'}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={!c.proposed}
            title={c.proposed ? undefined : c.proposedError}
            onClick={() => setOpen(open === 'preview' ? null : 'preview')}
          >
            {c.configured ? 'Reconfigure…' : 'Configure…'}
          </button>
        </span>
      </div>
      {open === 'snippet' ? <CodeBlock text={c.snippet} label={`${c.label} snippet`} /> : null}
      {open === 'preview' && c.proposed ? (
        <>
          <p className="settings-hint">
            This is what <code>{c.configPath}</code> will contain afterwards. Only the <code>prismlca</code>{' '}
            entry is added or replaced; everything else is kept, and the current file is backed up beside it.
          </p>
          <CodeBlock
            text={c.proposed}
            label={`${c.label} proposed configuration`}
            className="settings-mcp-preview"
          />
          <div className="settings-mcp-row">
            <button type="button" className="btn primary" disabled={busy} onClick={write}>
              Write to {c.label}’s configuration
            </button>
          </div>
        </>
      ) : null}
      {note ? <p className="settings-hint">{note}</p> : null}
    </div>
  )
}

export default function ExternalAgentsSettings(): JSX.Element {
  const [status, setStatus] = useState<McpStatusFull | null>(null)
  const [clients, setClients] = useState<McpClientConfig[]>([])
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<McpTestResult | 'running' | null>(null)
  const reloadClients = (): void => {
    void mcpClients()
      .then(setClients)
      .catch(() => {})
  }
  useEffect(() => {
    let alive = true
    void mcpStatus()
      .then((s) => {
        if (alive) setStatus(s)
      })
      .catch(() => {})
    reloadClients()
    const off = onMcpEvent((ev) => {
      if (ev.type === 'sessions') setStatus((s) => (s ? { ...s, sessions: ev.sessions } : s))
      if (ev.type === 'status')
        void mcpStatus()
          .then(setStatus)
          .catch(() => {})
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  const enabled = status?.enabled === true
  const setEnabled = (on: boolean): void => {
    setBusy(true)
    void mcpSetEnabled(on)
      .then(setStatus)
      .catch(() => {})
      .finally(() => setBusy(false))
  }
  return (
    <>
      <h4>External agents</h4>
      <label className="settings-field">
        <span>Let external agents drive PrismLCA (MCP server)</span>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={enabled}
          disabled={busy || status === null}
          onChange={(e) => setEnabled(e.target.checked)}
        />
      </label>
      <p className="settings-hint">
        On = an AI client on this computer that you connect yourself — Claude Code, Codex, Claude Desktop —
        can read and change your models through the same tools as the assistant, under your eyes: every change
        is logged under the client’s name and can be undone, and the client asks here before anything that
        cannot be. What the client reads goes to <b>its</b> AI provider, not through PrismLCA — that is the
        client’s contract with its provider, not ours (<PrivacyLink plain />
        ). Off = nothing listens. A client you have configured starts PrismLCA itself when it is not running.
      </p>
      {enabled ? (
        <div className="settings-mcp">
          <div className="settings-hint">
            {status?.running && status.url
              ? `Listening on ${status.url} (this computer only)${
                  status.sessions.length
                    ? ` — ${status.sessions.length} client${status.sessions.length === 1 ? '' : 's'} connected.`
                    : ' — no client connected.'
                }`
              : 'Starting…'}
          </div>
          <div className="settings-mcp-actions">
            <button
              type="button"
              className="btn sm"
              disabled={test === 'running'}
              onClick={() => {
                setTest('running')
                void mcpTestConnection()
                  .then(setTest)
                  .catch((e: unknown) =>
                    setTest({ ok: false, error: e instanceof Error ? e.message : String(e) })
                  )
              }}
            >
              {test === 'running' ? 'Testing…' : 'Test connection'}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              title="Ends every connected client; they reconnect on their next call."
              onClick={() => {
                setBusy(true)
                void mcpRegenerateToken()
                  .then(setStatus)
                  .catch(() => {})
                  .finally(() => setBusy(false))
              }}
            >
              New token
            </button>
          </div>
          {test && test !== 'running' ? (
            <p className="settings-hint" role="status">
              {test.ok
                ? `The bridge answered: ${test.tools} tools, PrismLCA ${test.version}, ${test.ms} ms.`
                : `The bridge did not answer: ${test.error}`}
            </p>
          ) : null}
          <h5>Connect a client</h5>
          <p className="settings-hint">
            Each client starts PrismLCA’s own bridge (<code>--mcp-proxy</code>) over stdio — no Node, no
            Python to install. Copy the snippet into the client’s configuration, or let PrismLCA write it
            after you have seen the change.
          </p>
          {clients.map((c) => (
            <ClientRow key={c.id} c={c} onConfigured={reloadClients} />
          ))}
        </div>
      ) : null}
    </>
  )
}
