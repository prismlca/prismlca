import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageRow } from './MessageRow'
import { RunStatus } from './RunStatus'
import { emptyTurn } from './turnView'

/** What the chat shows of a run's trouble: the cache warning while it runs, the error after a reload. */
describe('the run bar', () => {
  it("says once that the provider's prompt cache stopped working, with the reason on hover", () => {
    render(<RunStatus turn={{ ...emptyTurn(0), cacheWarning: 'dropped' }} labels={{}} />)
    const note = screen.getByText(/prompt cache is not working — rounds are billed in full/)
    expect(note.getAttribute('title')).toMatch(/billed at the full input price/)
  })

  it('says when the cache works again after it failed, still with the cost on hover', () => {
    render(<RunStatus turn={{ ...emptyTurn(0), cacheWarning: 'dropped-recovered' }} labels={{}} />)
    const note = screen.getByText(/prompt cache dropped out — working again/)
    expect(note.getAttribute('title')).toMatch(/billed at the full input price/)
  })

  it('says nothing about the cache while it works', () => {
    render(<RunStatus turn={emptyTurn(0)} labels={{}} />)
    expect(screen.queryByText(/prompt cache/)).toBeNull()
  })
})

describe('a stored answer of a failed run', () => {
  it('shows why it failed', () => {
    render(
      <MessageRow
        m={{ role: 'assistant', content: '', outcome: 'error', error: 'HTTP 404 — No endpoints found.' }}
        labels={{}}
        onJump={vi.fn()}
        onReveal={vi.fn()}
      />
    )
    expect(screen.getByText('Error: HTTP 404 — No endpoints found.')).toBeInTheDocument()
  })
})
