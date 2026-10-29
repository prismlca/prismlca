// @vitest-environment jsdom
/**
 * The gate in front of an empty workspace still leads to Settings and About. It hides the sidebar, and a
 * first-time user whose import failed could otherwise reach neither the update check nor the licence
 * and privacy notice (found on a Windows test install).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import SetupGate from './SetupGate'

const base = {
  project: 'Main',
  error: null,
  onImport: () => {},
  projectPicker: null
}

describe('SetupGate', () => {
  it('opens Settings and About from the gate', () => {
    const onOpenSettings = vi.fn()
    render(<SetupGate {...base} onOpenSettings={onOpenSettings} />)
    fireEvent.click(screen.getByRole('button', { name: 'About, licence and updates' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onOpenSettings.mock.calls).toEqual([['about'], ['display']])
  })

  it('shows no links when nobody can open Settings', () => {
    render(<SetupGate {...base} />)
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()
  })
})
