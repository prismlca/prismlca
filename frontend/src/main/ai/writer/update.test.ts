import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chat } from '../test/fakeStream'

/**
 * Updating a written chapter instead of writing it again: the writer is shown the chapter and what
 * changed, answers with replacements (or "still right"), and the result goes through the same
 * conversation with the gate and the reader, bound by position: the chapter arrives rebased into
 * today's positions, so it is checked and stored like a fresh write.
 */
vi.mock('../client', async () => (await import('../test/fakeStream')).clientModuleMock())
chat.alwaysDelta = true
chat.defaultUsage = { cost: 0.0001, prompt_tokens: 400 }
chat.defaultFinish = 'stop'

const { readUpdate } = await import('./update')
const { writeSection } = await import('../reportWriter')

const TEXT = 'Production is the largest phase at {{contribution.groups.0.share_text}}. Transport follows.'

const brief = {
  kind: 'contribution',
  title: 'Contribution analysis',
  language: 'English',
  prompt: 'Explain the contribution.',
  placeholders: ['contribution.groups.0.share_text'],
  facts: { contribution: { groups: [{ key: 'Transport' }, { key: 'Production' }] } },
  snapshot_id: 'snap',
  update: {
    text: TEXT,
    printed: 'Production is the largest phase at 40.0 %. Transport follows.',
    changes: ['contribution.groups.0 was rank 1 and is now rank 2'],
    open_points: [],
    lookups: [{ name: 'get_process_details', args: '{"code":"p"}', result: 'Injection moulding.' }]
  }
}

type Call = { path: string; body: Record<string, unknown> }
let calls: Call[] = []
const api = async (_m: string, path: string, body?: unknown): Promise<unknown> => {
  calls.push({ path, body: (body ?? {}) as Record<string, unknown> })
  if (path.endsWith('/review-brief')) return { printed: String((body as { text: string }).text) }
  return { ok: true, findings: [] }
}

const reply = (o: unknown): { text: string } => ({ text: JSON.stringify(o) })

beforeEach(() => {
  calls = []
  chat.rounds = []
  chat.seen.length = 0
})

describe('reading an update reply', () => {
  it('applies replacements to the chapter as it stands', () => {
    const out = readUpdate(
      JSON.stringify({ replacements: [{ old: 'the largest phase', new: 'the second-largest phase' }] }),
      TEXT
    )
    expect(out).toEqual({
      kind: 'edited',
      text: TEXT.replace('the largest phase', 'the second-largest phase')
    })
  })

  it('keeps the chapter when the writer says it is still right', () => {
    expect(readUpdate('{"unchanged": true, "why": "no rank word"}', TEXT)).toEqual({
      kind: 'unchanged',
      text: TEXT,
      why: 'no rank word'
    })
  })

  it('refuses a replacement that does not match, with a reason the writer can act on', () => {
    const out = readUpdate(JSON.stringify({ replacements: [{ old: 'words not there', new: 'x' }] }), TEXT)
    expect(out.kind).toBe('refused')
  })
})

describe('an update run', () => {
  it('shows the writer the chapter and what changed, and keeps the evidence it rests on', async () => {
    chat.rounds = [
      { text: JSON.stringify({ replacements: [{ old: 'the largest', new: 'the second-largest' }] }) },
      { text: JSON.stringify({ verdict: 'accept', issues: [] }) }
    ]
    const out = await writeSection({
      brief,
      model: 'writer-m',
      api,
      checkPath: '/r/sections/s1/proposal',
      reviewModel: 'reader-m',
      reviewPath: '/r/sections/s1/review-brief'
    })
    expect(out.text).toBe(TEXT.replace('the largest', 'the second-largest'))
    expect(out.update).toBe('edited')
    const assignment = String(chat.seen[0].messages[1].content)
    expect(assignment).toContain('This chapter is already written')
    expect(assignment).toContain('was rank 1 and is now rank 2')
    expect(assignment).not.toContain('FIGURE:') // an update keeps the chapter's charts
    expect(assignment).not.toContain('{{gone:')
    // Rebased by the backend already: checked and read by position, like a fresh write.
    expect(calls.find((c) => c.path.endsWith('/proposal'))?.body.keep_bindings).toBeUndefined()
    // The chapter's own lookups go with it: to the gate, to the reader, and on to the store.
    expect(out.lookups.map((l) => l.result)).toEqual(['Injection moulding.'])
    expect(calls.find((c) => c.path.endsWith('/proposal'))?.body.lookups).toEqual(brief.update.lookups)
  })

  it('counts an update as edited when the dialogue changed a chapter first called still right', async () => {
    chat.rounds = [
      { text: '{"unchanged": true, "why": "nothing moved"}' },
      reply({ issues: [{ quote: 'the largest phase', problem: 'Production is second now.' }] }),
      reply({ replacements: [{ old: 'the largest', new: 'the second-largest' }] }),
      reply({ points: [{ n: 1, status: 'resolved' }], issues: [] })
    ]
    const out = await writeSection({
      brief,
      model: 'writer-m',
      api,
      checkPath: '/r/sections/s1/proposal',
      reviewModel: 'reader-m',
      reviewPath: '/r/sections/s1/review-brief'
    })
    expect(out.text).toBe(TEXT.replace('the largest', 'the second-largest'))
    expect(out.update).toBe('edited')
  })

  it('tells the writer what a placeholder marked gone asks of it', async () => {
    const gone = 'Production carries {{gone:contribution.groups.3.share_text}}. Transport follows.'
    chat.rounds = [
      reply({
        replacements: [{ old: 'Production carries {{gone:contribution.groups.3.share_text}}. ', new: '' }]
      })
    ]
    await writeSection({
      brief: { ...brief, update: { ...brief.update, text: gone } },
      model: 'writer-m',
      api,
      checkPath: '/r/sections/s1/proposal'
    })
    const assignment = String(chat.seen[0].messages[1].content)
    expect(assignment).toContain('{{gone:…}} cited something that is no longer in the results')
  })

  it('keeps the chapter as it was when the answer cannot be applied twice over', async () => {
    chat.rounds = [{ text: 'I would rephrase it.' }, { text: 'Still not JSON.' }]
    const out = await writeSection({ brief, model: 'writer-m', api, checkPath: '/r/sections/s1/proposal' })
    expect(out.incomplete).toBe(true)
    expect(out.text).toBe(TEXT)
    expect(out.findings[0].kind).toBe('update_failed')
  })
})
