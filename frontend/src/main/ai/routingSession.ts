/**
 * The routing key that keeps one conversation with one provider (OpenRouter `session_id`).
 *
 * OpenRouter spreads the requests for a model over several providers, and each provider keeps its own
 * prompt cache. A round that lands somewhere else pays its whole prompt again. In report runs, GLM 5.3
 * moved between four providers inside single chapters. Without a key, OpenRouter groups the requests of
 * a conversation itself, by hashing its opening messages, but only once it has seen a cache hit. The
 * key does the same from the first request on.
 *
 * The key is random and lives in memory only. It names one conversation (a chat, or one report chapter's
 * writer or reader) for as long as its cache can be warm, never a person, an installation or a device.
 * A conversation idle for an hour gets a new key, and nothing survives a restart, so a chat continued a
 * week later starts with a key it never had before.
 */
import { randomUUID } from 'node:crypto'

/** How long a conversation keeps its key without a request. Longer than any provider's cache lives. */
export const ROUTING_SESSION_IDLE_MS = 60 * 60 * 1000

const sessions = new Map<string, { id: string; used: number }>()

/** The routing key of a conversation, new after an hour without a request. `now` is for the tests. */
export function routingSession(conversation: string, now = Date.now()): string {
  for (const [name, s] of sessions) if (now - s.used > ROUTING_SESSION_IDLE_MS) sessions.delete(name)
  const session = sessions.get(conversation) ?? { id: randomUUID(), used: now }
  session.used = now
  sessions.set(conversation, session)
  return session.id
}
