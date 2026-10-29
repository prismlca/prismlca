import { describe, expect, it } from 'vitest'

import { activeWork } from './activeWork'

describe('activeWork', () => {
  it('names chat runs, writer calls and import matching', () => {
    expect(activeWork([], [], false)).toEqual([])
    expect(activeWork(['chat-1', 'report:ai:7f3a'], [], true)).toEqual([
      'an assistant run',
      'the report writer',
      'the assistant matching an import'
    ])
  })

  it('a chat waiting on the user does not count — with its legs — but other chats still do', () => {
    expect(activeWork(['chat-1', 'chat-1:research'], ['chat-1'], false)).toEqual([])
    expect(activeWork(['chat-1', 'chat-2'], ['chat-1'], false)).toEqual(['an assistant run'])
    expect(activeWork(['chat-1', 'report:ai:7f3a'], ['chat-1'], false)).toEqual(['the report writer'])
  })

  it("an external session's question (empty chat id) pauses no chat", () => {
    expect(activeWork(['chat-1'], [''], false)).toEqual(['an assistant run'])
  })

  it('a chat whose id is a prefix of another is not paused by it', () => {
    expect(activeWork(['chat-10'], ['chat-1'], false)).toEqual(['an assistant run'])
  })
})
