import { useEffect, useRef, useState } from 'react'
import { AlertIcon, ClockIcon, LinkIcon, PaperclipIcon } from '../components/icons'
import { aiHasKey, KEY_CHANGED_EVENT } from '../lib/ai'
import { useAppSettings } from '../lib/appSettings'
import type { SettingsCategory, SettingsFocus } from '../views/Settings'
import ComposerMenu from './ComposerMenu'
import ModelPicker from './ModelPicker'
import type { Attachments } from './useAttachments'
import type { ChatPrefs } from './useChatPrefs'

/**
 * The chat's input pill: the attachment chips, the box (or "Transcribing…"), and the control row
 * under it — the "+" menu, the comparison chips, the model picker, the mic and Send/Stop.
 *
 * Rendered as `div.chat-bar` with no wrapper: it must stay a DIRECT child of `.canvas-chat`, whose
 * `> *` rule gives it back the pointer events the dock takes away.
 *
 * `onSend` is always called without an argument — the panel's send takes an optional transcript,
 * and a click event handed to it would be sent as one.
 */
export default function ChatComposer({
  activeDb,
  prefs,
  attachments: attach,
  comparedWith,
  backgroundDbs,
  libraryDbs,
  busy,
  askPending,
  queued = [],
  onUnsteer,
  voice,
  onToggleMic,
  onSend,
  onStop,
  onOpen,
  onPickComparison,
  onOpenSettings
}: {
  activeDb: string | null
  prefs: ChatPrefs
  attachments: Attachments
  comparedWith: string[]
  backgroundDbs?: string[]
  libraryDbs?: string[]
  /** The chat on screen has a run in flight: Stop instead of Send. */
  busy: boolean
  /** A question card of the running turn waits for an answer; the box types it. */
  askPending: boolean
  /** Messages typed while the run was working, waiting in main for the next round boundary. */
  queued?: string[]
  /** Take the i-th queued message back. */
  onUnsteer?: (index: number) => void
  voice: 'idle' | 'rec' | 'busy'
  onToggleMic: () => void
  onSend: () => void
  onStop: () => void
  /** Expand the panel (focusing the box does). */
  onOpen: () => void
  onPickComparison: () => void
  onOpenSettings?: (page: SettingsCategory, focus?: SettingsFocus) => void
}): JSX.Element {
  // The "+" flyout holding attach and the two per-chat toggles (claude.ai-style composer). Closed
  // by choosing "attach", by Escape, or by clicking anywhere outside — toggles keep it open so both
  // can be flipped in one visit.
  const [plusOpen, setPlusOpen] = useState(false)
  const [hasKey, setHasKey] = useState<boolean | null>(null) // null = still checking
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  // Settings → AI Chat can disable voice input app-wide; the mic then disappears.
  const voiceAllowed = useAppSettings().voiceEnabled
  // Is a key configured for the ACTIVE provider? If not, the chat is disabled with a hint.
  // Re-checked when the provider setting changes: main answers for whichever provider is active,
  // so a switch in Settings must re-ask — checked only on mount, an open chat kept the stale gate.
  // And re-asked when a key is stored or cleared: Settings opens over this panel, and a key saved for the
  // same provider left the chat locked on the stale answer until a provider switch.
  const activeProvider = useAppSettings().provider
  useEffect(() => {
    const check = (): void => {
      void aiHasKey()
        .then(setHasKey)
        .catch(() => setHasKey(false))
    }
    check()
    window.addEventListener(KEY_CHANGED_EVENT, check)
    return () => window.removeEventListener(KEY_CHANGED_EVENT, check)
  }, [activeProvider])

  // Grow the input upward to fit all lines (the chat is bottom-anchored, so the transcript above
  // shifts up as the input gets taller). Caps out and scrolls internally past the max.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    // Empty input → single line (rows=1). Measuring here instead would pick up the placeholder,
    // and a wrapped placeholder made the box two lines tall on first load.
    ta.style.height = prefs.input ? `${Math.min(ta.scrollHeight, 200)}px` : ''
  }, [prefs.input])

  const noKey = hasKey === false
  const disabled = !activeDb || noKey
  const placeholder = noKey
    ? 'No OpenRouter API key configured — add one under Settings → AI.'
    : !activeDb
      ? 'Open a model to chat'
      : voice === 'rec'
        ? 'Recording — click the mic to stop'
        : askPending
          ? 'Type your answer…'
          : busy
            ? 'Add a message — it reaches the assistant after its current step…'
            : 'Ask or instruct the assistant…'

  return (
    <div className="chat-bar">
      {/* What was typed while the run works, until the loop takes it at the next round boundary. The
          ✕ takes it back; once delivered the chip goes and the line appears in the answer. Left over
          after Stop or the run's last instant, it waits for the chat's next run — never sent alone. */}
      {queued.length ? (
        <div className="chat-attach-list chat-queued-list" aria-label="Messages waiting for the assistant">
          {queued.map((q, i) => (
            <div key={`${i}-${q.slice(0, 20)}`} className="chat-attach chat-queued" title={q}>
              <ClockIcon />
              <span className="chat-attach-name">{q.length > 60 ? `${q.slice(0, 60)}…` : q}</span>
              <span className="chat-attach-note">
                {busy ? 'after the current step' : 'with your next message'}
              </span>
              <button className="chat-attach-x" title="Take this message back" onClick={() => onUnsteer?.(i)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {attach.attachments.length > 0 || attach.attaching ? (
        <div className="chat-attach-list">
          {attach.attachments.map((a, i) => (
            <div
              key={a.id || `${a.name}-${i}`}
              className={`chat-attach${a.error ? ' bad' : ''}`}
              title={a.error || a.warning || a.name}
            >
              {a.error ? <AlertIcon /> : <PaperclipIcon />}
              <span className="chat-attach-name">{a.name}</span>
              {a.error ? <span className="chat-attach-note bad">{a.error}</span> : null}
              {!a.error && a.warning ? <span className="chat-attach-note">{a.warning}</span> : null}
              <button
                className="chat-attach-x"
                title="Remove attachment"
                onClick={() => attach.removeAttachment(i)}
              >
                ✕
              </button>
            </div>
          ))}
          {attach.attaching ? <div className="chat-attach chat-attach-busy">Reading…</div> : null}
        </div>
      ) : null}
      {voice === 'busy' ? (
        <div className="chat-input chat-voice-status" aria-live="polite">
          <span className="chat-voice-waves" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
          Transcribing…
        </div>
      ) : (
        <textarea
          ref={taRef}
          className="chat-input"
          rows={1}
          value={prefs.input}
          disabled={disabled}
          placeholder={placeholder}
          onFocus={() => !disabled && onOpen()}
          onChange={(e) => prefs.typeInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSend()
            }
          }}
        />
      )}
      {/* The controls live UNDER the input line (claude.ai-style): a "+" flyout on the left for
          attach + the per-chat toggles, mic and send on the right. The collapsed pill is a little
          taller for it, and the input gets the full width. */}
      <div className="chat-bar-controls">
        <ComposerMenu
          open={plusOpen}
          setOpen={setPlusOpen}
          disabled={disabled}
          activeDb={activeDb}
          prefs={prefs}
          comparedWith={comparedWith}
          backgroundDbs={backgroundDbs}
          libraryDbs={libraryDbs}
          attaching={attach.attaching}
          onAttach={attach.onAttachClick}
          onPickComparison={onPickComparison}
          onOpenSettings={onOpenSettings}
        />
        {/* Between the "+" and the microphone. One name fits; from two on, the row
            is too narrow for names (four of them squeezed to a letter each), so they fold into one
            chip that counts them and opens the "+" menu, where each has its switch. */}
        {prefs.comparisonOn.length === 1 ? (
          <div className="chat-cmp-list inline">
            <div
              className="chat-cmp"
              title={`Briefed on ${prefs.comparisonOn[0]} — the assistant keeps this model consistent with it`}
            >
              <LinkIcon />
              <span className="chat-attach-name">{prefs.comparisonOn[0]}</span>
              <button
                className="chat-attach-x"
                title="Not in this chat (the link itself stays; remove it under Comparison models…)"
                onClick={() => prefs.setComparisonOn(prefs.comparisonOn[0], false)}
              >
                ✕
              </button>
            </div>
          </div>
        ) : prefs.comparisonOn.length > 1 ? (
          <div className="chat-cmp-list inline">
            <button
              className="chat-cmp chat-cmp-many"
              title={`Briefed on ${prefs.comparisonOn.join(', ')} — switch one off in the + menu`}
              onClick={() => setPlusOpen(true)}
            >
              <LinkIcon />
              <span className="chat-attach-name">{prefs.comparisonOn.length} comparison models</span>
            </button>
          </div>
        ) : null}
        <span className="chat-bar-spacer" />
        {/* The model where claude.ai keeps it: bottom row, right before the mic, and a picker rather
            than a caption. It used to hang in the placeholder, where the first typed character wiped
            it out. Choosing writes through to the app setting, so it is the same
            chat model Settings shows — one setting, two places to reach it. */}
        <ModelPicker />
        {voiceAllowed ? (
          <button
            className={`chat-attach-btn chat-mic${voice === 'rec' ? ' rec' : ''}`}
            disabled={disabled || voice === 'busy'}
            aria-label={voice === 'rec' ? 'Stop recording' : 'Record a voice message'}
            title={
              voice === 'rec'
                ? 'Stop recording — the transcript is sent as your message'
                : 'Record a voice message (click again to stop)'
            }
            onClick={onToggleMic}
          >
            {/* Lucide "mic" (ISC, in THIRD-PARTY-NOTICES.md). */}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          </button>
        ) : null}
        {busy ? (
          <>
            {/* Enter queues while the run works; the button says so for whoever looks for Send. */}
            {prefs.input.trim() && !askPending ? (
              <button
                className="chat-send queue"
                onClick={() => onSend()}
                title="Send after the current step (Enter)"
                aria-label="Send after the current step"
              >
                ➤
              </button>
            ) : null}
            <button className="chat-send stop" onClick={onStop} title="Stop">
              ■
            </button>
          </>
        ) : (
          <button
            className="chat-send"
            onClick={() => onSend()}
            disabled={disabled || (!prefs.input.trim() && attach.attachments.length === 0)}
            title="Send"
          >
            ➤
          </button>
        )}
      </div>
    </div>
  )
}
