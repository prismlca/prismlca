import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import UpdatesLink from './UpdatesLink'

describe('UpdatesLink', () => {
  it('hands the click to the caller, which opens Settings → About', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<UpdatesLink onOpen={onOpen} />)
    await user.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})
