/**
 * Generate `docs/ai-tool-manifest.json` — the machine-readable contract of everything the built-in
 * assistant can do.
 *
 * Why this exists: the app embeds its chatbot directly, so there is no MCP server today. But the
 * API stays the canonical capability surface (ADR-003/011), and if an EXTERNAL agent (Claude
 * Desktop, a script, an MCP server) should ever drive PrismLCA, whoever writes it needs the tool
 * contract without reading TypeScript. `surface` says whether a tool is a thin HTTP wrapper
 * (portable — an MCP server can offer it) or a renderer action (`ui`, only meaningful inside the
 * app window).
 *
 * Run with:  npm run tools:manifest   (bundles via esbuild, so no TS runner dependency is needed;
 * paths are resolved from the working directory, i.e. it must run from `frontend/`).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MUTATING_TOOLS, TOOLS, toolCatalog } from '../src/main/ai/tools'

// `surface` is a field on the Tool itself (tools.ts) — this script used to keep its own name
// lists, and they drifted: canvas_view was listed by its four IMPL action names (not tool names),
// so the manifest called a renderer-driving tool "api".

const meta = new Map(toolCatalog().map((e) => [e.name, e]))

const manifest = {
  generated_by: 'frontend/scripts/dump-tool-manifest.ts (npm run tools:manifest)',
  note:
    'Canonical capability surface of the PrismLCA assistant. surface="api" tools are thin wrappers ' +
    'around the local FastAPI and are portable to an external MCP server; surface="ui" tools drive ' +
    'the Electron renderer and only work inside the app; surface="subagent" tools are backed by a ' +
    'nested LLM research loop (web search only) and would have to be reimplemented, not wrapped.',
  tool_count: TOOLS.length,
  tools: TOOLS.map((t) => {
    const f = t.spec.function
    const m = meta.get(f.name)
    return {
      name: f.name,
      label: m?.label ?? f.name,
      group: m?.group ?? 'Other',
      description: f.description,
      surface: t.surface ?? 'api',
      mutating: MUTATING_TOOLS.has(f.name),
      parameters: f.parameters
    }
  })
}

const out = join(process.cwd(), '..', 'docs', 'ai-tool-manifest.json')
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
console.log(`wrote ${out} (${manifest.tool_count} tools)`)
