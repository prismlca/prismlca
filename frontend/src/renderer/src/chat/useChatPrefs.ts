import { useCallback, useEffect, useRef, useState } from 'react'
import {
  carryNewChat,
  newChatKey,
  readDraft,
  readToggles,
  writeDraft,
  writeToggle,
  type ChatToggles
} from './chatPrefs'

type Next<T> = T | ((prev: T) => T)

export interface ChatPrefs {
  input: string
  /** Set the box and remember it as this chat's draft. Stable identity. */
  typeInput: (next: Next<string>) => void
  webSearch: boolean
  setWebSearch: (next: Next<boolean>) => void
  distancesOn: boolean
  setDistancesOn: (next: Next<boolean>) => void
  eurostatOn: boolean
  setEurostatOn: (next: Next<boolean>) => void
  useLibrary: boolean
  setUseLibrary: (next: Next<boolean>) => void
  comparisonOff: string[]
  /** The comparison models this chat keeps switched on. */
  comparisonOn: string[]
  setComparisonOn: (name: string, on: boolean) => void
  isReleased: (db: string) => boolean
  toggleBackground: (db: string) => void
  /** What this turn may search, and what is installed but held back. */
  searchedBackgrounds: string[]
  withheldBackgrounds: string[]
  /**
   * The first send on model `db` just created chat `id`: carry that model's placeholder (toggles and
   * draft) over to it and, while the panel still shows that placeholder, keep what is on screen for
   * it (the settings effect skips that one reload) and write further flips and keystrokes under it.
   * Stable.
   */
  adopt: (id: string, db: string | null) => void
}

/**
 * The composer's per-chat switches and draft, as React state backed by `chatPrefs`.
 *
 * The state is loaded from the store whenever the shown chat changes, and every change is written
 * back under the chat it was made in — which is what lets both survive this panel being unmounted.
 */
export function useChatPrefs(
  chatId: string | null,
  opts: {
    /** The model on screen: a chat that does not exist yet keeps its switches per model. */
    activeDb: string | null
    comparedWith: string[]
    backgroundDbs?: string[]
    secondaryBackgroundDbs?: string[]
  }
): ChatPrefs {
  const { activeDb, comparedWith, backgroundDbs, secondaryBackgroundDbs } = opts
  // The store key of what is on screen: the chat, or the not-yet-created chat of this model.
  const shownKey = chatId ?? newChatKey(activeDb)
  const [input, setInput] = useState(() => readDraft(shownKey))
  // Per-chat web access: **on unless this chat turned it off**. It used to start
  // off, and the cost of that was invisible: the toggle attaches OpenRouter's `web_search` AND
  // `web_fetch`, so with it off the assistant cannot open a URL the user pasted, cannot check a
  // safety data sheet, and — worst — is not told any of that. It answers from memory instead, which
  // is exactly the failure the sourcing rules exist to prevent. The app-wide switch in Settings → AI
  // → Chat still wins, and the same page caps how many lookups one reply may run (each one re-runs
  // the conversation through the model, V398). Held in a module-level map rather than plain state because this panel is unmounted every
  // time you leave the Model view — the conversation comes back from the backend, but a deliberately
  // CHANGED toggle used to be gone, silently, which is the one direction that costs the user something.
  const [webSearch, setWebSearchState] = useState(true)
  // Per-chat toggle for the distances tool (default on). Whether the feature can run at all is the
  // "+" menu's business: without it the row is not even shown, and main drops the tool regardless.
  const [distancesOn, setDistancesOnState] = useState(true)
  // Per-chat toggle for the Eurostat EoL statistics tool (default on); the app setting hides the row.
  const [eurostatOn, setEurostatOnState] = useState(true)
  // Per-chat release of the user's own library to the assistant — OFF by default, the release is
  // the deliberate act.
  const [useLibrary, setUseLibraryState] = useState(false)
  // The comparison models this chat holds back (the relation itself lives on the study).
  const [comparisonOff, setComparisonOffState] = useState<string[]>([])
  const [releasedBackgrounds, setReleasedBackgroundsState] = useState<Record<string, boolean>>({})

  /** The chat id `send` is about to materialise (see the settings effect). */
  const materialising = useRef<string | null>(null)

  useEffect(() => {
    // A chat shows its own setting: the default for one that never touched it, and its own choice for
    // one that did — in both directions, because turning web access OFF is now the deliberate act. This is
    // also what makes it survive leaving the Model view, which unmounts this panel. Exception kept
    // from before: the first send in a fresh chat materialises the chat id, and that must not switch
    // off what the user just enabled — the value is migrated to the new id at creation.
    // Only that materialisation is skipped. Switching INTO a chat whose run is in flight used to be
    // skipped too, and the previous chat's web/library/background toggles and draft stayed on screen
    // — and went out with the next message.
    if (materialising.current === shownKey) {
      materialising.current = null
      return
    }
    const t = readToggles(shownKey)
    setWebSearchState(t.webSearch)
    setDistancesOnState(t.distancesOn)
    setEurostatOnState(t.eurostatOn)
    setUseLibraryState(t.useLibrary)
    setComparisonOffState(t.comparisonOff)
    setReleasedBackgroundsState(t.releasedBackgrounds)
    setInput(readDraft(shownKey))
    // `shownKey` rather than `chatId`: with no chat open, a model switch changes the key as well.
  }, [shownKey])

  // One key for switches and draft alike: set on every render, and moved by `adopt` the moment the
  // first send has created the chat. The draft used to have a key of its own that only followed the
  // render, so text typed while the first send was still creating the chat landed under the placeholder.
  // Assigned AFTER the state hooks above, like the refs it replaces, so an updater React replays during
  // this render still sees the key of the previous one.
  // Every keystroke also lands in the module-level store, so unmounting this panel — which leaving the
  // Model view does — cannot lose it. Keyed by chat, and the empty string is deleted rather than stored
  // so a cleared box does not shadow a draft that a later chat switch would have restored.
  const keyRef = useRef<string>(shownKey)
  keyRef.current = shownKey

  const typeInput = useCallback((next: Next<string>) => {
    // An updater is accepted as well as a value: the voice path appends to whatever is in the box, and
    // reading that from a closure would append to a stale copy.
    setInput((prev) => {
      const value = typeof next === 'function' ? next(prev) : next
      writeDraft(keyRef.current, value)
      return value
    })
  }, [])

  const adopt = useCallback((id: string, db: string | null) => {
    // The placeholder of the model the send started on — never "whichever model is on screen now":
    // a model switch while createChat was pending used to move the OTHER model's draft and switches
    // into this chat and delete them there.
    const from = newChatKey(db)
    if (keyRef.current === from) {
      // The panel still shows it. The settings effect must let this id keep the toggles chosen before
      // the chat existed (they are migrated just below) — and only this one: a switch INTO a running
      // chat restores its own. After a model switch the panel shows another key, which stays as it is.
      materialising.current = id
      keyRef.current = id
    }
    // Carry the toggles and the draft set before the chat existed over to its id, so the very first
    // message of a chat is not the one that silently loses them.
    carryNewChat(db, id)
  }, [])

  // Remembering the toggle per chat, and restoring it when this panel comes back.
  const remember =
    <K extends keyof ChatToggles>(field: K, set: (u: (prev: ChatToggles[K]) => ChatToggles[K]) => void) =>
    (next: Next<ChatToggles[K]>): void => {
      set((prev) => {
        const value =
          typeof next === 'function' ? (next as (p: ChatToggles[K]) => ChatToggles[K])(prev) : next
        writeToggle(keyRef.current, field, value)
        return value
      })
    }
  const setWebSearch = remember('webSearch', setWebSearchState)
  const setDistancesOn = remember('distancesOn', setDistancesOnState)
  const setEurostatOn = remember('eurostatOn', setEurostatOnState)
  const setUseLibrary = remember('useLibrary', setUseLibraryState)
  const setComparisonOn = (name: string, on: boolean): void => {
    setComparisonOffState((prev) => {
      const value = on ? prev.filter((n) => n !== name) : prev.includes(name) ? prev : [...prev, name]
      writeToggle(keyRef.current, 'comparisonOff', value)
      return value
    })
  }
  const comparisonOn = comparedWith.filter((n) => !comparisonOff.includes(n))
  // A background without an explicit switch state follows its default: on unless it is one of
  // the secondary ones.
  const secondary = new Set(secondaryBackgroundDbs ?? [])
  const released = (db: string, state: Record<string, boolean>): boolean => state[db] ?? !secondary.has(db)
  const isReleased = (db: string): boolean => released(db, releasedBackgrounds)
  const toggleBackground = (db: string): void => {
    setReleasedBackgroundsState((prev) => {
      const value = { ...prev, [db]: !released(db, prev) }
      writeToggle(keyRef.current, 'releasedBackgrounds', value)
      return value
    })
  }
  // What this turn may search, and what is installed but held back — the prompt names both, so the
  // assistant can say "switch it on" instead of "it does not exist".
  const searchedBackgrounds = (backgroundDbs ?? []).filter((d) => isReleased(d))
  const withheldBackgrounds = (backgroundDbs ?? []).filter((d) => !isReleased(d))

  return {
    input,
    typeInput,
    webSearch,
    setWebSearch,
    distancesOn,
    setDistancesOn,
    eurostatOn,
    setEurostatOn,
    useLibrary,
    setUseLibrary,
    comparisonOff,
    comparisonOn,
    setComparisonOn,
    isReleased,
    toggleBackground,
    searchedBackgrounds,
    withheldBackgrounds,
    adopt
  }
}
