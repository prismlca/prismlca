import { describe, expect, it, vi } from 'vitest'
import { roadKm } from './route'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const place = (lat: number, lon: number) => ({ text: '', resolved: '', lat, lon, via: 'ors' as const })

describe('roadKm', () => {
  it('asks for an unlimited snapping radius — a geocoded city centre is rarely an HGV road', async () => {
    let sent: any
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body))
      return json({ routes: [{ summary: { distance: 414_620.4 } }] })
    })
    const out = await roadKm(place(52.157833, 10.411769), place(49.37625, 8.769869), 'k', {
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    expect(out.km).toBeCloseTo(414.62, 2)
    expect(sent.radiuses).toEqual([-1, -1])
    expect(sent.coordinates).toEqual([
      [10.411769, 52.157833],
      [8.769869, 49.37625]
    ])
  })

  it('tells a not-routable point apart from a missing route', async () => {
    const noPoint = vi.fn(async () =>
      json(
        { error: { code: 2010, message: 'Could not find routable point within a radius of 350.0 meters' } },
        404
      )
    )
    await expect(
      roadKm(place(1, 1), place(2, 2), 'k', { fetchOpts: { fetchImpl: noPoint as unknown as typeof fetch } })
    ).rejects.toThrow(/No road reachable for a heavy goods vehicle/)
    const noRoute = vi.fn(async () =>
      json({ error: { code: 2009, message: 'Route could not be found' } }, 404)
    )
    await expect(
      roadKm(place(1, 1), place(2, 2), 'k', { fetchOpts: { fetchImpl: noRoute as unknown as typeof fetch } })
    ).rejects.toThrow(/No road route between these places/)
  })
})
