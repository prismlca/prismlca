/**
 * The pure half of the release script (prepare.mjs): no git, no network, no files. Tested in
 * lib.test.ts. One command sets the version everywhere, drafts the changelog and checks the toolchain.
 */

/** `0.9.0` + `patch` → `0.9.1`; + `minor` → `0.10.0`; an explicit `x.y.z` must be higher. */
export function nextVersion(current, bump) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
    if (!m) throw new Error(`not a plain x.y.z version: ${v}`)
    return m.slice(1).map(Number)
  }
  const [maj, min, pat] = parse(current)
  let next
  if (bump === 'patch') next = [maj, min, pat + 1]
  else if (bump === 'minor') next = [maj, min + 1, 0]
  else if (/^\d+\.\d+\.\d+$/.test(bump ?? '')) next = parse(bump)
  else throw new Error('say which: patch, minor, or an explicit x.y.z (the script never guesses)')
  const cmp = next[0] - maj || next[1] - min || next[2] - pat
  if (cmp <= 0) throw new Error(`${next.join('.')} is not higher than ${current}`)
  return next.join('.')
}

/**
 * The previous release: the most recently PUBLISHED stable GitHub release. Sorted by `published_at`,
 * not taken from the top of the list — the API orders by creation, and a draft created early but
 * published late would otherwise come first. Spike tags never count.
 */
export function pickPreviousRelease(releases) {
  const stable = (releases ?? []).filter(
    (r) => r && !r.draft && !r.prerelease && r.published_at && !/-spike\./.test(r.tag_name ?? '')
  )
  stable.sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))
  const top = stable[0]
  return top ? { tag: top.tag_name, publishedAt: top.published_at } : null
}

/** What's-new entries (newest first, `date` = YYYY-MM-DD) written after the previous release's day. */
export function whatsNewSince(entries, sinceIso) {
  const since = sinceIso ? sinceIso.slice(0, 10) : null
  return (entries ?? []).filter((e) => e && typeof e.title === 'string' && (!since || e.date > since))
}

/** Marker the script refuses to release with: the section must have been read and decided. */
export const TODO = 'TODO(release):'

/**
 * The draft section for CHANGELOG.md. Every What's-new title is listed under "New" for the maintainer
 * to keep, move to "Fixes" or delete — What's-new also holds collected fixes, so it is no feature
 * counter. Issue references are added by hand. The TODO lines make the script wait until that is done.
 */
/**
 * Commit subjects since the previous release, as raw material for the Fixes list — not text for readers:
 * release commits, merges and documentation-only commits are left out, the rest is for a person (or the
 * agent preparing the release) to sum up in a few lines users would notice.
 */
export function commitSuggestions(subjects) {
  return (subjects ?? []).filter(
    (s) => s && !/^release: v\d/.test(s) && !/^Merge /.test(s) && !/^docs(\([^)]*\))?:/i.test(s)
  )
}

export function changelogSection({ version, date, previous, entries, repoUrl, commits = [] }) {
  const lines = [`## ${version} — ${date}`, '']
  if (!previous) {
    lines.push('First public beta.', '', `${TODO} write the notes for the first release by hand.`, '')
  } else {
    lines.push(`Changes since ${previous.tag}: ${repoUrl}/compare/${previous.tag}...v${version}`, '')
    lines.push('### New', '')
    for (const e of entries) lines.push(`- ${e.title}`)
    if (!entries.length) lines.push('- (nothing in What\'s new since the previous release)')
    lines.push('', '### Fixes', '', `- ${TODO} list the fixes worth naming (with #issue), or delete this section.`, '')
    // Every raw line carries the TODO mark, so none can slip into the published notes.
    if (commits.length) {
      lines.push(`${TODO} the commits since ${previous.tag}, to sum up above and then delete:`)
      for (const c of commits) lines.push(`${TODO}   ${c}`)
      lines.push('')
    }
    lines.push(`${TODO} sort the lines above into New and Fixes, then delete this line.`, '')
  }
  return lines.join('\n')
}

/** Put the section above the newest one, newest first — under the heading and whatever introduces the file. */
export function insertSection(changelog, section) {
  const at = changelog.search(/^## /m)
  if (at >= 0) return `${changelog.slice(0, at)}${section}\n${changelog.slice(at)}`.replace(/\n{3,}/g, '\n\n')
  return `${changelog.trimEnd()}\n\n${section}`.replace(/\n{3,}/g, '\n\n')
}

// ---------------------------------------------------------------------------------------------
// The CI half (ci.mjs, release.yml): pure decisions the workflow steps make.

/**
 * The tag a release run builds — `refs/tags/vX.Y.Z`, and only when every version source agrees. A spike
 * tag `vX.Y.Z-spike.N` builds the same way to rehearse the pipeline; its draft is a pre-release that is
 * never published and is deleted afterwards.
 */
export function checkReleaseRef(ref, frontendVersion, backendVersion) {
  const m = /^refs\/tags\/v(\d+\.\d+\.\d+)(-spike\.\d+)?$/.exec(ref ?? '')
  if (!m) return `a release builds only from a tag vX.Y.Z (or vX.Y.Z-spike.N), not ${ref || '(no ref)'}`
  const tag = m[1]
  if (frontendVersion !== tag || backendVersion !== tag)
    return `tag v${tag} but frontend/package.json says ${frontendVersion} and backend/pyproject.toml ${backendVersion}`
  return null
}

/**
 * Is the installed Electron on a supported line and on that line's newest patch? Electron supports the
 * three newest majors. `distTags` is `npm view electron dist-tags`.
 * Returns { block: [...], warn: [...] }.
 */
export function electronSupport(installed, distTags) {
  const block = []
  const warn = []
  const major = Number(String(installed).split('.')[0])
  const latestMajor = Number(String(distTags?.latest ?? '').split('.')[0])
  if (!Number.isFinite(major) || !Number.isFinite(latestMajor)) return { block: ['cannot read the Electron versions'], warn }
  if (major < latestMajor - 2) block.push(`Electron ${major} is out of support (supported: ${latestMajor - 2}–${latestMajor})`)
  const newest = distTags?.[`${major}-x-y`]
  if (newest && newest !== installed) block.push(`Electron ${installed} is behind its line's newest patch ${newest}`)
  if (major === latestMajor - 2) warn.push(`Electron ${major} is the oldest supported line and drops out with the next major`)
  return { block, warn }
}

/**
 * The audit rule: every advisory in SHIPPED code blocks until it is fixed or assessed in the
 * exceptions file (id, package, reason, expires). An expired exception blocks again. Build-only npm
 * packages never reach a user: they are listed, and only a critical one blocks.
 * `findings`: [{ id, package, severity, shipped }]; `exceptions`: [{ id, package, reason, expires }].
 */
export function auditVerdict(findings, exceptions, today) {
  const valid = new Map()
  const expired = []
  for (const e of exceptions ?? []) {
    if (!e?.id || !e?.reason || !e?.expires) continue
    if (e.expires < today) expired.push(e)
    else valid.set(e.id, e)
  }
  const blocked = []
  const accepted = []
  const reported = []
  for (const f of findings ?? []) {
    if (!f.shipped) {
      ;(f.severity === 'critical' ? blocked : reported).push(f)
    } else if (valid.has(f.id)) accepted.push({ ...f, reason: valid.get(f.id).reason })
    else blocked.push(f)
  }
  const used = new Set(accepted.map((f) => f.id))
  const stale = [...valid.values()].filter((e) => !used.has(e.id))
  return { blocked, accepted, reported, expired, stale }
}

/** PEP 503 name: `Win32_SetCTime` and `win32-setctime` are one package. */
export const pyName = (name) => String(name).toLowerCase().replace(/[-_.]+/g, '-')

/**
 * What pip-audit checks, from `uv export` of the WHOLE locked closure: every platform (a Windows-only
 * package must not slip past a gate that runs on Linux) and every extra. Environment markers go, and so
 * do local version labels — torch 2.14.1+cpu is built from the same source as 2.14.1, and PyPI, which
 * pip-audit asks, knows only the plain version. A line that is not an exact pin (a path or URL
 * dependency) cannot be checked and comes back in `unpinned`.
 */
export function auditRequirements(exportText) {
  const pins = new Set()
  const unpinned = []
  for (const raw of String(exportText).split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const req = line.replace(/\s*;.*$/, '').replace(/(==[^+\s]+)\+[\w.]+$/, '$1')
    if (/^[A-Za-z0-9][\w.-]*==[^\s=;]+$/.test(req)) pins.add(req)
    else unpinned.push(line)
  }
  return { pins: [...pins].sort(), unpinned }
}

const parseReport = (tool, text) => {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${tool} produced no report — the audit did not run`)
  }
}

/**
 * `npm audit --json`, accepted only as a finished report. npm exits 1 both when it finds something and
 * when its request fails, so the exit code cannot tell the two apart — and an error object, read as a
 * report, has no vulnerabilities at all.
 */
export function npmAuditReport(text) {
  const r = parseReport('npm audit', text)
  if (r?.error || r?.auditReportVersion !== 2 || typeof r?.vulnerabilities !== 'object' || !r.vulnerabilities)
    throw new Error(`npm audit failed: ${JSON.stringify(r?.error ?? r).slice(0, 300)}`)
  return r
}

/** pip-audit's JSON, accepted only if it reports on every pin it was given. */
export function pipAuditReport(text, pins) {
  const r = parseReport('pip-audit', text)
  if (!Array.isArray(r?.dependencies)) throw new Error(`pip-audit failed: ${JSON.stringify(r).slice(0, 300)}`)
  const seen = new Set(r.dependencies.map((d) => pyName(d.name)))
  const missing = pins.map((p) => p.split('==')[0]).filter((n) => !seen.has(pyName(n)))
  if (missing.length) throw new Error(`pip-audit did not report on ${missing.join(', ')}`)
  return r
}

/** `0.9.0-spike.2` → true: a rehearsal build, never a release. */
export const isSpike = (version) => /-spike\.\d+$/.test(String(version ?? ''))

/** The CHANGELOG section of one version, as release notes (without its own heading). */
/**
 * What would break the update feed: every file `latest*.yml` names (`url:` and `path:`) must be among the
 * release files under exactly that name, and no release file may contain a space — GitHub renames those on
 * upload, so the feed would point at a file that is not there. Returns the problems; empty means fine.
 */
export function feedProblems(feeds, files) {
  const present = new Set(files)
  const problems = files.filter((f) => f.includes(' ')).map((f) => `"${f}" has a space; GitHub renames it on upload`)
  for (const { name, text } of feeds) {
    const named = new Set(
      [...String(text).matchAll(/^\s*(?:-\s*url|path):\s*['"]?([^'"\n]+?)['"]?\s*$/gm)].map((m) => m[1])
    )
    for (const file of named)
      if (!present.has(file)) problems.push(`${name} names ${file}, which is not among the release files`)
  }
  return problems
}

export function notesFor(changelog, version) {
  const lines = String(changelog).split('\n')
  const start = lines.findIndex((l) => l.startsWith(`## ${version} `) || l === `## ${version}`)
  if (start < 0) return null
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim()
}
