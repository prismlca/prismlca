import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithPrism } from '../../test/render'
import LicenceLink from './LicenceLink'

describe('LicenceLink', () => {
  it('opens the licence in a sheet, with the file one click further', async () => {
    const user = userEvent.setup()
    const openLicence = vi.fn(async () => ({}))
    const openNotices = vi.fn(async () => ({}))
    renderWithPrism(<LicenceLink />, { routes: {}, overrides: { bridge: { openLicence, openNotices } } })
    expect(screen.getByText('Licence:')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'AGPL-3.0' }))
    const sheet = screen.getByRole('dialog', { name: 'Licence' })
    // The sheet shows the bundled file itself: the §7 permission at the top, the GNU text below.
    expect(sheet).toHaveTextContent('GNU Affero General Public License v3.0')
    expect(sheet).toHaveTextContent('Copyright (C) 2026 Jonas Harth')
    expect(sheet).toHaveTextContent(/GNU AFFERO GENERAL PUBLIC LICENSE/)
    expect(openLicence).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Open as file' }))
    expect(openLicence).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'Licence' })).not.toBeInTheDocument()
    expect(openNotices).not.toHaveBeenCalled()
  })

  it('opens the notices summary in a sheet, with the full file one click further', async () => {
    const user = userEvent.setup()
    const openNotices = vi.fn(async () => ({}))
    renderWithPrism(<LicenceLink />, { routes: {}, overrides: { bridge: { openNotices } } })
    await user.click(screen.getByRole('button', { name: 'Third-party notices' }))
    const sheet = screen.getByRole('dialog', { name: 'Third-party notices' })
    // The fixture's summary table, rendered — a table, not a wall of licence text.
    expect(await screen.findByRole('cell', { name: 'bw2data' })).toBeInTheDocument()
    expect(sheet).toHaveTextContent('BSD-3-Clause')
    await user.click(screen.getByRole('button', { name: 'Open the full notices' }))
    expect(openNotices).toHaveBeenCalledTimes(1)
  })
})
