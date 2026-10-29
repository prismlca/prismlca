import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExportBundleSheet, ImportBundleSheet } from './BundleDialogs'
import { renderWithPrism } from '../test/render'

describe('Import a model — the spreadsheet way in', () => {
  it('turns the exported .xlsx into a new model under the name given', async () => {
    const user = userEvent.setup()
    const onImported = vi.fn()
    const { prism } = renderWithPrism(<ImportBundleSheet onClose={() => {}} onImported={onImported} />, {
      routes: {
        'GET /api/v1/databases/folders': { folders: [], assignment: {} },
        'POST /api/v1/interop/model/import': (body: unknown) => ({
          database: (body as { name: string }).name,
          activities: 2
        })
      }
    })
    const file = new File([new Uint8Array([80, 75, 3, 4])], 'pet-bottle.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })
    await user.upload(screen.getByLabelText('Spreadsheet'), file)
    const name = await screen.findByDisplayValue('pet-bottle')
    await user.clear(name)
    await user.type(name, 'pet-bottle-from-sheet')
    await user.click(screen.getByRole('button', { name: 'Import spreadsheet' }))
    await waitFor(() => expect(onImported).toHaveBeenCalledWith('pet-bottle-from-sheet', null))
    const call = prism.calls.find((c) => c.path === '/api/v1/interop/model/import')
    expect(call?.body).toEqual({ name: 'pet-bottle-from-sheet', content: btoa('PK\u0003\u0004') })
  })

  it('says so when formulas name parameters the sheet could not carry, before opening the model', async () => {
    const user = userEvent.setup()
    const onImported = vi.fn()
    renderWithPrism(<ImportBundleSheet onClose={() => {}} onImported={onImported} />, {
      routes: {
        'GET /api/v1/databases/folders': { folders: [], assignment: {} },
        'POST /api/v1/interop/model/import': {
          database: 'hose',
          activities: 3,
          formulas_unresolved: "name 'm_hose' is not defined"
        }
      }
    })
    await user.upload(screen.getByLabelText('Spreadsheet'), new File([new Uint8Array([1])], 'hose.xlsx'))
    await user.click(await screen.findByRole('button', { name: 'Import spreadsheet' }))
    expect(await screen.findByText(/name 'm_hose' is not defined/)).toBeInTheDocument()
    expect(onImported).not.toHaveBeenCalled()
    // Leaving by Close hands the model over too — the list must learn it exists.
    const closers = screen.getAllByRole('button', { name: 'Close' })
    await user.click(closers[closers.length - 1])
    expect(onImported).toHaveBeenCalledWith('hose', null)
  })
})

describe('Import a model — the preview', () => {
  it('names the parts in plain words and says which newer ones will not be imported', async () => {
    const user = userEvent.setup()
    renderWithPrism(<ImportBundleSheet onClose={() => {}} onImported={() => {}} />, {
      routes: {
        'GET /api/v1/databases/folders': { folders: [], assignment: {} },
        'POST /api/v1/bundle/inspect': {
          manifest: { written_by: '0.9.0', format: 1 },
          sections: ['graph', 'research_log', 'view'],
          unreadable_sections: [],
          newer_sections: ['parameters'],
          library: { datasets: 0, present: 0, new: 0 },
          model: { name: 'Bottle', suggested_name: 'Bottle', name_taken: false, activities: 3, exchanges: 7 },
          references: [],
          summary: { total: 0, resolved: 0, can_import: true, counts: {} }
        }
      }
    })
    await user.upload(screen.getByLabelText('Bundle file'), new File([new Uint8Array([80, 75])], 'b.prism'))
    expect(
      await screen.findByText(/It holds: processes and flows, research log, canvas and results setup\./)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/In a newer format than this version of PrismLCA reads: parameters/)
    ).toBeInTheDocument()
    expect(screen.getByText('not imported')).toBeInTheDocument()
  })
})

describe('Export a model — the notes follow the choice', () => {
  it('names only the private parts that are picked, and what happens to My processes datasets', async () => {
    const user = userEvent.setup()
    renderWithPrism(<ExportBundleSheet database="Bottle" onClose={() => {}} />, {
      routes: {
        'GET /api/v1/interop/loses': { loses: [] },
        'POST /api/v1/bundle/presets': {
          presets: {
            model: ['graph', 'library'],
            full: ['graph', 'library', 'chats', 'audit'],
            graph: ['graph']
          },
          sections: [
            { name: 'graph', schema: 1, required: true, preset: 'model' },
            { name: 'library', schema: 1, required: false, preset: 'model' },
            { name: 'chats', schema: 1, required: false, preset: 'full' },
            { name: 'audit', schema: 1, required: false, preset: 'full' }
          ]
        }
      }
    })
    expect(await screen.findByText(/that the model uses travel with it/)).toBeInTheDocument()
    expect(screen.queryByText(/assistant conversations and what they cost/)).not.toBeInTheDocument()
    await user.click(screen.getByLabelText(/The change history of this model/))
    expect(screen.getByText(/change history in plain text/)).toBeInTheDocument()
    expect(screen.queryByText(/assistant conversations and what they cost/)).not.toBeInTheDocument()
    await user.click(screen.getByLabelText(/The datasets from My processes/))
    expect(screen.getByText(/stay behind — the recipient must already have them/)).toBeInTheDocument()
  })
})
