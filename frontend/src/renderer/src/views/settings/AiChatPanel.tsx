import { useState } from 'react'
import { defaultVoiceLanguage, VOICE_LANGUAGES } from '../../lib/ai'
import { setAS, useAppSettings } from '../../lib/appSettings'
import {
  clampWebLookups,
  DEFAULT_WEB_LOOKUPS_PER_ANSWER,
  MAX_WEB_LOOKUPS_PER_ANSWER
} from '../../../../shared/aiDefaults'

/** AI-Chat: chat-panel features — voice input and web search, each fully switchable. */
export function AiChatPanel(): JSX.Element {
  // Read from the store, not copied — see AiLimitsPanel for why the copies went (18.10.2026).
  const as = useAppSettings()
  const voiceEnabled = as.voiceEnabled
  const voiceLang = as.voiceLanguage || defaultVoiceLanguage()
  const webEnabled = as.webSearchEnabled
  // The one draft that stays local: an emptied field while typing, which has no stored value. Any
  // number (and the blur) hands the field back to the store — and so does a stored value that changes
  // under the draft (Reset, another writer): the draft only stands for the value it was typed over.
  const [webCapDraft, setWebCapDraft] = useState<{ raw: string; over: number } | null>(null)
  const webCap =
    webCapDraft && webCapDraft.over === as.webLookupsPerAnswer
      ? webCapDraft.raw
      : String(as.webLookupsPerAnswer)
  const setWebCap = (raw: string): void => {
    if (raw.trim() === '') {
      setWebCapDraft({ raw, over: as.webLookupsPerAnswer }) // still typing — the clamp runs on blur
      return
    }
    setWebCapDraft(null)
    setAS({ webLookupsPerAnswer: clampWebLookups(raw) })
  }
  const eurostatEnabled = as.eurostatEnabled !== false
  // The hint names the service the recording actually goes to; it is the provider's, not a fixed one.
  const provider = as.provider ?? 'openrouter'

  return (
    <>
      <h4>Voice input</h4>
      <label className="settings-field">
        <span>Offer voice input in the chat</span>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={voiceEnabled}
          onChange={(e) => setAS({ voiceEnabled: e.target.checked })}
        />
      </label>
      <p className="settings-hint">
        On = the chat shows a microphone button; the recording is sent to{' '}
        {provider === 'openai' ? 'OpenAI (gpt-transcribe)' : 'OpenRouter (Whisper)'} for transcription and the
        transcript is sent as your message. Off = the button disappears entirely.
      </p>
      {voiceEnabled ? (
        <>
          <label className="settings-field">
            <span>Spoken language</span>
            <select value={voiceLang} onChange={(e) => setAS({ voiceLanguage: e.target.value })}>
              {VOICE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <p className="settings-hint">
            Pin the language you speak into the microphone. Auto-detect can return an English translation
            instead of a transcript for non-English speech — pick your language to prevent that.
          </p>
        </>
      ) : null}

      <h4>Web search</h4>
      <label className="settings-field">
        <span>Offer web search in the chat</span>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={webEnabled}
          onChange={(e) => setAS({ webSearchEnabled: e.target.checked })}
        />
      </label>
      <p className="settings-hint">
        On = the chat shows a web-search toggle in the “+” menu, on for every new chat — switch it off there
        for one conversation. The search runs on the provider’s side, so it sees the query the assistant
        writes from your workspace. Off = the toggle disappears entirely and the assistant, its research
        helpers included, can never reach the web.
      </p>
      {webEnabled ? (
        <>
          <label className="settings-field">
            <span>Web lookups per reply</span>
            <input
              type="number"
              min={0}
              max={MAX_WEB_LOOKUPS_PER_ANSWER}
              step={1}
              value={webCap}
              onChange={(e) => setWebCap(e.target.value)}
              onBlur={(e) =>
                setWebCap(e.target.value === '' ? String(DEFAULT_WEB_LOOKUPS_PER_ANSWER) : e.target.value)
              }
            />
          </label>
          <p className="settings-hint">
            Searches and pages the provider may look up within one reply (OpenRouter chat only). Each lookup
            runs the model over the whole conversation again, so a reply with three lookups is billed four
            times; the chat then shows a “Web lookups by the provider” row. Default{' '}
            {DEFAULT_WEB_LOOKUPS_PER_ANSWER}; 0 = no cap of ours, the provider’s limit of{' '}
            {MAX_WEB_LOOKUPS_PER_ANSWER} applies.
          </p>
        </>
      ) : null}

      <h4>Eurostat EoL statistics</h4>
      <label className="settings-field">
        <span>Offer Eurostat waste statistics to the assistant</span>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={eurostatEnabled}
          onChange={(e) => setAS({ eurostatEnabled: e.target.checked })}
        />
      </label>
      <p className="settings-hint">
        On = the assistant can look up official end-of-life treatment mixes, packaging and municipal-waste
        statistics from Eurostat’s public API (free, no key; each table is cached for a day). Off = the tool
        disappears and the assistant is not told it exists. The chat’s “+” menu can also switch it off for one
        conversation.
      </p>
    </>
  )
}
