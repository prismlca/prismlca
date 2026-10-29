/**
 * Off means invisible for the web, as for distances and Eurostat: with web search off for a chat, the
 * model is neither offered `research_web` / `research_bom` nor told about them in the system prompt —
 * it used to get both, and a call then came back asking the user to switch the web on.
 */
import { describe, expect, it } from 'vitest'
import { toolSpecs } from './tools/focus'
import { buildSystemPrompt } from './systemPrompt'

const names = (specs: ReturnType<typeof toolSpecs>): string[] => specs.map((s) => s.function.name)

describe('web research tools: offered only with web search on', () => {
  it('drops both specs when the web is off, and only those two', () => {
    const on = toolSpecs(true)
    expect(names(on)).toEqual(expect.arrayContaining(['research_web', 'research_bom']))
    const off = toolSpecs(true, undefined, undefined, undefined, true, true, true, false)
    expect(names(off)).not.toContain('research_web')
    expect(names(off)).not.toContain('research_bom')
    expect(names(off)).toContain('eurostat_eol')
    expect(off.length).toBe(on.length - 2)
  })

  it('the system prompt names them only when they are offered', () => {
    const base = { activeDb: 'Model A', skills: [] }
    const on = buildSystemPrompt({ ...base, research: true })
    const off = buildSystemPrompt({ ...base, research: false })
    expect(on).toContain('`research_bom`')
    expect(on).toContain('`research_web`')
    expect(on).toMatch(/Other web facts/)
    for (const text of [off, buildSystemPrompt(base)]) {
      expect(text).not.toMatch(/research_(web|bom)/)
      expect(text).not.toMatch(/Other web facts/)
    }
    // Eurostat is its own switch: on without the web, its bullet stays.
    expect(buildSystemPrompt({ ...base, research: false, eurostat: true })).toContain('`eurostat_eol`')
  })
})
