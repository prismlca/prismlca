import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHAT_TITLE_MAX, withChatTitle } from './chatTitle'

/**
 * A chat's title is stored by main, not by the chat panel: the panel exists only on the Model page,
 * and a run going on while the user was elsewhere waited out the UI timeout for its title.
 */
function setup(status = 200) {
  let path: string | null = '/api/v1/ai/chats/Bottle/chat-1'
  const window = vi.fn(async () => ({ answered: 'by the window' }))
  const request = vi.fn(async () => ({ status, body: {} }))
  const announce = vi.fn()
  const call = withChatTitle(window, { chatPath: () => path, request, announce })
  return { call, window, request, announce, movePath: (p: string | null) => (path = p) }
}

afterEach(() => vi.restoreAllMocks())

describe('withChatTitle', () => {
  it('stores the title and announces it without asking the window', async () => {
    const t = setup()
    expect(await t.call('set_chat_title', { title: '  PET bottle  ' }, { chatId: 'chat-1' })).toEqual({
      ok: true
    })
    expect(t.request).toHaveBeenCalledWith('POST', '/api/v1/ai/chats/Bottle/chat-1/rename', {
      title: 'PET bottle'
    })
    expect(t.announce).toHaveBeenCalledWith('PET bottle')
    expect(t.window).not.toHaveBeenCalled()
  })

  it("stores under the chat's path as it is at the call, after a rename of the model", async () => {
    const t = setup()
    t.movePath('/api/v1/ai/chats/Bottle%20v2/chat-1')
    await t.call('set_chat_title', { title: 'PET bottle' })
    expect(t.request).toHaveBeenCalledWith('POST', '/api/v1/ai/chats/Bottle%20v2/chat-1/rename', {
      title: 'PET bottle'
    })
  })

  it('cuts a long title to what the chat list shows', async () => {
    const t = setup()
    await t.call('set_chat_title', { title: 'x'.repeat(CHAT_TITLE_MAX + 20) })
    expect(t.request).toHaveBeenCalledWith('POST', expect.any(String), { title: 'x'.repeat(CHAT_TITLE_MAX) })
  })

  it('announces nothing when the store refused, and still answers ok', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const t = setup(404)
    expect(await t.call('set_chat_title', { title: 'PET bottle' })).toEqual({ ok: true })
    expect(t.announce).not.toHaveBeenCalled()
    expect(String(vi.mocked(console.log).mock.calls[0]?.[0])).toContain('chat title not saved (HTTP 404)')
  })

  it('stores nothing for an empty title or a run without a chat', async () => {
    const t = setup()
    await t.call('set_chat_title', { title: '   ' })
    t.movePath(null)
    await t.call('set_chat_title', { title: 'PET bottle' })
    expect(t.request).not.toHaveBeenCalled()
    expect(t.announce).not.toHaveBeenCalled()
  })

  it('lets Stop end the wait for a store that does not answer, and announces nothing', async () => {
    const window = vi.fn()
    const announce = vi.fn()
    const call = withChatTitle(window, {
      chatPath: () => '/api/v1/ai/chats/Bottle/chat-1',
      request: () => new Promise(() => {}),
      announce
    })
    const stop = new AbortController()
    const pending = call('set_chat_title', { title: 'PET bottle' }, { signal: stop.signal })
    stop.abort()
    await expect(pending).rejects.toThrow('Canceled.')
    await expect(call('set_chat_title', { title: 'PET bottle' }, { signal: stop.signal })).rejects.toThrow(
      'Canceled.'
    )
    expect(announce).not.toHaveBeenCalled()
  })

  it('goes on without the title when the store does not answer in time', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const announce = vi.fn()
    const call = withChatTitle(vi.fn(), {
      chatPath: () => '/api/v1/ai/chats/Bottle/chat-1',
      request: () => new Promise(() => {}),
      announce,
      timeoutMs: 20
    })
    expect(await call('set_chat_title', { title: 'PET bottle' })).toEqual({ ok: true })
    expect(announce).not.toHaveBeenCalled()
    expect(String(vi.mocked(console.log).mock.calls[0]?.[0])).toContain(
      'chat title not saved (no answer in 20 ms)'
    )
  })

  it('passes every other UI call on to the window unchanged', async () => {
    const t = setup()
    const opts = { chatId: 'chat-1', activeDb: 'Bottle' }
    expect(await t.call('ask_user', { question: 'Which PET?' }, opts)).toEqual({ answered: 'by the window' })
    expect(t.window).toHaveBeenCalledWith('ask_user', { question: 'Which PET?' }, opts)
    expect(t.request).not.toHaveBeenCalled()
  })
})
