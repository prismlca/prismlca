import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chat } from '../test/fakeStream'

/**
 * Research a chapter paid for while no chapter came of it is held for the next write of the same
 * chapter: shown to the writer as earlier research, carried as evidence, and a question asked again is
 * answered from it instead of from the web. A stored chapter releases it.
 */
vi.mock('../client', async () => (await import('../test/fakeStream')).clientModuleMock())
chat.alwaysDelta = true
chat.gateCallsOnTools = true
chat.defaultUsage = { cost: 0.0004, prompt_tokens: 900 }
chat.defaultFinish = 'stop'
chat.fallbackText = 'A chapter.'

const { writeAll, writeSection } = await import('../reportWriter')
const { heldResearch } = await import('./heldResearch')

const BASE = '/api/v1/report/one/m/rep'
const brief = {
  kind: 'prose',
  title: 'Interpretation',
  language: 'English',
  prompt: 'Interpret the results and compare them with published LCAs.',
  literature: true,
  study: { goal: 'Compare drinking bottles', functional_unit: '100 fills' },
  data: { activity: { name: 'bottle', database: 'm', code: 'c' }, results: [] }
}

const FINDING = 'A reusable steel bottle breaks even with PET after 20 to 50 uses.'
const researchWeb = vi.fn(async (o: { question: string }) => ({
  question: o.question,
  findings: [{ text: FINDING, sources: ['https://example.org/bottle-lca'] }],
  sources: ['https://example.org/bottle-lca'],
  unsourced_dropped: 0,
  evidence: []
}))

const QUESTION = { questions: ['Published LCAs of reusable steel bottles versus PET'], context: '0.75 l, EU' }
const asking = (id: string, args: object = QUESTION) => ({
  calls: [{ id, name: 'research_web', arguments: JSON.stringify(args) }]
})

/** The gate: refuses every proposal while `refusing`, check and store alike. */
let refusing = false
let proposals: Array<Record<string, unknown>> = []
const api = async (_m: string, path: string, body?: unknown): Promise<unknown> => {
  const b = (body ?? {}) as Record<string, unknown>
  if (path.endsWith('/brief')) return { ...brief }
  if (!path.endsWith('/proposal')) return {}
  proposals.push(b)
  const findings = refusing ? [{ kind: 'literal_number', detail: 'The number 42 is written out.' }] : []
  return b.store ? { ok: !refusing, stored: !refusing, findings } : { ok: !refusing, findings }
}

const run = (id: string, base = BASE): ReturnType<typeof writeAll> =>
  writeAll({ base, waves: [[{ id }]], api, researchWeb })
const userTurn = (i = 0): string => JSON.stringify(chat.seen[i]?.messages[1]?.content ?? '')
const toolAnswer = (callId: string): string =>
  String(
    chat.seen.flatMap((c) => c.messages).find((m) => m.role === 'tool' && m.tool_call_id === callId)?.content
  )
const EARLIER = 'Research already done for this chapter'

beforeEach(() => {
  chat.rounds = []
  chat.seen.length = 0
  proposals = []
  refusing = false
  researchWeb.mockClear()
})

describe('research of a chapter that was not stored', () => {
  it('is handed to the next write of the chapter and not paid for again; a store releases it', async () => {
    const chapter = `${BASE}/sections/s-int`

    // Run 1: the research comes back, the gate refuses the chapter every time.
    refusing = true
    chat.rounds = [asking('r1'), { text: 'The interpretation, first run.' }]
    const [first] = await run('s-int')
    expect(first.stored).toBe(false)
    expect(researchWeb).toHaveBeenCalledTimes(1)
    expect(heldResearch(chapter)).toHaveLength(1)
    const paid = heldResearch(chapter)[0].result
    expect(paid).toContain(FINDING)

    // Run 2: the writer starts with that research in front of it and in its evidence, and the same
    // question asked again is answered from it — no second research leg.
    refusing = false
    chat.seen.length = 0
    proposals = []
    chat.rounds = [asking('r2'), { text: 'The interpretation, second run.' }]
    const [second] = await run('s-int')
    expect(userTurn()).toContain(EARLIER)
    expect(userTurn()).toContain(FINDING)
    expect(researchWeb).toHaveBeenCalledTimes(1)
    expect(toolAnswer('r2')).toContain(FINDING)
    // The gate checks the second text against the first run's research, once.
    const checked = proposals[0].lookups as Array<{ name: string; result: string }>
    expect(checked.filter((l) => l.name === 'research_web').map((l) => l.result)).toEqual([paid])
    expect(second.stored).toBe(true)
    expect(second.lookups?.map((l) => l.result)).toEqual([paid])

    // Stored: the chapter carries the research now, and the hold is gone.
    expect(heldResearch(chapter)).toEqual([])
    chat.seen.length = 0
    chat.rounds = [asking('r3'), { text: 'The interpretation, written anew.' }]
    await run('s-int')
    expect(userTurn()).not.toContain(EARLIER)
    expect(researchWeb).toHaveBeenCalledTimes(2)
  })

  it('stays with its own chapter of its own report', async () => {
    refusing = true
    chat.rounds = [asking('i1'), { text: 'The interpretation.' }]
    await run('s-own')
    expect(heldResearch(`${BASE}/sections/s-own`)).toHaveLength(1)

    refusing = false
    for (const [id, base] of [
      ['s-sibling', BASE],
      ['s-own', '/api/v1/report/one/m/other-report'],
      ['s-own', '/api/v1/report/one/other-model/rep']
    ]) {
      chat.seen.length = 0
      chat.rounds = [{ text: 'Another chapter.' }]
      await run(id, base)
      expect(userTurn()).not.toContain(EARLIER)
    }
    expect(heldResearch(`${BASE}/sections/s-own`)).toHaveLength(1)
  })

  it('survives a write that breaks off after the research', async () => {
    chat.rounds = [asking('t1'), { throws: new Error('connection reset') }]
    const [broken] = await run('s-broken')
    expect(broken.error).toContain('connection reset')
    expect(heldResearch(`${BASE}/sections/s-broken`)).toHaveLength(1)

    chat.seen.length = 0
    chat.rounds = [asking('t2'), { text: 'The interpretation.' }]
    await run('s-broken')
    expect(researchWeb).toHaveBeenCalledTimes(1)
    expect(toolAnswer('t2')).toContain(FINDING)
  })

  it('a new question is still searched; only the same question is answered from what is held', async () => {
    refusing = true
    chat.rounds = [asking('n1'), { text: 'The interpretation.' }]
    await run('s-new')
    refusing = false
    chat.rounds = [asking('n2', { questions: ['EU rules for food-contact steel'] }), { text: 'Prose.' }]
    await run('s-new')
    expect(researchWeb).toHaveBeenCalledTimes(2)
  })

  it('a single Write keeps holding until a stored chapter is seen to carry the research', async () => {
    const checkPath = `${BASE}/sections/s-single/proposal`
    const chapter = `${BASE}/sections/s-single`
    refusing = true
    chat.rounds = [asking('w1'), { text: 'The interpretation.' }]
    await writeSection({ brief, api, checkPath, researchWeb })
    expect(heldResearch(chapter)).toHaveLength(1)

    // The check passes, but the renderer stores afterwards and main never hears whether it worked: the
    // research stays held, so a failed store does not lose it.
    refusing = false
    chat.seen.length = 0
    chat.rounds = [{ text: 'The interpretation.' }]
    const out = await writeSection({ brief, api, checkPath, researchWeb })
    expect(userTurn()).toContain(EARLIER)
    expect(out.lookups.map((l) => l.name)).toEqual(['research_web'])
    expect(heldResearch(chapter)).toHaveLength(1)

    // The next write is an update of the stored chapter, which carries the research (as the backend sends
    // it back: new objects): released, and not shown twice.
    chat.seen.length = 0
    chat.rounds = [{ text: 'The interpretation, updated.' }]
    const update = {
      text: 'The interpretation.',
      printed: 'The interpretation.',
      changes: [],
      open_points: []
    }
    await writeSection({
      brief: { ...brief, update: { ...update, lookups: out.lookups.map((l) => ({ ...l })) } },
      api,
      checkPath,
      researchWeb
    })
    expect(heldResearch(chapter)).toEqual([])
    expect(userTurn()).not.toContain(EARLIER)
  })

  it('a batch whose questions all failed is not held; a partly failed one is held but asked again', async () => {
    const failing = vi.fn(async () => {
      throw new Error('503 Service Unavailable')
    })
    const two = {
      questions: ['Published LCAs of steel bottles', 'EU rules for food-contact steel'],
      context: ''
    }
    refusing = true
    chat.rounds = [asking('f1', two), { text: 'The interpretation.' }]
    await writeAll({ base: BASE, waves: [[{ id: 's-503' }]], api, researchWeb: failing })
    expect(heldResearch(`${BASE}/sections/s-503`)).toEqual([])

    let n = 0
    const half = vi.fn(async (o: { question: string }) => {
      if (n++ % 2) throw new Error('503 Service Unavailable')
      return {
        question: o.question,
        findings: [{ text: FINDING, sources: [] }],
        sources: [],
        unsourced_dropped: 0,
        evidence: []
      }
    })
    chat.rounds = [asking('p1', two), { text: 'The interpretation.' }]
    await writeAll({ base: BASE, waves: [[{ id: 's-half' }]], api, researchWeb: half })
    expect(heldResearch(`${BASE}/sections/s-half`)).toHaveLength(1)
    // The same batch asked again goes to the web: one of its questions deserves another try.
    refusing = false
    chat.rounds = [asking('p2', two), { text: 'Prose.' }]
    await writeAll({ base: BASE, waves: [[{ id: 's-half' }]], api, researchWeb: half })
    expect(half).toHaveBeenCalledTimes(4)
  })

  it('is not shown to a chapter that may not search the web', async () => {
    refusing = true
    chat.rounds = [asking('l1'), { text: 'The interpretation.' }]
    await run('s-lit')
    refusing = false
    chat.seen.length = 0
    chat.rounds = [{ text: 'The interpretation.' }]
    await writeSection({
      brief: { ...brief, literature: false },
      api,
      checkPath: `${BASE}/sections/s-lit/proposal`,
      researchWeb
    })
    expect(userTurn()).not.toContain(EARLIER)
  })
})
