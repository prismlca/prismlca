import { describe, expect, it } from 'vitest'

import { INSTRUCTIONS, INSTRUCTIONS_MAX_CHARS, buildOrientation, stripBullets } from './instructions'
import { MCP_EXCLUDED_TOOLS } from './catalog'

describe('MCP instructions', () => {
  it('stay under the client cut-off and point at orientation', () => {
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS)
    expect(INSTRUCTIONS).toMatch(/FIRST call `orientation`/)
    for (const name of MCP_EXCLUDED_TOOLS) expect(INSTRUCTIONS).not.toContain(name)
  })
})

describe('stripBullets', () => {
  it('drops a whole bullet with its continuation lines, keeps the rest', () => {
    const text = [
      '# H',
      '- keep me',
      '- drop research_web here',
      '  and this continuation',
      '- keep too',
      '',
      'para'
    ].join('\n')
    expect(stripBullets(text)).toBe(['# H', '- keep me', '- keep too', '', 'para'].join('\n'))
  })
})

describe('buildOrientation', () => {
  const text = buildOrientation({
    activeDb: 'Shampoo',
    skills: [{ name: 'Parameters & formulas', description: 'formula syntax', content: '' }],
    backgroundDbs: ['ecoinvent-3.12-cutoff', 'bafu-2026-v1'],
    preferredBackground: 'ecoinvent-3.12-cutoff',
    studyLanguage: 'de',
    study: { goal: 'Carbon footprint of 1 l shampoo' },
    clientName: 'Claude Code'
  })

  it('replaces the chat preamble and keeps the modelling rules', () => {
    expect(text).toMatch(/^# You are an external agent \(Claude Code\)/)
    expect(text).not.toContain('You are the assistant built into')
    expect(text).toContain('# LCA modelling conventions')
    expect(text).toContain('Sign convention for waste')
    expect(text).toContain('`ecoinvent-3.12-cutoff`')
    expect(text).toContain('Parameters & formulas')
    expect(text).toContain('German')
  })

  it('names no tool the catalogue does not carry, and no in-app-only feature', () => {
    // Whole words: `plan` is a tool name AND an English word ("explanation" contains it), and the
    // prompt writes tool names in backticks anyway — so a tool is "named" when it stands alone.
    for (const name of MCP_EXCLUDED_TOOLS) expect(text, name).not.toMatch(new RegExp(`\\b${name}\\b`))
    expect(text).not.toContain('prism:process/')
    // The chat's "+" menu of switches is the chat's; an external session has none.
    expect(text).not.toContain('left of the chat input')
  })

  it('ends with the session block: model and study metadata', () => {
    expect(text).toContain('# This session')
    expect(text).toContain('`Shampoo`')
    expect(text).toContain('Carbon footprint of 1 l shampoo')
    const withNotes = buildOrientation({
      activeDb: null,
      skills: [],
      toolNotes: { search_background: 'FULL TEXT' }
    })
    expect(withNotes).toContain('# Tool notes')
    expect(withNotes).toContain('## search_background\nFULL TEXT')
    const none = buildOrientation({ activeDb: null, skills: [] })
    expect(none).toContain('none open')
    expect(none).toContain('No study metadata recorded yet')
  })
})
