import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chat } from '../test/fakeStream'

/**
 * The conversation a drafted chapter goes through: contract check, second reader, the writer's answer,
 * the reader again. Offline — the model is the scripted stream, the backend a small fake whose gate
 * blocks a placeholder that does not resolve (contract) and flags the word "largest" (a word-list
 * suspicion that blocks only while nobody has read the chapter).
 */
vi.mock('../client', async () => (await import('../test/fakeStream')).clientModuleMock())
chat.alwaysDelta = true
chat.defaultUsage = { cost: 0.0001, prompt_tokens: 500 }
chat.defaultFinish = 'stop'

const { converse, parseAnswer } = await import('./dialogue')
const { quoted, parseReading } = await import('./reviewer')

const CHECK = '/api/v1/report/one/m/rep/sections/s1/proposal'
const REVIEW = '/api/v1/report/one/m/rep/sections/s1/review-brief'

type Call = { method: string; path: string; body: Record<string, unknown> }
let calls: Call[] = []

/** The printed form: every placeholder becomes the figure "20.0 %". */
const printed = (text: string): string => text.replace(/\{\{[^}]+\}\}/g, '20.0 %')

const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
  const b = (body ?? {}) as Record<string, unknown>
  calls.push({ method, path, body: b })
  const text = String(b.text ?? '')
  if (path === REVIEW)
    return { printed: printed(text), facts: { hotspots: [] }, study: {}, assignment: 'Write it.' }
  const findings = [
    ...(text.includes('{{bad}}') ? [{ kind: 'unresolved_placeholder', detail: 'bad does not resolve' }] : []),
    ...(/largest/.test(text) ? [{ kind: 'contradicted_claim', detail: '“the largest” is not true' }] : [])
  ]
  const contract = findings.filter((f) => f.kind === 'unresolved_placeholder')
  const ok = b.reviewed_by ? !contract.length : !findings.length
  return { ok, findings }
}

const base = (text: string, extra: Record<string, unknown> = {}): Parameters<typeof converse>[0] => ({
  text,
  figure: null,
  lookups: [],
  brief: { title: 'Contribution', snapshot_id: 'snap' },
  model: 'writer-m',
  messages: [
    { role: 'system', content: 'You write chapters.' },
    { role: 'user', content: 'Write the chapter.' }
  ],
  reviewModel: 'reader-m',
  api,
  checkPath: CHECK,
  reviewPath: REVIEW,
  tick: () => {},
  assertLive: () => {},
  onDraft: () => {},
  ...extra
})

const reply = (o: unknown): { text: string } => ({ text: JSON.stringify(o) })

beforeEach(() => {
  calls = []
  chat.rounds = []
  chat.seen.length = 0
})

describe('the second reader', () => {
  it('reads a chapter whose contract holds and stores the reading', async () => {
    chat.rounds = [reply({ verdict: 'accept', issues: [] })]
    const out = await converse(base('Transport carries {{hotspots.1.share_text}}.'))
    expect(out.review?.reviewer).toBe('reader-m')
    expect(out.review?.rounds).toBe(1)
    expect(out.review?.issues).toEqual([])
    // The gate was asked as a reviewed write: only the contract decides.
    expect(calls.find((c) => c.path === CHECK)?.body.reviewed_by).toBe('reader-m')
    // The reader read the chapter as printed, not the placeholder source.
    const readerTurn = String(chat.seen[0].messages.at(-1)?.content)
    expect(readerTurn).toContain('Transport carries 20.0 %.')
    expect(chat.seen[0].model).toBe('reader-m')
  })

  it('settles a point: the reader raises it, the writer fixes it, the reader closes it', async () => {
    chat.rounds = [
      reply({
        verdict: 'revise',
        issues: [{ quote: 'the largest contributor', problem: 'it is second', fix: 'say second largest' }]
      }),
      reply({ replacements: [{ old: 'the largest contributor', new: 'the second contributor' }] }),
      reply({ points: [{ n: 1, status: 'resolved' }], issues: [] })
    ]
    const out = await converse(base('Transport is the largest contributor at {{hotspots.1.share_text}}.'))
    expect(out.text).toBe('Transport is the second contributor at {{hotspots.1.share_text}}.')
    expect(out.review?.issues[0].status).toBe('resolved')
    expect(out.review?.rounds).toBe(2)
    // The word-list suspicion was there at first and gone after the fix: counted as fixed.
    expect(out.review?.hints.contradicted_claim).toEqual({ fixed: 1 })
    // The writer's answer was a model call of the writer's own model, with the point in its prompt.
    expect(chat.seen[1].model).toBe('writer-m')
    expect(String(chat.seen[1].messages.at(-1)?.content)).toContain('it is second')
  })

  it('lets the writer dispute a point and the reader call it a false alarm', async () => {
    chat.rounds = [
      reply({ verdict: 'revise', issues: [{ quote: 'the largest contributor', problem: 'not true' }] }),
      reply({ disputes: [{ point: 1, why: 'it is the largest in the facts' }] }),
      reply({ points: [{ n: 1, status: 'false_positive' }] })
    ]
    const text = 'Transport is the largest contributor at {{hotspots.0.share_text}}.'
    const out = await converse(base(text))
    expect(out.text).toBe(text)
    expect(out.review?.issues[0]).toMatchObject({
      status: 'false_positive',
      resolution: 'it is the largest in the facts'
    })
    // Read and accepted: the word list's guess did not decide, so the chapter is storable.
    expect(out.findings.some((f) => f.kind === 'unresolved_placeholder')).toBe(false)
    expect(out.review?.hints.contradicted_claim).toEqual({ dismissed: 1 })
    expect(String(chat.seen[2].messages.at(-1)?.content)).toContain('Disputed — the writer says')
  })

  it('drops a point whose quote is not in the chapter', async () => {
    chat.rounds = [reply({ verdict: 'revise', issues: [{ quote: 'words nobody wrote', problem: 'x' }] })]
    const out = await converse(base('Transport carries {{hotspots.1.share_text}}.'))
    expect(out.review?.issues).toEqual([])
    expect(chat.seen).toHaveLength(1) // no answer was asked of the writer
  })

  it('keeps a point open after the last reading instead of refusing the chapter', async () => {
    const issue = { quote: 'Transport carries', problem: 'unsupported' }
    chat.rounds = [
      reply({ verdict: 'revise', issues: [issue] }),
      reply({ disputes: [{ point: 1, why: 'it is in the facts' }] }),
      reply({ points: [{ n: 1, status: 'open' }] }),
      reply({ disputes: [{ point: 1, why: 'still in the facts' }] }),
      reply({ points: [{ n: 1, status: 'open' }] })
    ]
    const out = await converse(base('Transport carries {{hotspots.1.share_text}}.'))
    expect(out.review?.rounds).toBe(3)
    expect(out.review?.issues[0].status).toBe('open')
    expect(chat.rounds).toHaveLength(0)
  })

  it('collects questions for the author once, with a stable id', async () => {
    const q = { question: 'Is end of life in scope?', proposal: 'No', options: ['Yes', 'No'] }
    chat.rounds = [reply({ verdict: 'accept', issues: [], questions: [q, q] })]
    const out = await converse(base('Transport carries {{hotspots.1.share_text}}.'))
    expect(out.review?.questions).toHaveLength(1)
    expect(out.review?.questions[0].id).toMatch(/^q-/)
  })

  it('keeps the last text whose contract held when an answer breaks it beyond repair', async () => {
    chat.rounds = [
      reply({ verdict: 'revise', issues: [{ quote: 'Transport carries', problem: 'vague' }] }),
      reply({ replacements: [{ old: 'Transport carries', new: 'Transport carries {{bad}}' }] }),
      // the repair rounds fail to mend it
      reply({ replacements: [{ old: '{{bad}}', new: '{{bad}} still' }] }),
      reply({ replacements: [{ old: 'still', new: 'again' }] })
    ]
    const text = 'Transport carries {{hotspots.1.share_text}}.'
    const out = await converse(base(text))
    expect(out.text).toBe(text)
    expect(out.review?.issues[0].status).toBe('open')
  })

  it('falls back to the gate alone when the reader returns nothing usable', async () => {
    chat.rounds = [{ text: 'I think it is fine.' }, { text: '' }]
    const out = await converse(base('Transport carries {{hotspots.1.share_text}}.'))
    expect(out.review).toBeNull()
    const checks = calls.filter((c) => c.path === CHECK)
    expect(checks.at(-1)?.body.reviewed_by).toBeUndefined()
  })

  it('keeps the chapter when the reader call fails, and lets the gate decide alone', async () => {
    chat.rounds = [{ throws: new Error('429 rate limited') }, { throws: new Error('socket hang up') }]
    const text = 'Transport carries {{hotspots.1.share_text}}.'
    const out = await converse(base(text))
    expect(out.text).toBe(text)
    expect(out.review).toBeNull()
    expect(calls.filter((c) => c.path === CHECK).at(-1)?.body.reviewed_by).toBeUndefined()
  })

  it('takes an object that is no reading for no reading, not for an acceptance', async () => {
    chat.rounds = [reply({ error: 'review unavailable' }), reply({ error: 'review unavailable' })]
    const out = await converse(base('Transport carries {{hotspots.1.share_text}}.'))
    expect(out.review).toBeNull()
  })

  it('without a reader, the gate decides alone and a word-list finding is repaired', async () => {
    chat.rounds = [reply({ replacements: [{ old: 'the largest', new: 'a large' }] })]
    const out = await converse(base('Transport is the largest contributor.', { reviewModel: undefined }))
    expect(out.text).toBe('Transport is a large contributor.')
    expect(out.review).toBeNull()
    expect(calls.some((c) => c.path === REVIEW)).toBe(false)
  })
})

describe('reading the replies', () => {
  it('matches a quote across curly quotes, case and whitespace', () => {
    expect(quoted('the  “largest” share', 'Transport has The "largest"\nshare.')).toBe(true)
    expect(quoted('xy', 'xy')).toBe(false) // too short to be a quote
  })

  it('treats a reply that is not JSON as unreadable', () => {
    expect(parseReading('Looks fine to me.', 'text')).toBeNull()
  })

  it('reads a bare verdict as an acceptance, and an unrelated object as nothing', () => {
    expect(parseReading('{"verdict": "accept"}', 'text')?.accepted).toBe(true)
    expect(parseReading('{"points": []}', 'text')?.accepted).toBe(true)
    expect(parseReading('{"error": "busy"}', 'text')).toBeNull()
  })

  it('reads disputes beside replacements', () => {
    const a = parseAnswer(
      '{"replacements": [{"old": "a", "new": "b"}], "disputes": [{"point": 2, "why": "w"}]}'
    )
    expect(a?.disputes).toEqual([{ point: 2, why: 'w' }])
    expect(a?.edit && 'replacements' in a.edit).toBe(true)
  })
})
