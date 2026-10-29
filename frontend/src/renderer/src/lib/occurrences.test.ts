import { describe, expect, it } from 'vitest'
import type { Node } from '@xyflow/react'
import { splitId } from './canvas'
import {
  applyManualBoxes,
  boxTags,
  connectBody,
  edgeShareFor,
  pendingCopyId,
  placeByDataset,
  reconcileBoxes,
  shareFor,
  shownTags,
  tagKey
} from './occurrences'

const box = (id: string, data: Record<string, unknown>): Node =>
  ({ id, type: 'prism', position: { x: 0, y: 0 }, data: { readOnly: true, ...data } }) as Node

describe('box ids', () => {
  it('splitId answers the dataset for a box of it', () => {
    expect(splitId('ei/elec#3f2a91c04d1e')).toEqual(['ei', 'elec'])
    expect(splitId('ei/elec#new-2')).toEqual(['ei', 'elec'])
    expect(splitId('ei/coal#ei/elec#3f2a91c04d1e')).toEqual(['ei', 'coal'])
    expect(splitId('m1/a/b')).toEqual(['m1', 'a/b'])
    // A process code that contains '#' is not an occurrence and stays whole.
    expect(splitId('m1/mix#v2')).toEqual(['m1', 'mix#v2'])
  })

  it('a copy gets the next free id', () => {
    expect(pendingCopyId('ei/e', ['ei/e', 'ei/e#new-1'])).toBe('ei/e#new-2')
  })

  it('compares tags without regard to order', () => {
    const a = [
      { dimension: 'Phase', value: 'Use' },
      { dimension: 'Part', value: 'Lid' }
    ]
    expect(tagKey(a)).toBe(tagKey([...a].reverse()))
  })
})

describe('reconcileBoxes', () => {
  it('hands a re-tagged box the place of the box that shared its inputs', () => {
    const current = [box('ei/e', { uids: ['u1', 'u2'] }), box('ei/e#0123456789ab', { uids: ['u3'] })]
    const moves = reconcileBoxes(current, [
      { id: 'ei/e#ba9876543210', dataset_id: 'ei/e', uids: ['u1', 'u2'] }
    ])
    expect(moves.get('ei/e#ba9876543210')).toBe('ei/e')
  })

  it('leaves a box that is on the canvas already alone', () => {
    const current = [box('ei/e', { uids: ['u1'] }), box('ei/e#ba9876543210', { uids: ['u2'] })]
    expect(reconcileBoxes(current, [{ id: 'ei/e#ba9876543210', uids: ['u1', 'u2'] }]).size).toBe(0)
  })

  it('never hands a copy of the user to another box', () => {
    const current = [box('ei/e#new-1', { uids: [], datasetId: 'ei/e' })]
    expect(
      reconcileBoxes(current, [{ id: 'ei/e#0123456789ab', dataset_id: 'ei/e', uids: ['u5'] }]).size
    ).toBe(0)
  })

  it('falls back to the node of the same dataset that left (a process that became a box)', () => {
    const current = [box('lib/p', { uids: [] })]
    const moves = reconcileBoxes(current, [{ id: 'lib/p#abcdef012345', dataset_id: 'lib/p', uids: ['u9'] }])
    expect(moves.get('lib/p#abcdef012345')).toBe('lib/p')
  })
})

describe('connecting from a box', () => {
  it('hands the box tags to the new input, and a copy its pending ones', () => {
    const tagged = box('ei/e#0123456789ab', {
      uids: ['u2'],
      tags: [{ dimension: 'Phase', value: 'Use', color: 'x' }]
    })
    const copy = box('ei/e#new-1', {
      uids: [],
      pendingTags: [{ dimension: 'Phase', value: 'Raw materials' }]
    })
    expect(connectBody('ei/e#0123456789ab', 'm1/a', 2, [tagged])).toMatchObject({
      input_database: 'ei',
      input_code: 'e',
      activity_code: 'a',
      tags: { Phase: 'Use' }
    })
    expect(connectBody('ei/e#new-1', 'm1/a', 1, [copy]).tags).toEqual({ Phase: 'Raw materials' })
    expect(boxTags(tagged)).toEqual([{ dimension: 'Phase', value: 'Use' }])
    expect('tags' in connectBody('m1/b', 'm1/a', 1, [box('m1/b', { readOnly: false })])).toBe(false)
  })

  it('hands on only what the inputs hold themselves — an inherited value stays with its process', () => {
    const under = box('ei/e#0123456789ab', {
      uids: ['u1'],
      tags: [
        { dimension: 'Phase', value: 'Production', inherited: true, color: 'x' },
        { dimension: 'Part', value: 'Lid', color: 'y' }
      ]
    })
    expect(connectBody('ei/e#0123456789ab', 'm1/a', 1, [under]).tags).toEqual({ Part: 'Lid' })
    expect(boxTags(under)).toEqual([{ dimension: 'Part', value: 'Lid' }])
    expect(shownTags(under)).toEqual([
      { dimension: 'Phase', value: 'Production', inherited: true },
      { dimension: 'Part', value: 'Lid' }
    ])
    const plain = box('ei/e#0123456789ac', {
      uids: ['u2'],
      tags: [{ dimension: 'Phase', value: 'Production', inherited: true }]
    })
    expect('tags' in connectBody('ei/e#0123456789ac', 'm1/a', 1, [plain])).toBe(false)
  })
})

describe('opening a model whose boxes changed their ids meanwhile', () => {
  it('a box takes the stored spot of its dataset that no box uses any more', () => {
    const stored = { 'ei/e': {}, 'ei/s#0123456789ab': {}, 'ei/k': {}, 'm1/a': {} }
    const next = [
      { id: 'ei/e#aaaaaaaaaaaa', dataset_id: 'ei/e', uids: ['u1'] },
      { id: 'ei/e#bbbbbbbbbbbb', dataset_id: 'ei/e', uids: ['u2'] },
      { id: 'ei/s#cccccccccccc', dataset_id: 'ei/s', uids: ['u3'] },
      { id: 'ei/k', dataset_id: 'ei/k', uids: ['u4'] }
    ]
    expect(placeByDataset(next, stored)).toEqual(
      new Map([
        ['ei/e#aaaaaaaaaaaa', 'ei/e'],
        ['ei/s#cccccccccccc', 'ei/s#0123456789ab']
      ])
    )
  })

  it('never takes the spot of a copy or of a node under an expanded box', () => {
    const stored = { 'ei/e#new-1': {}, 'ei/e#ei/x#0123456789ab': {} }
    expect(placeByDataset([{ id: 'ei/e#aaaaaaaaaaaa', dataset_id: 'ei/e' }], stored).size).toBe(0)
  })
})

describe('Sankey shares', () => {
  const meta = { total: 10, unit: 'kg', method: [], n_nodes: 1, inputs: { u1: 2, u2: 3 } }
  it('a box carries its own inputs, an arrow its own input', () => {
    expect(
      shareFor(box('ei/e#0123456789ab', { uids: ['u1', 'u2'] }), { 'ei/e#0123456789ab': 0.9 }, meta)
    ).toBeCloseTo(0.5)
    expect(shareFor(box('m1/a', { readOnly: false }), { 'm1/a': 0.7 }, meta)).toBe(0.7)
    expect(edgeShareFor({ source: 'ei/e', data: { uid: 'u1' } }, { 'ei/e': 0.9 }, meta)).toBeCloseTo(0.2)
    expect(edgeShareFor({ source: 'm1/b', data: { uid: 'u7' } }, { 'm1/b': 0.4 }, meta)).toBe(0.4)
  })
})

describe('copies the user connected', () => {
  it('stay a box of their own, with the inputs the view remembers', () => {
    const graph = {
      bg_nodes: [{ id: 'ei/e', dataset_id: 'ei/e', uids: ['u1', 'u3'], tags: [] }],
      bg_edges: [
        { uid: 'u1', source: 'ei/e' },
        { uid: 'u3', source: 'ei/e' }
      ]
    }
    const out = applyManualBoxes(graph, { 'ei/e#new-1': { dataset: 'ei/e', uids: ['u3', 'gone'] } })
    expect(out.bg_nodes!.map((n) => [n.id, n.uids])).toEqual([
      ['ei/e', ['u1']],
      ['ei/e#new-1', ['u3']]
    ])
    expect(out.bg_edges!.find((e) => e.uid === 'u3')!.source).toBe('ei/e#new-1')
  })

  it('answer for their own tags: a copy of inputs that only inherit hands nothing on', () => {
    const phase = { dimension: 'Phase', value: 'Production' }
    const graph = {
      // One box: u1 holds Production itself, u3 takes it from its process — so the box holds it.
      bg_nodes: [{ id: 'ei/e#aaaaaaaaaaaa', dataset_id: 'ei/e', uids: ['u1', 'u3'], tags: [phase] }],
      bg_edges: [
        { uid: 'u1', source: 'ei/e#aaaaaaaaaaaa', tags: [phase] },
        { uid: 'u3', source: 'ei/e#aaaaaaaaaaaa', tags: [] }
      ]
    }
    const out = applyManualBoxes(graph, { 'ei/e#new-1': { dataset: 'ei/e', uids: ['u3'] } })
    const tagsOf = (id: string) => out.bg_nodes!.find((n) => n.id === id)!.tags
    expect(tagsOf('ei/e#aaaaaaaaaaaa')).toEqual([phase])
    expect(tagsOf('ei/e#new-1')).toEqual([{ ...phase, inherited: true }])
  })

  it('leave the graph alone when nothing is remembered or nothing is left', () => {
    const graph = { bg_nodes: [{ id: 'ei/e', uids: ['u1'] }], bg_edges: [{ uid: 'u1', source: 'ei/e' }] }
    expect(applyManualBoxes(graph, {})).toBe(graph)
    expect(applyManualBoxes(graph, { 'ei/e#new-1': { dataset: 'ei/e', uids: ['x'] } }).bg_nodes).toHaveLength(
      1
    )
  })
})
