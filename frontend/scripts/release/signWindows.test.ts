/**
 * What the Windows sign hook signs, and where the certificate subject comes from. The PowerShell half
 * (sign-windows.ps1) only runs on the release VM; the decisions are here, where a test can reach them.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { isOurs, subjectFrom } from './sign-windows.mjs'

const R = 'C:\\actions-runner\\_work\\prismlca\\prismlca\\frontend\\release'

describe('Windows sign hook', () => {
  it('signs our four executables', () => {
    for (const file of [
      `${R}\\win-unpacked\\PrismLCA.exe`,
      `${R}\\win-unpacked\\resources\\backend\\prism-lca-backend.exe`,
      `${R}\\PrismLCA-Setup-0.9.9.exe`,
      `${R}\\PrismLCA-Setup-0.9.9.__uninstaller.exe`,
      `${R}\\PrismLCA-Setup-0.9.8-spike.1.exe`,
      `${R}\\PrismLCA-Setup-0.9.8-spike.1.__uninstaller.exe`
    ])
      expect(isOurs(file), file).toBe(true)
  })

  it('leaves every other executable alone', () => {
    for (const file of [
      `${R}\\win-unpacked\\resources\\backend\\_internal\\setuptools\\cli-64.exe`,
      `${R}\\win-unpacked\\resources\\backend\\_internal\\prism-lca-backend.exe`,
      `${R}\\win-unpacked\\resources\\elevate.exe`,
      `${R}\\win-unpacked\\PrismLCA.exe.bak`,
      `${R}\\win-unpacked\\NotPrismLCA.exe`,
      `${R}\\PrismLCA-Setup-latest.exe`
    ])
      expect(isOurs(file), file).toBe(false)
  })

  it('takes the one certificate subject from publisherName', () => {
    const subject = 'CN="Open Source Developer, Jane Doe", O=Open Source Developer, L=Town, C=DE'
    const text = `win:\n  signtoolOptions:\n    publisherName: '${subject.replace(/'/g, "''")}'\n`
    expect(subjectFrom(text)).toBe(subject)
    expect(subjectFrom(`win:\n  signtoolOptions:\n    publisherName:\n      - '${subject}'\n`)).toBe(subject)
  })

  it('refuses a missing, a bare or a second publisher name', () => {
    expect(() => subjectFrom('win:\n  target: nsis\n')).toThrow(/publisherName/)
    expect(() => subjectFrom('win:\n  signtoolOptions:\n    publisherName: Jane Doe\n')).toThrow(/CN=/)
    expect(() =>
      subjectFrom("win:\n  signtoolOptions:\n    publisherName:\n      - 'CN=A, C=DE'\n      - 'CN=B, C=DE'\n")
    ).toThrow(/one certificate subject/)
  })

  it('is wired into electron-builder.yml with one SHA-256 signature per file and a subject', () => {
    const text = readFileSync(join(__dirname, '..', '..', 'electron-builder.yml'), 'utf-8')
    const options = (load(text) as { win: { signtoolOptions: Record<string, unknown> } }).win.signtoolOptions
    expect(options.sign).toBe('./scripts/release/sign-windows.mjs')
    expect(options.signingHashAlgorithms).toEqual(['sha256'])
    expect(subjectFrom(text)).toMatch(/^CN=/)
    expect(subjectFrom(text), 'the subject of the real certificate').not.toContain('PENDING')
  })
})
