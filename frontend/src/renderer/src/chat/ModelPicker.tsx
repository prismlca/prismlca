import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { aiKeyStatus, aiModels, KEY_CHANGED_EVENT, MODELS_CHANGED_EVENT, type AiModelInfo } from '../lib/ai'
import { EffortIcon, SwapIcon } from '../components/icons'
import { setAS, useAppSettings } from '../lib/appSettings'
import {
  DEFAULT_MODEL_ID,
  DEFAULT_OPENAI_MODEL_ID,
  REASONING_EFFORT_SHORT,
  type ReasoningEffort
} from '../../../shared/aiDefaults'
import { EffortDial } from '../components/EffortScale'

/**
 * The model catalogue for the picker beside the mic, fetched once per session. The button has to
 * show a label before anyone opens it, and the call behind it asks OpenRouter for live prices — so
 * the panel must not pay for that on every mount. A failed fetch clears the cache and is retried.
 */
let MODEL_CATALOGUE: Promise<AiModelInfo[]> | null = null
export const modelCatalogue = (): Promise<AiModelInfo[]> => {
  if (!MODEL_CATALOGUE)
    MODEL_CATALOGUE = aiModels().catch((e) => {
      MODEL_CATALOGUE = null
      throw e
    })
  return MODEL_CATALOGUE
}

type Provider = 'openrouter' | 'openai'
const PROVIDER_NAME: Record<Provider, string> = { openrouter: 'OpenRouter', openai: 'OpenAI' }

/**
 * The chat-model picker in the composer's control row, and the reasoning effort with it: the button
 * reads "Sonnet 5.5 (Claude): High", the menu has an Effort row pinned above the scrolling model
 * list, and that row opens the levels as a submenu — one control, not two.
 * When BOTH providers have a key, a "Change provider" row sits above it and swaps the list below;
 * with one key the provider stays where its key lives, Settings → AI.
 * No props: all three choices are app settings, and picking writes through to them.
 */
export default function ModelPicker(): JSX.Element {
  // The same chat-model choice as Settings → AI → Models, and only that one.
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  const [providerOpen, setProviderOpen] = useState(false)
  const effortCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const providerCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Both keys stored? Only then is a provider switch offered here: switching to a provider without
  // a key would lock the chat behind "no key" one click later. Re-asked when a key is stored or
  // cleared (Settings opens over this panel).
  const [bothKeys, setBothKeys] = useState(false)
  const [modelList, setModelList] = useState<AiModelInfo[]>([])
  const [modelsReady, setModelsReady] = useState(false)
  const modelRef = useRef<HTMLDivElement | null>(null)
  const settings = useAppSettings()
  // Model that will answer. From main's store, and subscribed: Settings may change it while this
  // chat is open, and a stale model name here would send the run to the wrong model.
  const currentModel = settings.model || DEFAULT_MODEL_ID
  // Only the active provider's models are offered, exactly as in Settings: a mixed list would let a
  // click store a model the current key cannot serve. A stored id from the other provider is left
  // alone and simply shown as-is — main resolves it the same way Settings describes.
  const provider: Provider = settings.provider === 'openai' ? 'openai' : 'openrouter'
  const pickableModels = modelList.filter(
    (m) => (m.provider ?? 'openrouter') === provider && m.selectable !== false
  )
  // The effort is keyed by the EFFECTIVE model, the one main will send: a stored id from the other
  // provider resolves to the active provider's default there (ipc/chat.ts), and so must its effort.
  const defaultId = provider === 'openai' ? DEFAULT_OPENAI_MODEL_ID : DEFAULT_MODEL_ID
  const effectiveId = pickableModels.some((m) => m.id === currentModel) ? currentModel : defaultId
  const effective = pickableModels.find((m) => m.id === effectiveId)
  // The button names the model that WILL answer. A stored id from the other provider (a switch
  // from here or from Settings) resolves to the active provider's default in main, so it is the
  // default that is shown and ticked — not a name the current key cannot serve.
  const currentModelLabel =
    effective?.label ?? modelList.find((m) => m.id === currentModel)?.label ?? currentModel
  const levels: readonly ReasoningEffort[] = effective?.reasoningEfforts ?? []
  const efforts = settings.reasoningEffort ?? {}
  const effort: ReasoningEffort | '' = efforts[effectiveId] ?? ''
  const effortShown = effort ? REASONING_EFFORT_SHORT[effort] : 'Default'
  const pickEffort = (v: ReasoningEffort | ''): void => {
    const next = { ...efforts }
    if (v) next[effectiveId] = v
    else delete next[effectiveId]
    setAS({ reasoningEffort: next })
  }

  useEffect(() => {
    let stale = false
    const load = (): void => {
      void modelCatalogue()
        .then((list) => {
          if (!stale) setModelList(list)
        })
        .catch(() => {})
        .finally(() => {
          if (!stale) setModelsReady(true)
        })
    }
    load()
    // A model added or removed in Settings while this chat is open: drop the session cache and
    // re-read, or the fallback below would take the new id for one the provider does not serve.
    const changed = (): void => {
      MODEL_CATALOGUE = null
      load()
    }
    window.addEventListener(MODELS_CHANGED_EVENT, changed)
    return () => {
      stale = true
      window.removeEventListener(MODELS_CHANGED_EVENT, changed)
    }
  }, [])

  useEffect(() => {
    const check = (): void => {
      void Promise.all([aiKeyStatus('openrouter'), aiKeyStatus('openai')])
        .then(([a, b]) => setBothKeys(a.present && b.present))
        .catch(() => setBothKeys(false))
    }
    check()
    window.addEventListener(KEY_CHANGED_EVENT, check)
    return () => window.removeEventListener(KEY_CHANGED_EVENT, check)
  }, [])

  useEffect(() => {
    if (!modelMenuOpen) {
      setEffortOpen(false)
      setProviderOpen(false)
      return
    }
    const away = (e: MouseEvent): void => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelMenuOpen(false)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setModelMenuOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [modelMenuOpen])

  // Each submenu follows the pointer with a short grace period (the Skills flyout's rule): hovering
  // the row opens it, leaving row and flyout closes it 150 ms later, a click toggles it outright.
  // Opening one closes the other — two flyouts side by side would cover the list.
  // A thumb being dragged may leave the flyout and come back; the flyout holds still until the
  // pointer is let go, and closes then only if it was let go outside.
  const dragging = useRef(false)
  const effortSub = useRef<HTMLDivElement | null>(null)
  const flyout = (
    timer: MutableRefObject<ReturnType<typeof setTimeout> | null>,
    set: (v: boolean) => void,
    closeOther: () => void
  ): { hold: () => void; release: () => void } => ({
    hold: () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      closeOther()
      set(true)
    },
    release: () => {
      if (dragging.current) return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => set(false), 150)
    }
  })
  const effortFly = flyout(effortCloseTimer, setEffortOpen, () => setProviderOpen(false))
  const providerFly = flyout(providerCloseTimer, setProviderOpen, () => setEffortOpen(false))
  const onEffortDrag = (held: boolean): void => {
    dragging.current = held
    if (held) return
    // Let go: close unless the pointer is still over the row or its flyout.
    const over = effortSub.current?.matches(':hover') ?? false
    if (!over) effortFly.release()
  }
  useEffect(
    () => () => {
      if (effortCloseTimer.current) clearTimeout(effortCloseTimer.current)
      if (providerCloseTimer.current) clearTimeout(providerCloseTimer.current)
    },
    []
  )

  const effortTitle = levels.length
    ? 'How hard the model thinks before it writes. Kept per model.'
    : 'No levels documented for this model — it runs on its API default.'

  return (
    <div className="chat-model-wrap" ref={modelRef}>
      <button
        className={`chat-bar-model${modelMenuOpen ? ' on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={modelMenuOpen}
        aria-label={`Chat model: ${currentModelLabel}${levels.length ? `, reasoning effort ${effortShown}` : ''}`}
        title="The model for this chat and its reasoning effort — click to change."
        onClick={() => setModelMenuOpen((v) => !v)}
      >
        <span className="chat-model-name">
          {currentModelLabel}
          {levels.length ? (
            <>
              : <span className="chat-model-effort">{effortShown}</span>
            </>
          ) : null}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {modelMenuOpen ? (
        <div className="chat-plus-menu chat-model-menu" role="menu" aria-label="Chat model">
          {/* Pinned above the list, outside its scroll box, so it stays put however long the list is —
              and so its flyout is not clipped by the list's overflow. */}
          {bothKeys ? (
            <div
              className="chat-menu-sub chat-model-head"
              onMouseEnter={providerFly.hold}
              onMouseLeave={providerFly.release}
            >
              <button
                className={`chat-menu-item${providerOpen ? ' open' : ''}`}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={providerOpen}
                title="Switch between OpenRouter and OpenAI — the model list follows."
                onClick={() => {
                  setEffortOpen(false)
                  setProviderOpen((v) => !v)
                }}
              >
                {/* In the tick slot, at the tick's width, so the label starts where every other
                    label in this menu starts. */}
                <span className="chat-model-tick" aria-hidden="true">
                  <SwapIcon />
                </span>
                <span className="chat-menu-label">
                  Change provider
                  <span className="chat-model-desc">{PROVIDER_NAME[provider]}</span>
                </span>
              </button>
              {providerOpen ? (
                <div
                  className="chat-plus-menu chat-submenu chat-effort-sub"
                  role="menu"
                  aria-label="Provider"
                >
                  {(['openrouter', 'openai'] as Provider[]).map((p) => (
                    <button
                      key={p}
                      className={`chat-menu-item chat-model-item${p === provider ? ' on' : ''}`}
                      role="menuitemradio"
                      aria-checked={p === provider}
                      onClick={() => {
                        // The menu stays open: the point of switching here is to pick from the
                        // other provider's list, which re-renders underneath.
                        setAS({ provider: p })
                        setProviderOpen(false)
                      }}
                    >
                      <span className="chat-model-tick" aria-hidden="true">
                        {p === provider ? '✓' : ''}
                      </span>
                      <span className="chat-menu-label">{PROVIDER_NAME[p]}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <div
            className="chat-menu-sub chat-model-head"
            ref={effortSub}
            onMouseEnter={levels.length ? effortFly.hold : undefined}
            onMouseLeave={levels.length ? effortFly.release : undefined}
          >
            <button
              className={`chat-menu-item${effortOpen ? ' open' : ''}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={effortOpen}
              disabled={!levels.length}
              title={effortTitle}
              onClick={() => {
                setProviderOpen(false)
                setEffortOpen((v) => !v)
              }}
            >
              <span className="chat-model-tick" aria-hidden="true">
                <EffortIcon />
              </span>
              <span className="chat-menu-label">
                Effort
                <span className="chat-model-desc">
                  {levels.length ? effortShown : 'no levels documented for this model'}
                </span>
              </span>
            </button>
            {effortOpen && levels.length ? (
              <div
                className="chat-plus-menu chat-submenu chat-effort-sub chat-effort-dial"
                role="group"
                aria-label="Reasoning effort"
              >
                <EffortDial
                  label="Reasoning effort"
                  levels={levels}
                  value={effort}
                  onChange={pickEffort}
                  onDragging={onEffortDrag}
                />
              </div>
            ) : null}
          </div>
          <div className="chat-menu-divider" />
          <div className="chat-model-list">
            {pickableModels.length === 0 ? (
              <div className="chat-menu-empty">{modelsReady ? 'No models available.' : 'Loading…'}</div>
            ) : null}
            {pickableModels.map((m) => (
              <button
                key={m.id}
                className={`chat-menu-item chat-model-item${m.id === effectiveId ? ' on' : ''}`}
                role="menuitemradio"
                aria-checked={m.id === effectiveId}
                title={`${m.label} — ${m.descriptor}${
                  m.userAdded ? ' · added by you, not checked by PrismLCA' : ''
                }`}
                onClick={() => {
                  setAS({ model: m.id })
                  setModelMenuOpen(false)
                }}
              >
                <span className="chat-model-tick" aria-hidden="true">
                  {m.id === effectiveId ? '✓' : ''}
                </span>
                <span className="chat-menu-label">
                  {m.label}
                  {/* The same mark as the settings table. This menu is a second place a
                      self-added model can be chosen, and it used to show nothing at all. */}
                  {m.userAdded ? <span className="chat-model-own">added by you</span> : null}
                  <span className="chat-model-desc">{m.descriptor}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
