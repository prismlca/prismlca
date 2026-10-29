import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithPrism } from '../test/render'
import type { PendingAsk } from '../lib/ai'
import type { McpSessionSnapshot } from '../lib/mcp'
import ExternalAgentsPanel from './ExternalAgentsPanel'

const session: McpSessionSnapshot = {
  id: 's1',
  project: 'proj-A',
  clientName: 'Claude Code',
  clientVersion: '2.1',
  startedAt: Date.now() - 60_000,
  lastSeen: Date.now(),
  activeDb: 'Shampoo',
  approval: 'irreversible',
  calls: 2,
  recent: [
    { n: 1, tool: 'orientation', args: '{}', ok: true, ms: 12, at: Date.now(), effect: 'read' },
    {
      n: 2,
      tool: 'edit_process',
      args: '{"code":"p1"}',
      ok: false,
      error: 'No such process.',
      ms: 30,
      at: Date.now(),
      effect: 'write'
    }
  ]
}

const approval: PendingAsk = {
  reqId: 'ui7',
  chatId: '',
  database: 'Shampoo',
  since: Date.now(),
  origin: 'mcp',
  sessionId: 's1',
  clientName: 'Claude Code',
  kind: 'approval',
  args: { tool: 'history', effect: 'irreversible', args: { action: 'undo' }, database: 'Shampoo' }
}

const question: PendingAsk = {
  reqId: 'ui8',
  chatId: '',
  database: 'Shampoo',
  since: Date.now(),
  origin: 'mcp',
  sessionId: 's1',
  clientName: 'Claude Code',
  args: { question: 'Which functional unit?', options: [{ label: '1 l' }, { label: '1 kg' }] }
}

describe('ExternalAgentsPanel', () => {
  it('shows the session, its calls, and resolves an approval card', async () => {
    const user = userEvent.setup()
    const uiResult = vi.fn()
    const setApproval = vi.fn(async () => true)
    const disconnect = vi.fn(async () => true)
    renderWithPrism(
      <ExternalAgentsPanel sessions={[session]} asks={[approval]} running onClose={() => {}} />,
      { overrides: { ai: { uiResult }, mcp: { setApproval, disconnect } } }
    )
    const dialog = screen.getByRole('dialog', { name: 'External agents' })
    expect(dialog).toHaveTextContent('Claude Code 2.1')
    expect(dialog).toHaveTextContent('model Shampoo')
    expect(dialog).toHaveTextContent('No such process.')
    // The card names the tool and says it cannot be undone; Allow answers main's request.
    const card = screen.getByRole('group', { name: 'Approval request from an external agent' })
    expect(card).toHaveTextContent('history')
    expect(card).toHaveTextContent('cannot be undone')
    await user.click(screen.getByRole('button', { name: 'Allow' }))
    expect(uiResult).toHaveBeenCalledWith('ui7', true, { approved: true }, undefined)
    // The approval mode is a per-session choice, sent to main on change.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Approval mode' }), 'every-write')
    expect(setApproval).toHaveBeenCalledWith('s1', 'every-write')
    await user.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(disconnect).toHaveBeenCalledWith('s1')
  })

  it('answers a question card with the picked option, or a typed answer', async () => {
    const user = userEvent.setup()
    const uiResult = vi.fn()
    const onClose = vi.fn()
    renderWithPrism(
      <ExternalAgentsPanel sessions={[session]} asks={[question]} running onClose={onClose} />,
      {
        overrides: { ai: { uiResult } }
      }
    )
    const answer = screen.getByRole('button', { name: 'Answer' })
    expect(answer).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '1 kg' }))
    await user.click(answer)
    expect(uiResult).toHaveBeenCalledWith('ui8', true, { answers: [['1 kg']], freeText: [false] }, undefined)
    // The own answer is one per question, closed until asked for, as on the chat's card.
    expect(screen.queryByRole('textbox')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Something else…' }))
    await user.type(screen.getByRole('textbox'), '0.5 l{Enter}')
    expect(uiResult).toHaveBeenLastCalledWith(
      'ui8',
      true,
      { answers: [['0.5 l']], freeText: [true] },
      undefined
    )
    // Escape closes the field, not the drawer around it.
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('says what to do when nothing is connected', () => {
    renderWithPrism(<ExternalAgentsPanel sessions={[]} asks={[]} running={false} onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'External agents' })).toHaveTextContent('Settings → AI → MCP')
  })

  it('says the window was started by the bridge while nobody has claimed it', async () => {
    const { prism } = renderWithPrism(
      <ExternalAgentsPanel sessions={[]} asks={[]} running onClose={() => {}} />,
      {
        overrides: {
          launch: { state: async () => ({ launchedBy: 'bridge', claimed: false, idleMinutes: 10 }) }
        }
      }
    )
    const dialog = screen.getByRole('dialog', { name: 'External agents' })
    expect(
      await screen.findByText(
        'Started by the bridge · quits after 10 idle minutes unless someone uses this window'
      )
    ).toBeInTheDocument()
    act(() => prism.emitBridgeState({ launchedBy: 'bridge', claimed: true, idleMinutes: 10 }))
    expect(dialog).not.toHaveTextContent('Started by the bridge')
  })

  it('has no bridge line when a person started the app', async () => {
    renderWithPrism(<ExternalAgentsPanel sessions={[]} asks={[]} running onClose={() => {}} />)
    await act(async () => undefined)
    expect(screen.getByRole('dialog', { name: 'External agents' })).not.toHaveTextContent(
      'Started by the bridge'
    )
  })
})
