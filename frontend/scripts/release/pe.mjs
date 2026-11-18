/**
 * Just enough of the Portable Executable format to sign a Windows package economically: whether a file is a
 * program file (exe, dll, pyd, node — anything Windows loads as code), whether it carries an embedded signature,
 * and a fingerprint of the code it carries that signing does not change. Pure functions over Buffers; whether a
 * signature is valid is for Windows to judge (sign-windows.ps1).
 *
 * Signing a PE file changes four things: the header checksum, the security entry of the data directory, zero
 * padding up to an 8-byte boundary, and the certificate table appended at the end (ImageHlp's ImageAddCertificate,
 * which signtool uses). The fingerprint leaves exactly those out, so an unsigned file and a signed copy of it from
 * an earlier release share it, and the earlier signature can be kept instead of spending a new one.
 */
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const MZ = 0x5a4d
const PE = 0x00004550
const PE32 = 0x10b
const PE32_PLUS = 0x20b
const SECURITY = 4 // index of the certificate table in the data directory

/**
 * Where signing writes in this file, or null when the bytes are not a PE image (or too short to tell).
 * `security` is null for an image whose data directory has no certificate entry: it cannot be signed.
 */
export function peLayout(buf) {
  if (buf.length < 64 || buf.readUInt16LE(0) !== MZ) return null
  const pe = buf.readUInt32LE(0x3c)
  const opt = pe + 24
  if (opt + 2 > buf.length || buf.readUInt32LE(pe) !== PE) return null
  const magic = buf.readUInt16LE(opt)
  if (magic !== PE32 && magic !== PE32_PLUS) return null
  const countAt = opt + (magic === PE32_PLUS ? 108 : 92)
  const dirs = opt + (magic === PE32_PLUS ? 112 : 96)
  if (countAt + 4 > buf.length) return null
  const checksum = opt + 64
  if (buf.readUInt32LE(countAt) <= SECURITY) return { checksum, security: null, certOffset: 0, certSize: 0 }
  const security = dirs + SECURITY * 8
  if (security + 8 > buf.length) return null
  return { checksum, security, certOffset: buf.readUInt32LE(security), certSize: buf.readUInt32LE(security + 4) }
}

/** The PE layout read from a file's first bytes, or null for any other file. */
export function readPeLayout(file) {
  const fd = openSync(file, 'r')
  try {
    let head = Buffer.alloc(4096)
    head = head.subarray(0, readSync(fd, head, 0, head.length, 0))
    if (head.length < 64 || head.readUInt16LE(0) !== MZ) return null
    // The PE header usually sits within the first few hundred bytes; read further when it does not.
    const need = head.readUInt32LE(0x3c) + 24 + 112 + 16 * 8
    if (need > head.length && need <= 1 << 20) {
      const more = Buffer.alloc(need)
      head = more.subarray(0, readSync(fd, more, 0, need, 0))
    }
    return peLayout(head)
  } finally {
    closeSync(fd)
  }
}

/** Total length of the DER element at `at` (tag, length bytes, content), or null when it is not one. */
function derLength(buf, at) {
  if (at + 2 > buf.length) return null
  const first = buf[at + 1]
  if (first < 0x80) return 2 + first
  const n = first & 0x7f
  if (n < 1 || n > 4 || at + 2 + n > buf.length) return null
  let len = 0
  for (let i = 0; i < n; i++) len = len * 256 + buf[at + 2 + i]
  return 2 + n + len
}

/**
 * The certificate table holds one PKCS#7 signature and nothing else: a single WIN_CERTIFICATE of revision 2.0 and
 * type PKCS_SIGNED_DATA, its 8-byte header plus the DER signature rounded up to 8 bytes filling the table, zeros
 * after the signature. Data tucked in behind a signature (the padding Windows tolerates unless
 * EnableCertPaddingCheck is set) fails here.
 */
export function isPlainSignatureTable(table) {
  if (table.length < 16 || table.length % 8 !== 0) return false
  if (table.readUInt32LE(0) !== table.length || table.readUInt16LE(4) !== 0x0200 || table.readUInt16LE(6) !== 0x0002)
    return false
  if (table[8] !== 0x30) return false // a DER SEQUENCE: the PKCS#7 ContentInfo
  const der = derLength(table, 8)
  if (der == null) return false
  const used = 8 + der
  if (used > table.length || Math.ceil(used / 8) * 8 !== table.length) return false
  return table.subarray(used).every((b) => b === 0)
}

/**
 * The fingerprint of the code in a PE file, equal for an unsigned file and every signed copy of it: SHA-256 over
 * the file with the checksum and the security entry zeroed, without the certificate table, padded with zeros to
 * an 8-byte boundary. Null when the bytes are not a signable PE image, or carry a signature in any other form
 * than a plain table at the end of the file — such a file is never taken as a signed copy.
 */
export function codeDigest(buf) {
  const pe = peLayout(buf)
  if (!pe || pe.security == null) return null
  let end = buf.length
  if (pe.certSize !== 0) {
    if (pe.certOffset + pe.certSize !== buf.length || pe.certOffset % 8 !== 0) return null
    if (!isPlainSignatureTable(buf.subarray(pe.certOffset))) return null
    end = pe.certOffset
  }
  if (pe.security + 8 > end) return null
  const hash = createHash('sha256')
  hash.update(buf.subarray(0, pe.checksum))
  hash.update(Buffer.alloc(4))
  hash.update(buf.subarray(pe.checksum + 4, pe.security))
  hash.update(Buffer.alloc(8))
  hash.update(buf.subarray(pe.security + 8, end))
  hash.update(Buffer.alloc((8 - (end % 8)) % 8))
  return hash.digest('hex')
}

/** Every PE file below `dir`: absolute path, path relative to `dir` with forward slashes, layout. */
export function programFiles(dir) {
  const out = []
  const visit = (abs) => {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name)
      const st = lstatSync(p)
      // A link would let a file outside the package be signed or copied over; electron-builder writes none.
      if (st.isSymbolicLink()) throw new Error(`${p} is a link; the package must consist of plain files`)
      if (st.isDirectory()) visit(p)
      else if (st.isFile()) {
        const layout = readPeLayout(p)
        if (layout) out.push({ abs: p, rel: relative(dir, p).split(sep).join('/'), layout })
      }
    }
  }
  visit(resolve(dir))
  return out
}
