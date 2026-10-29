import { describe, expect, it } from 'vitest'
import { hasChanges, wordDiff } from './wordDiff'

const render = (parts: ReturnType<typeof wordDiff>, kind: string): string =>
  parts
    .filter((p) => p.kind === kind || p.kind === 'same')
    .map((p) => p.text)
    .join('')

describe('wordDiff', () => {
  it('reproduces both sides exactly', () => {
    const before = 'Packaging dominates the balance with 60 %.'
    const after = 'Packaging contributes to the balance with 12 %.'
    const parts = wordDiff(before, after)
    expect(render(parts, 'removed')).toBe(before)
    expect(render(parts, 'added')).toBe(after)
  })

  it('marks only what moved', () => {
    const parts = wordDiff('the EF v3.1 method', 'the CML v4.8 method')
    const same = parts
      .filter((p) => p.kind === 'same')
      .map((p) => p.text.trim())
      .filter(Boolean)
    expect(same).toContain('the')
    expect(same).toContain('method')
    expect(hasChanges(parts)).toBe(true)
  })

  it('says so when nothing changed', () => {
    const parts = wordDiff('unchanged text here', 'unchanged text here')
    expect(hasChanges(parts)).toBe(false)
    expect(parts).toHaveLength(1)
  })

  it('handles an empty side', () => {
    expect(hasChanges(wordDiff('', 'all new'))).toBe(true)
    expect(wordDiff('gone', '').every((p) => p.kind === 'removed')).toBe(true)
  })
})
