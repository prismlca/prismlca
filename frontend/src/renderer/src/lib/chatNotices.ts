import { useSyncExternalStore } from 'react'
import type { AiEvent } from './ai'

/**
 * Chats that ended a turn while nobody was looking (V406).
 *
 * The chat dock lives on the Model view only, so an answer that arrives while the user is on Results,
 * in another model or with the dock collapsed used to be invisible until they went back by chance — a
 * 16-minute modelling turn that ended with `open_page results` was the case.
 * The Workbench feeds every assistant event in here and shows one banner row per notice; the chat
 * panel reports which chat it has on screen, and a turn that ends there needs no notice.
 *
 * Questions are not kept here: `usePendingAsks` already gives every unseen question its own banner,
 * and a second row for the same question would only say it twice.
 */
export interface ChatNotice {
  chatId: string
  /** The model the chat works on; null when this window never learnt it (e.g. a run older than a reload). */
  database: string | null
  kind: 'done' | 'error'
  /** The start of the answer, or the error message, on one line. */
  excerpt: string
  at: number
}

export const EXCERPT_CHARS = 80

let notices: ChatNotice[] = []
let visibleChat: string | null = null
// done/error carry no model, so it is learnt from the events that do and from the panel's sends.
const chatModels = new Map<string, string>()
const listeners = new Set<() => void>()

function publish(next: ChatNotice[]): void {
  notices = next
  for (const fn of listeners) fn()
}

export function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1).trimEnd()}…` : flat
}

/** Remember which model a chat works on — the panel calls this when it starts or adopts a run. */
export function noteChatModel(chatId: string, database: string | null | undefined): void {
  if (database) chatModels.set(chatId, database)
}

/** The chat the dock has open on screen, or null (collapsed, unmounted, no chat yet). */
export function setVisibleChat(chatId: string | null): void {
  visibleChat = chatId
  if (chatId) dismissChatNotice(chatId)
}

export function dismissChatNotice(chatId: string): void {
  if (notices.some((n) => n.chatId === chatId)) publish(notices.filter((n) => n.chatId !== chatId))
}

export function handleChatEvent(ev: AiEvent, now: number = Date.now()): void {
  if (ev.type === 'refresh') noteChatModel(ev.chatId, ev.database)
  else if (ev.type === 'ask') noteChatModel(ev.chatId, ev.ask.database)
  else if (ev.type === 'done' || ev.type === 'error') {
    if (ev.chatId === visibleChat) return
    const notice: ChatNotice = {
      chatId: ev.chatId,
      database: chatModels.get(ev.chatId) ?? null,
      kind: ev.type,
      excerpt: excerptOf(ev.type === 'done' ? ev.text : ev.message),
      at: now
    }
    // One row per chat, newest first: a later turn of the same chat replaces its older notice.
    publish([notice, ...notices.filter((n) => n.chatId !== ev.chatId)])
  }
}

export function chatNotices(): ChatNotice[] {
  return notices
}

export function useChatNotices(): ChatNotice[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    chatNotices,
    chatNotices
  )
}

/** Tests only: forget everything between cases. */
export function resetChatNotices(): void {
  notices = []
  visibleChat = null
  chatModels.clear()
  for (const fn of listeners) fn()
}
