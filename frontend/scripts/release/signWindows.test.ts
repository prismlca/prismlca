/**
 * What the Windows release signs and why (sign-windows.mjs): every program file carries a valid embedded signature;
 * a maker's own signature stays, a broken one stops the release, an unsigned file gets ours; a file whose code is
 * unchanged keeps the signature of the previous release (the budget itself: signBudget.test.ts). The PowerShell half (sign-windows.ps1) only runs on the release VM; the decisions are here, where a test can
 * reach them.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import * as hooks from './sign-windows.mjs'
import { publishTargetFrom } from './previous-release.mjs'
import {
  batches,
  checkVerdict,
  inPackage,
  planPackage,
  readFacts,
  signatureState,
  signerName,
  subjectFrom
} from './sign-windows.mjs'

const R = 'C:\\actions-runner\\_work\\prismlca\\prismlca\\frontend\\release'
const OURS = 'CN=Open Source Developer Jane Doe, O=Open Source Developer, L=Town, C=DE'
const MS = 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'
const valid = (subject: string) => ({ status: 'Valid', type: 'Authenticode', subject, problem: null })

describe('which file is signed where', () => {
  it('leaves the files of the unpacked app to afterSign, which signs them at once', () => {
    for (const file of [
      `${R}\\win-unpacked\\PrismLCA.exe`,
      `${R}\\win-unpacked\\resources\\backend\\prism-lca-backend.exe`,
      `${R}\\win-unpacked\\resources\\backend\\_internal\\setuptools\\cli-64.exe`
    ])
      expect(inPackage(file), file).toBe(true)
  })

  it('signs in the hook what electron-builder adds after packing: installer, uninstaller, elevate.exe', () => {
    for (const file of [
      `${R}\\PrismLCA-Setup-0.9.9.exe`,
      `${R}\\PrismLCA-Setup-0.9.9.__uninstaller.exe`,
      'C:\\Users\\build\\AppData\\Local\\Temp\\t-abc\\elevate-staging-1\\resources\\elevate.exe'
    ])
      expect(inPackage(file), file).toBe(false)
  })
})

describe('the signing rule', () => {
  it('gives ours to a file without an embedded signature', () => {
    expect(signatureState(null, false)).toBe('unsigned')
    // Windows may vouch for a file through a catalog on the build machine; the user's machine need not have it.
    expect(signatureState({ status: 'Valid', type: 'Catalog', subject: MS, problem: null }, false)).toBe('unsigned')
  })

  it('keeps a valid embedded signature, ours or its maker’s', () => {
    expect(signatureState(valid(MS), true)).toBe('valid')
    expect(signatureState(valid(OURS), true)).toBe('valid')
    // Older Windows PowerShell does not name the type; the embedded table found in the file stands for it.
    expect(signatureState({ ...valid(MS), type: '' }, true)).toBe('valid')
  })

  it('never signs over a signature that is not valid', () => {
    for (const status of ['HashMismatch', 'NotTrusted', 'UnknownError', 'NotSigned'])
      expect(signatureState({ ...valid(MS), status }, true), status).toBe('broken')
    expect(signatureState({ ...valid(MS), type: 'Catalog' }, true)).toBe('broken')
    expect(signatureState(undefined, true)).toBe('broken')
    // Ours without a timestamp or with another digest is not ours to our standard.
    expect(signatureState({ ...valid(OURS), problem: 'x.dll has no timestamp.' }, true)).toBe('broken')
  })
})

describe('the plan for the unpacked app', () => {
  const file = (rel: string, over: Partial<{ embedded: boolean; signable: boolean; digest: string | null }> = {}) => ({
    rel,
    embedded: false,
    signable: true,
    digest: `digest of ${rel}`,
    ...over
  })

  it('keeps foreign signatures, reuses unchanged code by its digest and signs the rest', () => {
    const plan = planPackage(
      [
        file('vcruntime140.dll', { embedded: true, digest: null }),
        file('resources/backend/_internal/_asyncio.pyd'),
        file('resources/backend/_internal/numpy/moved.pyd', { digest: 'digest of old/place.pyd' }),
        file('PrismLCA.exe')
      ],
      new Map([['vcruntime140.dll', valid(MS)]]),
      new Map([
        ['digest of resources/backend/_internal/_asyncio.pyd', 'resources/backend/_internal/_asyncio.pyd'],
        ['digest of old/place.pyd', 'old/place.pyd']
      ])
    )
    expect(plan).toEqual({
      keep: ['vcruntime140.dll'],
      reuse: [
        { rel: 'resources/backend/_internal/_asyncio.pyd', from: 'resources/backend/_internal/_asyncio.pyd' },
        { rel: 'resources/backend/_internal/numpy/moved.pyd', from: 'old/place.pyd' }
      ],
      sign: ['PrismLCA.exe'],
      broken: []
    })
  })

  it('stops at a broken signature and at a file that cannot take one', () => {
    const plan = planPackage(
      [file('tampered.dll', { embedded: true, digest: null }), file('old16bit.dll', { signable: false, digest: null })],
      new Map([['tampered.dll', { ...valid(MS), status: 'HashMismatch' }]]),
      new Map()
    )
    expect(plan.sign).toEqual([])
    expect(plan.broken).toHaveLength(2)
    expect(plan.broken[0]).toMatch(/^tampered\.dll: signature HashMismatch .*Microsoft Corporation/)
    expect(plan.broken[1]).toMatch(/^old16bit\.dll: .*no room for a signature/)
  })
})

describe('the final check', () => {
  it('passes only when every file carries a valid signature, and counts them by signer', () => {
    const facts = [
      { file: 'a.dll', ...valid(OURS) },
      { file: 'b.dll', ...valid(OURS) },
      { file: 'c.dll', ...valid(MS) }
    ]
    const ok = checkVerdict(facts, new Set(['a.dll', 'b.dll', 'c.dll']))
    expect(ok.problems).toEqual([])
    expect([...ok.signers]).toEqual([
      ['Open Source Developer Jane Doe', 2],
      ['Microsoft Corporation', 1]
    ])
  })

  it('names every unsigned or broken file', () => {
    const { problems } = checkVerdict(
      [
        { file: 'unsigned.pyd', status: 'NotSigned', type: 'None', subject: '', problem: null },
        { file: 'late.dll', ...valid(OURS), problem: 'late.dll has no timestamp.' }
      ],
      new Set(['late.dll'])
    )
    expect(problems).toEqual(['unsigned.pyd: not signed', 'late.dll: late.dll has no timestamp.'])
  })

  it('reads the signer the way a person would', () => {
    expect(signerName(MS)).toBe('Microsoft Corporation')
    expect(signerName('CN="Open Source Developer, Jane Doe", O=Open Source Developer, C=DE')).toBe('Open Source Developer, Jane Doe')
    expect(signerName('')).toBe('(none)')
  })
})

describe('the inspection as PowerShell answers it', () => {
  const fact = { status: 'Valid', type: 'Authenticode', subject: OURS, problem: null }

  it('takes a path written as a string', () => {
    expect(readFacts(JSON.stringify([{ file: `${R}\\a.dll`, ...fact }]))).toEqual([{ file: `${R}\\a.dll`, ...fact }])
    expect(readFacts('[]')).toEqual([])
  })

  it('takes a path Windows PowerShell wrote as an object, with the properties of the line it was read from', () => {
    // What ConvertTo-Json of Windows PowerShell 5.1 makes of a string that came out of Get-Content. A release run
    // stopped on it: path.resolve was handed the object.
    const decorated = {
      value: `${R}\\win-unpacked\\PrismLCA.exe`,
      PSPath: 'C:\\Temp\\prism-sign-1\\files.txt',
      PSChildName: 'files.txt',
      PSDrive: { Name: 'C' },
      ReadCount: 1
    }
    expect(readFacts(JSON.stringify([{ file: decorated, ...fact }]))).toEqual([{ file: decorated.value, ...fact }])
  })

  it('stops with the answer in the message when it names no file or is no list', () => {
    expect(() => readFacts(JSON.stringify([{ file: { PSPath: 'x' }, ...fact }]))).toThrow(/names no file: .*PSPath/)
    expect(() => readFacts(JSON.stringify([{ ...fact }]))).toThrow(/names no file/)
    expect(() => readFacts(JSON.stringify([{ file: '', ...fact }]))).toThrow(/names no file/)
    expect(() => readFacts(JSON.stringify({ file: 'a.dll', ...fact }))).toThrow(/answered no list/)
  })

  it('has the script read its list as plain strings', () => {
    // Get-Content is what decorates a line; the script reads the list through .NET and writes the path as text.
    const script = readFileSync(join(__dirname, 'sign-windows.ps1'), 'utf-8')
    expect(script).not.toMatch(/Get-Content\s+-/)
    expect(script).toContain('[System.IO.File]::ReadAllLines($path, [System.Text.Encoding]::UTF8)')
    expect(script).toContain('file = "$f"')
  })
})

describe('batches for signtool', () => {
  it('keep every command line short and the order intact', () => {
    const files = Array.from({ length: 400 }, (_, i) => `${R}\\win-unpacked\\resources\\backend\\_internal\\scipy\\file_${i}.pyd`)
    const out = batches(files)
    expect(out.flat()).toEqual(files)
    for (const b of out) expect(b.join(' ').length).toBeLessThan(24000)
    expect(out.length).toBeGreaterThan(1)
    expect(batches([])).toEqual([])
  })
})

describe('wiring', () => {
  const text = readFileSync(join(__dirname, '..', '..', 'electron-builder.yml'), 'utf-8')
  const config = load(text) as { afterSign: string; win: { signtoolOptions: Record<string, unknown> } }

  it('takes the one certificate subject from publisherName', () => {
    const subject = 'CN="Open Source Developer, Jane Doe", O=Open Source Developer, L=Town, C=DE'
    const yaml = `win:\n  signtoolOptions:\n    publisherName: '${subject.replace(/'/g, "''")}'\n`
    expect(subjectFrom(yaml)).toBe(subject)
    expect(subjectFrom(`win:\n  signtoolOptions:\n    publisherName:\n      - '${subject}'\n`)).toBe(subject)
  })

  it('refuses a missing, a bare or a second publisher name', () => {
    expect(() => subjectFrom('win:\n  target: nsis\n')).toThrow(/publisherName/)
    expect(() => subjectFrom('win:\n  signtoolOptions:\n    publisherName: Jane Doe\n')).toThrow(/CN=/)
    expect(() =>
      subjectFrom("win:\n  signtoolOptions:\n    publisherName:\n      - 'CN=A, C=DE'\n      - 'CN=B, C=DE'\n")
    ).toThrow(/one certificate subject/)
  })

  it('is wired into electron-builder.yml: both hooks, one SHA-256 signature per file, a subject', () => {
    const options = config.win.signtoolOptions
    expect(options.sign).toBe('./scripts/release/sign-windows.mjs')
    expect(config.afterSign).toBe('./scripts/release/sign-windows.mjs')
    expect(options.signingHashAlgorithms).toEqual(['sha256'])
    expect(subjectFrom(text)).toMatch(/^CN=/)
    expect(subjectFrom(text), 'the subject of the real certificate').not.toContain('PENDING')
    expect(publishTargetFrom(text)).toEqual({ owner: 'prismlca', repo: 'prismlca' })
  })

  it('exports each hook under the name electron-builder looks for first', () => {
    expect(typeof hooks.sign).toBe('function')
    expect(typeof hooks.afterSign).toBe('function')
  })

  it('signs nothing outside a Windows release build', async () => {
    const kind = process.env.PRISM_BUILD_KIND
    delete process.env.PRISM_BUILD_KIND
    try {
      await expect(hooks.sign({ path: `${R}\\PrismLCA-Setup-0.9.9.exe` })).resolves.toBeUndefined()
      await expect(hooks.afterSign({ electronPlatformName: 'win32', appOutDir: '/nowhere' })).resolves.toBeUndefined()
      process.env.PRISM_BUILD_KIND = 'release'
      await expect(hooks.afterSign({ electronPlatformName: 'linux', appOutDir: '/nowhere' })).resolves.toBeUndefined()
    } finally {
      if (kind === undefined) delete process.env.PRISM_BUILD_KIND
      else process.env.PRISM_BUILD_KIND = kind
    }
  })
})
