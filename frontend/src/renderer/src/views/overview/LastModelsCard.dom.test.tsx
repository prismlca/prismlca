import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LastModelsCard from './LastModelsCard'
import { renderWithPrism } from '../../test/render'
import { makePrism } from '../../test/prism'
import { initAppSettings, setAS } from '../../lib/appSettings'
import { reloadFolders } from '../../lib/modelFolders'
import type { DatabaseInfo } from '../../lib/api'

const fg = (name: string, node_count = 3): DatabaseInfo => ({
  name,
  node_count,
  read_only: false,
  kind: 'foreground'
})
const day = (d: number): string => new Date(Date.UTC(2026, 8, d, 12)).toISOString()

const FOLDERS = { folders: [{ id: 'f1', name: 'Packaging' }], of: { 'PET bottle': 'f1' } }

describe('Last models card', () => {
  beforeEach(async () => {
    const fixture = makePrism({ 'GET /api/v1/databases/folders': FOLDERS })
    ;(window as unknown as { prism: unknown }).prism = fixture.prism
    await initAppSettings()
    await reloadFolders()
    setAS({ recentModels: [] })
  })

  const rows = (): string[] =>
    screen
      .queryAllByRole('button')
      .map((b) => within(b).getByText(/./, { selector: '.ov-model-name' }).textContent ?? '')

  it('says what will appear when nothing was opened yet', () => {
    renderWithPrism(<LastModelsCard project="p" databases={[fg('a')]} onOpenModel={() => {}} />)
    expect(screen.getByText('Models you open will appear here.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Last models' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /view all/i })).toBeNull()
  })

  it('lists the current project’s models newest first, at most five, only those that still exist', () => {
    setAS({
      recentModels: [
        ...['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map((db, i) => ({ project: 'p', db, openedAt: day(i + 1) })),
        { project: 'p', db: 'deleted', openedAt: day(20) },
        { project: 'other', db: 'm1', openedAt: day(21) }
      ]
    })
    const dbs = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map((n) => fg(n))
    renderWithPrism(<LastModelsCard project="p" databases={dbs} onOpenModel={() => {}} />)
    expect(rows()).toEqual(['m6', 'm5', 'm4', 'm3', 'm2'])
    expect(screen.queryByText('deleted')).toBeNull()
  })

  it('shows folder, process count and the day it was opened', () => {
    setAS({ recentModels: [{ project: 'p', db: 'PET bottle', openedAt: '2026-09-24T10:00:00.000Z' }] })
    renderWithPrism(<LastModelsCard project="p" databases={[fg('PET bottle', 12)]} onOpenModel={() => {}} />)
    expect(screen.getByText('Packaging · 12 processes')).toBeInTheDocument()
    expect(screen.getByText('Opened Sep 24, 2026')).toBeInTheDocument()
  })

  it('opens a model on click and on Enter', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    setAS({ recentModels: [{ project: 'p', db: 'a', openedAt: day(1) }] })
    renderWithPrism(<LastModelsCard project="p" databases={[fg('a')]} onOpenModel={onOpen} />)
    await user.click(screen.getByRole('button', { name: /^a/ }))
    expect(onOpen).toHaveBeenCalledWith('a')
    screen.getByRole('button', { name: /^a/ }).focus()
    await user.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledTimes(2)
  })
})
