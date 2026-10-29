import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ModelToolbar, { type ModelToolbarProps } from './ModelToolbar'
import type { ViewKey } from './AppSidebar'

/**
 * The topbar's model branch serves every view except Overview, LCIA and Results — so "Model",
 * "Activity" and "Tags" also stood above Parameters, Scenarios and Report, where they act on a
 * canvas the page does not show. Undo/Redo is deliberately NOT part of that
 * move: the audit log lives on Parameters and Scenarios and the toolbar half has to stay with it
 * (logPagesRefresh.dom.test).
 */
const props = (view: ViewKey): ModelToolbarProps => ({
  view,
  activeDb: 'db',
  databases: [{ name: 'db', read_only: false } as ModelToolbarProps['databases'][number]],
  onPickModel: vi.fn(),
  undoState: { can_undo: true, can_redo: false, next_undo: 'Edit exchange', next_redo: null },
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  methods: [],
  chosen: '0',
  onChoose: vi.fn(),
  calcBusy: null,
  selectedCount: 1,
  onCalculate: vi.fn(),
  onNewModel: vi.fn(),
  onNewActivity: vi.fn(),
  onShowTagManager: vi.fn(),
  onShowModelInfo: vi.fn(),
  onExportModel: vi.fn(),
  onShowBackground: vi.fn(),
  onShowDistances: vi.fn(),
  lciaTab: 'compare',
  onLciaTab: vi.fn(),
  dark: false,
  onToggleDark: vi.fn(),
  onShowSettings: vi.fn()
})

const canvasButtons = ['Model', 'Process', 'Tags']
// Export belongs to the same family — it acts on the model as a whole and reached the toolbar for
// the same reason: saving a model meant leaving the page you were working on.
const canvasOnly = [...canvasButtons, 'Export model']

describe('ModelToolbar', () => {
  it('offers the canvas actions on the model page', () => {
    render(<ModelToolbar {...props('model')} />)
    for (const name of canvasOnly) expect(screen.getByRole('button', { name })).toBeTruthy()
  })

  for (const view of ['report', 'parameters', 'scenarios'] as ViewKey[]) {
    it(`hides them on ${view}, and keeps Undo there`, () => {
      render(<ModelToolbar {...props(view)} />)
      for (const name of canvasOnly) expect(screen.queryByRole('button', { name })).toBeNull()
      expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
    })
  }

  // Distances belongs where a transport leg gets its kilometres — the three pages that hold amounts,
  // parameters and scenario overrides — and nowhere a distance cannot be used.
  for (const view of ['model', 'parameters', 'scenarios'] as ViewKey[]) {
    it(`offers Distances on ${view}`, () => {
      render(<ModelToolbar {...props(view)} />)
      expect(screen.getByRole('button', { name: 'Distances' })).toBeTruthy()
    })
  }
  for (const view of ['report', 'overview', 'lcia', 'results'] as ViewKey[]) {
    it(`has no Distances button on ${view}`, () => {
      render(<ModelToolbar {...props(view)} />)
      expect(screen.queryByRole('button', { name: 'Distances' })).toBeNull()
    })
  }
})

/**
 * The FU pill names what Calculate will compute — and only once that is decided. It used to read
 * "FU: 1 unit" with nothing selected, a functional unit that did not exist.
 */
describe('the FU pill', () => {
  it('asks for a process until exactly one is selected', () => {
    const { rerender } = render(<ModelToolbar {...props('model')} selectedCount={0} />)
    expect(screen.getByText('FU: select a process')).toBeTruthy()
    rerender(<ModelToolbar {...props('model')} selectedCount={3} />)
    expect(screen.getByText('FU: select one process')).toBeTruthy()
  })

  it('names the unit, and the process in its tooltip', () => {
    render(<ModelToolbar {...props('model')} selectedCount={1} fuUnit="kg" fuName="Granulate" />)
    const pill = screen.getByText('FU: 1 kg')
    expect(pill.getAttribute('title')).toContain('1 kg of Granulate')
  })
})
