import { describe, expect, it } from 'vitest'

import {
  appLaunchCommandFor,
  claudeCodeAddCommand,
  claudeDesktopSnippet,
  codexSnippet,
  jsonHasEntry,
  mergeCodexToml,
  mergeJsonConfig,
  multilineStateAfter,
  tomlHasEntry
} from './clientConfig'

const linux = { command: '/opt/PrismLCA/prismlca', args: ['--mcp-proxy'] }
const windows = { command: 'C:\\Program Files\\PrismLCA\\PrismLCA.exe', args: ['--mcp-proxy'] }
const appimage = { command: '/home/u/Apps/PrismLCA-0.8.0.AppImage', args: ['--mcp-proxy'] }

describe('client snippets', () => {
  it('quote Windows paths for the shell and for TOML', () => {
    expect(claudeCodeAddCommand(windows)).toBe(
      'claude mcp add --scope user prismlca -- "C:\\Program Files\\PrismLCA\\PrismLCA.exe" --mcp-proxy'
    )
    expect(codexSnippet(windows)).toContain('command = "C:\\\\Program Files\\\\PrismLCA\\\\PrismLCA.exe"')
    expect(codexSnippet(windows)).toContain('tool_timeout_sec = 1900')
    expect(JSON.parse(claudeDesktopSnippet(windows)).mcpServers.prismlca.command).toBe(windows.command)
  })

  it('point an AppImage at itself — the mount path is never needed', () => {
    expect(claudeCodeAddCommand(appimage)).toBe(
      'claude mcp add --scope user prismlca -- /home/u/Apps/PrismLCA-0.8.0.AppImage --mcp-proxy'
    )
  })
})

describe('appLaunchCommandFor', () => {
  it('uses the AppImage file, never the temporary mount', () => {
    const cmd = appLaunchCommandFor({
      isPackaged: true,
      execPath: '/tmp/.mount_PrismLxyz/prismlca',
      appPath: '/tmp/.mount_PrismLxyz/resources/app.asar',
      appImage: '/home/u/Apps/PrismLCA-0.8.0.AppImage'
    })
    expect(cmd).toEqual({ command: '/home/u/Apps/PrismLCA-0.8.0.AppImage', args: [] })
    expect(appLaunchCommandFor({ isPackaged: true, execPath: 'C:\\P\\PrismLCA.exe', appPath: 'x' })).toEqual({
      command: 'C:\\P\\PrismLCA.exe',
      args: []
    })
    expect(
      appLaunchCommandFor({ isPackaged: false, execPath: '/n/electron', appPath: '/repo/frontend' })
    ).toEqual({
      command: '/n/electron',
      args: ['/repo/frontend']
    })
  })
})

describe('multilineStateAfter', () => {
  const ML = '\u0022\u0022\u0022' as const
  const LL = '\u0027\u0027\u0027' as const
  it('tracks the two multi-line delimiters and ignores quotes inside single-line strings', () => {
    expect(multilineStateAfter(`x = ${ML}start`, null)).toBe(ML)
    expect(multilineStateAfter('  [looks.like.a.header]', ML)).toBe(ML)
    expect(multilineStateAfter(`end${ML}`, ML)).toBe(null)
    expect(multilineStateAfter(`y = ${LL}`, null)).toBe(LL)
    expect(multilineStateAfter(`z = "has ${ML} inside" # comment ${ML}`, null)).toBe(null)
    expect(multilineStateAfter(`# ${ML} in a comment`, null)).toBe(null)
  })
})

describe('mergeJsonConfig', () => {
  it('adds our entry and keeps everything else', () => {
    const before = JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } })
    const after = JSON.parse(mergeJsonConfig(before, linux))
    expect(after.theme).toBe('dark')
    expect(after.mcpServers.other).toEqual({ command: 'x' })
    expect(after.mcpServers.prismlca).toEqual(linux)
    expect(jsonHasEntry(mergeJsonConfig(before, linux), linux)).toBe(true)
    expect(jsonHasEntry(before, linux)).toBe(false)
  })

  it('starts from nothing, and refuses a file that is not a JSON object', () => {
    expect(JSON.parse(mergeJsonConfig(null, linux)).mcpServers.prismlca).toEqual(linux)
    expect(() => mergeJsonConfig('[1,2]', linux)).toThrow(/not a JSON object/)
    expect(() => mergeJsonConfig('not json', linux)).toThrow()
  })
})

describe('mergeCodexToml', () => {
  it('appends a table to an existing file, keeping comments', () => {
    const before = '# my config\nmodel = "gpt-5.5"\n\n[mcp_servers.node_repl]\ncommand = "node"\n'
    const after = mergeCodexToml(before, linux)
    expect(
      after.startsWith(
        '# my config\nmodel = "gpt-5.5"\n\n[mcp_servers.node_repl]\ncommand = "node"\n\n[mcp_servers.prismlca]'
      )
    ).toBe(true)
    expect(tomlHasEntry(after, linux)).toBe(true)
    expect(tomlHasEntry(before, linux)).toBe(false)
  })

  it('replaces our table in place, sub-tables included, and leaves the others', () => {
    const before = [
      '[mcp_servers.prismlca]',
      'command = "/old/path"',
      'args = ["--mcp-proxy"]',
      '[mcp_servers.prismlca.env]',
      'FOO = "bar"',
      '',
      '[mcp_servers.other]',
      'command = "x"',
      ''
    ].join('\n')
    const after = mergeCodexToml(before, linux)
    expect(after).not.toContain('/old/path')
    expect(after).not.toContain('FOO')
    expect(after).toContain('[mcp_servers.other]\ncommand = "x"')
    expect(after.match(/\[mcp_servers\.prismlca\]/g)).toHaveLength(1)
    expect(after).toContain(`command = "${linux.command}"`)
  })

  it('recognises a header with a trailing comment or a quoted key, and never declares the table twice', () => {
    for (const before of [
      '[mcp_servers.prismlca] # local bridge\ncommand = "/old"\nargs = ["--mcp-proxy"]\n',
      '[ mcp_servers . "prismlca" ]\ncommand = "/old"\n',
      '[mcp_servers.\'prismlca\']\ncommand = "/old"\n\n[other]\nx = 1\n'
    ]) {
      const after = mergeCodexToml(before, linux)
      expect(after.match(/^\s*\[\s*mcp_servers\s*\.\s*["']?prismlca["']?\s*\]/gm), before).toHaveLength(1)
      expect(after).not.toContain('/old')
      expect(after).toContain(`command = "${linux.command}"`)
    }
  })

  it('leaves a header-like line inside a multi-line string alone, and every other setting too', () => {
    const ML = '\u0022\u0022\u0022'
    const before = [
      'model = "gpt-5.5"',
      `developer_instructions = ${ML}`,
      'Example of a server table:',
      '  [mcp_servers.prismlca]',
      '  command = "/example"',
      ML,
      'approval_policy = "never"',
      '',
      '[mcp_servers.node_repl]',
      'command = "node"',
      ''
    ].join('\n')
    const after = mergeCodexToml(before, linux)
    expect(after).toContain(`  [mcp_servers.prismlca]\n  command = "/example"\n${ML}`)
    expect(after).toContain('approval_policy = "never"')
    expect(after).toContain('[mcp_servers.node_repl]\ncommand = "node"')
    expect(after).toContain(`\n[mcp_servers.prismlca]\ncommand = "${linux.command}"`)
  })

  it('keeps an escaped delimiter inside a multi-line string, and refuses a merge that adds a setting', () => {
    const ML = '\u0022\u0022\u0022'
    // An escaped triple quote inside the string, then text that looks like a table.
    const before = [
      `developer_instructions = ${ML}`,
      `say \\${ML} to quote`,
      '[sandbox_workspace_write]',
      'network_access = true',
      `${ML} # closing`,
      'approval_policy = "never"',
      ''
    ].join('\n')
    const after = mergeCodexToml(before, linux)
    expect(after).toContain('[sandbox_workspace_write]\nnetwork_access = true')
    expect(after.startsWith(before)).toBe(true)
    expect(multilineStateAfter(`say \\${ML} to quote`, ML)).toBe(ML)
  })

  it('refuses a merge that would damage the file instead of writing it', () => {
    expect(() => mergeCodexToml('model = "gpt-5.5"\nbroken = = 1\n', linux)).toThrow(/not valid TOML/)
  })

  it('writes the display variables for Codex as an env sub-table, replaced as a whole', () => {
    const cmd = { ...linux, env: { DISPLAY: ':1', WAYLAND_DISPLAY: 'wayland-0' } }
    const text = codexSnippet(cmd)
    expect(text).toContain('[mcp_servers.prismlca.env]\nDISPLAY = ":1"\nWAYLAND_DISPLAY = "wayland-0"')
    const merged = mergeCodexToml(
      '[mcp_servers.prismlca]\ncommand = "/old"\nargs = []\n[mcp_servers.prismlca.env]\nDISPLAY = ":0"\n',
      cmd
    )
    expect(merged).not.toContain('":0"')
    expect(merged.match(/\[mcp_servers\.prismlca\.env\]/g)).toHaveLength(1)
  })

  it("keeps the client's own sub-tables under our entry (Codex approval choices) when reconfiguring", () => {
    const before = [
      '[mcp_servers.prismlca]',
      'command = "/old"',
      'args = ["--mcp-proxy"]',
      '',
      '[mcp_servers.prismlca.env]',
      'DISPLAY = ":0"',
      '',
      '[mcp_servers.prismlca.tools.model_info]',
      'approval_mode = "approve"',
      '',
      '[mcp_servers.prismlca.tools.canvas_view]',
      'approval_mode = "approve"',
      ''
    ].join('\n')
    const after = mergeCodexToml(before, { ...linux, env: { DISPLAY: ':1' } })
    expect(after).toContain('[mcp_servers.prismlca.tools.model_info]\napproval_mode = "approve"')
    expect(after).toContain('[mcp_servers.prismlca.tools.canvas_view]\napproval_mode = "approve"')
    expect(after).not.toContain('":0"')
    expect(after).toContain('DISPLAY = ":1"')
    expect(after).not.toContain('/old')
    expect(after.match(/^\[mcp_servers\.prismlca\]$/gm)).toHaveLength(1)
  })

  it('works on an empty file', () => {
    expect(mergeCodexToml(null, linux)).toBe(codexSnippet(linux))
  })
})
