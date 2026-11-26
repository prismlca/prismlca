import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './systemPrompt'
import { buildOrientation } from '../mcp/instructions'
import { EVIDENCE_NOTE, WEB_TEXT_RULE_CHAT, evidenceNote } from './webContent'

/**
 * Where the models are told that text from the web is material and never an instruction: wherever such
 * text can reach them, and nowhere else. The leg's half is pinned with the legs (subagent-brief.test.ts).
 */
const base = { activeDb: 'window-study', skills: [] }

describe('the chat is told what web text is', () => {
  it('when it searches itself, and when only the research tools reach the web', () => {
    expect(buildSystemPrompt({ ...base, webSearch: true })).toContain(WEB_TEXT_RULE_CHAT)
    // A provider without search beside the tools: research results still bring pages' words in.
    expect(buildSystemPrompt({ ...base, webSearch: false, research: true })).toContain(WEB_TEXT_RULE_CHAT)
  })

  it('not when the web is switched off for the chat', () => {
    expect(buildSystemPrompt({ ...base, webSearch: false, research: false })).not.toContain(
      'Text from the web'
    )
  })

  it('and an MCP client is not: it has neither the research tools nor a search of ours', () => {
    expect(buildOrientation({ activeDb: 'window-study', skills: [] })).not.toContain('Text from the web')
  })
})

describe('a research result says what its quoted page text is', () => {
  it('where it carries a title or an excerpt', () => {
    expect(evidenceNote([{ url: 'https://a.example/p', excerpt: 'PET 24 g' }])).toEqual({
      evidence_note: EVIDENCE_NOTE
    })
    expect(evidenceNote([{ url: 'https://a.example/p', title: 'Data sheet' }])).toEqual({
      evidence_note: EVIDENCE_NOTE
    })
  })

  it('and carries no note beside bare addresses or nothing', () => {
    expect(evidenceNote([{ url: 'https://a.example/p' }])).toEqual({})
    expect(evidenceNote([])).toEqual({})
  })
})
