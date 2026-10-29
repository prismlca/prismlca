import { Fragment, useEffect, useState } from 'react'
import type { ToolTrace } from '../lib/ai'
import { fmtInt } from '../lib/format'

/**
 * The row label of a call. A `plan` call that went through reads "Plan updated · 3/7": the plan
 * itself is on the card beside the dock, and listing it a second time here would put the same steps
 * on screen twice. The counter comes from the compact list the tool returned.
 */
function traceName(t: ToolTrace, labels: Record<string, string>): string {
  if (t.name === 'plan' && t.status === 'ok') {
    const m = /(\d+)\/(\d+) done\)/.exec(t.preview ?? '')
    if (m) return `Plan updated · ${m[1]}/${m[2]}`
    if (/^Plan withdrawn/.test(t.preview ?? '')) return 'Plan withdrawn'
    return 'Plan updated'
  }
  // Not a tool of ours: the provider's own web lookups inside a reply (agent.ts WEB_LOOKUPS_ROW).
  if (t.name === 'web_lookups') return 'Web lookups by the provider'
  return labels[t.name] ?? t.name
}

/** Pretty-print tool arguments; falls back to the raw string when the model sent invalid JSON. */
export function formatArgs(args?: string): string | null {
  if (!args || args === '{}') return null
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    return args
  }
}

/**
 * Seconds since `since` (epoch ms; without it, since this clock appeared), ticking.
 *
 * Without it a long call leaves the panel frozen: the "…" placeholder only renders when NO trace is
 * open, and a duration was only shown once a call had finished. A web-research sub-agent that took
 * nearly four minutes therefore looked identical to a dead run, and the only evidence of life was the
 * Stop button still being there. Counted from a timestamp rather than from the mount, because the
 * panel is unmounted on every view but Model: back from Results, a call in its sixth minute read "0 s".
 */
export function Elapsed({ since }: { since?: number }): JSX.Element {
  const [mounted] = useState(() => Date.now())
  const [now, setNow] = useState(mounted)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const secs = Math.max(0, Math.floor((now - (since ?? mounted)) / 1000))
  return (
    <span className="chat-trace-ms live" aria-live="off">
      {secs < 60 ? `${secs} s` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} min`}
    </span>
  )
}

/**
 * The tool calls of one turn, collapsed to one line each and expandable to arguments + result.
 *
 * Why it exists: the chat used to show only the *currently running* tool name and threw the rest
 * away, so nobody could see what the assistant actually did — diagnosing a wrong call meant
 * reproducing it against a live model. A rejected call (the tool returned `{"error": …}`) is marked
 * distinctly from a thrown one: the model was told no in both cases, which is exactly what you want
 * to spot, but they mean different things.
 */
export function ToolTraceList({
  traces,
  started,
  labels,
  running,
  summary,
  cost,
  provider
}: {
  traces: ToolTrace[]
  /** When each row of an in-flight turn started (epoch ms, same order) — what its clock counts from. */
  started?: number[]
  labels: Record<string, string>
  running?: boolean
  /** Collapse the whole list behind one line — what a finished turn wants in the transcript. */
  summary?: boolean
  /** USD the turn cost, shown on that line. */
  cost?: number
  /** The OpenRouter endpoint that served the turn, shown on that line — routing changes it per
   *  request, and it is the difference between a slow model and a slow provider. */
  provider?: string
}): JSX.Element {
  // A finished turn's calls are evidence, not reading. Forty of them expanded turn the transcript into
  // a list of tool names with the answer somewhere inside it, which is what a long run looked
  // like; one line that says how many and what they cost, and opens to the same list, keeps both.
  const [openSummary, setOpenSummary] = useState(false)
  if (summary && traces.length > 1 && !openSummary) {
    const seconds = traces.reduce((t, x) => t + (x.ms ?? 0), 0) / 1000
    // Three different things, three counts. Rejected = a guardrail or the user said no; failed = the
    // call broke. They were one badge labelled "refused" once, when a `calculate` that
    // died on its arguments was summarised as "1 refused" while the very same row, expanded, said
    // "failed" — the collapsed view contradicting the list it opens into. The same mismatch
    // existed for the other word: the row says "rejected", the summary used to say "refused" (V336).
    const refused = traces.filter((t) => t.status === 'rejected').length
    const failed = traces.filter((t) => t.status === 'error').length
    // Counted separately from both: these calls DID succeed and part of them applied, so calling
    // them refused would be as wrong as staying silent was.
    const partial = traces.reduce((n, t) => n + (t.itemsFailed ?? 0), 0)
    // A provider's attribution has to stay on screen after the turn folds up — that is what
    // "displayed" means for openrouteservice and Mapbox — so the notices ride under the one line.
    const notices = Array.from(new Set(traces.map((t) => t.notice).filter((n): n is string => !!n)))
    return (
      <>
        <button className="chat-traces-sum" onClick={() => setOpenSummary(true)}>
          <span className="chat-traces-sum-caret" aria-hidden="true">
            ▸
          </span>
          {traces.length} tool calls
          {/* This is the SUM of the calls' own durations, not how long the turn took — a 42-minute
            turn read as "10 min" and looked like a wall clock. Say which it is. */}
          {seconds >= 1
            ? ` · ${seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds / 60)} min`} in tools`
            : ''}
          {cost ? ` · $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}` : ''}
          {provider ? ` · ${provider}` : ''}
          {refused ? <span className="chat-trace-tag">{refused} rejected</span> : null}
          {failed ? <span className="chat-trace-tag">{failed} failed</span> : null}
          {partial ? (
            <span className="chat-trace-tag">
              {partial} batch item{partial === 1 ? '' : 's'} failed
            </span>
          ) : null}
        </button>
        {notices.map((n) => (
          <div key={n} className="chat-trace-notice">
            {n}
          </div>
        ))}
      </>
    )
  }
  return (
    <div className="chat-traces">
      {traces.map((t, i) => {
        const args = formatArgs(t.args)
        const hidden = (t.resultChars ?? 0) - (t.preview?.length ?? 0)
        const pending = !t.status
        return (
          <Fragment key={i}>
            <details className={`chat-trace ${t.status ?? 'running'}`}>
              <summary>
                <span className="chat-trace-name">{traceName(t, labels)}</span>
                {t.status === 'rejected' ? <span className="chat-trace-tag">rejected</span> : null}
                {t.status === 'error' ? <span className="chat-trace-tag">failed</span> : null}
                {/* A batch call succeeds while part of its work does not — the one case where 'ok' on
                  its own is a half-truth. Three of six processes were lost to a dropped socket and
                  nothing in this line said so. */}
                {t.itemsFailed ? (
                  <span className="chat-trace-tag">{t.itemsFailed} of the batch failed</span>
                ) : null}
                {pending && running ? (
                  <>
                    <span className="chat-trace-pulse" aria-hidden="true" />
                    <span className="chat-trace-tag">running…</span>
                    <Elapsed since={started?.[i]} />
                  </>
                ) : null}
                {t.ms != null && t.ms >= 1000 ? (
                  <span className="chat-trace-ms">{(t.ms / 1000).toFixed(1)} s</span>
                ) : null}
              </summary>
              {t.detail ? <div className="chat-trace-detail">{t.detail}</div> : null}
              {args ? <pre className="chat-trace-pre">{args}</pre> : null}
              {t.preview ? (
                <pre className="chat-trace-pre result">
                  {t.preview}
                  {hidden > 0 ? `\n… ${fmtInt(hidden)} more characters` : ''}
                </pre>
              ) : null}
              {!args && !t.preview && !t.detail ? (
                <div className="chat-trace-detail">No arguments, no output.</div>
              ) : null}
            </details>
            {/* Outside the <details>, so it is on screen whether the row is open or not: the attribution
              a data provider requires to be DISPLAYED (openrouteservice, OpenStreetMap, Mapbox). */}
            {t.notice ? <div className="chat-trace-notice">{t.notice}</div> : null}
          </Fragment>
        )
      })}
    </div>
  )
}
