import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { adoptLegacyUserData } from './userDataMigration'

// The rename "Prism LCA" → "PrismLCA" (30.09.2026) moved the packaged app's userData folder; the
// old folder's files are adopted once, and only into a folder that holds none of them yet.
describe('adoptLegacyUserData', () => {
  const dirs: string[] = []
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'prism-userdata-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('copies the old folder’s files into an empty new folder and leaves the old one alone', () => {
    const root = tmp()
    const legacy = join(root, 'Prism LCA')
    const current = join(root, 'PrismLCA')
    mkdirSync(legacy)
    writeFileSync(join(legacy, 'settings.json'), '{"a":1}')
    writeFileSync(join(legacy, 'secrets.json'), '{"k":"v"}')
    mkdirSync(join(legacy, 'Cache'))
    writeFileSync(join(legacy, 'Cache', 'index'), 'chromium')

    expect(adoptLegacyUserData(current, legacy).sort()).toEqual(['secrets.json', 'settings.json'])
    expect(readFileSync(join(current, 'settings.json'), 'utf-8')).toBe('{"a":1}')
    expect(readFileSync(join(current, 'secrets.json'), 'utf-8')).toBe('{"k":"v"}')
    expect(existsSync(join(current, 'Cache'))).toBe(false)
    expect(existsSync(join(legacy, 'settings.json'))).toBe(true)
  })

  it('ignores Chromium’s own files in the new folder, but never overwrites one of ours', () => {
    const root = tmp()
    const legacy = join(root, 'Prism LCA')
    const current = join(root, 'PrismLCA')
    mkdirSync(legacy)
    mkdirSync(current)
    writeFileSync(join(legacy, 'settings.json'), 'old')
    writeFileSync(join(current, 'Preferences'), '{}') // Chromium wrote this before we ran
    expect(adoptLegacyUserData(current, legacy)).toEqual(['settings.json'])

    // Second start: settings.json exists in the new folder now → nothing happens, even if the old
    // folder gained a file meanwhile.
    writeFileSync(join(current, 'settings.json'), 'new')
    writeFileSync(join(legacy, 'models.json'), '[]')
    expect(adoptLegacyUserData(current, legacy)).toEqual([])
    expect(readFileSync(join(current, 'settings.json'), 'utf-8')).toBe('new')
    expect(existsSync(join(current, 'models.json'))).toBe(false)
  })

  it('does nothing without an old folder, and never when both paths are the same', () => {
    const root = tmp()
    expect(adoptLegacyUserData(join(root, 'PrismLCA'), join(root, 'Prism LCA'))).toEqual([])
    const same = join(root, 'PrismLCA')
    mkdirSync(same)
    writeFileSync(join(same, 'settings.json'), 'x')
    expect(adoptLegacyUserData(same, same)).toEqual([])
  })
})
