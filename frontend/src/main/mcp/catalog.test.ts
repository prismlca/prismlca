import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { MCP_EXCLUDED_TOOLS, ORIENTATION_TOOL, isMcpTool, mcpToolDefs } from './catalog'

type ManifestTool = { name: string; surface?: 'api' | 'ui' | 'subagent' }
const manifest = JSON.parse(
  readFileSync(join(__dirname, '../../../../docs/ai-tool-manifest.json'), 'utf-8')
) as { tools: ManifestTool[] }

describe('MCP tool catalogue', () => {
  const all = mcpToolDefs({ distances: true, eurostat: true })
  const names = new Set(all.map((t) => t.name))

  it('offers every api and ui tool of the manifest, and none of the sub-agent tools', () => {
    for (const t of manifest.tools) {
      const surface = t.surface ?? 'api'
      if (surface === 'subagent') expect(names.has(t.name), t.name).toBe(false)
      else if (MCP_EXCLUDED_TOOLS.has(t.name)) expect(names.has(t.name), t.name).toBe(false)
      else expect(names.has(t.name), t.name).toBe(true)
    }
    // Exactly one MCP-only addition: the bootstrap tool.
    const extra = [...names].filter((n) => !manifest.tools.some((t) => t.name === n))
    expect(extra).toEqual([ORIENTATION_TOOL])
  })

  it('puts orientation first and keeps our JSON schemas unchanged', () => {
    expect(all[0].name).toBe(ORIENTATION_TOOL)
    const search = all.find((t) => t.name === 'search_background')!
    expect(search.inputSchema).toHaveProperty('properties.query')
    expect(search.title).toBeTruthy()
  })

  it('annotates from the effects table and flags irreversible tools for the client', () => {
    const del = all.find((t) => t.name === 'delete_model')!
    expect(del.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(del._meta).toEqual({ 'anthropic/requiresUserInteraction': true })
    const read = all.find((t) => t.name === 'get_current_model')!
    expect(read.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(read._meta).toBeUndefined()
  })

  it('drops switched-off tools and the feature-gated ones exactly like the chat', () => {
    const some = mcpToolDefs({ disabledTools: ['edit_tags'], distances: false, eurostat: false })
    const n = new Set(some.map((t) => t.name))
    expect(n.has('edit_tags')).toBe(false)
    expect(n.has('distances')).toBe(false)
    expect(n.has('eurostat_eol')).toBe(false)
    expect(n.has('edit_process')).toBe(true)
  })

  it('keeps every description under the client cut-off and parks the rest in tool notes', () => {
    for (const t of all) expect(t.description.length, t.name).toBeLessThanOrEqual(2048)
    const shortened = all.filter((t) => t._note)
    expect(shortened.map((t) => t.name)).toContain('search_background')
    for (const t of shortened) {
      expect(t.description).toMatch(/Tool notes/)
      expect(t._note!.length).toBeGreaterThan(t.description.length)
      expect(t._note!.startsWith(t.description.slice(0, 200))).toBe(true)
    }
  })

  it('isMcpTool follows the same rule', () => {
    expect(isMcpTool(ORIENTATION_TOOL)).toBe(true)
    expect(isMcpTool('get_current_model')).toBe(true)
    expect(isMcpTool('research_web')).toBe(false)
    expect(isMcpTool('no_such_tool')).toBe(false)
  })
})
