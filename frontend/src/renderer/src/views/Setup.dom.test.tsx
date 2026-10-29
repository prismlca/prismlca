/**
 * The first-run wizard asks for a workspace name (proposing "Main") while the user still stands in
 * Brightway's empty `default`, creates it before the import starts, and asks nothing once a
 * workspace of their own is active.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Setup from './Setup'
import { renderWithPrism } from '../test/render'
import type { ReactElement } from 'react'

const RUNNING = { state: 'running', step: 'starting', detail: '', progress: 0 }

/** The wizard with a backend that accepts the import and a folder picker that answers at once. */
const mount = (ui: ReactElement) =>
  renderWithPrism(ui, {
    routes: { 'POST /api/v1/setup/background': RUNNING, 'GET /api/v1/setup/status': RUNNING },
    overrides: { bridge: { pickDirectory: async () => '/data/datasets' } }
  })

describe('Setup wizard: the workspace name', () => {
  it('proposes "Main" in default and creates that workspace before the import starts', async () => {
    const created: string[] = []
    const { prism } = mount(
      <Setup
        project="default"
        workspaceEmpty
        onCreateWorkspace={async (name) => {
          created.push(name)
        }}
        onDone={() => {}}
      />
    )
    const field = screen.getByRole('textbox', { name: 'Workspace name' })
    expect(field).toHaveValue('Main')
    await userEvent.clear(field)
    await userEvent.type(field, 'Packaging 2026')
    await userEvent.click(screen.getByRole('button', { name: /choose folder/i }))
    await userEvent.click(screen.getByRole('button', { name: /start import/i }))
    await waitFor(() => expect(prism.calls.some((c) => c.path === '/api/v1/setup/background')).toBe(true))
    expect(created).toEqual(['Packaging 2026'])
  })

  it('leaves the user in default when the field is emptied', async () => {
    const onCreateWorkspace = vi.fn(async () => {})
    const { prism } = mount(
      <Setup project="default" workspaceEmpty onCreateWorkspace={onCreateWorkspace} onDone={() => {}} />
    )
    await userEvent.clear(screen.getByRole('textbox', { name: 'Workspace name' }))
    await userEvent.click(screen.getByRole('button', { name: /choose folder/i }))
    await userEvent.click(screen.getByRole('button', { name: /start import/i }))
    await waitFor(() => expect(prism.calls.some((c) => c.path === '/api/v1/setup/background')).toBe(true))
    expect(onCreateWorkspace).not.toHaveBeenCalled()
  })

  it('asks nothing once the user stands in a workspace of their own', () => {
    mount(<Setup project="Main" workspaceEmpty onCreateWorkspace={async () => {}} onDone={() => {}} />)
    expect(screen.queryByRole('textbox', { name: 'Workspace name' })).toBeNull()
  })

  it('asks nothing in a populated default: a second background joins the first', () => {
    mount(
      <Setup project="default" workspaceEmpty={false} onCreateWorkspace={async () => {}} onDone={() => {}} />
    )
    expect(screen.queryByRole('textbox', { name: 'Workspace name' })).toBeNull()
  })

  it('creates the workspace once even when Start is clicked twice while it is pending', async () => {
    let release: () => void = () => {}
    const created: string[] = []
    const onCreateWorkspace = async (name: string): Promise<void> => {
      created.push(name)
      await new Promise<void>((r) => {
        release = r
      })
    }
    const { prism } = mount(
      <Setup project="default" workspaceEmpty onCreateWorkspace={onCreateWorkspace} onDone={() => {}} />
    )
    await userEvent.click(screen.getByRole('button', { name: /choose folder/i }))
    const start = screen.getByRole('button', { name: /start import/i })
    await userEvent.click(start)
    expect(screen.getByRole('button', { name: /importing/i })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Workspace name' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: /importing/i }))
    release()
    await waitFor(() =>
      expect(prism.calls.filter((c) => c.path === '/api/v1/setup/background')).toHaveLength(1)
    )
    expect(created).toEqual(['Main'])
  })
})

/** A finished import with whatever the workspace holds afterwards. */
const finished = (background: { name: string; provider: string }[]) =>
  renderWithPrism(<></>, {
    routes: {
      'POST /api/v1/setup/background': RUNNING,
      'GET /api/v1/setup/status': {
        state: 'done',
        step: 'finished',
        detail: '',
        progress: 1,
        database: background[0].name
      },
      'GET /api/v1/setup/background': {
        background: background.map((b) => ({ ...b, activities: 1, label: b.name, version: '' }))
      }
    },
    overrides: { bridge: { pickDirectory: async () => '/data/release' } }
  })

describe('Setup wizard: after the import', () => {
  it('offers the other database and Start, which goes on to the app', async () => {
    const onAlsoImport = vi.fn()
    const onDone = vi.fn()
    const { rerender } = finished([{ name: 'ecoinvent-3.12-cutoff', provider: 'ecoinvent' }])
    rerender(<Setup project="Main" onAlsoImport={onAlsoImport} onDone={onDone} />)
    await userEvent.click(screen.getByRole('button', { name: /choose folder/i }))
    await userEvent.click(screen.getByRole('button', { name: /start import/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Also import BAFU…' }))
    expect(onAlsoImport).toHaveBeenCalledWith('bafu')
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('offers ecoinvent after BAFU', async () => {
    const { rerender } = finished([{ name: 'bafu-2026-v1', provider: 'bafu' }])
    rerender(<Setup project="Main" source="bafu" onAlsoImport={() => {}} onDone={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /choose folder/i }))
    await userEvent.click(screen.getByRole('button', { name: /start import/i }))
    expect(await screen.findByRole('button', { name: 'Also import ecoinvent…' })).toBeTruthy()
  })

  it('offers nothing more once both databases are there', async () => {
    const { rerender } = finished([
      { name: 'ecoinvent-3.12-cutoff', provider: 'ecoinvent' },
      { name: 'bafu-2026-v1', provider: 'bafu' }
    ])
    rerender(<Setup project="Main" onAlsoImport={() => {}} onDone={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /choose folder/i }))
    await userEvent.click(screen.getByRole('button', { name: /start import/i }))
    await screen.findByRole('button', { name: 'Start' })
    expect(screen.queryByRole('button', { name: /also import/i })).toBeNull()
  })
})
