/**
 * The questions the assistant is waiting on — main's record, because main is the only party that
 * survives what the user does with the window.
 *
 * An `ask_user` used to exist only as a round-trip: main asked the renderer, the chat panel showed a
 * card, and whoever answered settled the promise. That is fine while the chat is on screen. It is not
 * once the user has switched to another model, left the Model view, or collapsed the chat: the panel
 * either never hears the question or filters it away, nobody answers, and after the timeout the run
 * carries on without one — with the user finding out later, if at all. Two assistants working on two
 * models at once make that the normal case rather than the odd one.
 *
 * So the open questions are kept here, and two things read them: the Workbench, to show a banner
 * that leads to the chat, and the chat panel itself, to restore the card when its chat is opened
 * after the question arrived. Same reasoning as `ai:isRunning` (V274): the truth about a run lives
 * where the run lives.
 */
import type { PendingAsk } from '../../shared/ipc'

export class PendingAsks {
  private readonly byReq = new Map<string, PendingAsk>()

  /** Record a question the moment it is put to the renderer. */
  add(ask: PendingAsk): void {
    this.byReq.set(ask.reqId, ask)
  }

  /** Forget a question once it is answered, cancelled or timed out. Returns what was forgotten. */
  settle(reqId: string): PendingAsk | undefined {
    const ask = this.byReq.get(reqId)
    this.byReq.delete(reqId)
    return ask
  }

  /** Every open question, oldest first. */
  list(): PendingAsk[] {
    return [...this.byReq.values()].sort((a, b) => a.since - b.since)
  }

  /** The open question of one chat, if any — a run asks one thing at a time. */
  forChat(chatId: string): PendingAsk | undefined {
    return this.list().find((a) => a.chatId === chatId)
  }
}
