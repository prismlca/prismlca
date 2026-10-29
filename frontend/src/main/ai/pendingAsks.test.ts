import { describe, expect, it } from 'vitest'
import { PendingAsks } from './pendingAsks'

const ask = (reqId: string, chatId: string, since: number) => ({
  reqId,
  chatId,
  database: 'pet',
  args: { questions: [{ question: 'Which?', options: ['a', 'b'] }] },
  since
})

describe('the record of questions the assistant is waiting on', () => {
  it('keeps a question from the moment it is asked until it is settled', () => {
    const p = new PendingAsks()
    p.add(ask('u1', 'chat-a', 10))
    expect(p.list()).toHaveLength(1)
    expect(p.forChat('chat-a')?.reqId).toBe('u1')
    expect(p.forChat('chat-b')).toBeUndefined()

    expect(p.settle('u1')?.chatId).toBe('chat-a')
    expect(p.list()).toEqual([])
    // Settling twice — main's abort listener and the renderer's answer both try — is harmless.
    expect(p.settle('u1')).toBeUndefined()
  })

  it('lists oldest first, across chats', () => {
    const p = new PendingAsks()
    p.add(ask('u2', 'chat-b', 20))
    p.add(ask('u1', 'chat-a', 10))
    expect(p.list().map((a) => a.reqId)).toEqual(['u1', 'u2'])
  })
})
