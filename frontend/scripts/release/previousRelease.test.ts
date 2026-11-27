/**
 * Reading the previous release: GitHub's record of the latest release names the installer and its SHA-256, and the
 * app archive is found inside the installer only where exactly one place has the 7z signature, a valid start header
 * and the NSIS length in front of it. The download and 7-Zip run on the release VM; these are the parts that decide.
 */
import { crc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import { findAppArchive, installerOf } from './previous-release.mjs'

const TARGET = { owner: 'prismlca', repo: 'prismlca' }
const DIGEST = `sha256:${'ab'.repeat(32)}`
const asset = (name: string, digest: string | null = DIGEST) => ({ name, digest })
const release = (tag: string, assets: unknown[]) => ({ tag_name: tag, assets })

describe("the latest release's record", () => {
  it('names version, installer, its address and SHA-256 as the GitHub API writes them', () => {
    const record = release('v0.9.17', [
      asset('latest.yml'),
      asset('PrismLCA-Setup-0.9.17.exe'),
      asset('PrismLCA-Setup-0.9.17.exe.blockmap'),
      asset('PrismLCA-0.9.17.AppImage')
    ])
    expect(installerOf(record, TARGET)).toEqual({
      version: '0.9.17',
      name: 'PrismLCA-Setup-0.9.17.exe',
      url: 'https://github.com/prismlca/prismlca/releases/download/v0.9.17/PrismLCA-Setup-0.9.17.exe',
      sha256: 'ab'.repeat(32)
    })
  })

  it('refuses a record that could point anywhere else or cannot be checked', () => {
    const one = (tag: string, a: unknown) => () => installerOf(release(tag, [a]), TARGET)
    expect(one('v0.9', asset('PrismLCA-Setup-0.9.exe'))).toThrow(/version tag/)
    expect(one('0.9.17', asset('PrismLCA-Setup-0.9.17.exe'))).toThrow(/version tag/)
    expect(one('v0.9.17', asset('../PrismLCA-Setup-0.9.17.exe'))).toThrow(/0 Windows installers/)
    expect(one('v0.9.17', asset('evil/PrismLCA-Setup-0.9.17.exe'))).toThrow(/0 Windows installers/)
    expect(one('v0.9.17', asset('PrismLCA-Setup-0.9.17.exe', null))).toThrow(/SHA-256/)
    expect(one('v0.9.17', asset('PrismLCA-Setup-0.9.17.exe', 'sha512:abc'))).toThrow(/SHA-256/)
    const two = release('v0.9.17', [asset('PrismLCA-Setup-0.9.17.exe'), asset('PrismLCA-Setup-0.9.17-x.exe')])
    expect(() => installerOf(two, TARGET)).toThrow(/2 Windows installers/)
    expect(() => installerOf({}, TARGET)).toThrow(/version tag/)
  })
})

/** A 7z start header for an archive of `length` bytes; `bad` spoils its CRC. */
function startHeader(length: number, bad = false): Buffer {
  const h = Buffer.alloc(32)
  Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]).copy(h)
  h.writeBigUInt64LE(BigInt(length - 32 - 40), 12) // next header offset
  h.writeBigUInt64LE(40n, 20) // next header size
  h.writeUInt32LE((crc32(h.subarray(12, 32)) ^ (bad ? 1 : 0)) >>> 0, 8)
  return h
}

/** Installer bytes: a stub, then NSIS's length prefix and the archive start, as electron-builder lays it out. */
function installer(at: number, length: number, prefix = length, bad = false): Buffer {
  const buf = Buffer.alloc(at + 64, 0x11)
  buf.writeUInt32LE(prefix, at - 4)
  startHeader(length, bad).copy(buf, at)
  return buf
}

describe('app archive inside the installer', () => {
  it('is found by signature, start-header CRC and the NSIS length in front of it', () => {
    expect(findAppArchive(installer(235387, 586693886), 587396424)).toEqual({ start: 235387, length: 586693886 })
  })

  it('is not taken from a place where any of the three does not fit', () => {
    expect(findAppArchive(installer(1000, 5000, 4999), 10_000)).toBeNull() // length prefix
    expect(findAppArchive(installer(1000, 5000, 5000, true), 10_000)).toBeNull() // CRC
    expect(findAppArchive(installer(1000, 50_000), 10_000)).toBeNull() // longer than the installer
    expect(findAppArchive(Buffer.alloc(4096), 4096)).toBeNull()
  })

  it('is not taken when two places qualify', () => {
    const two = Buffer.concat([installer(1000, 5000), installer(1000, 5000)])
    expect(findAppArchive(two, 100_000)).toBeNull()
  })
})
