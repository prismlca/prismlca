import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openPath: async () => '' } }))

const { summarySection } = await import('./licence')

describe('summarySection', () => {
  it('returns the Summary section up to the next second-level heading', () => {
    const md = [
      '# PrismLCA third-party notices',
      '',
      'Generated.',
      '',
      '## Summary',
      '',
      '### Python runtime packages (1)',
      '',
      '| Package | Version | Licence | Note |',
      '|---|---|---|---|',
      '| bw2data | 4.7 | BSD-3-Clause |  |',
      '',
      '## Python packages',
      '',
      'MIT License …'
    ].join('\n')
    const out = summarySection(md)
    expect(out.startsWith('## Summary')).toBe(true)
    expect(out).toContain('| bw2data | 4.7 | BSD-3-Clause |  |')
    expect(out).not.toContain('## Python packages')
    expect(out).not.toContain('MIT License')
  })

  it('is empty when there is no summary', () => {
    expect(summarySection('# Notices\n\nnothing here')).toBe('')
  })
})
