/**
 * The program files of the previous published release, unpacked from its Windows installer: the source of
 * signatures a release can keep instead of spending new ones (Certum allows 5,000 signatures a month per
 * certificate). The release VM starts clean for every job, so the last published release is the only place earlier
 * signatures survive — public, unchangeable, and checked here like any other input: the installer must match the
 * SHA-256 GitHub states for it, sign-windows.mjs checks its signature before anything is unpacked, and every file
 * taken from it must carry our own valid signature and the exact code of the fresh build (pe.mjs).
 *
 * Which release is the latest, and its installer's name and SHA-256, come from the GitHub API's record of the
 * release: reading that record counts as no download. The update feed (latest.yml) and the installer do count, in
 * the download statistics of the release, so the tests on every pull request take the installer from the Actions
 * cache when it is there (the workflow previous-installer-cache.yml keeps it) and download it only when it is not.
 *
 * electron-builder's NSIS installer carries the app as one 7z archive, stored uncompressed (SetCompress off in its
 * extractAppPackage.nsh): NSIS writes a 4-byte length and then the archive's bytes. The archive is found by its
 * signature, that length, its own start-header CRC, and it must be the only candidate.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, openSync, readSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
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

const INSTALLER = /^PrismLCA-Setup-[0-9A-Za-z.-]+\.exe$/

/**
 * Version, installer name, download address and SHA-256 (hex) of the Windows installer, from the GitHub API's record
 * of a release of `target`. The address is built from the record's tag and file name, not taken from it.
 */
export function installerOf(release, { owner, repo }) {
  const tag = String(release?.tag_name ?? '')
  const version = /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1]
  if (!version) throw new Error(`the latest release has no version tag: ${tag || '(none)'}`)
  const found = (Array.isArray(release.assets) ? release.assets : []).filter((a) => INSTALLER.test(String(a?.name ?? '')))
  if (found.length !== 1) throw new Error(`${tag} has ${found.length} Windows installers, not one`)
  const { name, digest } = found[0]
  const sha256 = /^sha256:([0-9a-f]{64})$/.exec(String(digest ?? ''))?.[1]
  if (!sha256) throw new Error(`${name}: GitHub states no SHA-256 for it`)
  const url = `https://github.com/${owner}/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`
  return { version, name, url, sha256 }
}

/** The latest published release's installer, as installerOf describes it. Reads metadata only. */
export async function latestRelease(target) {
  const headers = { 'user-agent': 'prismlca-release', accept: 'application/vnd.github+json' }
  // The record is public; a token only lifts the limit on anonymous calls (60 an hour per address).
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(`https://api.github.com/repos/${target.owner}/${target.repo}/releases/latest`, { headers })
  if (!res.ok) throw new Error(`the latest release's record: HTTP ${res.status}`)
  return installerOf(await res.json(), target)
}

async function sha256Of(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
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

/** Downloads `url` to `file`; the bytes must have the SHA-256 (hex) GitHub states for them. */
async function download(url, file, sha256) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'prismlca-release' } })
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`)
  const hash = createHash('sha256')
  const tap = new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk)
      done(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(res.body), tap, createWriteStream(file))
  const got = hash.digest('hex')
  if (got !== sha256) throw new Error(`${url}: SHA-256 ${got} does not match the one GitHub states (${sha256})`)
}

/**
 * Puts the latest published release's installer at `installer` and returns the release version. `cache`, when
 * given, is a directory that may hold that installer under its own name: a copy with the stated SHA-256 is taken
 * from there, and anything else is downloaded.
 */
export async function downloadPreviousInstaller(target, installer, { cache } = {}) {
  const latest = await latestRelease(target)
  const kept = cache ? join(cache, latest.name) : null
  if (kept && existsSync(kept)) {
    if ((await sha256Of(kept)) === latest.sha256) {
      copyFileSync(kept, installer)
      console.log(`${latest.name}: taken from the cache, not downloaded`)
      return latest.version
    }
    console.log(`${latest.name}: the cached copy is not the published one; downloading it`)
  } else if (cache) console.log(`${latest.name}: not in the cache; downloading it`)
  await download(latest.url, installer, latest.sha256)
  return latest.version
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
