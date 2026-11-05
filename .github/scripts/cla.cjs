/**
 * The CLA check on pull requests, run by .github/workflows/cla.yml through actions/github-script.
 *
 * Every author of a pull request's commits accepts the Contributor License Agreement once, by posting the
 * sentence below as a comment (CONTRIBUTING.md). This script records those acceptances in a JSON file on the
 * `cla-signatures` branch, sets a "CLA" status on the pull request's head commit, and keeps one comment on
 * the pull request up to date with who is still missing.
 *
 * It runs with a write token on pull requests from forks, so it never touches their code: it reads the pull
 * request through the API only, and the workflow checks this file out from the default branch. What a
 * contributor controls — comment text, commit author names — is only compared or stored as data; the comment
 * it writes names GitHub logins, which GitHub validates, and short commit hashes. A run's time stays linear in
 * that text, and its API calls stay bounded.
 *
 * Every run works out the whole state again from the pull request as it is now, whatever started it — a
 * push, a new base, any comment. GitHub keeps only the newest waiting run per pull request and drops the
 * others, so no run may rely on the one before it having happened.
 */
'use strict'

const PHRASE = 'I have read the CLA Document and I hereby sign the CLA'
const BRANCH = 'cla-signatures'
const FILE = 'signatures/cla.json'
const STATUS = 'CLA'
const MARKER = '<!-- prismlca-cla -->'
const BOT = 'github-actions[bot]'
// They hold the copyright the agreement licenses to, so there is nothing for them to sign.
const MAINTAINERS = ['Siever1984']

// GitHub logins ignore case, and a login read from a commit address keeps whatever case was typed there.
const sameLogin = (a) => (b) => a.toLowerCase() === b.toLowerCase()
const exempt = (login) => MAINTAINERS.some(sameLogin(login)) || login.endsWith('[bot]')

// One character of what a signing line may end in.
const TAIL = /[\s.!]/

const squash = (line) => {
  const text = line.replace(/^[>\s]+/, '')
  // Trimmed at the end by hand, in time linear in the line's length.
  let end = text.length
  while (end > 0 && TAIL.test(text[end - 1])) end--
  return text.slice(0, end).replace(/\s+/g, ' ').toLowerCase()
}

/** A comment signs when one of its lines is the sentence — quoted or not, any case, with or without a full stop. */
function signs(body) {
  const want = squash(PHRASE)
  return String(body ?? '')
    .split('\n')
    .some((line) => squash(line) === want)
}

const missingRef = (e) => {
  if (e.status === 404) return true
  throw e
}

// Co-authors named in a commit message are authors too, and need an agreement as much as the author.
// Read in linear time, with exactly the result of /^co-authored-by:\s*(.*?)\s*<([^<>\s]+)>\s*$/gim.
const TRAILER = /^co-authored-by:/gim
const SPACE = /\s*/y // spaces, line breaks included
// What ends a line for `^`, `$` and `.` in a pattern.
const LINE_BREAK = /[\n\r\u2028\u2029]/g
// The address closes its line: `<address>`, then nothing but spaces. Both are matched within one line.
const ADDRESS_ENDS_LINE = /<([^<>\s]+)>\s*$/
const ADDRESS_IS_LINE = /^<([^<>\s]+)>\s*$/

/** Every co-author trailer in a commit message, as `[name, address]`. */
function coAuthorTrailers(message) {
  const found = []
  const skipSpace = (i) => {
    SPACE.lastIndex = i
    SPACE.exec(message)
    return SPACE.lastIndex
  }
  const lineEnd = (i) => {
    LINE_BREAK.lastIndex = i
    return LINE_BREAK.exec(message)?.index ?? message.length
  }
  TRAILER.lastIndex = 0
  while (TRAILER.exec(message)) {
    // The name starts at the first character that is not a space, on this line or a later one.
    const start = skipSpace(TRAILER.lastIndex)
    const end = lineEnd(start)
    const line = message.slice(start, end)
    const own = ADDRESS_ENDS_LINE.exec(line)
    if (own) {
      found.push([line.slice(0, own.index).trimEnd(), own[1]])
      TRAILER.lastIndex = end
      continue
    }
    // Or the whole line is the name, and the address stands alone on the next line that is not blank.
    const next = skipSpace(end)
    const nextEnd = lineEnd(next)
    const alone = ADDRESS_IS_LINE.exec(message.slice(next, nextEnd))
    if (alone) {
      found.push([line.trimEnd(), alone[1]])
      TRAILER.lastIndex = nextEnd
    }
  }
  return found
}

// GitHub's private commit address names the account: `<id>+<login>@…`, or `<login>@…` from before 2017.
const NOREPLY = /^(?:(\d+)\+)?([a-z\d][a-z\d-]*(?:\[bot\])?)@users\.noreply\.github\.com$/i
// Tools that add themselves as co-authors; they hold no copyright, so there is no one to sign.
const TOOL_EMAILS = ['noreply@anthropic.com']
const TOOL_LOGINS = ['Copilot']
// One lookup per account and run, at most this many a run; a commit naming more is left to the maintainer.
const MAX_LOOKUPS = 20

/** The GitHub account of a login, as GitHub knows it, or null when there is none. */
async function accountOf(github, login) {
  try {
    const { data } = await github.rest.users.getByUsername({ username: login })
    return { login: data.login, id: data.id }
  } catch (e) {
    if (missingRef(e)) return null
  }
}

/**
 * Everyone who wrote the commits, as GitHub accounts; the commits whose author or a co-author we cannot
 * match to an account (short hashes); and how many commits GitHub listed — it lists at most 250 of a pull
 * request, however many pages one asks for.
 *
 * GitHub matches the author by the commit's email, which whoever made the commit chose. That is fine for
 * finding who still has to sign; it proves nothing about who did — that is why the pull request's own,
 * signed-in author always has to sign as well (see `run`).
 */
async function commitAuthors(github, repo, number) {
  const commits = await github.paginate(github.rest.pulls.listCommits, {
    ...repo,
    pull_number: number,
    per_page: 100
  })
  const authors = new Map()
  const add = (account, name) => {
    if (!authors.has(account.id)) authors.set(account.id, { login: account.login, id: account.id, name })
  }
  const unlinked = new Set()
  const unplaced = new Set()
  const looked = new Map() // lowercase login → account or null
  const lookUp = async (login) => {
    const key = login.toLowerCase()
    if (!looked.has(key)) {
      if (looked.size >= MAX_LOOKUPS) return null
      looked.set(key, await accountOf(github, login))
    }
    return looked.get(key)
  }
  for (const c of commits) {
    const short = c.sha.slice(0, 7)
    if (c.author?.login) add(c.author, c.commit?.author?.name ?? '')
    else unlinked.add(short)
    for (const [name, address] of coAuthorTrailers(String(c.commit?.message ?? ''))) {
      if (TOOL_EMAILS.includes(address.toLowerCase())) continue
      const [, id, login] = NOREPLY.exec(address) ?? []
      // A tool or a bot named as co-author adds no one who could sign — as if the line were not there.
      if (login && (TOOL_LOGINS.some(sameLogin(login)) || login.endsWith('[bot]'))) continue
      const account = login ? await lookUp(login) : null
      // Anyone can write any number into a trailer: the id has to be the account's own.
      if (account && (!id || Number(id) === account.id)) add(account, name)
      else unplaced.add(short)
    }
  }
  return {
    authors: [...authors.values()],
    unlinked: [...unlinked],
    unplaced: [...unplaced],
    listed: commits.length
  }
}

async function readSignatures(github, repo) {
  try {
    const { data } = await github.rest.repos.getContent({
      ...repo,
      path: FILE,
      ref: BRANCH
    })
    const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'))
    return { sha: data.sha, signatures: parsed.signatures ?? [] }
  } catch (e) {
    if (missingRef(e)) return { sha: null, signatures: [] }
  }
}

async function writeSignatures(github, repo, file, signatures, message) {
  const text =
    JSON.stringify({ agreement: 'CLA.md / CLA-ENTITY.md (Harmony 1.0)', signatures }, null, 2) + '\n'
  const branchExists =
    file.sha !== null ||
    (await github.rest.git.getRef({ ...repo, ref: `heads/${BRANCH}` }).then(
      () => true,
      (e) => !missingRef(e)
    ))
  if (branchExists) {
    await github.rest.repos.createOrUpdateFileContents({
      ...repo,
      path: FILE,
      branch: BRANCH,
      message,
      content: Buffer.from(text).toString('base64'),
      ...(file.sha ? { sha: file.sha } : {})
    })
    return
  }
  // The branch holds nothing but the signatures, so its first commit has no parent.
  const { data: tree } = await github.rest.git.createTree({
    ...repo,
    tree: [{ path: FILE, mode: '100644', type: 'blob', content: text }]
  })
  const { data: commit } = await github.rest.git.createCommit({
    ...repo,
    message,
    tree: tree.sha,
    parents: []
  })
  await github.rest.git.createRef({
    ...repo,
    ref: `refs/heads/${BRANCH}`,
    sha: commit.sha
  })
}

/** Signing comments on this pull request by authors who have not signed yet, as new signature records. */
function signingComments(comments, pr, unsigned) {
  const waiting = new Map(unsigned.map((a) => [a.id, a]))
  const fresh = []
  for (const c of comments) {
    const who = c.user && waiting.get(c.user.id)
    if (!who || !signs(c.body)) continue
    waiting.delete(c.user.id)
    fresh.push({
      login: who.login,
      id: who.id,
      name: who.name,
      signed_at: c.created_at,
      pull_request: pr.number,
      comment: c.html_url,
      commit: pr.head.sha
    })
  }
  return fresh
}

/** Records what the comments sign and returns the ids of everyone who has signed. */
async function recordSignatures(github, repo, pr, needed, comments) {
  for (let attempt = 1; ; attempt++) {
    const file = await readSignatures(github, repo)
    const signed = new Set(file.signatures.map((s) => s.id))
    const fresh = signingComments(
      comments,
      pr,
      needed.filter((a) => !signed.has(a.id))
    )
    if (fresh.length === 0) return signed
    const who = fresh.map((s) => s.login).join(', ')
    try {
      await writeSignatures(
        github,
        repo,
        file,
        [...file.signatures, ...fresh],
        `CLA signed by ${who} (#${pr.number})`
      )
      for (const s of fresh) signed.add(s.id)
      return signed
    } catch (e) {
      // Another run wrote the file or created the branch in between: read it again and add to that.
      if (attempt < 3 && (e.status === 409 || e.status === 422)) continue
      throw e
    }
  }
}

function askBody(repo, pr, { missing, unlinked, unplaced, truncated }) {
  const doc = (f) => `https://github.com/${repo.owner}/${repo.repo}/blob/${pr.base.ref}/${f}`
  const lines = [
    MARKER,
    'Thank you for your contribution! Before we can merge it, every author of its commits accepts the PrismLCA ' +
      `Contributor License Agreement once: [CLA.md](${doc('CLA.md')}) for individuals, ` +
      `[CLA-ENTITY.md](${doc('CLA-ENTITY.md')}) if you contribute for an organisation. ` +
      'To accept, post this sentence as a comment on this pull request:',
    '',
    `> ${PHRASE}`
  ]
  if (missing.length) lines.push('', `Still missing: ${missing.map((a) => `@${a.login}`).join(', ')}`)
  if (unlinked.length)
    lines.push(
      '',
      `No GitHub account claims the author email of ${unlinked.join(', ')}, so we cannot tell who wrote ` +
        'these commits. Add that email to your GitHub account, or rewrite the commits with one it knows, ' +
        'then comment `recheck`.'
    )
  if (unplaced.length)
    lines.push(
      '',
      `${unplaced.join(', ')} name a co-author we cannot match to a GitHub account. Co-authors need the ` +
        'agreement too: write their GitHub address (`ID+login@users.noreply.github.com`, shown in their email ' +
        'settings) into the `Co-authored-by` line so they can sign here, or the maintainer checks their ' +
        'agreement by hand.'
    )
  if (truncated)
    lines.push(
      '',
      `This pull request has ${pr.commits} commits, and GitHub lists only the first 250 of them, so we cannot ` +
        'see every author. Please squash it into fewer commits.'
    )
  return lines.join('\n')
}

function statusLine({ missing, unlinked, unplaced, truncated }) {
  if (truncated) return 'Too many commits to check every author — please squash'
  if (missing.length) return `Still missing: ${missing.map((a) => a.login).join(', ')}`.slice(0, 140)
  if (unlinked.length) return 'Commits whose author no GitHub account claims'
  if (unplaced.length) return 'Co-authors we cannot match to a GitHub account — the maintainer checks by hand'
  return 'All commit authors have accepted the CLA'
}

async function report({ github, context }, pr, outcome, comments) {
  const repo = context.repo
  const ok =
    !outcome.truncated && !outcome.missing.length && !outcome.unlinked.length && !outcome.unplaced.length
  await github.rest.repos.createCommitStatus({
    ...repo,
    sha: pr.head.sha,
    state: ok ? 'success' : 'failure',
    context: STATUS,
    description: statusLine(outcome),
    target_url: `${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`
  })
  const mine = comments.find((c) => c.user?.login === BOT && String(c.body ?? '').startsWith(MARKER))
  if (ok && !mine) return
  const body = ok
    ? `${MARKER}\nAll commit authors have accepted the CLA — thank you.`
    : askBody(repo, pr, outcome)
  if (!mine) await github.rest.issues.createComment({ ...repo, issue_number: pr.number, body })
  else if (mine.body !== body) await github.rest.issues.updateComment({ ...repo, comment_id: mine.id, body })
}

async function run({ github, context }) {
  const repo = context.repo
  const p = context.payload
  let number
  if (context.eventName === 'pull_request_target') number = p.pull_request.number
  else if (context.eventName === 'issue_comment' && p.issue?.pull_request) number = p.issue.number
  else return

  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: number })
  const { authors, unlinked, unplaced, listed } = await commitAuthors(github, repo, number)
  if (!authors.some((a) => a.id === pr.user.id))
    authors.push({ login: pr.user.login, id: pr.user.id, name: '' })
  const needed = authors.filter((a) => !exempt(a.login))
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repo,
    issue_number: number,
    per_page: 100
  })
  const signed = await recordSignatures(github, repo, pr, needed, comments)
  const missing = needed.filter((a) => !signed.has(a.id))
  await report(
    { github, context },
    pr,
    { missing, unlinked, unplaced, truncated: pr.commits > listed },
    comments
  )
}

module.exports = { run, signs, coAuthorTrailers, PHRASE, BRANCH, FILE, STATUS, MARKER, MAX_LOOKUPS }
