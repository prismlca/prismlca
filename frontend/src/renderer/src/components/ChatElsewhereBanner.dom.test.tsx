import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithPrism } from '../test/render'
import { noteChatModel, resetChatNotices, setVisibleChat } from '../lib/chatNotices'
import ChatElsewhereBanner from './ChatElsewhereBanner'

afterEach(() => act(() => resetChatNotices()))

describe('ChatElsewhereBanner', () => {
  it('shows nothing until a chat out of sight ends a turn', () => {
    const { prism } = renderWithPrism(<ChatElsewhereBanner onOpen={() => {}} />)
    expect(screen.queryByRole('status')).toBeNull()
    act(() => setVisibleChat('c1'))
    act(() => prism.emit({ chatId: 'c1', type: 'done', text: 'Seen already' }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('one row per chat, newest first, naming the model and the start of the answer', () => {
    noteChatModel('c1', 'pet-bottle')
    noteChatModel('c2', 'hose-cart')
    const { prism } = renderWithPrism(<ChatElsewhereBanner onOpen={() => {}} />)
    act(() => prism.emit({ chatId: 'c1', type: 'done', text: 'The bottle model is complete.' }))
    act(() => prism.emit({ chatId: 'c2', type: 'error', message: 'Provider timed out' }))
    const rows = screen.getByRole('status').children
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Assistant failed in “hose-cart” — Provider timed out')
    expect(rows[1]).toHaveTextContent('Assistant finished in “pet-bottle” — The bottle model is complete.')
  })

  it('Open hands over model and chat and removes the row; ✕ only removes it', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    noteChatModel('c1', 'pet-bottle')
    const { prism } = renderWithPrism(<ChatElsewhereBanner onOpen={onOpen} />)
    act(() => prism.emit({ chatId: 'c1', type: 'done', text: 'Done' }))
    act(() => prism.emit({ chatId: 'c2', type: 'done', text: 'Other' }))
    // c2's model was never learnt: no way to open it, only to dismiss.
    expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'c1', database: 'pet-bottle' }))
    expect(screen.getByRole('status')).toHaveTextContent('Assistant finished in another chat — Other')
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('the row goes when the user reaches that chat by other means', () => {
    noteChatModel('c1', 'pet-bottle')
    const { prism } = renderWithPrism(<ChatElsewhereBanner onOpen={() => {}} />)
    act(() => prism.emit({ chatId: 'c1', type: 'done', text: 'Done' }))
    expect(screen.getByRole('status')).toBeInTheDocument()
    act(() => setVisibleChat('c1'))
    expect(screen.queryByRole('status')).toBeNull()
  })
})
