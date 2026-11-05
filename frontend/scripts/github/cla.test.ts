/**
 * The CLA check (.github/scripts/cla.cjs) against an in-memory GitHub: who counts as signed, where the
 * signatures land, what the pull request gets told — and that a write which loses a race is retried
 * instead of dropping a signature. Also that a run's time and its API lookups stay bounded.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

type Cla = {
  run: (args: { github: unknown; context: unknown }) => Promise<void>
  signs: (body: string) => boolean
  coAuthorTrailers: (message: string) => string[][]
  PHRASE: string
  FILE: string
  MARKER: string
  MAX_LOOKUPS: number
}
const cla = createRequire(import.meta.url)(
  join(__dirname, '..', '..', '..', '.github', 'scripts', 'cla.cjs')
) as Cla

type User = { login: string; id: number; type?: string }
type Comment = { id: number; user: User; body: string; created_at: string; html_url: string }
type Commit = { sha: string; author: User | null; commit: { author: { name: string }; message: string } }

const MAINTAINER: User = { login: 'Siever1984', id: 1 }
const ALICE: User = { login: 'alice', id: 101 }
const BOB: User = { login: 'bob', id: 102 }
const BOT: User = { login: 'github-actions[bot]', id: 41898282, type: 'Bot' }

const fail = (status: number): Error => Object.assign(new Error(`HTTP ${status}`), { status })
const commit = (
  sha: string,
  author: User | null,
  name = author?.login ?? 'someone',
  message = 'Change'
): Commit => ({
  sha,
  author,
  commit: { author: { name }, message }
})
const coAuthored = (sha: string, author: User, ...trailers: string[]): Commit =>
  commit(sha, author, author.login, ['Change', '', ...trailers.map((t) => `Co-authored-by: ${t}`)].join('\n'))
/**
 * Just enough of GitHub's REST API for the script, with the state it writes kept for the assertions.
 * `known` are the accounts it finds by login, for co-author addresses.
 */
function fakeGitHub(
  commits: Commit[],
  comments: Comment[],
  pr: { commits?: number; user?: User } = {},
  known: User[] = [MAINTAINER, ALICE, BOB]
) {
  const state = {
    file: null as null | { sha: string; text: string },
    branch: false,
    writes: 0,
    conflictOnce: null as null | (() => void),
    statuses: [] as { state: string; description: string; sha: string }[],
    calls: 0,
    lookups: [] as string[]
  }
  let seq = 0
  const put = (text: string): void => {
    state.file = { sha: `blob${++seq}`, text }
    state.writes++
  }
  const counted =
    <A extends unknown[], R>(fn: (...a: A) => R) =>
    (...a: A): R => {
      state.calls++
      return fn(...a)
    }
  const rest = {
    pulls: {
      get: counted(async () => ({
        data: {
          number: 7,
          head: { sha: 'head777' },
          base: { ref: 'main' },
          commits: pr.commits ?? commits.length,
          user: pr.user ?? commits[0]?.author ?? MAINTAINER
        }
      })),
      listCommits: 'listCommits'
    },
    issues: {
      listComments: 'listComments',
      createComment: counted(async ({ body }: { body: string }) => {
        comments.push({ id: 900 + comments.length, user: BOT, body, created_at: 'now', html_url: 'u' })
      }),
      updateComment: counted(async ({ comment_id, body }: { comment_id: number; body: string }) => {
        comments.find((c) => c.id === comment_id)!.body = body
      })
    },
    users: {
      getByUsername: counted(async ({ username }: { username: string }) => {
        state.lookups.push(username)
        // GitHub logins ignore case.
        const found = known.find((u) => u.login.toLowerCase() === username.toLowerCase())
        if (!found) throw fail(404)
        return { data: found }
      })
    },
    repos: {
      getContent: counted(async () => {
        if (!state.file) throw fail(404)
        return { data: { sha: state.file.sha, content: Buffer.from(state.file.text).toString('base64') } }
      }),
      createOrUpdateFileContents: counted(async ({ sha, content }: { sha?: string; content: string }) => {
        if (state.conflictOnce) {
          state.conflictOnce()
          state.conflictOnce = null
          throw fail(409)
        }
        if (state.file && sha !== state.file.sha) throw fail(409)
        put(Buffer.from(content, 'base64').toString('utf8'))
      }),
      createCommitStatus: counted(async (s: { state: string; description: string; sha: string }) => {
        state.statuses.push(s)
      })
    },
    git: {
      getRef: counted(async () => {
        if (!state.branch) throw fail(404)
        return { data: {} }
      }),
      createTree: counted(async ({ tree }: { tree: { content: string }[] }) => ({
        data: { sha: 'tree1', text: tree[0].content }
      })),
      createCommit: counted(async ({ parents }: { parents: string[] }) => {
        expect(parents).toEqual([])
        return { data: { sha: 'commit1' } }
      }),
      createRef: counted(async () => {
        if (state.branch) throw fail(422)
        state.branch = true
      })
    }
  }
  // The orphan branch's file arrives through createTree; keep its text as the file.
  const createTree = rest.git.createTree
  rest.git.createTree = async (args) => {
    const r = await createTree(args)
    put(r.data.text)
    return r
  }
  const github = {
    rest,
    paginate: counted(async (what: unknown) => (what === 'listCommits' ? commits : [...comments]))
  }
  const signatures = (): { login: string; id: number; comment: string; commit: string }[] =>
    state.file ? JSON.parse(state.file.text).signatures : []
  return { github, state, signatures }
}

const context = (eventName: string, payload: object) => ({
  eventName,
  payload,
  repo: { owner: 'prismlca', repo: 'prismlca' },
  serverUrl: 'https://github.com',
  runId: 1
})
const opened = context('pull_request_target', { pull_request: { number: 7 } })
const commented = (user: User, body: string) =>
  context('issue_comment', { issue: { number: 7, pull_request: {} }, comment: { user, body } })
const signing = (user: User, id = 500): Comment => ({
  id,
  user,
  body: cla.PHRASE,
  created_at: '2026-11-02T10:00:00Z',
  html_url: `https://github.com/prismlca/prismlca/pull/7#issuecomment-${id}`
})
const botComment = (comments: Comment[]) => comments.find((c) => c.user.login === BOT.login)

describe('signs', () => {
  it.each([
    cla.PHRASE,
    `${cla.PHRASE}.`,
    `> ${cla.PHRASE}`,
    cla.PHRASE.toUpperCase(),
    `Thanks for the project!\n\n${cla.PHRASE}\n`,
    cla.PHRASE.replace(/ /g, '  '),
    `Thanks!\r\n> >  ${cla.PHRASE} . !! \r\n`
  ])('accepts %j', (body) => expect(cla.signs(body)).toBe(true))

  it.each([
    'Do I have to write "I have read the CLA Document and I hereby sign the CLA"?',
    'I have read the CLA Document',
    `${cla.PHRASE} later`,
    `${cla.PHRASE}. x`,
    ''
  ])('rejects %j', (body) => expect(cla.signs(body)).toBe(false))
})

// The trailers are read with exactly this pattern's result.
const ONE_PATTERN = /^co-authored-by:\s*(.*?)\s*<([^<>\s]+)>\s*$/gim
const byPattern = (message: string): string[][] => [...message.matchAll(ONE_PATTERN)].map((m) => [m[1], m[2]])

/** A repeatable stream of random whole numbers below n. */
function randomFrom(seed: number): (n: number) => number {
  return (n) => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * n)
  }
}

describe('coAuthorTrailers', () => {
  it.each([
    [
      'Change\n\nCo-authored-by: Bob <102+bob@users.noreply.github.com>',
      [['Bob', '102+bob@users.noreply.github.com']]
    ],
    ['co-authored-by:Bob<bob@x>', [['Bob', 'bob@x']]],
    ['CO-AUTHORED-BY:   Bob   Builder \t <bob@x>  \t', [['Bob   Builder', 'bob@x']]],
    [
      'Change\r\n\r\nCo-authored-by: Bob <bob@x>\r\nCo-authored-by: Ann <ann@x>\r\n',
      [
        ['Bob', 'bob@x'],
        ['Ann', 'ann@x']
      ]
    ],
    [
      'Co-authored-by:\u00a0Bob\u00a0<bob@x>\u2028Co-authored-by: Ann <ann@x>',
      [
        ['Bob', 'bob@x'],
        ['Ann', 'ann@x']
      ]
    ],
    ['Co-authored-by: <bob@x>', [['', 'bob@x']]],
    [
      'Co-authored-by: Mallory <@everyone> <mallory@example.org>',
      [['Mallory <@everyone>', 'mallory@example.org']]
    ],
    // The pattern reads on across line breaks, for the name and for the address.
    ['Co-authored-by: Bob\n\n  <bob@x>', [['Bob', 'bob@x']]],
    ['Co-authored-by:\n Bob <bob@x>', [['Bob', 'bob@x']]],
    ['Co-authored-by:\nCo-authored-by: Bob <bob@x>', [['Co-authored-by: Bob', 'bob@x']]],
    ['Co-authored-by: Bob <bob@x> and Ann', []],
    ['  Co-authored-by: Bob <bob@x>', []],
    ['Co-authored-by: Bob', []],
    ['Co-authored-by: Bob <bob x>', []],
    ['Co-authored-by: Bob <bob@x', []],
    ['Co-authored-by: Bob <<bob@x>>', []],
    ['Co-authored by: Bob <bob@x>', []]
  ])('reads %j as the single pattern did', (message, expected) => {
    expect(byPattern(message)).toEqual(expected)
    expect(cla.coAuthorTrailers(message)).toEqual(expected)
  })

  it('reads any message as the single pattern did', () => {
    // Trailers from pieces, the odd ones included: every kind of space and line break, brackets in the
    // name, broken addresses, a name or an address on the next line.
    const PREFIX = ['Co-authored-by:', 'CO-AUTHORED-BY:', ' Co-authored-by:', 'Co-authored by:']
    const SPACE = ['', '', ' ', '  ', '\t', '\u00a0', '\v', '\ufeff']
    const BREAK = ['', '\n', '\r\n', '\r', '\u2028', '\u2029', '\n\n', '\n \n']
    const NAME = ['', 'Bob', 'Bob  Builder', 'x<y', 'a>b', '<@everyone>', 'Co-authored-by: Ann', '<a@b> x']
    const ADDRESS = [
      '<a@b>',
      '<1+bob@users.noreply.github.com>',
      '<a b>',
      '<<a>>',
      '<a@b><c@d>',
      '<a@b> x',
      'a@b>'
    ]
    const random = randomFrom(1)
    const pick = (list: string[]): string => list[random(list.length)]
    const differ: string[] = []
    let trailers = 0
    for (let i = 0; i < 20000; i++) {
      let message = pick(['', 'Change\n\n'])
      for (let line = random(4); line >= 0; line--) {
        message += pick(PREFIX) + pick(SPACE) + pick(NAME) + pick(SPACE)
        if (random(4) === 0) message += pick(BREAK) + pick(SPACE)
        message += pick(ADDRESS) + pick(SPACE) + pick(BREAK)
      }
      const expected = byPattern(message)
      trailers += expected.length
      if (JSON.stringify(cla.coAuthorTrailers(message)) !== JSON.stringify(expected))
        differ.push(JSON.stringify(message))
    }
    expect(differ).toEqual([])
    expect(trailers, 'the pieces make enough real trailers to compare').toBeGreaterThan(5000)
  })

  it('reads long lines in linear time', () => {
    const n = 200_000
    const P = 'Co-authored-by:'
    const messages = [
      P + ' '.repeat(n) + 'x',
      P + ' \t\u00a0'.repeat(n / 3),
      P + ' <a'.repeat(n / 3),
      P + ' <a> x'.repeat(n / 6),
      P + ' x <a>' + ' '.repeat(n) + 'x',
      P + ' x <' + 'a'.repeat(n) + '!',
      `${P}\n`.repeat(n / 16),
      P + ' x' + '\n '.repeat(n / 2) + 'y'
    ]
    const started = performance.now()
    for (const m of messages) expect(cla.coAuthorTrailers(m)).toEqual([])
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('CLA run', () => {
  let comments: Comment[]
  beforeEach(() => {
    comments = []
  })

  it('passes a maintainer-only pull request without a comment', async () => {
    const gh = fakeGitHub([commit('a1', MAINTAINER)], comments)
    await cla.run({ github: gh.github, context: opened })
    expect(gh.state.statuses.at(-1)).toMatchObject({ state: 'success', sha: 'head777' })
    expect(comments).toEqual([])
    expect(gh.state.writes).toBe(0)
  })

  it('needs no CLA from bots', async () => {
    const gh = fakeGitHub([commit('a1', { login: 'dependabot[bot]', id: 49699333 })], comments)
    await cla.run({ github: gh.github, context: opened })
    expect(gh.state.statuses.at(-1)?.state).toBe('success')
  })

  it('asks an outside author to sign and names them in the status', async () => {
    const gh = fakeGitHub([commit('a1', ALICE), commit('a2', MAINTAINER)], comments)
    await cla.run({ github: gh.github, context: opened })
    expect(gh.state.statuses.at(-1)).toMatchObject({ state: 'failure', description: 'Still missing: alice' })
    const asked = botComment(comments)!.body
    expect(asked.startsWith(cla.MARKER)).toBe(true)
    expect(asked).toContain(`> ${cla.PHRASE}`)
    expect(asked).toContain('@alice')
    expect(asked).not.toContain('@Siever1984')
    expect(gh.state.writes).toBe(0)
  })

  it('records a signature on a new branch and turns the comment into thanks', async () => {
    const gh = fakeGitHub([commit('a1', ALICE)], comments)
    await cla.run({ github: gh.github, context: opened })
    comments.push(signing(ALICE))
    await cla.run({ github: gh.github, context: commented(ALICE, cla.PHRASE) })
    expect(gh.state.branch).toBe(true)
    expect(gh.signatures()).toEqual([
      expect.objectContaining({
        login: 'alice',
        id: 101,
        pull_request: 7,
        commit: 'head777',
        comment: signing(ALICE).html_url
      })
    ])
    expect(gh.state.statuses.at(-1)?.state).toBe('success')
    expect(botComment(comments)!.body).toContain('thank you')
    expect(comments.filter((c) => c.user.login === BOT.login)).toHaveLength(1)
  })

  it('does not count a signing comment by someone who wrote none of the commits', async () => {
    const gh = fakeGitHub([commit('a1', ALICE)], comments)
    comments.push(signing(BOB))
    await cla.run({ github: gh.github, context: commented(BOB, cla.PHRASE) })
    expect(gh.signatures()).toEqual([])
    expect(gh.state.statuses.at(-1)?.state).toBe('failure')
  })

  it('remembers a signature for the next pull request', async () => {
    const gh = fakeGitHub([commit('a1', ALICE)], comments)
    comments.push(signing(ALICE))
    await cla.run({ github: gh.github, context: commented(ALICE, cla.PHRASE) })
    comments.length = 0
    await cla.run({ github: gh.github, context: opened })
    expect(gh.state.statuses.at(-1)?.state).toBe('success')
    expect(gh.state.writes).toBe(1)
    expect(comments).toEqual([])
  })

  it('fails commits no GitHub account claims, without naming their author', async () => {
    const gh = fakeGitHub([commit('a1', ALICE), commit('deadbeef1', null, 'Mallory <@everyone>')], comments)
    comments.push(signing(ALICE))
    await cla.run({ github: gh.github, context: opened })
    expect(gh.state.statuses.at(-1)).toMatchObject({ state: 'failure' })
    const asked = botComment(comments)!.body
    expect(asked).toContain('deadbee')
    expect(asked).not.toContain('Mallory')
    expect(asked).not.toContain('Still missing')
  })

  it('always needs the signed-in author of the pull request, whoever the commits claim to be', async () => {
    // Bob put the maintainer's email into his commit; GitHub then credits the commit to the maintainer.
    const gh = fakeGitHub([commit('a1', MAINTAINER)], comments, { user: BOB })
    await cla.run({ github: gh.github, context: opened })
    expect(gh.state.statuses.at(-1)).toMatchObject({ state: 'failure', description: 'Still missing: bob' })
  })

  it('needs co-authors with a GitHub address, in either form, and lets them sign', async () => {
    const gh = fakeGitHub(
      [
        coAuthored('a1', ALICE, 'Bob <102+bob@users.noreply.github.com>'),
        coAuthored('a2', ALICE, 'Bob <bob@users.noreply.github.com>')
      ],
      comments
    )
    comments.push(signing(ALICE))
    await cla.run({ github: gh.github, context: opened })
    expect(gh.state.statuses.at(-1)).toMatchObject({ state: 'failure', description: 'Still missing: bob' })
    comments.push(signing(BOB, 501))
    await cla.run({ github: gh.github, context: commented(BOB, cla.PHRASE) })
    expect(gh.signatures().map((s) => s.login)).toEqual(['alice', 'bob'])
    expect(gh.state.statuses.at(-1)?.state).toBe('success')
  })

  it('does not take the id in a co-author address on trust', async () => {
    // Bob's own number with the maintainer's login, to hide Bob's real commit behind an exempt account.
    const gh = fakeGitHub(
      [coAuthored('a1', ALICE, 'Bob <102+Siever1984@users.noreply.github.com>'), commit('b2', BOB)],
      comments,
      { user: ALICE }
    )
    comments.push(signing(ALICE))
    await cla.run({ github: gh.github, context: opened })
    expect(gh.state.statuses.at(-1)).toMatchObject({ state: 'failure', description: 'Still missing: bob' })
    expect(botComment(comments)!.body).toContain('a1 name a co-author')
  })

  it('keeps the name of a pull request author who also wrote the commits', async () => {
    const gh = fakeGitHub([commit('a1', ALICE, 'Alice Example')], comments)
    comments.push(signing(ALICE))
    await cla.run({ github: gh.github, context: opened })
    expect(gh.signatures()).toEqual([expect.objectContaining({ login: 'alice', name: 'Alice Example' })])
  })

  it('does not ask tools that add themselves as co-authors', async () => {
    const gh = fakeGitHub(
      [
        coAuthored(
          'a1',
          MAINTAINER,
          'Claude Opus 5.5 <noreply@anthropic.com>',
          'Copilot <175728472+Copilot@users.noreply.github.com>',
          'dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>'
        )
      ],
      comments
    )
    await cla.run({ github: gh.github, context: opened })
    expect(gh.state.statuses.at(-1)?.state).toBe('success')
  })

  it('leaves co-authors it cannot match to the maintainer, without repeating their name or address', async () => {
    const gh = fakeGitHub(
      [coAuthored('c0ffee12', ALICE, 'Mallory <@everyone> <mallory@example.org>')],
      comments
    )
    comments.push(signing(ALICE))
    await cla.run({ github: gh.github, context: opened })
    expect(gh.state.statuses.at(-1)).toMatchObject({ state: 'failure' })
    expect(gh.state.statuses.at(-1)?.description).toContain('by hand')
    const asked = botComment(comments)!.body
    expect(asked).toContain('c0ffee1')
    expect(asked).not.toMatch(/mallory|everyone/i)
  })

  it('keeps both signatures when another run wrote the file in between', async () => {
    const gh = fakeGitHub([commit('a1', ALICE)], comments)
    // Bob signed earlier, on another pull request.
    gh.state.file = { sha: 'blob-bob', text: JSON.stringify({ signatures: [{ login: 'bob', id: 102 }] }) }
    gh.state.branch = true
    comments.push(signing(ALICE))
    // Between Alice's read and her write, a third signature lands.
    gh.state.conflictOnce = () => {
      gh.state.file = {
        sha: 'blob-carol',
        text: JSON.stringify({
          signatures: [
            { login: 'bob', id: 102 },
            { login: 'carol', id: 103 }
          ]
        })
      }
    }
    await cla.run({ github: gh.github, context: commented(ALICE, cla.PHRASE) })
    expect(gh.signatures().map((s) => s.login)).toEqual(['bob', 'carol', 'alice'])
    expect(gh.state.statuses.at(-1)?.state).toBe('success')
  })

  it('checks the whole pull request again on any comment, and ignores comments on plain issues', async () => {
    const gh = fakeGitHub([commit('a1', MAINTAINER)], comments)
    await cla.run({ github: gh.github, context: commented(BOB, 'Looks good to me') })
    await cla.run({ github: gh.github, context: commented(BOT, 'Something automated') })
    expect(gh.state.statuses.map((s) => s.state)).toEqual(['success', 'success'])
    const calls = gh.state.calls
    await cla.run({
      github: gh.github,
      context: context('issue_comment', { issue: { number: 8 }, comment: { user: ALICE, body: cla.PHRASE } })
    })
    expect(gh.state.calls).toBe(calls)
  })

  it('fails closed when GitHub does not list every commit', async () => {
    const gh = fakeGitHub([commit('a1', MAINTAINER)], comments, { commits: 251 })
    await cla.run({ github: gh.github, context: opened })
    expect(gh.state.statuses.at(-1)).toMatchObject({ state: 'failure' })
    expect(botComment(comments)!.body).toContain('251 commits')
  })

  it('reads long commit messages and comments in linear time', async () => {
    const line = 'Co-authored-by:' + ' '.repeat(2500) + 'x'
    const gh = fakeGitHub(
      [commit('a1', ALICE, 'alice', `Change\n\n${line}`), commit('a2', ALICE, 'alice', line)],
      comments
    )
    comments.push({ ...signing(ALICE), body: 'a' + ' .'.repeat(32767) + 'x' })
    const started = performance.now()
    await cla.run({ github: gh.github, context: commented(ALICE, 'a') })
    expect(performance.now() - started).toBeLessThan(250)
    expect(gh.state.statuses.at(-1)).toMatchObject({ state: 'failure', description: 'Still missing: alice' })
  })

  it('looks a co-author up once, however often and in whatever case the commits name them', async () => {
    const trailers = Array.from({ length: 1000 }, (_, i) =>
      i % 2 ? 'Bob <bob@users.noreply.github.com>' : 'BOB <102+BOB@users.noreply.github.com>'
    )
    const gh = fakeGitHub(
      [coAuthored('a1', ALICE, ...trailers), coAuthored('a2', ALICE, ...trailers)],
      comments
    )
    comments.push(signing(ALICE))
    await cla.run({ github: gh.github, context: opened })
    expect(gh.state.lookups).toEqual(['BOB'])
    expect(gh.state.statuses.at(-1)).toMatchObject({ state: 'failure', description: 'Still missing: bob' })
  })

  it('looks up a bounded number of co-authors a run and leaves commits naming more to the maintainer', async () => {
    const many: User[] = Array.from({ length: cla.MAX_LOOKUPS + 1 }, (_, i) => ({
      login: `user${i}`,
      id: 1000 + i
    }))
    const trailer = (u: User): string => `${u.login} <${u.id}+${u.login}@users.noreply.github.com>`
    const gh = fakeGitHub(
      [
        coAuthored('a1', ALICE, ...many.slice(0, -1).map(trailer)),
        coAuthored('a2', ALICE, trailer(many.at(-1)!)),
        // Already looked up, so still placed.
        coAuthored('a3', ALICE, trailer(many[0]))
      ],
      comments,
      {},
      [ALICE, ...many]
    )
    comments.push(signing(ALICE))
    await cla.run({ github: gh.github, context: opened })
    expect(gh.state.lookups).toHaveLength(cla.MAX_LOOKUPS)
    expect(gh.state.statuses).toEqual([expect.objectContaining({ state: 'failure' })])
    const asked = botComment(comments)!.body
    expect(asked).toContain('a2 name a co-author')
    expect(asked).toContain('@user0')
    expect(asked).not.toContain(`@user${cla.MAX_LOOKUPS}`)
  })
})
