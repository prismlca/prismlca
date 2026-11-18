/**
 * The program files of the previous published release, unpacked from its Windows installer: the source of
 * signatures a release can keep instead of spending new ones (Certum allows 5,000 signatures a month per
 * certificate). The release VM starts clean for every job, so the last published release is the only place earlier
 * signatures survive — public, unchangeable, and checked here like any other input: the installer must match the
 * update feed's SHA-512, sign-windows.mjs checks its signature before anything is unpacked, and every file taken
 * from it must carry our own valid signature and the exact code of the fresh build (pe.mjs).
 *
 * electron-builder's NSIS installer carries the app as one 7z archive, stored uncompressed (SetCompress off in its
 * extractAppPackage.nsh): NSIS writes a 4-byte length and then the archive's bytes. The archive is found by its
 * signature, that length, its own start-header CRC, and it must be the only candidate.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, createWriteStream, openSync, readSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32 } from 'node:zlib'

// js-yaml comes with electron-updater, a runtime dependency.
import { load } from 'js-yaml'

/** Where releases are published (the update feed), from the text of electron-builder.yml. */
export function publishTargetFrom(configText) {
  const { owner, repo } = load(configText)?.publish ?? {}
  if (typeof owner !== 'string' || typeof repo !== 'string') throw new Error('electron-builder.yml: publish needs owner and repo')
  return { owner, repo }
}

const SEVEN_Z = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
// The NSIS stub and the installer's own small files come first; the app archive starts within the first megabyte
// today (0.9.12: at 235,387 bytes). The search window leaves room for growth.
const SEARCH_BYTES = 32 << 20

/** Version, installer file name and its SHA-512 from a latest.yml update feed. */
export function feedEntry(text) {
  const feed = load(text) ?? {}
  const { version, path, sha512 } = feed
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`latest.yml names no release version: ${version}`)
  if (typeof path !== 'string' || !/^PrismLCA-Setup-[0-9A-Za-z.-]+\.exe$/.test(path))
    throw new Error(`latest.yml names no installer: ${path}`)
  if (typeof sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(sha512)) throw new Error('latest.yml carries no SHA-512 of the installer')
  return { version, path, sha512 }
}

/**
 * Where the app archive sits in the first bytes of an installer of `size` bytes: { start, length }, or null when
 * not exactly one place qualifies.
 */
export function findAppArchive(head, size) {
  const found = []
  for (let at = head.indexOf(SEVEN_Z); at !== -1; at = head.indexOf(SEVEN_Z, at + 1)) {
    if (at < 4 || at + 32 > head.length) continue
    if (head[at + 6] !== 0) continue // major version of the 7z format
    if (crc32(head.subarray(at + 12, at + 32)) !== head.readUInt32LE(at + 8)) continue
    const length = 32 + Number(head.readBigUInt64LE(at + 12)) + Number(head.readBigUInt64LE(at + 20))
    if (!Number.isSafeInteger(length) || length >= 2 ** 31 || at + length > size) continue
    if (head.readUInt32LE(at - 4) !== length) continue
    found.push({ start: at, length })
  }
  return found.length === 1 ? found[0] : null
}

/** Downloads `url` to `file`; the bytes must have the SHA-512 (base64) the update feed names. */
async function download(url, file, sha512) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'prismlca-release' } })
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`)
  const hash = createHash('sha512')
  const tap = new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk)
      done(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(res.body), tap, createWriteStream(file))
  const got = hash.digest('base64')
  if (got !== sha512) throw new Error(`${url}: SHA-512 ${got} does not match the update feed (${sha512})`)
}

/**
 * Fetches the latest published release's update feed and installer into `installer`.
 * Returns the release version.
 */
export async function downloadPreviousInstaller({ owner, repo }, installer) {
  const base = `https://github.com/${owner}/${repo}/releases`
  const res = await fetch(`${base}/latest/download/latest.yml`, { redirect: 'follow', headers: { 'user-agent': 'prismlca-release' } })
  if (!res.ok) throw new Error(`latest.yml of the latest release: HTTP ${res.status}`)
  const { version, path, sha512 } = feedEntry(await res.text())
  await download(`${base}/download/v${version}/${encodeURIComponent(path)}`, installer, sha512)
  return version
}

/** Copies the app archive out of `installer` into `archive`. */
export async function carveAppArchive(installer, archive) {
  const size = statSync(installer).size
  const fd = openSync(installer, 'r')
  let head
  try {
    head = Buffer.alloc(Math.min(size, SEARCH_BYTES))
    head = head.subarray(0, readSync(fd, head, 0, head.length, 0))
  } finally {
    closeSync(fd)
  }
  const at = findAppArchive(head, size)
  if (!at) throw new Error(`${installer}: no single app archive found inside`)
  await pipeline(createReadStream(installer, { start: at.start, end: at.start + at.length - 1 }), createWriteStream(archive))
}

/**
 * Unpacks the program files of `archive`, and the RECORD files of its Python packages, into `dir` with electron-builder's own 7-Zip (downloaded and
 * checksum-checked by electron-builder). A fresh file with another extension finds no earlier copy and is signed.
 */
export async function unpackProgramFiles(archive, dir) {
  const require = createRequire(import.meta.url)
  const sevenZip = await require('app-builder-lib/out/toolsets/7zip.js').getPath7za()
  const run = spawnSync(
    sevenZip,
    // -ssc-: names match case-insensitively everywhere (VCOMP140.DLL), as they do on Windows.
    // RECORD: which files each Python package installed, for sign-budget.mjs's estimate.
    ['x', archive, `-o${dir}`, '-y', '-bd', '-ssc-', '-ir!*.exe', '-ir!*.dll', '-ir!*.pyd', '-ir!*.node', '-ir!RECORD'],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  )
  if (run.error) throw run.error
  if (run.status !== 0) throw new Error(`7-Zip could not unpack ${archive} (exit ${run.status})`)
}
