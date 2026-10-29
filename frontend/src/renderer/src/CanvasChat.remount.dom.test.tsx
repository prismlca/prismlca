import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CanvasChat from './CanvasChat'
import { renderWithPrism } from './test/render'

/**
 * Coming back to the chat. The panel exists on the Model view only: a look at the Overview during a run
 * unmounts it, and it returned blank — the opening message gone until the chat store had answered, the
 * run bar with it. It now starts from what it showed when it went (chat/shownChats.ts).
 *
 * Its own file because that memory lives in module scope, which vitest keeps per FILE.
 */
const ui = {
  jumpToProcess: vi.fn(),
  autoLayout: vi.fn(),
  screenshotRect: () => null,
  calculateInCanvas: vi.fn(),
  setupResults: vi.fn(),
  getCanvas: vi.fn(),
  clearCanvas: vi.fn(),
  removeFromCanvas: vi.fn(),
  refresh: vi.fn()
}

const PROMPT = 'Build a model of the dishwashing liquid'

describe('the chat the panel comes back to', () => {
  it('is on screen at once until the chat store has answered, in StrictMode too', async () => {
    let release = (): void => {}
    const held = new Promise<void>((r) => (release = r))
    let slow = false
    const routes = {
      'GET /api/v1/ai/chats/m': async () => {
        if (slow) await held
        return {
          chats: [
            { id: 'newer', title: 'Newer' },
            { id: 'c1', title: 'Dishwashing' }
          ]
        }
      },
      'GET /api/v1/ai/chats/m/newer': {
        id: 'newer',
        title: 'Newer',
        messages: [{ role: 'user', content: 'a newer chat' }]
      },
      'GET /api/v1/ai/chats/m/c1': {
        id: 'c1',
        title: 'Dishwashing',
        messages: [{ role: 'user', content: PROMPT }]
      }
    }
    const first = renderWithPrism(
      <CanvasChat activeDb="m" ui={ui} focusChat={{ chatId: 'c1', nonce: 1 }} />,
      {
        routes
      }
    )
    expect(await screen.findByText(PROMPT)).toBeInTheDocument()
    first.unmount()

    slow = true
    renderWithPrism(
      <StrictMode>
        <CanvasChat activeDb="m" ui={ui} />
      </StrictMode>,
      { routes }
    )
    await userEvent.click(screen.getByPlaceholderText(/Ask or instruct the assistant/))
    expect(screen.getByText(PROMPT)).toBeInTheDocument()
    // Then the store's answer takes over, by the usual rule: the newest chat of the model (listed first).
    release()
    expect(await screen.findByText('a newer chat')).toBeInTheDocument()
    expect(screen.queryByText(PROMPT)).toBeNull()
  })

  it('belongs to its model: another model starts from its own', async () => {
    renderWithPrism(<CanvasChat activeDb="other" ui={ui} />, {
      routes: { 'GET /api/v1/ai/chats/other': { chats: [] } }
    })
    await userEvent.click(screen.getByPlaceholderText(/Ask or instruct the assistant/))
    expect(screen.queryByText(PROMPT)).toBeNull()
  })

  it('shows the run bar of a chat that is running, however quickly main answers', async () => {
    const { container } = renderWithPrism(<CanvasChat activeDb="r" ui={ui} />, {
      routes: {
        'GET /api/v1/ai/chats/r': { chats: [{ id: 'r1', title: 'Running' }] },
        'GET /api/v1/ai/chats/r/r1': {
          id: 'r1',
          title: 'Running',
          messages: [{ role: 'user', content: 'go' }]
        }
      },
      overrides: { ai: { isRunning: async () => true } }
    })
    await userEvent.click(screen.getByPlaceholderText(/Ask or instruct the assistant/))
    await waitFor(() => expect(container.querySelector('.chat-runbar')).not.toBeNull())
  })

  it('does not bring back a run that ended while main was being asked', async () => {
    let answer = (_v: boolean): void => {}
    const { container, prism } = renderWithPrism(<CanvasChat activeDb="d" ui={ui} />, {
      routes: {
        'GET /api/v1/ai/chats/d': { chats: [{ id: 'd1', title: 'Done' }] },
        'GET /api/v1/ai/chats/d/d1': { id: 'd1', title: 'Done', messages: [{ role: 'user', content: 'go' }] }
      },
      overrides: { ai: { isRunning: () => new Promise<boolean>((r) => (answer = r)) } }
    })
    await userEvent.click(screen.getByPlaceholderText(/Ask or instruct the assistant/))
    expect(await screen.findByText('go')).toBeInTheDocument()
    act(() => prism.emit({ type: 'done', chatId: 'd1', text: '' }))
    await act(async () => answer(true))
    expect(container.querySelector('.chat-runbar')).toBeNull()
  })

  it('keeps what came in while main was being asked: a queue report, and a run that ended with its question', async () => {
    let answer = (): void => {}
    const held = new Promise<void>((r) => (answer = r))
    const { prism } = renderWithPrism(<CanvasChat activeDb="q" ui={ui} />, {
      routes: {
        'GET /api/v1/ai/chats/q': { chats: [{ id: 'q1', title: 'Queued' }] },
        'GET /api/v1/ai/chats/q/q1': {
          id: 'q1',
          title: 'Queued',
          messages: [{ role: 'user', content: 'go' }]
        }
      },
      overrides: {
        ai: {
          isRunning: async () => (await held, true),
          steerQueue: async () => (await held, []),
          pendingAsks: async () => (
            await held,
            [{ reqId: 'r9', chatId: 'q1', kind: 'question', args: { question: 'Which bottle size?' } }]
          )
        }
      }
    })
    await userEvent.click(screen.getByPlaceholderText(/Ask or instruct the assistant/))
    expect(await screen.findByText('go')).toBeInTheDocument()
    act(() => prism.emit({ type: 'steer', chatId: 'q1', queued: ['use the 1 L bottle too'] }))
    expect(await screen.findByText(/use the 1 L bottle too/)).toBeInTheDocument()
    act(() => prism.emit({ type: 'done', chatId: 'q1', text: '' }))
    await act(async () => answer())
    // The empty queue read before the report does not erase its chip, and the run that ended in between
    // does not come back with its expired question.
    expect(screen.getByText(/use the 1 L bottle too/)).toBeInTheDocument()
    expect(screen.queryByText('Which bottle size?')).toBeNull()
  })

  it('keeps the queued messages of the chat shown when "Go to chat" opens that same chat', async () => {
    const routes = {
      'GET /api/v1/ai/chats/s': { chats: [{ id: 's1', title: 'Same' }] },
      'GET /api/v1/ai/chats/s/s1': { id: 's1', title: 'Same', messages: [{ role: 'user', content: 'go' }] }
    }
    const { prism, rerender } = renderWithPrism(<CanvasChat activeDb="s" ui={ui} />, { routes })
    await userEvent.click(screen.getByPlaceholderText(/Ask or instruct the assistant/))
    expect(await screen.findByText('go')).toBeInTheDocument()
    act(() => prism.emit({ type: 'steer', chatId: 's1', queued: ['and the refill pouch'] }))
    expect(await screen.findByText(/and the refill pouch/)).toBeInTheDocument()
    rerender(<CanvasChat activeDb="s" ui={ui} focusChat={{ chatId: 's1', nonce: 2 }} />)
    await waitFor(() => expect(prism.calls.filter((c) => c.path === '/api/v1/ai/chats/s/s1')).toHaveLength(2))
    expect(screen.getByText(/and the refill pouch/)).toBeInTheDocument()
  })
})
