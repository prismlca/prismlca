/**
 * What each client needs to start the bridge, as text to copy and as a change to its configuration
 * file (Settings → AI → MCP, "Configure"). Pure functions over strings: the
 * paths and the writing live in ipc/mcp.ts, so the merges are testable with fixtures.
 *
 * JetBrains' auto-configure is the model; the rule is that another
 * program's configuration is written only after the user has seen the change and clicked, with a
 * backup beside the file.
 */

export interface BridgeCommand {
  command: string
  args: string[]
  /** Variables the client must hand the bridge (Codex strips the environment; the app needs a display). */
  env?: Record<string, string>
}

/**
 * How to start the app, from what the process knows about itself. An AppImage runs from a temporary
 * mount: `execPath` points into it and is gone after exit, while the runtime puts the file the user
 * actually has in `APPIMAGE` — that is the path a client configuration must carry.
 */
export function appLaunchCommandFor(env: {
  isPackaged: boolean
  execPath: string
  appPath: string
  appImage?: string
}): BridgeCommand {
  if (!env.isPackaged) return { command: env.execPath, args: [env.appPath] }
  if (env.appImage) return { command: env.appImage, args: [] }
  return { command: env.execPath, args: [] }
}

export type ClientId = 'claude-code' | 'codex' | 'claude-desktop'

import { parse as parseToml } from 'smol-toml'

export interface ClientSpec {
  id: ClientId
  label: string
  /** Where the change goes, as the user knows the file. */
  configHint: string
}

export const CLIENTS: ClientSpec[] = [
  { id: 'claude-code', label: 'Claude Code', configHint: '~/.claude.json (user scope)' },
  { id: 'codex', label: 'Codex (CLI and app)', configHint: '~/.codex/config.toml' },
  { id: 'claude-desktop', label: 'Claude Desktop', configHint: 'claude_desktop_config.json' }
]

export const SERVER_KEY = 'prismlca'

/** Shell quoting that holds in bash, zsh, PowerShell and cmd for the paths we hand out: double
 *  quotes around anything with a space or a backslash; `"` inside is not a character in a path. */
function shellQuote(s: string): string {
  return /[\s\\"'$`]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

/** The one-liner for Claude Code: a stdio server at user scope, every project. */
export function claudeCodeAddCommand(cmd: BridgeCommand): string {
  return `claude mcp add --scope user ${SERVER_KEY} -- ${[cmd.command, ...cmd.args].map(shellQuote).join(' ')}`
}

/** The `mcpServers` entry Claude Code (~/.claude.json) and Claude Desktop (claude_desktop_config.json) share. */
export function mcpServersEntry(cmd: BridgeCommand): Record<string, unknown> {
  return { command: cmd.command, args: cmd.args }
}

export function claudeDesktopSnippet(cmd: BridgeCommand): string {
  return JSON.stringify({ mcpServers: { [SERVER_KEY]: mcpServersEntry(cmd) } }, null, 2)
}

/** TOML basic string: backslashes and quotes escaped — a Windows path has plenty of the former. */
export function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Codex: a `[mcp_servers.prismlca]` table. The timeouts are the ones a calculation needs: Codex's
 *  defaults are 10 s to start and 60 s per tool, and a cold app start or a Monte Carlo is longer. */
export function codexSnippet(cmd: BridgeCommand): string {
  const env = Object.entries(cmd.env ?? {})
  return [
    `[mcp_servers.${SERVER_KEY}]`,
    `command = ${tomlString(cmd.command)}`,
    `args = [${cmd.args.map(tomlString).join(', ')}]`,
    'startup_timeout_sec = 30',
    // Longer than the 15 minutes a question or approval card may wait on a person (timeouts.ts), and than
    // the bridge's own forward timeout (proxy.ts) — a layer that gives up earlier turns a human answer
    // into an error.
    'tool_timeout_sec = 1900',
    ...(env.length
      ? [
          '',
          `[mcp_servers.${SERVER_KEY}.env]`,
          ...env.map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)} = ${tomlString(v)}`)
        ]
      : []),
    ''
  ].join('\n')
}

/**
 * The JSON file with our entry set, everything else untouched. A missing or empty file becomes a
 * file with only our entry; a file that is not JSON is refused rather than overwritten.
 */
export function mergeJsonConfig(existing: string | null, cmd: BridgeCommand): string {
  let doc: Record<string, unknown> = {}
  if (existing && existing.trim()) {
    const parsed = JSON.parse(existing) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('The file is not a JSON object.')
    doc = parsed as Record<string, unknown>
  }
  const servers =
    doc.mcpServers && typeof doc.mcpServers === 'object' && !Array.isArray(doc.mcpServers)
      ? { ...(doc.mcpServers as Record<string, unknown>) }
      : {}
  servers[SERVER_KEY] = mcpServersEntry(cmd)
  return `${JSON.stringify({ ...doc, mcpServers: servers }, null, 2)}\n`
}

/** Does the JSON file already carry exactly this entry? (For the "configured" badge.) */
export function jsonHasEntry(existing: string | null, cmd: BridgeCommand): boolean {
  try {
    const doc = existing ? (JSON.parse(existing) as { mcpServers?: Record<string, unknown> }) : {}
    const e = doc?.mcpServers?.[SERVER_KEY] as { command?: string; args?: string[] } | undefined
    return !!e && e.command === cmd.command && JSON.stringify(e.args ?? []) === JSON.stringify(cmd.args)
  } catch {
    return false
  }
}

/** Our table header as TOML allows it to be written: spaces, a bare or quoted key, sub-tables, a
 *  trailing comment. `[mcp_servers.prismlca] # local bridge` is valid TOML and was missed before
 *  — the merge then declared the table twice and broke the file. */
const TOML_BLOCK = new RegExp(
  `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${SERVER_KEY}"|'${SERVER_KEY}'|${SERVER_KEY})\\s*(?:\\.[^\\]]+)?\\]\\s*(?:#.*)?$`,
  'm'
)
/** Any table header line (ours or not), trailing comment allowed. */
const TOML_ANY_HEADER = /^\s*\[/

/**
 * The TOML file with our table set: an existing `[mcp_servers.prismlca]` table (and its sub-tables)
 * is replaced in place, otherwise the table is appended. Nothing else is parsed or touched — TOML
 * is edited as lines on purpose, so a user's comments and ordering survive.
 */
export function mergeCodexToml(existing: string | null, cmd: BridgeCommand): string {
  const block = codexSnippet(cmd)
  const text = existing ?? ''
  if (!hasOurHeader(text)) {
    const sep = text.length === 0 ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
    const appended = `${text}${sep}${block}`
    assertMergedToml(text, appended, cmd)
    return appended
  }
  // Drop every line from our table header(s) up to the next table header that is not ours. A line
  // inside a multi-line string is text, not a header, however much it looks like one (a
  // `developer_instructions` example quoting our table once rewrote the user's file).
  const lines = text.split('\n')
  const out: string[] = []
  let skipping = false
  let inserted = false
  let inString: MultilineDelimiter | null = null
  for (const line of lines) {
    const header = inString === null && TOML_ANY_HEADER.test(line)
    inString = multilineStateAfter(line, inString)
    if (header) {
      if (TOML_BLOCK.test(line)) {
        // Ours: the table itself and its `env` sub-table are replaced. Any OTHER sub-table under
        // it belongs to the client — Codex writes `[mcp_servers.prismlca.tools.<name>]` with the
        // user's approval choices — and is kept as it stands.
        const sub = line.replace(/#.*$/, '').match(/\]\s*$/)
          ? line.replace(/#.*$/, '').trim().slice(1, -1).trim()
          : ''
        const path = sub.split('.').map((seg) => seg.trim().replace(/^["']|["']$/g, ''))
        const foreignSub = path.length > 2 && path[2] !== 'env'
        if (foreignSub) {
          skipping = false
          out.push(line)
          continue
        }
        skipping = true
        if (!inserted) {
          out.push(...block.trimEnd().split('\n'))
          inserted = true
        }
        continue
      }
      skipping = false
    }
    if (!skipping) out.push(line)
  }
  const merged = `${out.join('\n').replace(/\n*$/, '')}\n`
  assertMergedToml(text, merged, cmd)
  return merged
}

/** Is our table declared anywhere — as a header, not as text inside a multi-line string? */
function hasOurHeader(text: string): boolean {
  let inString: MultilineDelimiter | null = null
  for (const line of text.split('\n')) {
    if (inString === null && TOML_BLOCK.test(line)) return true
    inString = multilineStateAfter(line, inString)
  }
  return false
}

/** TOML's two multi-line string delimiters, spelled as escapes so this file stays greppable. */
export type MultilineDelimiter = '\u0022\u0022\u0022' | '\u0027\u0027\u0027'
const BASIC_ML: MultilineDelimiter = '\u0022\u0022\u0022'
const LITERAL_ML: MultilineDelimiter = '\u0027\u0027\u0027'

/**
 * Where a line leaves us with respect to TOML multi-line strings. Good enough for deciding "is this
 * `[...]` line a header?": a header can only start outside a string. Escapes inside multi-line basic
 * strings are not tracked — rare, and the parser check below catches any damage before it is written.
 */
export function multilineStateAfter(
  line: string,
  state: MultilineDelimiter | null
): MultilineDelimiter | null {
  let s = state
  let i = 0
  while (i < line.length) {
    if (s === null) {
      // Outside strings a comment ends the line; a single-line string's quotes can hide a delimiter.
      if (line[i] === '#') return null
      if (line.startsWith(BASIC_ML, i)) {
        s = BASIC_ML
        i += 3
        continue
      }
      if (line.startsWith(LITERAL_ML, i)) {
        s = LITERAL_ML
        i += 3
        continue
      }
      if (line[i] === '\u0022' || line[i] === '\u0027') {
        const q = line[i]
        let j = i + 1
        while (j < line.length && line[j] !== q) j += line[j] === '\\' && q === '\u0022' ? 2 : 1
        i = j + 1
        continue
      }
      i++
    } else {
      // Inside a basic multi-line string a backslash escapes the next character — including a
      // quote that would otherwise look like the closing delimiter.
      if (s === BASIC_ML && line[i] === '\\') {
        i += 2
        continue
      }
      if (line.startsWith(s, i)) {
        s = null
        i += 3
        continue
      }
      i++
    }
  }
  return s
}

/**
 * Before anything is written: the merged text parses, our table is exactly what we meant, and the
 * REST of the document is identical to the user's file — nothing changed, nothing removed, nothing
 * added (a string that the scanner misread as a header would otherwise become a live setting).
 * A merge that fails any of these is refused — the user's file is never the place to find out.
 */
function assertMergedToml(before: string, merged: string, cmd: BridgeCommand): void {
  let parsedBefore: Record<string, unknown> = {}
  if (before.trim()) {
    try {
      parsedBefore = parseToml(before) as Record<string, unknown>
    } catch (e) {
      throw new Error(`The existing file is not valid TOML: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  let parsed: Record<string, unknown>
  try {
    parsed = parseToml(merged) as Record<string, unknown>
  } catch (e) {
    throw new Error(`The merged file would not be valid TOML: ${e instanceof Error ? e.message : String(e)}`)
  }
  const servers = (parsed.mcp_servers ?? {}) as Record<string, unknown>
  const ours = servers[SERVER_KEY] as { command?: unknown; args?: unknown } | undefined
  if (!ours || ours.command !== cmd.command || JSON.stringify(ours.args) !== JSON.stringify(cmd.args))
    throw new Error('The merged file does not carry our entry as intended.')
  if (stableJson(withoutOurTable(parsedBefore)) !== stableJson(withoutOurTable(parsed)))
    throw new Error('The merge would change something other than our entry; refused.')
}

/**
 * The document minus what we own in `mcp_servers.<ours>` (its scalar keys and `env`) — everything
 * else, the client's own sub-tables under our entry included, a merge must leave as it was.
 */
function withoutOurTable(doc: Record<string, unknown>): Record<string, unknown> {
  const out = { ...doc }
  const servers = out.mcp_servers
  if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
    const rest: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
      if (name !== SERVER_KEY) {
        rest[name] = value
        continue
      }
      // Keep only the client's sub-tables of our entry (anything that is a table and not `env`).
      const foreign = Object.fromEntries(
        Object.entries((value as Record<string, unknown>) ?? {}).filter(
          ([k, v]) => k !== 'env' && v && typeof v === 'object' && !Array.isArray(v)
        )
      )
      if (Object.keys(foreign).length) rest[name] = foreign
    }
    if (Object.keys(rest).length) out.mcp_servers = rest
    else delete out.mcp_servers
  }
  return out
}

/** JSON with sorted keys at every level, so two parses of the same document compare equal. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object' && !(v instanceof Date))
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v instanceof Date ? v.toISOString() : v)
}
export function tomlHasEntry(existing: string | null, cmd: BridgeCommand): boolean {
  if (!existing || !hasOurHeader(existing)) return false
  return existing.includes(`command = ${tomlString(cmd.command)}`)
}
