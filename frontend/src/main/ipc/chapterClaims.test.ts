import { describe, expect, it } from 'vitest'
import { chapterKey, claimChapters } from './chapterClaims'

const BASE = '/api/v1/report/one/db/rep-1'

describe('one writer per chapter', () => {
  it('refuses a second run on a chapter that is being written, and frees it when the first ends', () => {
    const release = claimChapters([chapterKey(BASE, 's1'), chapterKey(BASE, 's2')])
    expect(() => claimChapters([chapterKey(BASE, 's2')])).toThrow(/already working on this chapter/)
    // Another chapter of the same report is free, and so is the same id in another report.
    claimChapters([chapterKey(BASE, 's3')])()
    claimChapters([chapterKey('/api/v1/report/one/db/rep-2', 's1')])()
    release()
    claimChapters([chapterKey(BASE, 's2')])()
  })

  it('takes nothing when it refuses', () => {
    const release = claimChapters([chapterKey(BASE, 'a')])
    expect(() => claimChapters([chapterKey(BASE, 'b'), chapterKey(BASE, 'a')])).toThrow()
    // `b` was not left taken by the refused run.
    claimChapters([chapterKey(BASE, 'b')])()
    release()
  })
})
