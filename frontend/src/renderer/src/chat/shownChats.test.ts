import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../lib/ai'
import { withLiveTail } from './shownChats'

const user: ChatMessage = { role: 'user', content: 'Build the model' }
const answer: ChatMessage = { role: 'assistant', content: 'Done.', turn_id: 't1' }

describe('the store’s copy of a chat shown from memory', () => {
  it('keeps a turn that ended live while the store was answering', () => {
    const base = [user]
    expect(withLiveTail([user], [user, answer], base)).toEqual([user, answer])
  })

  it('does not repeat what the store already has saved of it', () => {
    const stored = [user, answer]
    expect(withLiveTail(stored, [user, answer], [user])).toBe(stored)
    // Saved in part: the answer is there, the follow-up typed after it not yet.
    const next: ChatMessage = { role: 'user', content: 'continue' }
    expect(withLiveTail([user, answer], [user, answer, next], [user])).toEqual([user, answer, next])
  })

  it('keeps a message repeated word for word — the same words earlier are another message', () => {
    const again: ChatMessage = { role: 'user', content: 'continue' }
    const base = [user, again, answer]
    const live: ChatMessage = { role: 'user', content: 'continue' }
    expect(withLiveTail(base, [...base, live], base)).toEqual([...base, live])
    // Nor does the last remembered message count as the store having the new one.
    expect(withLiveTail([user, again], [user, again, live], [user, again])).toEqual([user, again, live])
  })

  it('takes the store’s copy whole when the panel was not merely added to', () => {
    const other: ChatMessage = { role: 'user', content: 'another chat' }
    expect(withLiveTail([user], [other], [user])).toEqual([user])
    expect(withLiveTail([user, answer], [user], [user])).toEqual([user, answer])
  })
})
