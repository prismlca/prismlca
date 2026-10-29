/**
 * The CLA check (.github/scripts/cla.cjs) against an in-memory GitHub: who counts as signed, where the
 * signatures land, what the pull request gets told — and that a write which loses a race is retried
 * instead of dropping a signature.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

type Cla = {
  run: (args: { github: unknown; context: unknown }) => Promise<void>
  signs: (body: string) => boolean
  PHRASE: string
  FILE: string
  MARKER: string
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
// Accounts the fake knows by login, for co-author addresses without the numeric id.
const accounts = (): User[] => [MAINTAINER, ALICE, BOB]

/** Just enough of GitHub's REST API for the script, with the state it writes kept for the assertions. */
function fakeGitHub(commits: Commit[], comments: Comment[], pr: { commits?: number; user?: User } = {}) {
  const state = {
    file: null as null | { sha: string; text: string },
    branch: false,
    writes: 0,
    conflictOnce: null as null | (() => void),
    statuses: [] as { state: string; description: string; sha: string }[],
    calls: 0
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
        const found = accounts().find((u) => u.login === username)
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
    cla.PHRASE.replace(/ /g, '  ')
  ])('accepts %j', (body) => expect(cla.signs(body)).toBe(true))

  it.each([
    'Do I have to write "I have read the CLA Document and I hereby sign the CLA"?',
    'I have read the CLA Document',
    `${cla.PHRASE} later`,
    ''
  ])('rejects %j', (body) => expect(cla.signs(body)).toBe(false))
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
})
