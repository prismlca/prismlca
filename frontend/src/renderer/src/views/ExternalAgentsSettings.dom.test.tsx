import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithPrism } from '../test/render'
import ExternalAgentsSettings from './ExternalAgentsSettings'

const running = { enabled: true, running: true, url: 'http://127.0.0.1:4321/mcp', token: 't', sessions: [] }
const clients = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    configHint: '~/.claude.json (user scope)',
    configPath: '/home/u/.claude.json',
    exists: true,
    configured: false,
    snippet: 'claude mcp add --scope user prismlca -- /opt/PrismLCA/prismlca --mcp-proxy',
    proposed: '{\n  "mcpServers": {\n    "prismlca": {}\n  }\n}\n'
  },
  {
    id: 'codex',
    label: 'Codex (CLI and app)',
    configHint: '~/.codex/config.toml',
    configPath: '/home/u/.codex/config.toml',
    exists: false,
    configured: false,
    snippet: '[mcp_servers.prismlca]\ncommand = "/opt/PrismLCA/prismlca"',
    proposed: '[mcp_servers.prismlca]\ncommand = "/opt/PrismLCA/prismlca"\n'
  }
]

describe('ExternalAgentsSettings', () => {
  it('shows the clients while the server is on, previews a change, and writes it on click', async () => {
    const user = userEvent.setup()
    const configureClient = vi.fn(async () => ({
      ok: true,
      path: '/home/u/.claude.json',
      backup: '/home/u/.claude.json.bak-1'
    }))
    const testConnection = vi.fn(async () => ({ ok: true, tools: 49, version: '0.8.0', ms: 812 }))
    renderWithPrism(<ExternalAgentsSettings />, {
      overrides: {
        mcp: { status: async () => running, clients: async () => clients, configureClient, testConnection }
      }
    })
    expect(await screen.findByText(/Listening on http:\/\/127\.0\.0\.1:4321\/mcp/)).toBeInTheDocument()
    expect(await screen.findByText('Claude Code')).toBeInTheDocument()
    // Nothing is written before the preview has been shown and confirmed.
    await user.click(screen.getAllByRole('button', { name: 'Configure…' })[0])
    expect(screen.getByLabelText('Claude Code proposed configuration')).toHaveTextContent('"prismlca"')
    // Every code box carries its own Copy all, top right.
    expect(screen.getAllByRole('button', { name: 'Copy all' }).length).toBeGreaterThan(0)
    expect(configureClient).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Write to Claude Code’s configuration' }))
    expect(configureClient).toHaveBeenCalledWith('claude-code')
    expect(await screen.findByText(/Written to \/home\/u\/\.claude\.json \(backup:/)).toBeInTheDocument()
    // The connection test reports what the bridge answered.
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(await screen.findByRole('status')).toHaveTextContent('49 tools, PrismLCA 0.8.0, 812 ms')
    expect(testConnection).toHaveBeenCalled()
  })

  it('hides the client list while the server is off', async () => {
    renderWithPrism(<ExternalAgentsSettings />, {
      overrides: {
        mcp: {
          status: async () => ({ ...running, enabled: false, running: false }),
          clients: async () => clients
        }
      }
    })
    expect(await screen.findByRole('checkbox')).not.toBeChecked()
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument()
  })
})
