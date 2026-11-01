import { describe, expect, it } from 'vitest'
import { ROUTING_SESSION_IDLE_MS, routingSession } from './routingSession'

/**
 * The routing key pins a conversation to one provider while its cache can be warm, and no longer: it is
 * random, per conversation, and replaced after an hour without a request.
 */
describe('routingSession', () => {
  it('keeps one key per conversation while it is in use', () => {
    const t = 1_000_000
    const a = routingSession('chat:one', t)
    expect(routingSession('chat:one', t + 50 * 60_000)).toBe(a)
    // Each request renews the hour: a chat in steady use keeps its key.
    expect(routingSession('chat:one', t + 100 * 60_000)).toBe(a)
  })

  it('gives every conversation its own random key', () => {
    const t = 2_000_000
    const a = routingSession('writer:/r/1/sections/a', t)
    const b = routingSession('writer:/r/1/sections/b', t)
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f-]{36}$/) // a UUID, nothing derived from the name, the machine or the user
  })

  it('replaces the key of a conversation idle for more than an hour', () => {
    const t = 3_000_000
    const first = routingSession('chat:later', t)
    expect(routingSession('chat:later', t + ROUTING_SESSION_IDLE_MS + 1)).not.toBe(first)
  })
})
