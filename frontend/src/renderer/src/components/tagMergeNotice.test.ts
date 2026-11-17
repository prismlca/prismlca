import { describe, expect, it } from 'vitest'
import { mergeNotice } from './tagMergeNotice'

describe('the merge confirm’s notice', () => {
  it('names what a group merge takes along, in one sentence', () => {
    const preview = {
      views: ['the Results split', 'the Detailed results grouping'],
      reports: [{ id: 'rep-1', name: 'Study' }]
    }
    expect(mergeNotice(preview, 'Bauteil', null, 'Component')).toBe(
      'The Results split, the Detailed results grouping and report “Study” use “Bauteil” and will use “Component”.'
    )
    expect(mergeNotice({ views: [], reports: [{ id: 'rep-1', name: '' }] }, 'A', null, 'B')).toBe(
      'Report “rep-1” uses “A” and will use “B”.'
    )
  })

  it('adds the backend’s sentence about the reports that split by both groups', () => {
    const note =
      'Report “Both” already splits by both groups and keeps its breakdowns; change them in the report.'
    const preview = {
      views: ['the Results split'],
      reports: [],
      reports_kept: [{ id: 'r', name: 'Both' }],
      note
    }
    expect(mergeNotice(preview, 'A', null, 'B')).toBe(`The Results split uses “A” and will use “B”. ${note}`)
    expect(mergeNotice({ ...preview, views: [] }, 'A', null, 'B')).toBe(note)
  })

  it('says nothing when the merge touches only the tags', () => {
    expect(mergeNotice({ views: [], reports: [] }, 'A', null, 'B')).toBe('')
    expect(mergeNotice({ reports_citing: [] }, 'A', 'x', 'y')).toBe('')
  })

  it('passes on the backend’s sentence about the reports citing a merged value', () => {
    const note =
      'Report “Study” (2 chapters) cites “x”; those figures show as missing until the chapters are updated.'
    expect(
      mergeNotice({ reports_citing: [{ id: 'r', name: 'Study', chapters: 2 }], note }, 'A', 'x', 'y')
    ).toBe(note)
  })
})
