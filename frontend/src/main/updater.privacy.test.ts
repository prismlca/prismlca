/**
 * Tripwire for V-1 (no installation ID in update requests). `neutraliseInstallationId` in updater.ts
 * replaces two private members of the installed electron-updater: the lazy staging ID and the header builder.
 * Private members can move in any release. This test reads the installed package and fails the moment
 * the names it relies on are gone — so an upgrade cannot quietly start sending an installation ID
 * again. (At runtime the guard fails closed as well; this makes the failure visible before a build.)
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const out = dirname(require.resolve('electron-updater'))
const read = (file: string): string => readFileSync(join(out, file), 'utf-8')

describe('electron-updater internals the privacy guard relies on', () => {
  it('still creates the staging ID lazily through stagingUserIdPromise', () => {
    const src = read('AppUpdater.js')
    expect(src).toMatch(
      /this\.stagingUserIdPromise = new lazy_val_1\.Lazy\(\(\) => this\.getOrCreateStagingUserId\(\)\)/
    )
    expect(src).toContain('".updaterId"')
  })

  it('still sends it only through computeFinalHeaders', () => {
    const src = read('AppUpdater.js')
    const sends = src.match(/"x-user-staging-id"/g) ?? []
    expect(sends).toHaveLength(1)
    expect(src).toMatch(/this\.computeFinalHeaders\(\{ "x-user-staging-id": stagingUserId \}\)/)
    expect(src).toMatch(/stagingUserId = await this\.stagingUserIdPromise\.value/)
  })

  it('still offers install() on the NSIS updater, which the install step calls directly', () => {
    expect(read('BaseUpdater.js')).toMatch(/\n {4}install\(isSilent = false, isForceRunAfter = false\) \{/)
  })
})
