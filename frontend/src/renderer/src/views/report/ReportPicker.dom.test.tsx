// @vitest-environment jsdom
/**
 * Deleting a full report from beside the list: it asks first and names what goes, it clears the selection
 * and has the page re-read the list, and it waits while chapters are being written.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: { method: string; path: string }[] = []
vi.mock('../../lib/api', async (actual) => ({
  ...(await actual<typeof import('../../lib/api')>()),
  api: vi.fn(async (method: string, path: string) => {
    calls.push({ method, path })
    return { ok: true }
  })
}))

import ReportPicker, { type StoredReport } from './ReportPicker'
import { reportBase, trackWriteAll } from '../../lib/report/writeAllRuns'

const reports: StoredReport[] = [
  { id: 'rep-1', name: 'Glass bottle', lang: 'en', section_count: 12 },
  { id: 'rep-2', name: 'Can', lang: 'de', section_count: 1 }
]

function picker(over: Partial<Parameters<typeof ReportPicker>[0]> = {}): {
  onSelect: ReturnType<typeof vi.fn>
  onDeleted: ReturnType<typeof vi.fn>
} {
  const onSelect = vi.fn()
  const onDeleted = vi.fn()
  render(
    <ReportPicker
      database="My model/1"
      reports={reports}
      selected="rep-1"
      onSelect={onSelect}
      onCreate={() => {}}
      canCreate
      busy={false}
      writing={false}
      onDeleted={onDeleted}
      {...over}
    />
  )
  return { onSelect, onDeleted }
}

beforeEach(() => {
  calls.length = 0
})

describe('the Delete button', () => {
  it('is the "New report" button with only its icon, paired with it so the two stand equally tall', () => {
    picker()
    const create = screen.getByRole('button', { name: 'New report' })
    const remove = screen.getByRole('button', { name: 'Delete report' })
    for (const name of create.classList) expect(remove.classList).toContain(name)
    // The pair stretches Delete to the height of "New report" (report.css), so they have to share it.
    expect(remove.parentElement).toBe(create.parentElement)
    expect(remove.parentElement?.classList).toContain('report-pick-acts')
    expect(remove.textContent).toBe('')
  })
})

describe('deleting a report', () => {
  it('asks first, naming the report and its chapters, then deletes it and clears the selection', async () => {
    const { onSelect, onDeleted } = picker()
    fireEvent.click(screen.getByRole('button', { name: 'Delete report' }))
    expect(calls).toHaveLength(0) // nothing before the answer

    const dialog = document.querySelector('.confirm-modal') as HTMLElement
    expect(dialog.textContent).toContain('“Glass bottle” and its 12 chapters')
    expect(dialog.textContent).toContain('cannot be undone')
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Delete report' })))

    expect(calls).toEqual([{ method: 'POST', path: '/api/v1/report/one/My%20model%2F1/rep-1/delete' }])
    expect(onSelect).toHaveBeenCalledWith('')
    expect(onDeleted).toHaveBeenCalled()
  })

  it('is not offered with nothing picked', () => {
    picker({ selected: '' })
    expect(screen.getByRole('button', { name: 'Delete report' })).toHaveProperty('disabled', true)
  })

  it('waits while chapters are being written', () => {
    picker({ writing: true })
    const button = screen.getByRole('button', { name: 'Delete report' })
    expect(button).toHaveProperty('disabled', true)
    expect(button.getAttribute('title')).toMatch(/being written/)
  })

  it('also waits for a Write-all run that an earlier chapter panel started', async () => {
    // The panel was remounted (the report picked away and back): its own flag says idle, the run does not.
    let finish: () => void = () => {}
    const run = trackWriteAll(reportBase('My model/1', 'rep-1'), new Promise<void>((r) => (finish = r)))
    picker({ writing: false })
    expect(screen.getByRole('button', { name: 'Delete report' })).toHaveProperty('disabled', true)
    await act(async () => {
      finish()
      await run
    })
    expect(screen.getByRole('button', { name: 'Delete report' })).toHaveProperty('disabled', false)
  })
})
