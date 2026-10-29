import { readFileSync } from 'fs'
import { resolve } from 'path'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderWithPrism } from '../../test/render'
import notice from '../../assets/privacy-notice.md?raw'
import PrivacyLink from './PrivacyLink'

describe('PrivacyLink', () => {
  it('opens the bundled notice in a modal and closes it again', async () => {
    const user = userEvent.setup()
    renderWithPrism(<PrivacyLink />, { routes: {} })
    expect(screen.queryByRole('dialog', { name: 'Privacy notice' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Privacy notice' }))
    const dialog = screen.getByRole('dialog', { name: 'Privacy notice' })
    // The Markdown's H1 and version line become the sheet head; the sections are the body.
    expect(dialog.querySelector('.sheet-head h3')).toHaveTextContent('PrismLCA privacy notice')
    expect(dialog.querySelector('.sheet-head p')).toHaveTextContent(/^Version of/)
    expect(dialog).toHaveTextContent('Who is responsible')
    expect(dialog).toHaveTextContent('contact@prismlca.com')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'Privacy notice' })).not.toBeInTheDocument()
  })

  it('ships the same text as the repository root PRIVACY.md', () => {
    // Two copies by necessity (the renderer cannot import from outside its root in a packaged
    // build); this is what keeps them one text. Update both or this fails.
    const root = readFileSync(resolve(__dirname, '../../../../../../PRIVACY.md'), 'utf8')
    expect(notice).toBe(root)
  })
})
