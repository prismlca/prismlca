import { describe, expect, it } from 'vitest'
import { forReader, LOOKUP_CHARS, researchDigest } from './readerEvidence'

const finding = (text: string, sources: string[] = ['https://example.org/a']) => ({
  text,
  sources,
  source_class: 'official',
  confidence: 'high',
  confidence_note: 'x'.repeat(300),
  cited_by_search: true
})
const answer = (question: string, texts: string[]) => ({
  question,
  findings: texts.map((t) => finding(t)),
  sources: ['https://example.org/a'],
  unsourced_dropped: 0,
  evidence: [{ quote: 'raw page text '.repeat(400) }]
})

describe('what the second reader sees of a literature search', () => {
  it('shows every question of a batch, past where the old 4 000-character cut fell', () => {
    const batch = {
      total: 3,
      succeeded: 2,
      failed: 1,
      results: [
        {
          i: 0,
          ok: true,
          result: answer('Which EU rules apply?', ['Surfactants must be 60 % biodegradable.'])
        },
        { i: 1, ok: false, error: '503 Service Unavailable' },
        {
          i: 2,
          ok: true,
          result: answer('Published LCAs?', ['Golsteijn et al. (2015) found chemicals dominate.'])
        }
      ]
    }
    const raw = JSON.stringify(batch)
    expect(raw.indexOf('Golsteijn')).toBeGreaterThan(4_000)

    const shown = forReader({ name: 'research_web', args: '{}', result: raw })
    expect(shown).toContain('Question 1: Which EU rules apply?')
    expect(shown).toContain('Surfactants must be 60 % biodegradable.')
    expect(shown).toContain('Question 2: failed — 503 Service Unavailable')
    expect(shown).toContain('Golsteijn et al. (2015) found chemicals dominate.')
    expect(shown).toContain('https://example.org/a')
    // The raw excerpts and the bookkeeping are left out: they are what made the result long.
    expect(shown).not.toContain('raw page text')
    expect(shown).not.toContain('confidence_note')
    expect(shown.length).toBeLessThan(1_000)
  })

  it('shows a single answer the same way, and a source the text names only once', () => {
    const one = answer('EU rules?', ['Rule X applies (https://example.org/a).'])
    expect(researchDigest(JSON.stringify(one))).toBe(
      'Question: EU rules?\n  - Rule X applies (https://example.org/a).'
    )
  })

  it('passes anything else through, cut later than before', () => {
    const doc = 'a'.repeat(7_000) + ' extrapolated from Europe, data year 2015'
    expect(forReader({ name: 'get_process_details', args: '{}', result: doc })).toContain('data year 2015')
    const long = 'b'.repeat(LOOKUP_CHARS + 50)
    expect(forReader({ name: 'get_process_details', args: '{}', result: long })).toMatch(/… \[cut\]$/)
    expect(forReader({ name: 'research_web', args: '{}', result: 'Error: timeout' })).toBe('Error: timeout')
  })
})
