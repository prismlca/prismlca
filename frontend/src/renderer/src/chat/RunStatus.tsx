import type { ChatMessage } from '../lib/ai'
import { Elapsed } from './ToolTraceList'
import type { TurnView } from './turnView'
import { compact, contextLabel } from './chatFormat'

/**
 * What this conversation has consumed, added up over its turns.
 *
 * It replaces the model name, which the composer's placeholder says anyway. The numbers come from the
 * messages themselves, not from a running counter: the same place the per-turn cost lives, so a
 * reload, a chat switch and a deleted message all stay correct without a second source of truth.
 *
 * `In` INCLUDES the cached share — the cache is a discount on the same prompt, not a second prompt —
 * which is why the hit rate sits directly beside it and not at the end of the line.
 *
 * A chat from before this was recorded shows nothing at all. "In: 0" would be a measurement; silence
 * is the truth.
 */
export function ChatUsage({
  messages,
  window
}: {
  messages: ChatMessage[]
  window?: number
}): JSX.Element | null {
  // The last turn that recorded how full the context was when it answered — a level, not a sum, so
  // it is read off the newest message rather than added up.
  const level = [...messages].reverse().find((m) => m.context_tokens)?.context_tokens
  const t = messages.reduce(
    (a, m) => ({
      In: a.In + (m.prompt_tokens ?? 0),
      cached: a.cached + (m.cached_tokens ?? 0),
      out: a.out + (m.completion_tokens ?? 0)
    }),
    { In: 0, cached: 0, out: 0 }
  )
  if (!t.In && !t.out) return null
  const hit = t.In ? Math.round((t.cached / t.In) * 100) : 0
  return (
    <span
      className="chat-head-powered"
      title={
        'Tokens over the whole chat, helpers included. In contains the cached share; Out includes reasoning.' +
        (level
          ? ` Context: ${compact(level)}${window ? ` of ${compact(window)}` : ''} tokens after the last turn.`
          : '')
      }
    >
      In: {compact(t.In)}
      {t.In ? ` · Cache hit: ${hit}%` : ''} · Out: {compact(t.out)}
      {level ? ` · Context: ${contextLabel(level, window)}` : ''}
    </span>
  )
}

/**
 * What the run is doing, pinned to the top of the panel.
 *
 * The tool rows themselves scroll away — on a long run the transcript is mostly trace lines and the one
 * that is actually running left the viewport minutes ago. This is the
 * one line that never moves: what is running now, for how long, and how many calls deep the turn is.
 * Deliberately not a second docked window: the canvas is the point of that screen, and a message's own
 * calls belong with the message, which is what the collapsed summary below keeps.
 */
export function RunStatus({ turn, labels }: { turn: TurnView; labels: Record<string, string> }): JSX.Element {
  const { live, reasoning, restarts, context } = turn
  const idx = live.findIndex((t) => !t.status)
  const pending = idx >= 0 ? live[idx] : undefined
  return (
    <div className="chat-runbar">
      <span className="chat-trace-pulse" aria-hidden="true" />
      <span className="chat-runbar-what">
        {pending ? (labels[pending.name] ?? pending.name) : 'Thinking'}
        {pending?.detail ? <span className="chat-runbar-note"> · {pending.detail}</span> : null}
        {!pending && reasoning > 0 ? (
          <span className="chat-runbar-note">
            {' '}
            · reasoning, {Math.round(reasoning / 100) / 10}k characters
          </span>
        ) : null}
        {/* A discarded round is minutes of someone's evening. It used to be invisible: the counter
            silently jumped back to zero while the clock kept climbing. */}
        {!pending && restarts > 0 ? (
          <span className="chat-runbar-note"> · restarted {restarts}× (the model returned nothing)</span>
        ) : null}
      </span>
      {/* The clock times WHICH call is running, or the thinking phase now under way — never the turn.
          Timing the turn, ten seconds into a run the bar claimed "Research a question on the web ·
          1:37 min" for a call that had just started. The thinking phase begins anew when a round is
          abandoned and begun again, so the elapsed time belongs to the attempt whose reasoning is
          counted beside it: "reasoning, 0.8k characters · 6:08 min" was once two different clocks. */}
      <Elapsed since={pending ? turn.started[idx] : turn.thinkingAt} />
      {live.length ? <span className="chat-runbar-count">{live.length} calls</span> : null}
      {/* How full the window is, from the provider's own count of the last request. Claude Code and
          Codex show this in their status lines; here it was only in dev.log. Marked once the
          condensing threshold is crossed, because from then on older tool results are summaries. */}
      {context ? (
        <span
          className={`chat-runbar-ctx${context.tokens >= context.budget ? ' full' : ''}`}
          title={
            `${compact(context.tokens)} tokens in the model's context${context.window ? ` of ${compact(context.window)}` : ''}` +
            ` — older tool results are condensed from ${compact(context.budget)} on`
          }
        >
          context {contextLabel(context.tokens, context.window)}
        </span>
      ) : null}
    </div>
  )
}
