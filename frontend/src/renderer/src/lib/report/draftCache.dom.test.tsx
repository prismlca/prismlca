import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { draftKey, loadDrafts, saveDrafts } from './draftCache'
import useChapterWriter from '../../views/report/useChapterWriter'
import type { StoredReportFull } from './model'

/**
 * V424a: a chapter the gate refused three times was "kept as a draft" — in React state only. After a
 * renderer reload (and after a hot reload that remounted the panel) the paid text was gone, the list read
 * "2 chapters empty", and the writer report said "Nothing to report" over the refused chapter. The drafts
 * and the gate's reasons for them are mirrored into localStorage per report, as a per-viewer cache.
 */
const BASE = '/api/v1/report/one/db/rep-1'
const OTHER = '/api/v1/report/one/db/rep-2'
const REASON = { kind: 'unsupported', detail: '“31 %” does not appear in the results handed over.' }

afterEach(() => localStorage.clear())

describe('the draft cache', () => {
  it('round-trips a draft with its reasons, per report', () => {
    saveDrafts(BASE, { c1: { text: 'Die Sachbilanz …', model: 'm' } }, { c1: [REASON], c2: [REASON] })
    const back = loadDrafts(BASE)
    expect(back.drafts).toEqual({ c1: { text: 'Die Sachbilanz …', model: 'm' } })
    // Only a draft's reasons are kept — a stored chapter's remarks stay per session.
    expect(back.findings).toEqual({ c1: [REASON] })
    expect(loadDrafts(OTHER)).toEqual({ drafts: {}, findings: {} })
  })

  it('removes the key when the last draft is gone', () => {
    saveDrafts(BASE, { c1: { text: 'x y' } }, {})
    saveDrafts(BASE, {}, {})
    expect(localStorage.getItem(draftKey(BASE))).toBeNull()
  })

  it('treats garbage as a cache miss', () => {
    localStorage.setItem(draftKey(BASE), '{not json')
    expect(loadDrafts(BASE)).toEqual({ drafts: {}, findings: {} })
  })

  it('keeps the text when the quota refuses the lookups', () => {
    const real = Storage.prototype.setItem
    let calls = 0
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k, v) {
      calls++
      if (calls === 1) throw new Error('QuotaExceededError')
      return real.call(this, k, v)
    })
    saveDrafts(BASE, { c1: { text: 'kept', lookups: [{ big: 'x'.repeat(10) }] } }, { c1: [REASON] })
    spy.mockRestore()
    expect(loadDrafts(BASE).drafts.c1).toEqual({ text: 'kept' })
  })
})

const props = (base: string) => ({
  base,
  database: 'db',
  reportLang: 'de',
  studyLang: 'de',
  studyLangGuessed: false,
  reportRef: { current: null as StoredReportFull | null },
  stale: {},
  blocker: () => null,
  mutate: async () => true,
  load: async () => {},
  loadStaleness: async () => null,
  setStale: vi.fn(),
  setStaleFailure: vi.fn(),
  mergeCorrectionTried: vi.fn(),
  setError: vi.fn(),
  openChapter: vi.fn(),
  openWriterReport: vi.fn()
})

describe('useChapterWriter with the cache', () => {
  it('brings a refused chapter back after a remount, reasons included', () => {
    saveDrafts(BASE, { lci: { text: 'Entwurf der Sachbilanz' } }, { lci: [REASON] })
    const { result } = renderHook(() => useChapterWriter(props(BASE)))
    expect(result.current.drafts.lci?.text).toBe('Entwurf der Sachbilanz')
    expect(result.current.findings.lci).toEqual([REASON])
  })

  it('a later run storing another chapter leaves the refused one and its reasons alone', () => {
    saveDrafts(BASE, { lci: { text: 'Entwurf' } }, { lci: [REASON] })
    const { result } = renderHook(() => useChapterWriter(props(BASE)))
    act(() => result.current.setFindings((f) => ({ ...f, summary: [] })))
    expect(loadDrafts(BASE).findings.lci).toEqual([REASON])
    expect(result.current.findings.lci).toEqual([REASON])
  })

  it('discarding the draft clears it from the cache too', () => {
    saveDrafts(BASE, { lci: { text: 'Entwurf' } }, { lci: [REASON] })
    const { result } = renderHook(() => useChapterWriter(props(BASE)))
    act(() => result.current.discardDraft('lci'))
    expect(localStorage.getItem(draftKey(BASE))).toBeNull()
  })

  it('switching reports loads the other report’s drafts and never writes one into the other', () => {
    saveDrafts(BASE, { lci: { text: 'Entwurf A' } }, {})
    saveDrafts(OTHER, { goal: { text: 'Entwurf B' } }, {})
    const { result, rerender } = renderHook((p: ReturnType<typeof props>) => useChapterWriter(p), {
      initialProps: props(BASE)
    })
    rerender(props(OTHER))
    // The panel calls reset() from its report-switch effect.
    act(() => result.current.reset())
    expect(Object.keys(result.current.drafts)).toEqual(['goal'])
    expect(loadDrafts(BASE).drafts).toEqual({ lci: { text: 'Entwurf A' } })
    expect(loadDrafts(OTHER).drafts).toEqual({ goal: { text: 'Entwurf B' } })
  })
})
