import { afterEach, describe, expect, it } from 'vitest'
import type { AiEvent } from './ai'
import {
  chatNotices,
  dismissChatNotice,
  excerptOf,
  handleChatEvent,
  noteChatModel,
  resetChatNotices,
  setVisibleChat
} from './chatNotices'

const done = (chatId: string, text = 'Done.'): AiEvent => ({ chatId, type: 'done', text })

afterEach(resetChatNotices)

describe('chatNotices', () => {
  it('keeps one notice per chat, newest first, with the model learnt from the panel or the events', () => {
    noteChatModel('a', 'pet-bottle')
    handleChatEvent({ chatId: 'b', type: 'refresh', database: 'hose-cart' })
    handleChatEvent(done('a', 'First answer'), 1)
    handleChatEvent({ chatId: 'b', type: 'error', message: 'Provider timed out' }, 2)
    handleChatEvent(done('a', 'Second answer'), 3)
    expect(chatNotices().map((n) => [n.chatId, n.database, n.kind, n.excerpt])).toEqual([
      ['a', 'pet-bottle', 'done', 'Second answer'],
      ['b', 'hose-cart', 'error', 'Provider timed out']
    ])
  })

  it('takes the model from a question, and says null when it was never learnt', () => {
    handleChatEvent({
      chatId: 'q',
      type: 'ask',
      ask: { reqId: 'r', chatId: 'q', database: 'steel-bottle', args: {}, since: 1 }
    } as AiEvent)
    handleChatEvent(done('q'))
    handleChatEvent(done('unknown'))
    expect(chatNotices().map((n) => [n.chatId, n.database])).toEqual([
      ['unknown', null],
      ['q', 'steel-bottle']
    ])
  })

  it('leaves the chat on screen alone, and reaching a chat clears its notice', () => {
    setVisibleChat('a')
    handleChatEvent(done('a'))
    expect(chatNotices()).toEqual([])
    setVisibleChat(null)
    handleChatEvent(done('a'))
    handleChatEvent(done('b'))
    expect(chatNotices()).toHaveLength(2)
    setVisibleChat('a')
    expect(chatNotices().map((n) => n.chatId)).toEqual(['b'])
    dismissChatNotice('b')
    expect(chatNotices()).toEqual([])
  })

  it('ignores the events that do not end a turn', () => {
    handleChatEvent({ chatId: 'a', type: 'delta', text: 'partial' })
    expect(chatNotices()).toEqual([])
  })

  it('cuts the excerpt to one line of about 80 characters', () => {
    expect(excerptOf('  Two\n\nlines  ')).toBe('Two lines')
    const cut = excerptOf('x'.repeat(200))
    expect(cut).toHaveLength(80)
    expect(cut.endsWith('…')).toBe(true)
  })
})
