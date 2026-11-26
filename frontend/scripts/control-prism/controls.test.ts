import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BINARIES, binaryFor, BOMBADIL_VERSION } from './bombadil'
import {
  BACKEND_LOG,
  definedNames,
  readControls,
  readVerified,
  reexported,
  shippedProperties,
  specHash
} from './controls'
import { drivingCommands } from './recipe'

/**
 * Holds the exploring spec (features/explore/) to its positive controls. A property that has never been seen to go
 * red may be unable to: a green run with it says nothing. So every property the spec ships goes red in a control,
 * and controls/verified.json names the spec they last passed on — change the spec, and this test sends you to run
 * them again (they take Bombadil and about half an hour, so they cannot run here).
 */

const SPEC = join(__dirname, '..', '..', 'features', 'explore')
const source = (f: string): string => readFileSync(join(SPEC, f), 'utf8')
const controls = readControls(SPEC)

describe('the exploring spec and its positive controls', () => {
  const shipped = shippedProperties(source('properties.ts'))

  it('ships the properties of properties.ts, all of them and nothing else', () => {
    expect(shipped).toContain('restAfterInput')
    expect(shipped).toContain('noConsoleErrors')
    expect(source('explore.ts')).toContain('export * from "./properties.ts";')
    // explore.ts defines actions only: a property defined there would bypass the controls
    expect(definedNames(source('explore.ts'))).toEqual(['exploration'])
  })

  it('has a control that turns each shipped property red', () => {
    const controlled = new Set(controls.flatMap((c) => c.red))
    const uncontrolled = shipped.filter((p) => !controlled.has(p))
    expect(uncontrolled, 'properties no control turns red — add one to controls/controls.json').toEqual([])
  })

  it('has controls that run the shipped properties themselves, not copies, and whose files exist', () => {
    for (const c of controls) {
      const spec = source(join('controls', c.spec))
      const taken = reexported(spec, '/properties.ts')
      for (const p of c.red.filter((p) => p !== BACKEND_LOG)) {
        expect(shipped, `${c.name} controls ${p}, which the spec does not ship`).toContain(p)
        expect(taken, `${c.spec} must re-export ${p} from ../properties.ts`).toContain(p)
      }
      // A control that defined a property under a shipped name would test its own copy.
      expect(
        definedNames(spec).filter((n) => shipped.includes(n)),
        c.spec
      ).toEqual([])
      if (c.patch) expect(existsSync(join(SPEC, 'controls', c.patch)), c.patch).toBe(true)
      expect(() => drivingCommands(c.prep ?? [])).not.toThrow()
      expect(c.seconds).toBeGreaterThan(0)
    }
  })

  it('passed its positive controls as it is now', () => {
    const verified = readVerified(SPEC)
    expect(
      verified?.spec,
      'features/explore/ changed since its positive controls last passed. From frontend/, run ' +
        '`node scripts/control-prism.mjs explore --control all` (Linux or macOS, about half an hour); when all pass ' +
        'it rewrites controls/verified.json — commit that with the change.'
    ).toBe(specHash(SPEC))
    expect(
      verified?.bombadil,
      'the controls passed on another Bombadil than the pinned one: run them again'
    ).toBe(BOMBADIL_VERSION)
    // Every control has its result in the record. The fingerprint guards against forgetting the controls; a record
    // written by hand instead of by `explore --control all` defeats it on purpose, like raising a size ceiling.
    expect(Object.keys(verified?.controls ?? {}).sort()).toEqual(controls.map((c) => c.name).sort())
  })
})

describe('the spec fingerprint', () => {
  let dir = ''
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('covers the spec, not its description or its record, and not how lines end', () => {
    dir = mkdtempSync(join(tmpdir(), 'explore-spec-'))
    mkdirSync(join(dir, 'controls'))
    writeFileSync(join(dir, 'explore.ts'), 'export const a = 1\n')
    writeFileSync(join(dir, 'controls', 'rest.ts'), 'export const b = 2\n')
    const before = specHash(dir)
    writeFileSync(join(dir, 'README.md'), 'words')
    writeFileSync(join(dir, 'controls', 'verified.json'), '{}')
    writeFileSync(join(dir, 'explore.ts'), 'export const a = 1\r\n')
    expect(specHash(dir)).toBe(before)
    writeFileSync(join(dir, 'controls', 'rest.ts'), 'export const b = 3\n')
    expect(specHash(dir)).not.toBe(before)
  })

  it('reads what a spec file defines and re-exports', () => {
    const text = [
      'export { noConsoleErrors, noUncaughtExceptions } from "@antithesishq/bombadil/browser/defaults/properties";',
      'export { restAfterInput,\n  loadEnds } from "../properties.ts";',
      'export const restWasMeasured = restMeasured;',
      'export const exploration = weighted(['
    ].join('\n')
    expect(definedNames(text)).toEqual(['restWasMeasured', 'exploration'])
    expect(reexported(text, '/properties.ts')).toEqual(['restAfterInput', 'loadEnds'])
    expect(shippedProperties(text)).toEqual([
      'restWasMeasured',
      'exploration',
      'noConsoleErrors',
      'noUncaughtExceptions'
    ])
  })
})

describe('the pinned Bombadil', () => {
  it('has a binary with its SHA-256 for Linux and Apple silicon, none for Windows', () => {
    expect(binaryFor('linux', 'x64')?.asset).toBe('bombadil-x86_64-linux')
    expect(binaryFor('darwin', 'arm64')?.asset).toBe('bombadil-aarch64-darwin')
    expect(binaryFor('win32', 'x64')).toBeNull()
    for (const b of Object.values(BINARIES)) expect(b.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})
