import { describe, expect, it } from 'vitest'

import type { ApiRaw } from './execute'
import { activeWorkspace, pinnedTo, pinnedToActiveWorkspace, WORKSPACE_UNKNOWN } from './workspacePin'

const answering =
  (status: number, body: unknown): ApiRaw =>
  async () => ({ status, body })

describe('the workspace a run is pinned to', () => {
  it('is the active workspace the backend reports, or none when it cannot say', async () => {
    expect(await activeWorkspace(answering(200, { current_project: { name: 'Main' } }))).toBe('Main')
    expect(await activeWorkspace(answering(200, { current_project: null }))).toBeNull()
    expect(await activeWorkspace(answering(503, { current_project: { name: 'Main' } }))).toBeNull()
    expect(
      await activeWorkspace(async () => {
        throw new Error('down')
      })
    ).toBeNull()
  })

  it('rides on every request, percent-encoded, over any header of the same name', async () => {
    const sent: Array<Record<string, string> | undefined> = []
    const api: ApiRaw = async (_m, _p, _b, h) => (sent.push(h), { status: 200, body: {} })
    const pinned = pinnedTo('Müller', api)
    await pinned('GET', '/a')
    await pinned('POST', '/b', {}, { 'X-Prism-Turn': 't', 'X-Prism-Project': 'Other' })
    expect(sent).toEqual([
      { 'X-Prism-Project': 'M%C3%BCller' },
      { 'X-Prism-Turn': 't', 'X-Prism-Project': 'M%C3%BCller' }
    ])
    expect(pinnedTo(null, api)).toBe(api)
  })

  it('is required: a run whose workspace cannot be read does not start', async () => {
    for (const api of [
      answering(200, { current_project: null }),
      answering(500, { error: 'down' }),
      async () => {
        throw new Error('down')
      }
    ] as ApiRaw[])
      await expect(pinnedToActiveWorkspace(api)).rejects.toThrow(WORKSPACE_UNKNOWN)
  })
})
