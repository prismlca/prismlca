/**
 * The canvas keys of a view follow its model's name — the renderer's half of the backend's
 * `rename_canvas_keys`. Without it a renamed model's cached view still keyed its positions, colours and
 * group boxes by the old name, and a write still pending sent them back.
 */
import { describe, expect, it } from 'vitest'
import { renameCanvasKeys } from './canvasKeys'
import { renameDatabaseInView } from './subjectKey'

describe('renameCanvasKeys', () => {
  it('moves positions, node colours, group members and placed reference boxes', () => {
    const out = renameCanvasKeys(
      {
        layout: {
          pos: { 'B/root': { x: 1, y: 2 }, 'ecoinvent/hex': { x: 3, y: 4 } },
          refs: [
            { id: 'B/sub#new-1', dataset_id: 'B/sub', name: 'sub', location: null, unit: null, x: 0, y: 0 }
          ]
        },
        colors: { 'B/root': '#111111' },
        groups: [{ id: 'g1', color: '#000000', members: ['B/root', 'ecoinvent/hex'] }]
      },
      'B',
      'B2'
    )
    expect(out).toEqual({
      layout: {
        pos: { 'B2/root': { x: 1, y: 2 }, 'ecoinvent/hex': { x: 3, y: 4 } },
        refs: [
          { id: 'B2/sub#new-1', dataset_id: 'B2/sub', name: 'sub', location: null, unit: null, x: 0, y: 0 }
        ]
      },
      colors: { 'B2/root': '#111111' },
      groups: [{ id: 'g1', color: '#000000', members: ['B2/root', 'ecoinvent/hex'] }]
    })
  })

  it('leaves a model whose name only starts with the old one alone', () => {
    expect(renameCanvasKeys({ layout: { pos: { 'A/B/x': 1 } } }, 'A', 'C')).toBeNull()
  })

  it('is part of renaming a whole view', () => {
    const out = renameDatabaseInView({ layout: { pos: { 'B/root': { x: 1, y: 2 } } } }, 'B', 'B2')
    expect(out).toEqual({ layout: { pos: { 'B2/root': { x: 1, y: 2 } } } })
  })
})
