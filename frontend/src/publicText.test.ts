/**
 * Text the repository publishes — code, comments, docs, assets — keeps two rules of CLAUDE.md.
 *
 * "The product name is PrismLCA": one word, never with a space and never cut to its first half.
 * Identifiers keep their own spelling (prism_lca, prism-lca, X-Prism-Token, PrismApi); the wordmark
 * `Prism<b>LCA</b>` is the one word set in two weights; a path segment after `/` or `\` is the old data
 * folder as it really is on disk. Tests are not read for this rule: they spell the old name on purpose, to
 * check the code that handles it.
 *
 * "Comments and public docs speak as a team": no review handles, no personal names, no attributions.
 * - Handles are caught in the forms the review lists used: CR and a number, FE- or BE- with an area and a
 *   number, MCP and a number. A letter and a digit is too common to tell from a paper size or a grid cell,
 *   so that form is left to review. V-numbers and issue keys may stay.
 * - The person is the maintainer, read from package.json. The first name standing alone is how an
 *   attribution reads, so it is caught everywhere. The full name stands where the law, a licence or the
 *   credits need it, and those files are listed in NAME_FILES with their reason; anywhere else it is caught
 *   too, and so is the full name in parentheses with a date. A generic "(name, date)" pattern would also
 *   catch source citations such as "(Models API, 2026-11-08)", so the guard looks for the person instead.
 *
 * Read are the files git tracks or would add (nothing ignored, so nothing private), minus texts of third
 * parties, which keep their own spelling and names. Patterns run over whole files, so a name wrapped onto
 * the next line still reads as one. An exception excuses the occurrences inside its own text, as many as it
 * states and no more: a new occurrence, even beside an old one, needs its own entry.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '../..')
/** This file names the forms it looks for. */
const SELF = 'frontend/src/publicText.test.ts'

/** Text we write. Images, fonts, dictionaries and binaries are not read. */
const TEXT = /\.(?:[cm]?[jt]sx?|py|css|md|html|json|ya?ml|toml|typ|nsh|ps1|sh|spec)$/
/** Third-party texts and data, reproduced as they are. */
const THIRD_PARTY =
  /(?:^|\/)THIRD-PARTY-NOTICES\.md$|(?:^|\/)package-lock\.json$|^frontend\/resources\/dictionaries\/|^backend\/src\/prism_lca\/assets\/(?:geo|transport)\/[^/]+\.json$/
/** Test code and its harnesses. */
const TEST = /\.test\.[cm]?[jt]sx?$|(?:^|\/)test\/|^backend\/tests\/|^frontend\/e2e\//

/** A place that keeps a form the rule forbids, on purpose: the `count` occurrences inside `text` in `file`
 *  (one when not given). */
interface Keep {
  file: string
  text: string
  why: string
  count?: number
}

const KEEP_OLD_NAME: Keep[] = [
  {
    file: 'backend/src/prism_lca/config.py',
    text: 'APP_NAME = "Prism LCA"',
    why: "the data folder's name on disk; renaming it would orphan every user's data"
  },
  {
    file: 'frontend/src/main/userDataMigration.ts',
    text: 'The product was renamed from "Prism LCA" to "PrismLCA"',
    why: 'the migration says which folder it moves the settings from'
  },
  {
    file: 'frontend/src/main/index.ts',
    text: "adoptLegacyUserData(userData, join(dirname(userData), 'Prism LCA'))",
    why: 'the old settings folder the migration adopts'
  },
  {
    file: 'frontend/src/main/index.ts',
    text: 'from the former "Prism LCA" folder',
    why: 'the log line names the old settings folder'
  },
  ...['local', 'support', 'data'].map((dir) => ({
    file: 'frontend/scripts/control-prism/doctor.ts',
    text: `at(${dir}, 'Prism LCA')`,
    why: 'the data folder of older installs, looked for by name'
  })),
  {
    file: 'backend/src/prism_lca/engine/report_prompts.py',
    text: '(Prism Model Health Check) was carried out',
    why: 'quotes a sentence a model wrote, as the example of what a report must not say'
  },
  {
    file: 'backend/src/prism_lca/engine/report_prompts.py',
    text: 'r"|Prism(?:\\s?LCA)?"',
    why: 'the pattern that finds the product name in report prose'
  },
  {
    file: 'CLAUDE.md',
    text: 'Never "Prism LCA" with a space and never shortened to "Prism"',
    why: 'states this rule',
    count: 2
  }
]

const NOT_HANDLES: Keep[] = [
  {
    file: 'CLAUDE.md',
    text: 'no review handles (A1, CR06, FE-VIEW-02)',
    why: 'states the rule, with examples of handles',
    count: 2
  }
]

const NOT_ATTRIBUTIONS: Keep[] = []

/** Files that have to name the maintainer, and why. The full name stands there; nowhere else. */
const NAME_FILES: Record<string, string> = {
  'CLA.md': 'the party to the contributor agreement',
  'CLA-ENTITY.md': 'the party to the contributor agreement',
  'PRIVACY.md': 'the privacy controller',
  'frontend/src/renderer/src/assets/privacy-notice.md': 'the privacy controller (copy of PRIVACY.md)',
  'README.md': 'copyright and the code-signing publisher',
  'CHANGELOG.md': 'the code-signing publisher of the installers',
  'frontend/package.json': 'the package author',
  'frontend/electron-builder.yml': 'copyright, package maintainer and code-signing publisher',
  'frontend/src/main/splash.ts': 'credits on the start screen',
  'frontend/src/renderer/src/views/Overview.tsx': 'credits on the Overview',
  'frontend/src/renderer/src/views/settings/AboutLinks.tsx': 'credits in Settings, About',
  'frontend/src/renderer/src/views/overview/LicenceLink.dom.test.tsx': 'checks the copyright line it shows'
}

const OLD_NAME = /(?<![\w\-/\\])Prism(?!\w|<b>LCA)/g
const HANDLE = /\b(?:CR-?\d{2,3}|(?:FE|BE)-[A-Z]{2,5}-\d{1,3}|MCP-?\d{2})\b/g

const author: string =
  JSON.parse(readFileSync(join(ROOT, 'frontend/package.json'), 'utf8')).author?.name ?? ''
const [first, last] = [author.split(/\s+/)[0], author.split(/\s+/).at(-1) ?? '']
/** Between first and last name: spaces, or a line break with the comment marks of the next line. */
const GAP = '[\\s/#*]+'
const FIRST_NAME = new RegExp(`\\b${first}\\b(?!${GAP}${last}\\b)`, 'g')
const FULL_NAME = new RegExp(`\\b${first}${GAP}${last}\\b`, 'g')
const DATED_FULL_NAME = new RegExp(`\\(\\s*${first}${GAP}${last}\\s*,\\s*\\d`, 'g')

interface Hit {
  file: string
  /** 1-based line of the match's start. */
  n: number
  line: string
  /** Offset of the match within `line`. */
  at: number
  match: string
}

function publishedFiles(): Map<string, string> {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  const out = new Map<string, string>()
  for (const file of new Set(listed.split('\0'))) {
    if (!TEXT.test(file) || THIRD_PARTY.test(file) || !existsSync(join(ROOT, file))) continue
    out.set(file, readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n'))
  }
  return out
}

const files = publishedFiles()

/** Every match of `pattern` (global) in the files `scope` lets through. */
function hits(pattern: RegExp, scope: (file: string) => boolean): Hit[] {
  const out: Hit[] = []
  for (const [file, text] of files) {
    if (!scope(file)) continue
    for (const m of text.matchAll(pattern)) {
      const start = text.lastIndexOf('\n', m.index - 1) + 1
      const end = text.indexOf('\n', m.index)
      out.push({
        file,
        n: text.slice(0, m.index).split('\n').length,
        line: text.slice(start, end < 0 ? undefined : end),
        at: m.index - start,
        match: m[0]
      })
    }
  }
  return out
}

/** Whether `keep` covers this occurrence: same file, and the match lies inside one of the keep's texts. */
function covers(keep: Keep, hit: Hit): boolean {
  if (keep.file !== hit.file) return false
  for (let i = hit.line.indexOf(keep.text); i >= 0; i = hit.line.indexOf(keep.text, i + 1)) {
    if (i <= hit.at && hit.at + hit.match.length <= i + keep.text.length) return true
  }
  return false
}

/** The occurrences no entry of `keeps` covers, and the entries that cover another number than they state. */
function check(found: Hit[], keeps: Keep[]): { open: string[]; miscounted: string[] } {
  const used = new Map<Keep, number>(keeps.map((k) => [k, 0]))
  const open: string[] = []
  for (const hit of found) {
    const keep = keeps.find((k) => covers(k, hit))
    if (keep) used.set(keep, (used.get(keep) ?? 0) + 1)
    else open.push(`${hit.file}:${hit.n}: ${hit.line.trim().slice(0, 160)}`)
  }
  const miscounted = keeps
    .filter((k) => used.get(k) !== (k.count ?? 1))
    .map((k) => `${k.file}: "${k.text}" covers ${used.get(k)}, states ${k.count ?? 1}`)
  return { open, miscounted }
}

const product = (file: string): boolean => !TEST.test(file)
const voice = (file: string): boolean => file !== SELF

const oldName = check(hits(OLD_NAME, product), KEEP_OLD_NAME)
const handles = check(hits(HANDLE, voice), NOT_HANDLES)
const firstName = check(hits(FIRST_NAME, voice), NOT_ATTRIBUTIONS)
const fullName = [
  ...hits(FULL_NAME, (f) => voice(f) && !(f in NAME_FILES)),
  ...hits(DATED_FULL_NAME, voice)
].map((h) => `${h.file}:${h.n}: ${h.line.trim().slice(0, 160)}`)

const VOICE_RULE = 'CLAUDE.md, "Comments and public docs speak as a team"'

describe('the patterns', () => {
  const cases: [string, RegExp, string[], string[]][] = [
    [
      'old product name',
      OLD_NAME,
      ['Welcome to Prism LCA', 'Open Prism and', "Prism's canvas", 'the Prism-LCA app'],
      ['PrismLCA', 'prism_lca', "'X-Prism-Token'", 'PrismApi', 'Prism<b>LCA</b>', '.local/share/Prism LCA/x']
    ],
    [
      'review handle',
      HANDLE,
      ['// fixed per CR06', 'see FE-VIEW-02', 'BE-ENG-12 asked for', 'MCP01 showed'],
      ['V277', 'PL-141', 'ADR-005', 'A4 paper', 'soap MP-01', 'CO2', 'MCP 2025-06-18', 'CRLF']
    ],
    [
      'first name',
      FIRST_NAME,
      [`(${first}, 12.11.2026)`, `${first}'s call`, `as ${first} decided`],
      [
        `Copyright (C) 2026 ${first} ${last}`,
        `${first} ${last}, the author`,
        `signed by ${first}\n${last}`,
        `// credits: ${first}\n// ${last}`
      ]
    ],
    [
      'dated full name',
      DATED_FULL_NAME,
      [`(${first} ${last}, 2026-11-12)`, `( ${first} ${last}, 12.11.2026)`],
      [`Copyright (C) 2026 ${first} ${last}`, `(${first} ${last}, the author)`]
    ]
  ]
  for (const [what, pattern, caught, passed] of cases) {
    it(`catches a ${what} and lets the lookalikes pass`, () => {
      const test = (s: string): boolean => s.match(pattern) !== null
      expect(caught.filter((s) => !test(s))).toEqual([])
      expect(passed.filter(test)).toEqual([])
    })
  }

  it('lets an exception cover only the occurrences inside its own text', () => {
    const keep: Keep = { file: 'a.ts', text: "join(dir, 'Prism LCA')", why: 'test' }
    const at = (line: string): Hit => {
      const m = line.match(new RegExp(OLD_NAME.source))
      return { file: 'a.ts', n: 1, line, at: m?.index ?? -1, match: m?.[0] ?? '' }
    }
    expect(covers(keep, at("const old = join(dir, 'Prism LCA')"))).toBe(true)
    expect(covers(keep, at("win.setTitle('Prism LCA'); join(dir, 'Prism LCA')"))).toBe(false)
    expect(covers({ ...keep, file: 'b.ts' }, at("join(dir, 'Prism LCA')"))).toBe(false)
  })
})

describe('published text', () => {
  it('reads the real tree — an empty walk would pass everything below', () => {
    expect(files.size).toBeGreaterThan(1000)
    for (const f of ['CLAUDE.md', 'backend/src/prism_lca/config.py', SELF]) expect(files.has(f)).toBe(true)
    for (const f of Object.keys(NAME_FILES)) expect(files.has(f), `NAME_FILES lists ${f}`).toBe(true)
    expect(first.length).toBeGreaterThan(2)
    expect(last).not.toBe(first)
  })

  it('writes the product name as one word', () => {
    expect(
      oldName.open,
      'Write the product name as "PrismLCA": one word, never "Prism LCA" with a space and never a bare ' +
        '"Prism" (CLAUDE.md, "The product name is PrismLCA"). Identifiers keep their own spelling ' +
        '(prism_lca, prism-lca, X-Prism-Token). Only a place that must keep the old spelling — the real ' +
        'name of the old data folder, a pattern that looks for the old name — goes into KEEP_OLD_NAME in ' +
        'publicText.test.ts, with the reason'
    ).toEqual([])
  })

  it('carries no review handles', () => {
    expect(
      handles.open,
      'These look like review handles, the IDs of findings in a review list. Comments and docs speak as a ' +
        'team and carry their reason themselves: say what the code guards against or why it is written ' +
        `this way, and leave the handle to the commit message (${VOICE_RULE}). V-numbers and issue keys ` +
        'may stay. If one of these is not a handle but, say, a product code, add it to NOT_HANDLES in ' +
        'publicText.test.ts with what it is'
    ).toEqual([])
  })

  it('names no person by first name', () => {
    expect(
      firstName.open,
      `These lines name a person by first name: ${first}, the maintainer (package.json). Where text has ` +
        'to name the person — copyright, CLA, privacy controller, code-signing publisher, credits in the ' +
        'app or the docs — it ' +
        `gives the full name, ${first} ${last}, in a file listed in NAME_FILES of publicText.test.ts. ` +
        'Everywhere else code, comments and docs speak as a team, "we" or neutral: no personal names and ' +
        'no attributions such as "(name, date)". A comment carries its reason itself; who decided and ' +
        `when belongs in the commit message (${VOICE_RULE})`
    ).toEqual([])
  })

  it('gives the full name only where the person has to be named', () => {
    expect(
      fullName,
      `These lines give the maintainer's full name, ${first} ${last}, outside the files that have to ` +
        'name the person, or with a date as an attribution. Code, comments and docs speak as a team, ' +
        '"we" or neutral: a comment carries its reason itself; who decided and when belongs in the commit ' +
        `message (${VOICE_RULE}). If the line is meant to name the person — a copyright line, the CLA, ` +
        'the privacy controller, the code-signing publisher, or credits in the app or the docs — the full ' +
        'name is right there: add this file to NAME_FILES in publicText.test.ts with the reason'
    ).toEqual([])
  })

  it('keeps every exception to the occurrences it states', () => {
    expect(
      [...oldName.miscounted, ...handles.miscounted, ...firstName.miscounted],
      'An exception in publicText.test.ts covers another number of occurrences than it states. Fewer: ' +
        'the text it excuses is gone or changed — remove or update the entry. More: a new occurrence ' +
        'repeats an excused text; fix the new one, or give it its own entry with its own reason'
    ).toEqual([])
  })
})
