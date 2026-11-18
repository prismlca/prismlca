/**
 * Reading the previous release: the update feed names the installer and its SHA-512, and the app archive is found
 * inside the installer only where exactly one place has the 7z signature, a valid start header and the NSIS length
 * in front of it. The download and 7-Zip run on the release VM; these are the parts that decide.
 */
import { crc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import { feedEntry, findAppArchive } from './previous-release.mjs'

const SHA = `${'A'.repeat(86)}==`

describe('update feed', () => {
  it('names version, installer and SHA-512 as electron-builder writes them', () => {
    const text = [
      'version: 0.9.12',
      'files:',
      '  - url: PrismLCA-Setup-0.9.12.exe',
      `    sha512: ${SHA}`,
      '    size: 587396424',
      'path: PrismLCA-Setup-0.9.12.exe',
      `sha512: ${SHA}`,
      "releaseDate: '2026-11-13T18:02:11.188Z'"
    ].join('\n')
    expect(feedEntry(text)).toEqual({ version: '0.9.12', path: 'PrismLCA-Setup-0.9.12.exe', sha512: SHA })
  })

  it('refuses a feed that could point anywhere else', () => {
    const feed = (version: string, path: string, sha512: string) => `version: ${version}\npath: ${path}\nsha512: '${sha512}'\n`
    expect(() => feedEntry(feed('0.9.12', '../other.exe', SHA))).toThrow(/installer/)
    expect(() => feedEntry(feed('0.9.12', 'evil/PrismLCA-Setup-1.exe', SHA))).toThrow(/installer/)
    expect(() => feedEntry(feed('0.9', 'PrismLCA-Setup-0.9.exe', SHA))).toThrow(/version/)
    expect(() => feedEntry(feed('0.9.12', 'PrismLCA-Setup-0.9.12.exe', 'abc'))).toThrow(/SHA-512/)
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
