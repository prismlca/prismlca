import { describe, expect, it } from 'vitest'
import { posix, win32 } from 'node:path'
import { clientConfigPath, type PathProbe } from './clientConfigPath'

const HOME = 'C:\\Users\\u'
const LOCAL = `${HOME}\\AppData\\Local`
const ROAMING = `${HOME}\\AppData\\Roaming`
const DATA = `${LOCAL}\\Claude-Data\\claude_pzs8sxrjxfjjc`
const PACKAGED = `${LOCAL}\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude`
const CLASSIC = `${ROAMING}\\Claude`
const FILE = 'claude_desktop_config.json'

/** A machine made of files: path → when it was last written. Directories follow from the paths. */
function machine(
  platform: NodeJS.Platform,
  home: string,
  files: Record<string, number> = {},
  env: Record<string, string> = {}
): PathProbe {
  const p = platform === 'win32' ? win32 : posix
  const key = (s: string): string => (platform === 'win32' ? s.toLowerCase() : s)
  return {
    platform,
    home,
    env,
    list: (dir) => {
      const names = new Set<string>()
      for (const file of Object.keys(files)) {
        const rel = p.relative(dir, file)
        if (key(file).startsWith(key(dir) + p.sep) && rel) names.add(rel.split(p.sep)[0])
      }
      return [...names]
    },
    mtime: (path) => Object.entries(files).find(([f]) => key(f) === key(path))?.[1] ?? null
  }
}

const windows = (files: Record<string, number> = {}, env: Record<string, string> = {}): PathProbe =>
  machine('win32', HOME, files, { LOCALAPPDATA: LOCAL, APPDATA: ROAMING, ...env })

describe('Claude Desktop on Windows', () => {
  const desktop = (files: Record<string, number>): string =>
    clientConfigPath('claude-desktop', windows(files))

  it('is the classic place on a machine without the app', () => {
    expect(desktop({})).toBe(`${CLASSIC}\\${FILE}`)
  })

  it('is the classic place for the classic installer', () => {
    expect(desktop({ [`${CLASSIC}\\config.json`]: 5, [`${CLASSIC}\\${FILE}`]: 5 })).toBe(
      `${CLASSIC}\\${FILE}`
    )
  })

  it('is the redirected folder for an older Store build', () => {
    expect(desktop({ [`${PACKAGED}\\Local State`]: 5 })).toBe(`${PACKAGED}\\${FILE}`)
  })

  it('leaves the folders the app moved its data out of', () => {
    const files = {
      [`${DATA}\\config.json`]: 9,
      [`${DATA}\\${FILE}`]: 9,
      [`${PACKAGED}\\.user-data-left.claude_pzs8sxrjxfjjc`]: 8,
      [`${PACKAGED}\\config.json`]: 7,
      [`${PACKAGED}\\${FILE}`]: 3,
      [`${CLASSIC}\\.user-data-left.claude_pzs8sxrjxfjjc`]: 8
    }
    expect(desktop(files)).toBe(`${DATA}\\${FILE}`)
  })

  it('stays out of a folder the app left, although an entry of ours there is the newest file', () => {
    const files = {
      [`${DATA}\\config.json`]: 9,
      [`${CLASSIC}\\.user-data-left.claude_pzs8sxrjxfjjc`]: 8,
      [`${CLASSIC}\\config.json`]: 8,
      [`${CLASSIC}\\${FILE}`]: 20
    }
    expect(desktop(files)).toBe(`${DATA}\\${FILE}`)
  })

  it('returns to a folder the app left once it writes its state there again', () => {
    // Back to the classic installer after a Store build had moved the data away.
    const files = {
      [`${DATA}\\config.json`]: 9,
      [`${CLASSIC}\\.user-data-left.claude_pzs8sxrjxfjjc`]: 8,
      [`${CLASSIC}\\config.json`]: 20
    }
    expect(desktop(files)).toBe(`${CLASSIC}\\${FILE}`)
  })

  it('takes the new folder before the app has written any state there', () => {
    const files = {
      [`${DATA}\\${FILE}`]: 9,
      [`${CLASSIC}\\.user-data-left.claude_pzs8sxrjxfjjc`]: 8,
      [`${CLASSIC}\\${FILE}`]: 3
    }
    expect(desktop(files)).toBe(`${DATA}\\${FILE}`)
  })

  it('is the new folder on a fresh Store install, although a classic folder holds an entry of ours', () => {
    const files = { [`${DATA}\\config.json`]: 9, [`${DATA}\\Local State`]: 9, [`${CLASSIC}\\${FILE}`]: 20 }
    expect(desktop(files)).toBe(`${DATA}\\${FILE}`)
  })

  it('takes the folder the app wrote its state to last when two installations live side by side', () => {
    const files = { [`${DATA}\\config.json`]: 9, [`${CLASSIC}\\Local State`]: 12 }
    expect(desktop(files)).toBe(`${CLASSIC}\\${FILE}`)
    expect(desktop({ ...files, [`${DATA}\\Local State`]: 15 })).toBe(`${DATA}\\${FILE}`)
  })

  it('prefers the newer home when both were written at the same moment', () => {
    expect(desktop({ [`${DATA}\\config.json`]: 9, [`${CLASSIC}\\config.json`]: 9 })).toBe(`${DATA}\\${FILE}`)
  })

  it('takes a folder that holds anything when none holds the app state', () => {
    expect(desktop({ [`${PACKAGED}\\${FILE}`]: 3 })).toBe(`${PACKAGED}\\${FILE}`)
  })

  it('goes where the marker points when the new folder is not there, never back into the folder the app left', () => {
    const marked = { [`${CLASSIC}\\.user-data-left.claude_pzs8sxrjxfjjc`]: 8, [`${CLASSIC}\\config.json`]: 8 }
    expect(desktop(marked)).toBe(`${DATA}\\${FILE}`)
    expect(desktop({ [`${PACKAGED}\\.user-data-left.claude_pzs8sxrjxfjjc`]: 8 })).toBe(`${DATA}\\${FILE}`)
  })

  it('takes no folder name from a marker that names none', () => {
    expect(desktop({ [`${PACKAGED}\\.user-data-left...`]: 8 })).toBe(`${CLASSIC}\\${FILE}`)
  })

  it('ignores other packages and other folders beside the app’s', () => {
    const files = {
      [`${LOCAL}\\Packages\\ClaudeTools_abc\\LocalCache\\Roaming\\Claude\\config.json`]: 30,
      [`${LOCAL}\\Claude-Data\\README.txt`]: 30,
      [`${CLASSIC}\\config.json`]: 5
    }
    expect(desktop(files)).toBe(`${CLASSIC}\\${FILE}`)
  })

  it('finds the folders without the variables, below the home directory', () => {
    const probe = machine('win32', HOME, { [`${DATA}\\config.json`]: 9 })
    expect(clientConfigPath('claude-desktop', probe)).toBe(`${DATA}\\${FILE}`)
  })
})

describe('Claude Desktop elsewhere', () => {
  it('is in Application Support on macOS', () => {
    expect(clientConfigPath('claude-desktop', machine('darwin', '/Users/u'))).toBe(
      `/Users/u/Library/Application Support/Claude/${FILE}`
    )
  })

  it('is in the configuration directory on Linux', () => {
    expect(clientConfigPath('claude-desktop', machine('linux', '/home/u'))).toBe(
      `/home/u/.config/Claude/${FILE}`
    )
    expect(
      clientConfigPath('claude-desktop', machine('linux', '/home/u', {}, { XDG_CONFIG_HOME: '/home/u/cfg' }))
    ).toBe(`/home/u/cfg/Claude/${FILE}`)
  })
})

describe('Claude Code and Codex', () => {
  it('are in the home directory', () => {
    expect(clientConfigPath('claude-code', machine('linux', '/home/u'))).toBe('/home/u/.claude.json')
    expect(clientConfigPath('codex', machine('linux', '/home/u'))).toBe('/home/u/.codex/config.toml')
    expect(clientConfigPath('claude-code', windows())).toBe(`${HOME}\\.claude.json`)
    expect(clientConfigPath('codex', windows())).toBe(`${HOME}\\.codex\\config.toml`)
  })

  it('move with the variable each client reads', () => {
    const probe = windows({}, { CLAUDE_CONFIG_DIR: 'D:\\cfg\\claude', CODEX_HOME: 'D:\\cfg\\codex' })
    expect(clientConfigPath('claude-code', probe)).toBe('D:\\cfg\\claude\\.claude.json')
    expect(clientConfigPath('codex', probe)).toBe('D:\\cfg\\codex\\config.toml')
  })

  it('stay where they are when the variable is empty or names no absolute directory', () => {
    const probe = machine('linux', '/home/u', {}, { CLAUDE_CONFIG_DIR: '  ', CODEX_HOME: 'relative/dir' })
    expect(clientConfigPath('claude-code', probe)).toBe('/home/u/.claude.json')
    expect(clientConfigPath('codex', probe)).toBe('/home/u/.codex/config.toml')
  })
})
