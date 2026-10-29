import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithPrism } from '../test/render'
import BridgeBanner from './BridgeBanner'

const unclaimed = { launchedBy: 'bridge', claimed: false, idleMinutes: 10 }

describe('BridgeBanner', () => {
  it('shows for a bridge-launched, unclaimed instance, with main’s idle minutes', async () => {
    renderWithPrism(<BridgeBanner />, {
      overrides: { launch: { state: async () => ({ ...unclaimed, idleMinutes: 7 }) } }
    })
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Opened for an external agent · closes after 7 idle minutes · click anywhere to keep it'
    )
  })

  it('Keep open claims the instance, and the bar goes when main reports the claim', async () => {
    const user = userEvent.setup()
    const keepOpen = vi.fn(async () => undefined)
    const { prism } = renderWithPrism(<BridgeBanner />, {
      overrides: { launch: { state: async () => unclaimed, keepOpen } }
    })
    await user.click(await screen.findByRole('button', { name: 'Keep open' }))
    expect(keepOpen).toHaveBeenCalledTimes(1)
    act(() => prism.emitBridgeState({ ...unclaimed, claimed: true }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('stays hidden when claimed, when a person started the app, or without the API', async () => {
    const { unmount } = renderWithPrism(<BridgeBanner />, {
      overrides: { launch: { state: async () => ({ ...unclaimed, claimed: true }) } }
    })
    await act(async () => undefined)
    expect(screen.queryByRole('status')).toBeNull()
    unmount()
    const human = renderWithPrism(<BridgeBanner />)
    await act(async () => undefined)
    expect(screen.queryByRole('status')).toBeNull()
    human.unmount()
    // An older preload without `prism.bridge`: nothing shown, nothing thrown.
    const old = renderWithPrism(<BridgeBanner />)
    delete (window.prism as unknown as { bridge?: unknown }).bridge
    old.rerender(<BridgeBanner key="again" />)
    await act(async () => undefined)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('follows a pushed state that arrives after mount', async () => {
    const { prism } = renderWithPrism(<BridgeBanner />)
    await act(async () => undefined)
    expect(screen.queryByRole('status')).toBeNull()
    act(() => prism.emitBridgeState(unclaimed))
    expect(screen.getByRole('status')).toHaveTextContent('closes after 10 idle minutes')
  })
})
