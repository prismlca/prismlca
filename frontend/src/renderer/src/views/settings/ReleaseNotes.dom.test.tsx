/**
 * The About page shows a newer version's release notes as the notes are written — headings, bulleted items
 * with their bold lead-ins, links that open in the browser — not as one run of plain text.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReleaseNotes, UpdateState } from '../../../../shared/updates'
import { AboutPanel } from './AboutPanel'

const NOTES: ReleaseNotes = {
  blocks: [
    { kind: 'heading', spans: [{ text: 'New' }] },
    {
      kind: 'list',
      ordered: false,
      items: [
        [
          {
            kind: 'paragraph',
            spans: [
              { text: 'Life cycle inventory.', strong: true },
              { text: ' A table of every elementary flow (' },
              { text: '#147', href: 'https://github.com/prismlca/prismlca/pull/147' },
              { text: ').' }
            ]
          }
        ],
        [{ kind: 'paragraph', spans: [{ text: 'Keyboard and screen readers.' }] }]
      ]
    },
    { kind: 'code', text: 'npm run build\n  --verbose' },
    { kind: 'heading', spans: [{ text: 'Fixes' }] },
    { kind: 'list', ordered: false, items: [[{ kind: 'paragraph', spans: [{ text: 'Electron 44.11.6.' }] }]] }
  ]
}

let opened: ReturnType<typeof vi.fn>

function showAvailable(notes: ReleaseNotes): void {
  const state: UpdateState = { phase: 'available', current: '0.9.16', version: '0.9.17', notes }
  ;(window as unknown as { prism: unknown }).prism = {
    buildInfo: vi.fn(async () => ({
      version: '0.9.16',
      kind: 'release',
      commit: 'abc1234',
      electron: '44',
      os: 'x'
    })),
    info: vi.fn(async () => ({})),
    openExternal: opened,
    updates: { state: vi.fn(async () => state), onEvent: vi.fn(() => () => undefined) }
  }
}

beforeEach(() => {
  opened = vi.fn(async () => undefined)
})

describe('release notes on the About page', () => {
  it('shows headings and a bulleted list with bold lead-ins, and opens a link in the browser', async () => {
    showAvailable(NOTES)
    render(<AboutPanel />)
    await userEvent.click(await screen.findByText('What is new in 0.9.17'))
    const notes = document.querySelector<HTMLElement>('.release-notes')!
    expect(
      within(notes)
        .getAllByRole('heading')
        .map((h) => h.textContent)
    ).toEqual(['New', 'Fixes'])
    const lists = within(notes).getAllByRole('list')
    expect(lists.map((l) => l.tagName)).toEqual(['UL', 'UL'])
    const items = within(lists[0]).getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual([
      'Life cycle inventory. A table of every elementary flow (#147).',
      'Keyboard and screen readers.'
    ])
    expect(items[0].querySelector('strong')?.textContent).toBe('Life cycle inventory.')
    // A code block keeps its lines and indentation.
    expect(notes.querySelector('pre > code')?.textContent).toBe('npm run build\n  --verbose')
    await userEvent.click(within(items[0]).getByRole('button', { name: '#147' }))
    expect(opened).toHaveBeenCalledWith('https://github.com/prismlca/prismlca/pull/147')
    expect(screen.queryByText(/Shortened here/)).toBeNull()
  })

  it('points to the release page when the notes were cut', async () => {
    showAvailable({ ...NOTES, cut: true })
    render(<AboutPanel />)
    await userEvent.click(await screen.findByText('What is new in 0.9.17'))
    const cut = screen.getByText(/Shortened here/)
    await userEvent.click(within(cut).getByRole('button', { name: 'release page' }))
    expect(opened).toHaveBeenCalledWith('https://github.com/prismlca/prismlca/releases/tag/v0.9.17')
  })
})
