/**
 * The composer's per-chat memory: the six toggles of the "+" menu and the half-typed draft.
 *
 * Module-level on purpose, and without React: the chat lives on the Model page and is torn down
 * whenever you look at Results or the Report, while the conversation itself is restored from the
 * backend. What only lived in component state was lost with it. Not localStorage either — a
 * deliberately changed toggle and an unsent thought both lapse when the app restarts.
 *
 * Seven maps rather than one record per chat, on purpose: a field that was never touched is
 * MISSING (and reads as its default), and the carry-over to a freshly created chat copies only the
 * fields that are present. A merged record would have to reinvent both.
 */

/**
 * Web-search opt-in per chat, module-level so it survives this panel being unmounted.
 *
 * It has to outlive the component: the chat lives on the Model page and is torn down whenever you look
 * at Results or the Report, while the conversation itself is restored from the backend. A deliberately
 * enabled web search was not, so the next message went out without it and nothing said so. Module
 * scope and not localStorage on purpose — the opt-in still lapses when the app restarts.
 */
const WEB_SEARCH_BY_CHAT = new Map<string, boolean>()
/** Same for the distances tool: per chat, default on, the store and the keys still decide. */
const DISTANCES_BY_CHAT = new Map<string, boolean>()
/** And for the Eurostat EoL statistics tool: per chat, default on, the app setting still decides. */
const EUROSTAT_BY_CHAT = new Map<string, boolean>()
// Whether THIS chat may draw on the user's own library (My processes) — same lifecycle as the web
// toggle: per chat, surviving the panel unmount. Defaults to OFF: most chats
// model against the background alone, and releasing one's own datasets is the deliberate act.
const LIBRARY_BY_CHAT = new Map<string, boolean>()
// Comparison models a chat switched OFF. The relation lives on the study (symmetric, see
// lib/comparison.ts) and is on by default in every chat of the model; only the exceptions are kept here.
const COMPARISON_OFF_BY_CHAT = new Map<string, string[]>()
// Which background databases this chat searches, per database name. Default: the primary one
// (ecoinvent when installed) on, every other one (BAFU) off — each has its own switch in the "+"
// menu, like "My processes". Missing key = the default for that database.
const BACKGROUNDS_BY_CHAT = new Map<string, Record<string, boolean>>()
/**
 * The key of the chat that does not exist yet on model `db` — the one the first send creates. Emptied
 * by that send. Per model, since one `'(new)'` shared by every model
 * let a switch flipped before the first chat of model m show up in a fresh panel on model n.
 */
export function newChatKey(db: string | null): string {
  return `(new):${db ?? ''}`
}

/**
 * Half-typed messages, per chat, for as long as the app runs.
 *
 * Same reason as the map above: the chat lives on the Model page and is torn down the moment you look at
 * Parameters. The conversation comes back from the backend, but a sentence you had not sent yet existed
 * only in component state — so a glance at another page to check a number threw it away. Not
 * localStorage on purpose: an unsent thought should not outlive the session it was had in.
 */
const DRAFT_BY_CHAT = new Map<string, string>()

/** The six per-chat switches of the "+" menu. */
export interface ChatToggles {
  webSearch: boolean
  distancesOn: boolean
  eurostatOn: boolean
  useLibrary: boolean
  comparisonOff: string[]
  releasedBackgrounds: Record<string, boolean>
}

const MAPS: { [K in keyof ChatToggles]: Map<string, ChatToggles[K]> } = {
  webSearch: WEB_SEARCH_BY_CHAT,
  distancesOn: DISTANCES_BY_CHAT,
  eurostatOn: EUROSTAT_BY_CHAT,
  useLibrary: LIBRARY_BY_CHAT,
  comparisonOff: COMPARISON_OFF_BY_CHAT,
  releasedBackgrounds: BACKGROUNDS_BY_CHAT
}

/** A chat's switches: its own choice where it made one, the default everywhere else. */
export function readToggles(key: string): ChatToggles {
  return {
    webSearch: WEB_SEARCH_BY_CHAT.get(key) ?? true,
    distancesOn: DISTANCES_BY_CHAT.get(key) ?? true,
    eurostatOn: EUROSTAT_BY_CHAT.get(key) ?? true,
    useLibrary: LIBRARY_BY_CHAT.get(key) ?? false,
    comparisonOff: COMPARISON_OFF_BY_CHAT.get(key) ?? [],
    releasedBackgrounds: BACKGROUNDS_BY_CHAT.get(key) ?? {}
  }
}

/** Remember one switch for one chat. */
export function writeToggle<K extends keyof ChatToggles>(key: string, field: K, value: ChatToggles[K]): void {
  ;(MAPS[field] as Map<string, ChatToggles[K]>).set(key, value)
}

/**
 * Carry what was set on model `db` before the chat existed over to its id, so the very first message
 * of a chat is not the one that silently loses it. Only the fields the placeholder actually holds are
 * copied — the toggles and the draft: text typed while the first send is still
 * creating the chat was left under the placeholder, gone from this chat after a remount and back in
 * the next new one.
 *
 * The placeholder is emptied afterwards: it used to be kept, so every
 * later new chat started from whatever was last flipped before a chat existed. A fresh chat now
 * starts at the defaults.
 */
export function carryNewChat(db: string | null, id: string): void {
  const from = newChatKey(db)
  for (const map of [...Object.values(MAPS), DRAFT_BY_CHAT] as Array<Map<string, unknown>>) {
    if (!map.has(from)) continue
    map.set(id, map.get(from))
    map.delete(from)
  }
}

/** The unsent draft of a chat, or ''. */
export function readDraft(key: string): string {
  return DRAFT_BY_CHAT.get(key) ?? ''
}

/** Remember a draft. The empty string is deleted rather than stored, so a cleared box does not
 *  shadow a draft that a later chat switch would have restored. */
export function writeDraft(key: string, value: string): void {
  if (value) DRAFT_BY_CHAT.set(key, value)
  else DRAFT_BY_CHAT.delete(key)
}
