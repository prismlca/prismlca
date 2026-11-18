/**
 * The PE facts the Windows signing rests on: which files are program files, where a signature sits, and a code
 * fingerprint that an unsigned file and its signed copy share — and that nothing hidden in a signed file can fake.
 * The test files are built here the way signtool signs (ImageAddCertificate): pad to 8 bytes, append one
 * WIN_CERTIFICATE, point the security entry at it, rewrite the checksum.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { codeDigest, isPlainSignatureTable, peLayout, programFiles, readPeLayout } from './pe.mjs'

/** A minimal PE image: DOS header, PE signature at `peAt`, COFF header, optional header with 16 directories. */
function image({ plus = true, peAt = 0x80, body = 333, dirs = 16 } = {}): Buffer {
  const optSize = plus ? 112 + 16 * 8 : 96 + 16 * 8
  const buf = Buffer.alloc(peAt + 24 + optSize + body)
  buf.writeUInt16LE(0x5a4d, 0)
  buf.writeUInt32LE(peAt, 0x3c)
  buf.writeUInt32LE(0x00004550, peAt)
  const opt = peAt + 24
  buf.writeUInt16LE(plus ? 0x20b : 0x10b, opt)
  buf.writeUInt32LE(0x1234, opt + 64) // checksum as the linker left it
  buf.writeUInt32LE(dirs, opt + (plus ? 108 : 92))
  for (let i = opt + optSize; i < buf.length; i++) buf[i] = (i * 7 + 3) & 0xff // code
  return buf
}

/** A WIN_CERTIFICATE holding a DER SEQUENCE of `content` bytes, padded to 8; `extra` lands behind the DER. */
function certificate(content = 300, extra = Buffer.alloc(0)): Buffer {
  const der = Buffer.concat([Buffer.from([0x30, 0x82, content >> 8, content & 0xff]), Buffer.alloc(content, 0x5a), extra])
  const length = Math.ceil((8 + der.length) / 8) * 8
  const cert = Buffer.alloc(length)
  cert.writeUInt32LE(length, 0)
  cert.writeUInt16LE(0x0200, 4)
  cert.writeUInt16LE(0x0002, 6)
  der.copy(cert, 8)
  return cert
}

/** `fresh` signed the way signtool does it. */
function signed(fresh: Buffer, cert = certificate()): Buffer {
  const pe = peLayout(fresh)!
  const padded = Buffer.concat([fresh, Buffer.alloc((8 - (fresh.length % 8)) % 8)])
  const out = Buffer.concat([padded, cert])
  out.writeUInt32LE(padded.length, pe.security!)
  out.writeUInt32LE(cert.length, pe.security! + 4)
  out.writeUInt32LE(0xbeef, pe.checksum)
  return out
}

describe('PE layout', () => {
  it('finds the checksum and the security entry in PE32+ and PE32 images', () => {
    expect(peLayout(image({ plus: true }))).toEqual({ checksum: 0x80 + 24 + 64, security: 0x80 + 24 + 112 + 32, certOffset: 0, certSize: 0 })
    expect(peLayout(image({ plus: false }))).toMatchObject({ security: 0x80 + 24 + 96 + 32 })
  })

  it('is null for anything that is not a PE image', () => {
    expect(peLayout(Buffer.from('MZ but nothing more'))).toBeNull()
    expect(peLayout(Buffer.alloc(4096))).toBeNull()
    const ne = image()
    ne.writeUInt32LE(0x0000454e, 0x80) // "NE": a 16-bit image
    expect(peLayout(ne)).toBeNull()
  })

  it('has no security entry when the data directory stops before it', () => {
    expect(peLayout(image({ dirs: 4 }))?.security).toBeNull()
    expect(codeDigest(image({ dirs: 4 }))).toBeNull()
  })

  it('reads the layout from a file, also when the PE header sits far in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-'))
    afterAll(() => rmSync(dir, { recursive: true, force: true }))
    const far = image({ peAt: 9000 })
    writeFileSync(join(dir, 'far.dll'), far)
    writeFileSync(join(dir, 'notes.txt'), 'MZ is also how a text can start')
    expect(readPeLayout(join(dir, 'far.dll'))).toEqual(peLayout(far))
    expect(readPeLayout(join(dir, 'notes.txt'))).toBeNull()
  })
})

describe('signature table', () => {
  it('accepts one PKCS#7 signature padded to 8 bytes', () => {
    expect(isPlainSignatureTable(certificate(300))).toBe(true)
    expect(isPlainSignatureTable(certificate(301))).toBe(true)
  })

  it('refuses data behind the signature, a second entry and foreign types', () => {
    expect(isPlainSignatureTable(certificate(300, Buffer.from('hidden payload')))).toBe(false)
    const two = Buffer.concat([certificate(300), certificate(300)])
    two.writeUInt32LE(two.length, 0) // the first entry claims the whole table
    expect(isPlainSignatureTable(two)).toBe(false)
    const short = Buffer.concat([certificate(300), certificate(300)]) // two entries, each with its own length
    expect(isPlainSignatureTable(short)).toBe(false)
    const x509 = certificate(300)
    x509.writeUInt16LE(0x0001, 6) // WIN_CERT_TYPE_X509
    expect(isPlainSignatureTable(x509)).toBe(false)
    const nonzero = certificate(301) // 8 + 305 bytes, three bytes of padding
    nonzero[nonzero.length - 1] = 1
    expect(isPlainSignatureTable(nonzero)).toBe(false)
  })
})

describe('code digest', () => {
  it('is the same for an unsigned file and its signed copy', () => {
    for (const body of [333, 336]) {
      const fresh = image({ body })
      expect(codeDigest(signed(fresh))).toBe(codeDigest(fresh))
      expect(codeDigest(signed(fresh, certificate(4000)))).toBe(codeDigest(fresh))
    }
    expect(codeDigest(signed(image({ plus: false })))).toBe(codeDigest(image({ plus: false })))
  })

  it('differs when one byte of code differs', () => {
    const fresh = image()
    const other = Buffer.from(fresh)
    other[other.length - 10] ^= 1
    expect(codeDigest(signed(other))).not.toBe(codeDigest(fresh))
  })

  it('takes trailing zeros for the padding signtool adds, which yields the same signed file', () => {
    const fresh = image({ body: 333 })
    const withZeros = Buffer.concat([fresh, Buffer.alloc((8 - (fresh.length % 8)) % 8)])
    expect(codeDigest(withZeros)).toBe(codeDigest(fresh))
    expect(signed(withZeros).equals(signed(fresh))).toBe(true)
  })

  it('has none for a signed file whose table is not plain or not at the end', () => {
    const fresh = image()
    expect(codeDigest(signed(fresh, certificate(300, Buffer.from('hidden'))))).toBeNull()
    const appended = Buffer.concat([signed(fresh), Buffer.from('after the table')])
    expect(codeDigest(appended)).toBeNull()
    const misaligned = signed(fresh)
    misaligned.writeUInt32LE(misaligned.readUInt32LE(peLayout(fresh)!.security!) - 1, peLayout(fresh)!.security!)
    expect(codeDigest(misaligned)).toBeNull()
  })
})

describe('the files of a package', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sign-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const pe = () => {
    const buf = Buffer.alloc(0x80 + 24 + 240 + 16)
    buf.writeUInt16LE(0x5a4d, 0)
    buf.writeUInt32LE(0x80, 0x3c)
    buf.writeUInt32LE(0x00004550, 0x80)
    buf.writeUInt16LE(0x20b, 0x80 + 24)
    buf.writeUInt32LE(16, 0x80 + 24 + 108)
    return buf
  }

  it('are found by content, whatever their name, and named relative to the package', () => {
    mkdirSync(join(dir, 'app', 'resources', 'backend'), { recursive: true })
    writeFileSync(join(dir, 'app', 'PrismLCA.exe'), pe())
    writeFileSync(join(dir, 'app', 'resources', 'backend', 'VCOMP140.DLL'), pe())
    writeFileSync(join(dir, 'app', 'resources', 'backend', 'odd.bin'), pe())
    writeFileSync(join(dir, 'app', 'resources', 'app.asar'), 'not a program')
    expect(programFiles(join(dir, 'app')).map((f) => f.rel).sort()).toEqual([
      'PrismLCA.exe',
      'resources/backend/VCOMP140.DLL',
      'resources/backend/odd.bin'
    ])
  })

  it('may not contain links, which could point signing or copying elsewhere', () => {
    mkdirSync(join(dir, 'linked'))
    symlinkSync(join(dir, 'app'), join(dir, 'linked', 'elsewhere'))
    expect(() => programFiles(join(dir, 'linked'))).toThrow(/is a link/)
  })
})
