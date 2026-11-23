import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  changedBetween,
  SourceChanged,
  chooseProfile,
  CloneUnsupported,
  CopyError,
  copiesDir,
  copyEntries,
  listTree,
  personFolders,
  skipInProfile,
  takeCopy,
  type CopyPlan
} from './copy'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'cp-copy-test-'))
  dirs.push(d)
  return d
}

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** A person's folders with a little of everything the copy has to tell apart. */
function person(): { root: string; plan: CopyPlan } {
  const root = scratch()
  const data = join(root, 'share', 'Prism LCA')
  const profile = join(root, 'config', 'prism-lca')
  write(join(data, 'brightway', 'projects.db'), 'projects')
  write(join(data, 'brightway', 'p1', 'lci', 'databases.db'), 'db')
  write(join(data, 'brightway', 'p1', 'lci', 'databases.db-journal'), 'journal')
  write(join(data, 'prism_meta', 'vocab.json'), '{}')
  write(join(data, '.prism-instance.lock'), '{"pid": 1}')
  write(join(profile, 'settings.json'), '{"provider":"openrouter"}')
  write(join(profile, 'Local Storage', 'leveldb', '000003.log'), 'prefs')
  write(join(profile, 'secrets.json'), '{"v":1,"keys":{"openai":"Y2lwaGVy"}}')
  write(join(profile, 'openrouter-key'), 'plain')
  write(join(profile, 'mcp-endpoint.json'), '{"port":1,"token":"t"}')
  write(join(profile, 'mcp-launch-1-abc.log'), 'log')
  write(join(profile, 'Cache', 'Cache_Data', 'data_0'), 'cache')
  write(join(profile, 'DevToolsActivePort'), '9222')
  write(join(profile, 'settings.json.tmp'), 'half')
  const install = join(root, 'session')
  mkdirSync(install)
  return {
    root,
    plan: {
      data,
      profile,
      install: { data: join(install, 'data'), userData: join(install, 'user-data') },
      // Test folders sit on whatever the temp folder is; most cannot clone.
      full: true
    }
  }
}

const quiet = (): void => {}

describe('skipInProfile', () => {
  it("leaves out caches, the running app's markers, its MCP endpoint, browser state and the keys", () => {
    for (const rel of [
      'Cache/Cache_Data/data_0',
      'GPUCache',
      'SingletonLock',
      'SingletonSocket',
      'DevToolsActivePort',
      'mcp-endpoint.json',
      'mcp-launch-12-x.log',
      'pending-update.json',
      'Cookies',
      'Session Storage/000003.log',
      'DIPS',
      'settings.json.tmp',
      'openrouter-key',
      'secrets.json'
    ]) {
      expect(skipInProfile(rel), rel).toBe(true)
    }
    for (const rel of ['settings.json', 'Local Storage/leveldb/000003.log', 'models.json', 'Local State']) {
      expect(skipInProfile(rel), rel).toBe(false)
    }
  })
})

describe('takeCopy', () => {
  it('copies data and profile, without what stays out, keeping modification times', async () => {
    const { plan } = person()
    const old = new Date('2026-11-01T18:00:00Z')
    utimesSync(join(plan.data, 'prism_meta', 'vocab.json'), old, old)
    const report = await takeCopy(plan, quiet)
    const { data, userData } = plan.install
    expect(readFileSync(join(data, 'brightway', 'p1', 'lci', 'databases.db'), 'utf8')).toBe('db')
    // The journal goes along: SQLite rolls an interrupted write back from it on the first open.
    expect(existsSync(join(data, 'brightway', 'p1', 'lci', 'databases.db-journal'))).toBe(true)
    expect(existsSync(join(data, '.prism-instance.lock'))).toBe(false)
    expect(statSync(join(data, 'prism_meta', 'vocab.json')).mtimeMs).toBe(old.getTime())
    expect(readFileSync(join(userData, 'settings.json'), 'utf8')).toContain('openrouter')
    expect(existsSync(join(userData, 'Local Storage', 'leveldb', '000003.log'))).toBe(true)
    for (const gone of [
      'secrets.json',
      'openrouter-key',
      'mcp-endpoint.json',
      'mcp-launch-1-abc.log',
      'Cache',
      'DevToolsActivePort',
      'settings.json.tmp'
    ]) {
      expect(existsSync(join(userData, gone)), gone).toBe(false)
    }
    expect(report).toMatchObject({ files: 6, attempts: 1, shared: false })
    expect(report.from).toEqual({ data: plan.data, profile: plan.profile })
  })

  it('copies again when the app wrote during the copy, and keeps only a copy nothing changed under', async () => {
    const { plan } = person()
    const db = join(plan.data, 'brightway', 'p1', 'lci', 'databases.db')
    let writes = 0
    const lines: string[] = []
    const report = await takeCopy(plan, (l) => lines.push(l), {
      pauseMs: 0,
      during: (part) => {
        if (part === 'data' && writes++ === 0) writeFileSync(db, 'db, written while copied')
      }
    })
    expect(report.attempts).toBe(2)
    expect(lines).toEqual([expect.stringMatching(/wrote while it was copied \(.*databases\.db\)/)])
    expect(readFileSync(join(plan.install.data, 'brightway', 'p1', 'lci', 'databases.db'), 'utf8')).toBe(
      'db, written while copied'
    )
  })

  it('gives up when the app keeps writing, names the files, and leaves no copy behind', async () => {
    const { plan } = person()
    const settings = join(plan.profile, 'settings.json')
    let n = 0
    await expect(
      takeCopy(plan, quiet, {
        tries: 3,
        pauseMs: 0,
        during: (part) => {
          if (part === 'profile') writeFileSync(settings, `{"n":${n++}}`)
        }
      })
    ).rejects.toThrow(/kept writing while it was copied \(3 tries; changed: .*settings\.json\)/)
    expect(existsSync(plan.install.data)).toBe(false)
    expect(existsSync(plan.install.userData)).toBe(false)
  })

  it('copies again when a listed file is gone before its turn, as a journal SQLite removes', async () => {
    const { plan } = person()
    const prefs = join(plan.profile, 'Local Storage', 'leveldb', '000003.log')
    let removed = false
    const lines: string[] = []
    const report = await takeCopy(plan, (l) => lines.push(l), {
      pauseMs: 0,
      // The data is copied first, so the profile's listing still names the file when it goes.
      during: (part) => {
        if (part === 'data' && !removed) {
          rmSync(prefs)
          removed = true
        }
      }
    })
    expect(report.attempts).toBe(2)
    expect(lines).toEqual([expect.stringMatching(/wrote while it was copied \(.*000003\.log\)/)])
    expect(existsSync(join(plan.install.userData, 'Local Storage', 'leveldb', '000003.log'))).toBe(false)
  })

  it('notices a file replaced by renaming, even with the same size and times', async () => {
    const { plan } = person()
    const vocab = join(plan.data, 'prism_meta', 'vocab.json')
    const before = listTree(plan.data, () => false)
    const { atime, mtime } = statSync(vocab)
    write(`${vocab}.new`, '{}')
    utimesSync(`${vocab}.new`, atime, mtime)
    renameSync(`${vocab}.new`, vocab)
    expect(
      changedBetween(
        before,
        listTree(plan.data, () => false)
      )
    ).toEqual(['prism_meta/vocab.json'])
  })

  it('says which listed file was gone when its turn came', () => {
    const { plan } = person()
    const entries = listTree(plan.data, () => false)
    rmSync(join(plan.data, 'brightway', 'p1', 'lci', 'databases.db-journal'))
    expect(() => copyEntries(plan.data, plan.install.data, entries, true)).toThrow(SourceChanged)
  })

  it('notices files that appeared or went', () => {
    const { plan } = person()
    const before = listTree(plan.data, () => false)
    write(join(plan.data, 'prism_meta', 'new.json'), '{}')
    rmSync(join(plan.data, 'brightway', 'projects.db'))
    expect(
      changedBetween(
        before,
        listTree(plan.data, () => false)
      ).sort()
    ).toEqual(['brightway/projects.db', 'prism_meta/new.json'])
  })

  it('refuses when there is no data to copy', async () => {
    const { plan } = person()
    await expect(takeCopy({ ...plan, data: join(plan.data, 'nope') }, quiet)).rejects.toThrow(
      /no PrismLCA data to copy/
    )
  })

  it.skipIf(process.platform === 'win32')('refuses a link instead of following it', () => {
    const { plan, root } = person()
    write(join(root, 'elsewhere', 'x'), 'x')
    symlinkSync(join(root, 'elsewhere'), join(plan.data, 'linked'))
    expect(() => listTree(plan.data, () => false)).toThrow(CopyError)
    expect(() => listTree(plan.data, () => false)).toThrow(/is a link/)
  })

  it('shares blocks, or says that this disk cannot', () => {
    const { plan } = person()
    const entries = listTree(plan.data, () => false)
    try {
      copyEntries(plan.data, plan.install.data, entries, false)
    } catch (e) {
      expect(e).toBeInstanceOf(CloneUnsupported)
      expect((e as Error).message).toMatch(/cannot share blocks/)
      return
    }
    expect(readFileSync(join(plan.install.data, 'brightway', 'projects.db'), 'utf8')).toBe('projects')
  })
})

describe('where things are', () => {
  it("takes the profile the person's app used last", () => {
    const root = scratch()
    const packaged = join(root, 'PrismLCA')
    const dev = join(root, 'prism-lca')
    write(join(packaged, 'settings.json'), '{}')
    write(join(dev, 'settings.json'), '{}')
    utimesSync(join(packaged, 'settings.json'), new Date(1000), new Date(1000))
    expect(chooseProfile([packaged, dev])).toBe(dev)
    expect(chooseProfile([packaged, join(root, 'missing')])).toBe(packaged)
    expect(chooseProfile([join(root, 'missing')])).toBeNull()
  })

  it("names the person's folders and a copies folder on the same disk", () => {
    expect(personFolders({}, 'linux', '/home/u')).toEqual({
      data: '/home/u/.local/share/Prism LCA',
      profiles: ['/home/u/.config/PrismLCA', '/home/u/.config/prism-lca']
    })
    expect(copiesDir({}, 'linux', '/home/u')).toBe('/home/u/.cache/prismlca/control-prism')
    expect(copiesDir({ XDG_CACHE_HOME: '/c' }, 'linux', '/home/u')).toBe('/c/prismlca/control-prism')
    expect(copiesDir({}, 'darwin', '/Users/u')).toBe('/Users/u/Library/Caches/prismlca/control-prism')
    expect(copiesDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u')).toBe(
      'C:\\Users\\u\\AppData\\Local\\prismlca\\control-prism'
    )
  })
})
