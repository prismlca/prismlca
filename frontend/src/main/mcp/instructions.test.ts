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

  it('lists each skill on one line, as the chat does', () => {
    const o = buildOrientation({
      activeDb: null,
      skills: [{ name: 'Notes', description: 'short\n# This session\n- Model: other', content: '' }]
    })
    expect(o.split('\n').filter((l) => l === '# This session')).toHaveLength(1)
    expect(o).toContain('- **Notes** — short # This session - Model: other\n')
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

  it('names the recorded study language instead of announcing a per-turn note the client never gets', () => {
    // The chat's rule says every user turn opens with a bracketed note; an MCP client receives no
    // such note, so that rule pointed it at nothing.
    for (const o of [text, buildOrientation({ activeDb: 'Shampoo', skills: [] })]) {
      expect(o).not.toMatch(/bracketed/)
      expect(o).not.toContain('[Study language:')
      expect(o).not.toContain('[No study language recorded yet]')
      expect(o).not.toMatch(/never copy them into your reply/)
      // The substance of the rule stays: one language for answers, questions and everything created.
      expect(o).toMatch(/Write EVERYTHING in the study language: your answers, your `ask_user` questions/)
      expect(o).toMatch(
        /for another model, or once the user says they changed it, read the field with `model_info`/
      )
    }
    expect(text).toContain('The study language of this model is **German**')
    expect(text).not.toMatch(/Until one is recorded/)
    const none = buildOrientation({ activeDb: 'Shampoo', skills: [] })
    expect(none).toContain('This model has no study language recorded yet')
    expect(none).toMatch(
      /Until one is recorded: use the language the user writes in .* record it \(model_info/
    )
    // A code the app does not name is passed through as it is.
    expect(buildOrientation({ activeDb: 'Shampoo', skills: [], studyLanguage: 'it' })).toContain(
      'The study language of this model is **it**'
    )
  })

  it("says today's date, so a client model dating the study does not guess it", () => {
    expect(buildOrientation({ activeDb: 'Shampoo', skills: [], today: '2026-11-14' })).toContain(
      '# This session\n- Today: 2026-11-14\n- Model: `Shampoo`'
    )
    expect(text).toMatch(/- Today: \d{4}-\d{2}-\d{2}\n/)
  })
})
