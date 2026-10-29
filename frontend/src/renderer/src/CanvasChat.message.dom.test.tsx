import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MessageRow } from './CanvasChat'
import type { AttachmentMeta } from '../../shared/ipc'

/**
 * The transcript row, after it was lifted out of `messages.map` and memoised.
 *
 * The chat's own tests all render an EMPTY conversation, so nothing here was covered: a move of this
 * markup could have dropped the attachment row or the process links and every test would still have
 * passed. What the rail of assertions below protects is the markup, plus the one property the move
 * was made for — that an unchanged message is not re-rendered, and with it not re-parsed, when the
 * panel renders for a reason of its own.
 */
const LABELS = { calculate: 'Calculate impact score' }
const ATTACH: AttachmentMeta = {
  id: 'a1',
  name: 'datasheet.pdf',
  kind: 'pdf',
  bytes: 4096,
  pages: 3
}

describe('a transcript row', () => {
  it('renders a user message as plain text, without running it through Markdown', () => {
    render(
      <MessageRow
        m={{ role: 'user', content: 'Use **grid mix** for the electricity' }}
        labels={LABELS}
        onJump={vi.fn()}
        onReveal={vi.fn()}
      />
    )
    // The asterisks stay: a user's own words are not the model's Markdown.
    expect(screen.getByText(/Use \*\*grid mix\*\* for the electricity/)).toBeInTheDocument()
  })

  it('renders an assistant message as Markdown, GFM tables included', () => {
    const md = '## Result\n\n| Stage | GWP |\n| --- | --- |\n| Use | 12 |\n'
    render(
      <MessageRow
        m={{ role: 'assistant', content: md }}
        labels={LABELS}
        onJump={vi.fn()}
        onReveal={vi.fn()}
      />
    )
    expect(screen.getByRole('heading', { name: 'Result' })).toBeInTheDocument()
    // The table proves remarkGfm is still wired up — it moved to a module constant in the same edit.
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '12' })).toBeInTheDocument()
  })

  it('turns a prism:process link into a jump button and calls back with the decoded code', async () => {
    const onJump = vi.fn()
    render(
      <MessageRow
        m={{ role: 'assistant', content: 'See [the mix](prism:process/market%20for%20electricity).' }}
        labels={LABELS}
        onJump={onJump}
        onReveal={vi.fn()}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /the mix/ }))
    expect(onJump).toHaveBeenCalledWith('market for electricity')
  })

  it('jumps from the keyboard too, and keeps the arrow on the last word of the name', async () => {
    const onJump = vi.fn()
    render(
      <MessageRow
        m={{ role: 'assistant', content: 'See [steel sheet, cold rolled](prism:process/abc) first.' }}
        labels={LABELS}
        onJump={onJump}
        onReveal={vi.fn()}
      />
    )
    const link = screen.getByRole('button', { name: 'steel sheet, cold rolled' })
    // An inline span, so a long name wraps like the prose around it — a <button> cannot.
    expect(link.tagName).toBe('SPAN')
    expect(link.querySelector('.chat-proclink-tail')?.textContent).toBe('rolled')
    link.focus()
    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard(' ')
    expect(onJump).toHaveBeenCalledTimes(2)
    expect(onJump).toHaveBeenLastCalledWith('abc')
  })

  it('survives a broken escape in a process link instead of taking the window down', () => {
    // The text being decoded is written by a MODEL, and '%E9' is not valid UTF-8, so
    // decodeURIComponent throws. There is no error boundary around the chat, and chats are persisted
    // and replayed — an unguarded decode would have killed the workbench on every reopen of the
    // affected chat. Found when the link path was made reachable.
    render(
      <MessageRow
        m={{ role: 'assistant', content: 'See [the mix](prism:process/%E9) and the rest.' }}
        labels={LABELS}
        onJump={vi.fn()}
        onReveal={vi.fn()}
      />
    )
    // The words survive, the link does not, and everything after it is still on screen.
    expect(screen.getByText(/the mix/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText(/and the rest/)).toBeInTheDocument()
  })

  it('shows the files that travelled with the turn, and opens them two ways', async () => {
    const onReveal = vi.fn()
    render(
      <MessageRow
        m={{
          role: 'user',
          content: 'Here is the datasheet',
          attachments: [ATTACH]
        }}
        labels={LABELS}
        onJump={vi.fn()}
        onReveal={onReveal}
      />
    )
    // The accessible name comes from the button's own text, not its title attribute.
    await userEvent.click(screen.getByRole('button', { name: /datasheet\.pdf/ }))
    expect(onReveal).toHaveBeenLastCalledWith(ATTACH, false)
    await userEvent.click(screen.getByRole('button', { name: /sources folder/ }))
    expect(onReveal).toHaveBeenLastCalledWith(ATTACH, true)
  })

  it('keeps the folded tool summary of a finished turn', () => {
    render(
      <MessageRow
        m={{
          role: 'assistant',
          content: 'Done.',
          // Two, because one call is shown in full — the fold starts at the second (ToolTraceList).
          tools: [
            { name: 'calculate', status: 'ok', ms: 100 },
            { name: 'calculate', status: 'ok', ms: 200 }
          ]
        }}
        labels={LABELS}
        onJump={vi.fn()}
        onReveal={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: /2 tool calls/ })).toBeInTheDocument()
  })

  it('is memoised — the whole point of lifting it out of the map', () => {
    // Structural, deliberately: what this guards against is somebody unwrapping the memo() while
    // tidying, which no behavioural assertion would notice and which would quietly put every
    // message's Markdown back through the parser on each render of the panel.
    expect((MessageRow as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'))
  })
})
