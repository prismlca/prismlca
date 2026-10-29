/**
 * Off means invisible: with the distances feature off for a chat, the model is
 * neither offered the tool nor told about it in the system prompt. Both halves, because either one
 * alone leaves the model asking for something it cannot call.
 */
import { describe, expect, it } from 'vitest'
import { toolSpecs } from './tools/focus'
import { PARALLEL_SAFE_TOOLS, TOOLS } from './tools/registry'
import { buildSystemPrompt } from './systemPrompt'

const names = (specs: ReturnType<typeof toolSpecs>): string[] => specs.map((s) => s.function.name)

describe('distances: offered only when available', () => {
  it('is in the registry, parallel-safe, and offered by default', () => {
    expect(TOOLS.some((t) => t.spec.function.name === 'distances')).toBe(true)
    expect(PARALLEL_SAFE_TOOLS.has('distances')).toBe(true)
    expect(names(toolSpecs(true))).toContain('distances')
    expect(names(toolSpecs(true, undefined, undefined, undefined, true))).toContain('distances')
  })

  it('drops the spec entirely when the feature is off for the chat', () => {
    const specs = toolSpecs(true, undefined, undefined, undefined, false)
    expect(names(specs)).not.toContain('distances')
    // Nothing else moved.
    expect(specs.length).toBe(toolSpecs(true).length - 1)
  })

  it('the system prompt mentions the tool only when it is offered', () => {
    const base = { activeDb: 'Model A', skills: [] }
    const on = buildSystemPrompt({ ...base, distances: true })
    const off = buildSystemPrompt({ ...base, distances: false })
    const unsaid = buildSystemPrompt(base)
    expect(on).toContain('`distances`')
    expect(on).toMatch(/rail infrastructure/)
    expect(off).not.toContain('`distances`')
    expect(off).not.toMatch(/Transport distances/)
    expect(unsaid).not.toContain('`distances`')
    // The research bullet no longer sends distances to the web when the tool exists.
    expect(on).not.toMatch(/material compositions, transport distances/)
  })
})
