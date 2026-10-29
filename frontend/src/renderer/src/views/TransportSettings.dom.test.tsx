import { afterEach, describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Settings from './Settings'
import { renderWithPrism } from '../test/render'
import { setAS } from '../lib/appSettings'
import { DEFAULT_TRANSPORT } from '../../../shared/distanceDefaults'

/**
 * The Transport distances page: its own category outside the AI group, and the two rules that make
 * it work — the nested group is always written AS A WHOLE (main merges shallowly, a partial patch
 * would wipe the other fields), and without any key the assistant's tool cannot be switched on.
 */
const ROUTES = { 'GET /api/v1/ai/skills': { skills: [] } }

describe('Settings → Transport distances', () => {
  afterEach(() => setAS({ transport: DEFAULT_TRANSPORT }))

  it('is a group of pages of its own and writes the geocoder choice through as a whole group', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} />, { routes: ROUTES })
    await user.click(screen.getByRole('button', { name: 'Transport distances' })) // unfold the group
    await user.click(screen.getByRole('button', { name: 'API provider' }))
    const group = await screen.findByRole('radiogroup', { name: 'Geocoder' })
    await user.click(within(group).getByRole('radio', { name: /Mapbox/ }))
    await waitFor(() => {
      const t = prism.settings.transport as typeof DEFAULT_TRANSPORT
      expect(t.geocoder).toBe('mapbox')
      // The rest of the group travelled along — nothing was wiped by a partial write.
      expect(t.glec).toEqual({ road: true, air: true, rail: true, sea: true })
      expect(t.dailyCalls).toEqual(DEFAULT_TRANSPORT.dailyCalls)
    })
    // Choosing Mapbox surfaces its token field and the permanent-geocode notice.
    expect(await screen.findByLabelText('Mapbox access token')).toBeInTheDocument()
    expect(screen.getByText(/permanent/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull()
  })

  it('switches a GLEC adjustment off and prints the source beside it', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} />, { routes: ROUTES })
    await user.click(screen.getByRole('button', { name: 'Transport distances' }))
    await user.click(await screen.findByRole('button', { name: 'DAF' }))
    expect(screen.getByText(/GLEC Framework v3.2 \(Oct 2025\) \/ EN 16258/)).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: /Air: great-circle distance \+ 95 km/ }))
    await waitFor(() => {
      const t = prism.settings.transport as typeof DEFAULT_TRANSPORT
      expect(t.glec.air).toBe(false)
      expect(t.glec.road).toBe(true)
    })
    expect(screen.getByText(/says nothing about whether rail infrastructure exists/)).toBeInTheDocument()
  })

  it('without any key the assistant switch is disabled and says why', async () => {
    const user = userEvent.setup()
    renderWithPrism(<Settings onClose={() => {}} />, {
      routes: ROUTES,
      overrides: {
        distance: {
          availability: async () => ({ ors: false, mapbox: false, geocoder: null, available: false }),
          keyStatus: async () => ({
            present: false,
            hint: '',
            source: 'none',
            backend: 'test',
            trusted: true,
            available: true
          })
        }
      }
    })
    await user.click(screen.getByRole('button', { name: 'Transport distances' }))
    await user.click(await screen.findByRole('button', { name: 'Limits' }))
    const box = await screen.findByRole('checkbox', { name: /Offer the distances tool/ })
    await waitFor(() => expect(box).toBeDisabled())
    expect(screen.getByText(/not even told the tool exists/)).toBeInTheDocument()
  })
})
