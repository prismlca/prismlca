/**
 * The Background data sheet shows an import that runs while it opens — started in the wizard, or before
 * the window was reloaded — and holds back what would collide with it.
 */
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import BackgroundData from './BackgroundData'
import { renderWithPrism } from '../test/render'

const OVERVIEW = {
  project: 'Main',
  biosphere: { name: 'biosphere3', flows: 4300, revision: null, source: null },
  background: [],
  offered: ['ecoinvent', 'bafu'],
  methods: { total: 0, custom: 0 },
  models: []
}

describe('Background data: an import that is already running', () => {
  it('shows its progress first and keeps the imports and the reset back', async () => {
    const { prism } = renderWithPrism(
      <BackgroundData onClose={() => {}} onImport={() => {}} onChanged={() => {}} />,
      {
        routes: {
          'GET /api/v1/setup/background': OVERVIEW,
          'GET /api/v1/import/batches': { batches: [], own: 0, library: 'My processes' },
          'GET /api/v1/setup/status': {
            state: 'running',
            step: 'writing',
            detail: 'Writing 27,400 datasets — a write cannot be cancelled…',
            progress: 0.78
          }
        }
      }
    )
    expect(await screen.findByRole('progressbar', { name: 'Import progress' })).toBeTruthy()
    expect(screen.getByText(/Writing 27,400 datasets/)).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Import BAFU:20XY…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Import ecoinvent…' })).toBeDisabled()
    expect(prism.calls.filter((c) => c.path === '/api/v1/setup/status').length).toBeGreaterThan(0)
  })

  it('shows nothing of an import that has ended', async () => {
    const { prism } = renderWithPrism(
      <BackgroundData onClose={() => {}} onImport={() => {}} onChanged={() => {}} />,
      {
        routes: {
          'GET /api/v1/setup/background': OVERVIEW,
          'GET /api/v1/import/batches': { batches: [], own: 0, library: 'My processes' },
          'GET /api/v1/setup/status': { state: 'done', step: 'finished', detail: 'Imported 3 activities.' }
        }
      }
    )
    await waitFor(() => expect(prism.calls.some((c) => c.path === '/api/v1/setup/status')).toBe(true))
    expect(await screen.findByRole('button', { name: 'Import BAFU:20XY…' })).toBeEnabled()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByText(/Imported 3 activities/)).toBeNull()
  })
})
