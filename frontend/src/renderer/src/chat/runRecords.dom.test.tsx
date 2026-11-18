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

  it('says a single missed round as one round, and a partial hit as part of the prompt', () => {
    render(<RunStatus turn={{ ...emptyTurn(0), cacheWarning: 'missed' }} labels={{}} />)
    expect(screen.getByText(/a round missed the prompt cache — billed in full/)).toBeTruthy()
    expect(screen.queryByText(/not working/)).toBeNull()
    render(<RunStatus turn={{ ...emptyTurn(0), cacheWarning: 'partial' }} labels={{}} />)
    const note = screen.getByText(/a round got only part of the prompt from the cache/)
    expect(note.getAttribute('title')).toMatch(/older state of the conversation/)
  })

  it('names the step clock, and shows the run clock from the run record — a reload keeps it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-14T18:10:05Z'))
    const run = { runId: 'r1', state: 'running' as const, startedAt: '2026-11-14T18:05:00Z' }
    const { container } = render(
      <RunStatus turn={{ ...emptyTurn(Date.now() - 12_000), runId: 'r1' }} labels={{}} run={run} />
    )
    expect(container.querySelector('.chat-trace-ms')!.getAttribute('title')).toBe('time in this step')
    expect(screen.getByText('run 5:05').getAttribute('title')).toBe('time since the run started')
    // A view assembled after a reload names no run: the record still times it.
    render(
      <RunStatus
        turn={emptyTurn(Date.now())}
        labels={{}}
        run={{ ...run, startedAt: '2026-11-14T17:00:00Z' }}
      />
    )
    expect(screen.getByText('run 1:10:05')).toBeTruthy()
    vi.useRealTimers()
  })

  it('shows no run clock for a send whose run has not reported, nor for another or a finished run', () => {
    const run = { runId: 'r1', state: 'running' as const, startedAt: '2026-11-14T18:05:00Z' }
    render(<RunStatus turn={{ ...emptyTurn(0), runId: null }} labels={{}} run={run} />)
    render(<RunStatus turn={{ ...emptyTurn(0), runId: 'r2' }} labels={{}} run={run} />)
    render(<RunStatus turn={emptyTurn(0)} labels={{}} run={{ ...run, state: 'stopped' }} />)
    render(<RunStatus turn={emptyTurn(0)} labels={{}} />)
    expect(screen.queryByText(/^run /)).toBeNull()
  })

  it('says when the cache works again after it failed, still with the cost on hover', () => {
    render(<RunStatus turn={{ ...emptyTurn(0), cacheWarning: 'dropped-recovered' }} labels={{}} />)
    const note = screen.getByText(/prompt cache dropped out — working again/)
    expect(note.getAttribute('title')).toMatch(/billed at the full input price/)
  })

  it('shows what the research agents have billed so far, once they have billed anything', () => {
    render(<RunStatus turn={{ ...emptyTurn(0), researchCost: 1.3396 }} labels={{}} />)
    const note = screen.getByText('research $1.34')
    expect(note.getAttribute('title')).toMatch(/Settings → AI → Limits/)
  })

  it('says nothing about research in a run without it', () => {
    render(<RunStatus turn={emptyTurn(0)} labels={{}} />)
    expect(screen.queryByText(/research/)).toBeNull()
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
