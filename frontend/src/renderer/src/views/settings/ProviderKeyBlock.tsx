import { useEffect, useRef, useState } from 'react'
import { aiClearKey, aiKeyStatus, aiSetKey, type KeyStatus } from '../../lib/ai'

/** The per-provider wording of the key block — everything else about the block is shared. */
const KEY_COPY = {
  openrouter: {
    label: 'OpenRouter API key',
    placeholder: 'sk-or-v1-…',
    envVar: 'OPENROUTER_API_KEY',
    company: 'OpenRouter',
    createAt: 'openrouter.ai under Keys',
    devfile: '.secrets/openrouter-key',
    flow: 'straight to OpenRouter’s servers, and on to whichever model you pick'
  },
  openai: {
    label: 'OpenAI API key',
    placeholder: 'sk-…',
    envVar: 'OPENAI_API_KEY',
    company: 'OpenAI',
    createAt: 'platform.openai.com under API keys',
    devfile: '.secrets/openai-key',
    flow: 'straight to OpenAI’s servers'
  }
} as const

export type ProviderChoice = keyof typeof KEY_COPY

/**
 * The provider key: entered here, stored by the OS, never seen by this page again.
 *
 * First block on the page, because nothing else on it does anything without a key. The field shows a
 * mask once a key is stored (`sk-or-v…1f4c`) — the value cannot be read back out of the main process,
 * which is the point, so this is not a form you edit but one you replace.
 *
 * One block, bound to the ACTIVE provider rather than two blocks side by side: the second key is a
 * state most users never have, and the one-line note below covers it. Both keys stay stored in
 * parallel — switching the provider never clears either one.
 *
 * The notice above the field is deliberately not the small print at the bottom: it is the moment the
 * user hands their credentials and their documents to a third party, and it says both halves of that
 * out loud — where the data goes, and whose bill it is.
 */
export function ProviderKeyBlock({ provider }: { provider: ProviderChoice }): JSX.Element {
  const copy = KEY_COPY[provider]
  const other: ProviderChoice = provider === 'openrouter' ? 'openai' : 'openrouter'
  const [status, setStatus] = useState<KeyStatus | null>(null)
  const [otherStored, setOtherStored] = useState(false)
  const [draft, setDraft] = useState('')
  const abandoned = useRef(false) // Escape beats the blur it triggers; see `commit`
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = (): void => {
    void aiKeyStatus(provider)
      .then(setStatus)
      .catch(() => setStatus(null))
    void aiKeyStatus(other)
      .then((s) => setOtherStored(s.present))
      .catch(() => setOtherStored(false))
  }
  // Re-bound on every provider switch: the mask, the source and the copy all belong to that key.
  useEffect(() => {
    setDraft('')
    setError(null)
    setStatus(null)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider])

  const commit = async (): Promise<void> => {
    // Escape clears the field and blurs it, and the blur runs before `setDraft('')` reaches this
    // closure — so without the flag, abandoning a half-pasted key STORED it (the same defect the
    // parameter table had, found 24.08.2026). A ref is the only thing that crosses a synchronous blur.
    if (abandoned.current) {
      abandoned.current = false
      return
    }
    const v = draft.trim()
    if (!v) return
    setBusy(true)
    setError(null)
    const r = await aiSetKey(v, provider).catch((e) => ({ ok: false, error: String(e) }))
    setBusy(false)
    if (!r.ok) return setError(r.error || 'The key could not be stored.')
    setDraft('')
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
    load()
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    await aiClearKey(provider).catch(() => undefined)
    setBusy(false)
    setDraft('')
    load()
  }

  // Where the key actually lives, in the user's words. `trusted: false` is a Linux box with no
  // keyring, where Chromium falls back to a hard-coded password — obfuscation, and saying "encrypted"
  // there would be a lie the user cannot check.
  const whereItLives = (stored: boolean): string => {
    if (!status) return ''
    if (!status.available)
      return `This system offers no credential store, so PrismLCA will not write a key to disk. Set ${copy.envVar} in the environment instead.`
    // "is" once there is a key, "will be" while the field is still empty — the same fact, but the
    // empty state read as though something were already encrypted.
    const verb = stored ? 'It is kept' : 'A key you enter is kept'
    if (status.backend === 'keychain') return `${verb} encrypted in your macOS keychain.`
    if (status.backend === 'dpapi') return `${verb} encrypted by Windows DPAPI, for your account only.`
    if (status.trusted) return `${verb} encrypted in your desktop keyring (${status.backend}).`
    return `No desktop keyring is running here, so a key on disk would only be obfuscated, not encrypted — PrismLCA says so rather than calling it safe. Start a keyring (gnome-keyring, KWallet), or set ${copy.envVar} in the environment and keep the key off the disk entirely.`
  }

  return (
    <>
      <h4>Provider key</h4>
      {/* The whole point of this block, above the field rather than below it. */}
      <p className="settings-notice">
        Entering an {copy.company} API key sends your search queries and the contents of the documents you
        index {copy.flow}. What happens to that data there is governed by your own agreement and terms of use
        with {copy.company}, not by anything PrismLCA can promise.{' '}
        <strong>Set a spending limit on the key.</strong> PrismLCA has brakes of its own — a cost ceiling per
        run, a tool-round budget, and the running total under Usage &amp; costs — but the account is yours and
        so is the bill, including what a run costs when a brake is switched off or fails.
      </p>
      <label className="settings-field settings-key">
        <span>{copy.label}</span>
        <input
          type="password"
          value={draft}
          placeholder={status?.present ? status.hint : copy.placeholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              e.stopPropagation() // abandons the key being typed; Settings stays open
              abandoned.current = true
              setDraft('')
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
      </label>
      <p className="settings-hint">
        {status?.present ? (
          <>
            A key is configured{status.source === 'env' ? ' from the environment' : ''}
            {status.source === 'devfile' ? ' from this checkout' : ''} — <code>{status.hint}</code>.{' '}
            {status.source === 'env'
              ? `${copy.envVar} is set in the environment and overrides anything stored here.`
              : status.source === 'devfile'
                ? `It comes from ${copy.devfile} in the working copy — a developer convenience that is not stored by the OS and not managed from here. Type a key above and the stored one takes over.`
                : whereItLives(true)}{' '}
            Typing a new one replaces it; it is never shown again.
          </>
        ) : (
          <>
            No key yet — the assistant, the report writer and API embeddings stay switched off until there is
            one. Create one at {copy.createAt}, with a credit limit on it. {whereItLives(false)}
          </>
        )}
      </p>
      {otherStored ? (
        <p className="settings-hint">
          Your {KEY_COPY[other].company} key stays stored — switch the provider back any time and it applies
          again.
        </p>
      ) : null}
      {saved ? <p className="settings-hint ok">Stored.</p> : null}
      {error ? <p className="settings-hint bad">{error}</p> : null}
      {status?.present && status.source === 'stored' ? (
        <button className="btn sm" disabled={busy} onClick={() => void remove()}>
          Remove the key
        </button>
      ) : null}
    </>
  )
}
