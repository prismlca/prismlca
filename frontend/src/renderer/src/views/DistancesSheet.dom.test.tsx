import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DistancesSheet, { kmText, SUGGEST_DEBOUNCE_MS } from './DistancesSheet'
import { renderWithPrism } from '../test/render'
import { setAS } from '../lib/appSettings'
import { DEFAULT_TRANSPORT } from '../../../shared/distanceDefaults'

/**
 * The panel's contract: the number shown is the one copied, every lookup lands in the recent list
 * (kept in the app settings, five deep), the geocoder is named while the sheet is open, and without
 * a key the sheet points at Settings instead of pretending.
 */
const roadResult = {
  mode: 'road',
  geocoder: 'ors',
  results: [
    {
      from: { text: 'Heidelberg', resolved: 'Heidelberg, Germany', lat: 49.41, lon: 8.69, via: 'ors' },
      to: { text: 'Hamburg', resolved: 'Hamburg, Germany', lat: 53.55, lon: 9.99, via: 'ors' },
      km: 504,
      raw_km: 480,
      adjustment: 'routed distance × 1.05 (GLEC / ISO 14083: +5 % planned → actual)'
    }
  ],
  attribution:
    'Routing © openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors · Geocoding: openrouteservice',
  quota: {}
}

describe('DistancesSheet', () => {
  // The store is a module singleton; only reset it once a bridge exists (the pure kmText case mounts nothing).
  afterEach(() => {
    if ((window as unknown as { prism?: unknown }).prism) setAS({ transport: DEFAULT_TRANSPORT })
  })

  it('looks a pair up, shows and copies the adjusted kilometres, and remembers the lookup', async () => {
    const user = userEvent.setup()
    const compute = vi.fn(async () => roadResult)
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { prism } = renderWithPrism(<DistancesSheet onClose={() => {}} onOpenSettings={() => {}} />, {
      overrides: { distance: { compute } }
    })
    // The geocoder stands in the head while the sheet is open.
    expect(await screen.findByText(/Geocoding: openrouteservice/)).toBeInTheDocument()

    const inputs = screen.getAllByPlaceholderText(/place, address/)
    await user.type(inputs[0], 'Heidelberg')
    await user.type(inputs[1], 'Hamburg')
    await user.click(screen.getByRole('button', { name: 'Compute' }))

    expect(compute).toHaveBeenCalledWith({ mode: 'road', from: 'Heidelberg', to: 'Hamburg' })
    expect(await screen.findByText('504')).toBeInTheDocument()
    expect(screen.getByText(/480 km before adjustment/)).toBeInTheDocument()
    expect(screen.getAllByText('Heidelberg, Germany').length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: 'Copy kilometres' }))
    expect(writeText).toHaveBeenCalledWith('504')
    expect(await screen.findByText('Copied')).toBeInTheDocument()

    await waitFor(() => {
      const t = prism.settings.transport as typeof DEFAULT_TRANSPORT
      expect(t.recent).toHaveLength(1)
      expect(t.recent[0]).toMatchObject({
        mode: 'road',
        from: 'Heidelberg',
        to: 'Hamburg',
        km: 504,
        geocoder: 'ors'
      })
    })
    const recent = screen.getByRole('list', { name: 'Recent lookups' })
    expect(within(recent).getByText('Heidelberg → Hamburg')).toBeInTheDocument()
    expect(within(recent).getByRole('button', { name: 'Copy 504 km' })).toBeInTheDocument()
  })

  it('keeps five recent lookups, newest first', async () => {
    const user = userEvent.setup()
    let n = 0
    const compute = vi.fn(async () => ({
      ...roadResult,
      results: [{ ...roadResult.results[0], km: 100 + ++n }]
    }))
    const { prism } = renderWithPrism(<DistancesSheet onClose={() => {}} onOpenSettings={() => {}} />, {
      overrides: { distance: { compute } }
    })
    const [fromBox, toBox] = await screen.findAllByPlaceholderText(/place, address/)
    await user.type(fromBox, 'A')
    for (let i = 0; i < 6; i++) {
      // A different destination each time — the same pair again would only move to the top.
      await user.clear(toBox)
      await user.type(toBox, `B${i}`)
      await user.click(screen.getByRole('button', { name: 'Compute' }))
      await screen.findByText(String(101 + i))
    }
    await waitFor(() => {
      const t = prism.settings.transport as typeof DEFAULT_TRANSPORT
      expect(t.recent.map((r) => r.km)).toEqual([106, 105, 104, 103, 102])
    })
  })

  it('without any key it points at Settings and cannot compute', async () => {
    const user = userEvent.setup()
    const onOpenSettings = vi.fn()
    renderWithPrism(<DistancesSheet onClose={() => {}} onOpenSettings={onOpenSettings} />, {
      overrides: {
        distance: {
          availability: async () => ({ ors: false, mapbox: false, geocoder: null, available: false })
        }
      }
    })
    await user.click(await screen.findByRole('button', { name: /Open Settings/ }))
    expect(onOpenSettings).toHaveBeenCalled()
    const [fromBox, toBox] = screen.getAllByPlaceholderText(/place, address/)
    await user.type(fromBox, 'A')
    await user.type(toBox, 'B')
    expect(screen.getByRole('button', { name: 'Compute' })).toBeDisabled()
  })

  it('road: a ferry/shuttle crossing is shown as its own leg, outside the figure', async () => {
    const user = userEvent.setup()
    const compute = vi.fn(async () => ({
      mode: 'road',
      geocoder: 'ors',
      results: [
        {
          from: { text: 'London', resolved: 'London, UK', lat: 51.5, lon: -0.13, via: 'ors' },
          to: { text: 'Paris', resolved: 'Paris, France', lat: 48.86, lon: 2.35, via: 'ors' },
          km: 452.1,
          raw_km: 472.3,
          adjustment: 'road part (routed 472.3 km − 41.8 km crossing) × 1.05',
          crossings: 'present',
          crossing: { km: 41.8, note: 'On a ferry or a vehicle shuttle train' }
        }
      ],
      attribution: 'Routing © openrouteservice.org by HeiGIT',
      quota: {}
    }))
    const { prism } = renderWithPrism(<DistancesSheet onClose={() => {}} onOpenSettings={() => {}} />, {
      overrides: { distance: { compute } }
    })
    const [fromBox, toBox] = await screen.findAllByPlaceholderText(/place, address/)
    await user.type(fromBox, 'London')
    await user.type(toBox, 'Paris')
    await user.click(screen.getByRole('button', { name: 'Compute' }))
    expect(await screen.findByText('452.1')).toBeInTheDocument()
    expect(
      screen.getByText(/Plus 41.8 km on a ferry or a vehicle shuttle train, not in the figure/)
    ).toBeInTheDocument()
    // The Recent entry keeps the crossing, so a reused figure still says another leg is needed.
    await waitFor(() => {
      const t = prism.settings.transport as { recent: Array<{ crossing_km?: number }> }
      expect(t.recent[0].crossing_km).toBe(41.8)
    })
  })

  it('shows the sea snap distances apart from the sailed kilometres, and the rail caveat', async () => {
    const user = userEvent.setup()
    const compute = vi.fn(async (req: { mode: string }) =>
      req.mode === 'sea'
        ? {
            mode: 'sea',
            geocoder: 'ors',
            results: [
              {
                from: { text: 'Shanghai', resolved: 'Shanghai', lat: 31, lon: 121, via: 'ors' },
                to: { text: 'Hamburg', resolved: 'Hamburg', lat: 53, lon: 10, via: 'ors' },
                km: 19613.7,
                raw_km: 19613.7,
                adjustment: null,
                sea: { from_snap_km: 33.1, to_snap_km: 2.2, passages: ['suez'] }
              }
            ],
            attribution: 'Sea route: searoute',
            quota: {}
          }
        : {
            mode: 'rail',
            geocoder: 'ors',
            results: [
              {
                from: { text: 'A' },
                to: { text: 'B' },
                km: 142,
                raw_km: 100,
                adjustment: 'great-circle × 1.2'
              }
            ],
            attribution: 'Great-circle distance (WGS84)',
            rail_caveat:
              'Rail distance is the great-circle distance times a circuity factor. It says nothing about whether rail infrastructure exists on this relation.',
            quota: {}
          }
    )
    renderWithPrism(<DistancesSheet onClose={() => {}} onOpenSettings={() => {}} />, {
      overrides: { distance: { compute } }
    })
    const [fromBox, toBox] = await screen.findAllByPlaceholderText(/place, address/)
    await user.type(fromBox, 'Shanghai')
    await user.type(toBox, 'Hamburg')
    await user.click(screen.getByRole('radio', { name: /Sea/ }))
    await user.click(screen.getByRole('button', { name: 'Compute' }))
    expect(await screen.findByText('19 613.7')).toBeInTheDocument()
    expect(screen.getByText(/Not included: 33.1 km from the origin/)).toBeInTheDocument()
    expect(screen.getByText(/Via suez/)).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: /Rail/ }))
    await user.click(screen.getByRole('button', { name: 'Compute' }))
    expect(
      await screen.findByText(/says nothing about whether rail infrastructure exists/)
    ).toBeInTheDocument()
  })

  it('kmText is one decimal, dot, no unit', () => {
    expect(kmText(504)).toBe('504')
    expect(kmText(19613.74)).toBe('19613.7')
    expect(kmText(0.05)).toBe('0.1')
  })

  it('suggests places while typing — one debounced request, and a pick fills the field', async () => {
    const user = userEvent.setup()
    const suggest = vi.fn(async () => [
      { label: 'Heidelberg, BW, Germany', lat: 49.41, lon: 8.69, country: 'DE' },
      { label: 'Heidelberg, PA, USA', lat: 40.4, lon: -80.1, country: 'US' }
    ])
    renderWithPrism(<DistancesSheet onClose={() => {}} onOpenSettings={() => {}} />, {
      overrides: { distance: { suggest } }
    })
    const [fromBox] = await screen.findAllByPlaceholderText(/place, address/)
    await user.type(fromBox, 'Heidel')
    const option = await screen.findByRole('option', { name: 'Heidelberg, PA, USA' })
    // Six keystrokes, one request: the debounce waited for the typing to stop.
    expect(suggest).toHaveBeenCalledTimes(1)
    expect(suggest).toHaveBeenCalledWith({ text: 'Heidel' })
    await user.click(within(option).getByRole('button'))
    expect(fromBox).toHaveValue('Heidelberg, PA, USA')
    expect(screen.queryByRole('listbox')).toBeNull()
    // Choosing a suggestion does not ask again for the label it just put there.
    await waitFor(() => expect(suggest).toHaveBeenCalledTimes(1))
  })

  it('asks for no suggestions while Mapbox geocodes (it bills per request)', async () => {
    const user = userEvent.setup()
    const suggest = vi.fn(async () => [])
    renderWithPrism(<DistancesSheet onClose={() => {}} onOpenSettings={() => {}} />, {
      overrides: {
        distance: {
          suggest,
          availability: async () => ({ ors: true, mapbox: true, geocoder: 'mapbox', available: true })
        }
      }
    })
    await screen.findByText(/Geocoding: Mapbox/)
    const [fromBox] = screen.getAllByPlaceholderText(/place, address/)
    await user.type(fromBox, 'Heidelberg')
    await new Promise((r) => setTimeout(r, SUGGEST_DEBOUNCE_MS + 100))
    expect(suggest).not.toHaveBeenCalled()
  })

  it('clicking a recent lookup puts its mode and places back into the fields', async () => {
    const user = userEvent.setup()
    renderWithPrism(<DistancesSheet onClose={() => {}} onOpenSettings={() => {}} />)
    // After the render: the store writes through the bridge the render installed.
    setAS({
      transport: {
        ...DEFAULT_TRANSPORT,
        recent: [
          {
            mode: 'sea',
            from: 'Shanghai',
            to: 'Rotterdam',
            km: 19613.7,
            at: '2026-09-05T00:00:00Z',
            geocoder: 'ors'
          }
        ]
      }
    })
    await user.click(await screen.findByRole('button', { name: 'Shanghai → Rotterdam' }))
    // Sea mode: the placeholder names the port catalogue.
    const [fromBox, toBox] = screen.getAllByPlaceholderText(/place, port/)
    expect(fromBox).toHaveValue('Shanghai')
    expect(toBox).toHaveValue('Rotterdam')
    expect(screen.getByRole('radio', { name: /Sea/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('sea: "Around the Cape" asks for via=cape and the recent entry remembers it', async () => {
    const user = userEvent.setup()
    const compute = vi.fn(async (req: { via?: string }) => ({
      mode: 'sea',
      geocoder: 'ors',
      results: [
        {
          from: { text: 'Shanghai', resolved: 'Shanghai', lat: 31, lon: 121, via: 'ors' },
          to: { text: 'Rotterdam', resolved: 'Rotterdam', lat: 52, lon: 4, via: 'ors' },
          km: req.via === 'cape' ? 25762 : 19614,
          raw_km: req.via === 'cape' ? 25762 : 19614,
          adjustment: null,
          sea: {
            from_snap_km: 33,
            to_snap_km: 2,
            passages: req.via === 'cape' ? ['south_africa'] : ['suez'],
            via: req.via ?? 'shortest'
          }
        }
      ],
      attribution: 'Sea route: searoute',
      quota: {}
    }))
    const { prism } = renderWithPrism(<DistancesSheet onClose={() => {}} onOpenSettings={() => {}} />, {
      overrides: { distance: { compute } }
    })
    const [fromBox, toBox] = await screen.findAllByPlaceholderText(/place, address/)
    await user.type(fromBox, 'Shanghai')
    await user.type(toBox, 'Rotterdam')
    expect(screen.queryByRole('radio', { name: 'Around the Cape' })).toBeNull() // road: no sea routing
    await user.click(screen.getByRole('radio', { name: /Sea/ }))
    await user.click(screen.getByRole('radio', { name: 'Around the Cape' }))
    await user.click(screen.getByRole('button', { name: 'Compute' }))
    expect(compute).toHaveBeenLastCalledWith({ mode: 'sea', from: 'Shanghai', to: 'Rotterdam', via: 'cape' })
    expect(await screen.findByText('25 762')).toBeInTheDocument()
    expect(screen.getByText(/Routed around the Cape of Good Hope/)).toBeInTheDocument()
    await waitFor(() => {
      const t = prism.settings.transport as typeof DEFAULT_TRANSPORT
      expect(t.recent[0]).toMatchObject({ mode: 'sea', via: 'cape', km: 25762 })
    })
  })

  it('looking the same pair up again moves it to the top instead of listing it twice', async () => {
    const user = userEvent.setup()
    const compute = vi.fn(async () => roadResult)
    const { prism } = renderWithPrism(<DistancesSheet onClose={() => {}} onOpenSettings={() => {}} />, {
      overrides: { distance: { compute } }
    })
    const [fromBox, toBox] = await screen.findAllByPlaceholderText(/place, address/)
    await user.type(fromBox, 'Heidelberg')
    await user.type(toBox, 'Hamburg')
    await user.click(screen.getByRole('button', { name: 'Compute' }))
    await screen.findByText('504')
    await user.click(screen.getByRole('button', { name: 'Compute' }))
    await waitFor(() => expect(compute).toHaveBeenCalledTimes(2))
    await waitFor(() => {
      const t = prism.settings.transport as typeof DEFAULT_TRANSPORT
      expect(t.recent).toHaveLength(1)
    })
  })

  it('Stop ends the lookup: the bridge is told, and the late answer is neither shown nor remembered', async () => {
    const user = userEvent.setup()
    let finish: (v: typeof roadResult) => void = () => {}
    const compute = vi.fn(() => new Promise<typeof roadResult>((resolve) => (finish = resolve)))
    const cancel = vi.fn(async () => ({ ok: true }))
    const { prism } = renderWithPrism(<DistancesSheet onClose={() => {}} onOpenSettings={() => {}} />, {
      overrides: { distance: { compute, cancel } }
    })
    await screen.findByText(/Geocoding: openrouteservice/)
    const inputs = screen.getAllByPlaceholderText(/place, address/)
    await user.type(inputs[0], 'Heidelberg')
    await user.type(inputs[1], 'Hamburg')
    // No Stop before a lookup runs.
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Compute' }))
    expect(await screen.findByText(/Looking up/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(cancel).toHaveBeenCalledTimes(1)
    // Idle again at once: Compute is back, Stop is gone, no error shown for a stop.
    expect(await screen.findByRole('button', { name: 'Compute' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()

    // The stopped lookup's answer arrives later (the service resolves what it had): stale, discarded.
    finish(roadResult)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText('504')).toBeNull()
    expect((prism.settings.transport as typeof DEFAULT_TRANSPORT).recent).toHaveLength(0)
  })
})
