import { describe, expect, it } from 'vitest'
import type { ToolCtx } from '../context'
import { TOOL_BY_NAME } from '../index'
import { previousReviewOf, previousReviewSection, type LoggedReview } from './reviewHistory'

/**
 * A re-review in the same chat sees the review before it — its findings and the outcome recorded for
 * each — and is told to check the "fixed" ones and to raise a "rejected" one only with new evidence.
 * Another chat's review is never shown: that conversation never saw its reasons.
 */

const LOG: LoggedReview[] = [
  { id: 'r1', chat: 'chat-a', review: 'Should fix: the old point.', stale: true },
  {
    id: 'r2',
    chat: 'chat-a',
    review: 'Blocking: the widget proxy.\nShould fix: the lid mass.',
    stale: true,
    resolutions: [
      { finding: 'widget proxy', resolution: 'fixed' },
      { finding: 'lid mass', resolution: 'rejected', reason: 'the supplier sheet gives 12 g' }
    ]
  },
  { id: 'r3', chat: 'chat-b', review: 'Worth a look: someone else’s point.', stale: false },
  { id: 'r4', review: 'Should fix: logged before the log kept chats.' }
]

describe('previousReviewOf', () => {
  it("picks this chat's latest review, never another chat's or an unattributed one", () => {
    expect(previousReviewOf(LOG, 'chat-a')?.id).toBe('r2')
    expect(previousReviewOf(LOG, 'chat-b')?.id).toBe('r3')
    expect(previousReviewOf(LOG, 'chat-c')).toBeNull()
    expect(previousReviewOf(LOG, undefined)).toBeNull()
    expect(previousReviewOf({ ok: true }, 'chat-a')).toBeNull()
  })
})

describe('previousReviewSection', () => {
  it('quotes the findings with their outcomes and says how to treat fixed and rejected ones', () => {
    const s = previousReviewSection(LOG[1])
    expect(s).toContain('PREVIOUS REVIEW')
    expect(s).toContain('Edits have been made since')
    expect(s).not.toContain('cut off')
    expect(s).toContain('Blocking: the widget proxy.')
    expect(s).toContain('- fixed: widget proxy')
    expect(s).toContain('- rejected: lid mass — the supplier sheet gives 12 g')
    expect(s).toMatch(/"fixed" against the dossier/)
    expect(s).toMatch(/"rejected" finding again only with evidence/)
  })

  it('says when the earlier review was cut off at its deadline', () => {
    expect(previousReviewSection({ review: 'Blocking: half', partial: true })).toContain(
      'cut off at its deadline'
    )
  })

  it('says when nothing was recorded and when the model is unchanged', () => {
    const s = previousReviewSection({ review: 'Blocking: none.', stale: false })
    expect(s).toContain('Nothing has been edited since')
    expect(s).toContain('No outcome was recorded')
    // Unknown (an earlier backend session): no claim either way.
    expect(previousReviewSection({ review: 'Blocking: none.', stale: null })).not.toMatch(/edited since/i)
  })
})

describe('review_model and the previous review', () => {
  const run = async (
    chatId: string | undefined,
    review: Awaited<ReturnType<NonNullable<ToolCtx['review']>>> = {
      text: 'Blocking: none.',
      outcome: 'ok',
      reasoning_chars: 0,
      attempts: 1,
      ms: 1
    }
  ): Promise<{ dossier: string; out: any; posts: Array<{ path: string; body: any }>; gets: string[] }> => {
    let dossier = ''
    const posts: Array<{ path: string; body: any }> = []
    const gets: string[] = []
    const ctx: ToolCtx = {
      api: async (method, path, body) => {
        if (method === 'POST') {
          posts.push({ path, body })
          return { id: 'new-review' }
        }
        gets.push(path)
        if (path.startsWith('/api/v1/provenance/review')) return LOG
        if (path.startsWith('/api/v1/study')) return { goal: 'compare widgets' }
        return { ok: true }
      },
      ui: async () => ({}),
      activeDb: 'demo-model',
      chatId,
      review: async (o) => ((dossier = o.dossier), review)
    }
    const out = JSON.parse((await TOOL_BY_NAME.review_model.run({}, ctx)) as string)
    return { dossier, out, posts, gets }
  }

  it("hands a re-review in the same chat that chat's previous findings, and logs the new one with the chat", async () => {
    const { dossier, posts } = await run('chat-a')
    expect(dossier).toContain('PREVIOUS REVIEW')
    expect(dossier).toContain('- rejected: lid mass')
    expect(dossier).not.toContain('someone else')
    expect(posts.find((p) => p.path === '/api/v1/provenance/review')?.body.chat).toBe('chat-a')
  })

  it('a chat that never reviewed this model, or a run outside a chat, gets no such section', async () => {
    expect((await run('chat-c')).dossier).not.toContain('PREVIOUS REVIEW')
    const outside = await run(undefined)
    expect(outside.dossier).not.toContain('PREVIOUS REVIEW')
    expect(outside.gets.some((p) => p.startsWith('/api/v1/provenance/review'))).toBe(false)
    expect(outside.posts[0].body.chat).toBeUndefined()
  })

  it('says it is no ISO critical review and when to run it again', async () => {
    const { out } = await run('chat-c')
    expect(out.note).toMatch(/not a critical review in the ISO 14044 sense/)
    expect(out.note).toMatch(/After a structural change/)
    expect(out.cut_off).toBeUndefined()
  })

  it('marks a review cut off at its deadline, in the answer and in the log', async () => {
    const { out, posts } = await run('chat-c', {
      text: 'Blocking: half of it.',
      outcome: 'ok',
      partial: true,
      reasoning_chars: 0,
      attempts: 2,
      ms: 1
    })
    expect(out.review).toBe('Blocking: half of it.')
    expect(out.cut_off).toMatch(/ran out of time/)
    expect(posts.find((p) => p.path === '/api/v1/provenance/review')?.body.partial).toBe(true)
  })

  it('a timed-out review tells the model to go on without it and tell the user', async () => {
    const { out, posts } = await run('chat-c', {
      text: '',
      outcome: 'timeout',
      reasoning_chars: 90_000,
      attempts: 2,
      ms: 960_000
    })
    expect(out.review).toBeNull()
    expect(out.review_failed).toBe('timeout')
    expect(out.note).toMatch(/^The review timed out — continue without it and tell the user/)
    expect(posts).toHaveLength(0) // nothing to log
  })
})
