import { describe, expect, it } from 'vitest'
import {
  announcesUnfinishedWork,
  compactMessages,
  failedItems,
  compactThreshold,
  estimateChars,
  runawayRepetition,
  withCacheBreakpoint
} from './agent'
import { RESEARCH_MODEL, REVIEW_MODEL } from './subagent'
import { findModel, getModels, setUserModels } from './models'

const AI_MODELS = getModels()
import type { ChatMessage } from './providers/types'

const OMITTED = '[earlier tool result omitted to fit the context]'

/**
 * Build a conversation of `rounds` tool-call rounds, each with one tool result.
 * `names` gives the tool per round, which decides what compaction may drop first.
 */
function conversation(rounds: number, names: string[] = []): ChatMessage[] {
  const out: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'do it' }
  ]
  for (let i = 0; i < rounds; i++) {
    out.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: `c${i}`, type: 'function', function: { name: names[i] ?? 'calculate', arguments: '{}' } }
      ]
    })
    out.push({ role: 'tool', tool_call_id: `c${i}`, content: `big result ${i}`.repeat(100) })
  }
  return out
}

describe('withCacheBreakpoint', () => {
  it('wraps the text in a single cacheable text part', () => {
    const parts = withCacheBreakpoint('system prompt')
    expect(parts).toEqual([{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }])
  })
})

describe('estimateChars', () => {
  it('counts string content, multi-part content and tool_calls', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'abcde' },
      { role: 'assistant', content: [{ type: 'text', text: 'xy' }] },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'a', type: 'function', function: { name: 'n', arguments: '{}' } }]
      }
    ]
    expect(estimateChars(msgs)).toBeGreaterThan(5)
    expect(estimateChars([])).toBe(0)
  })
})

describe('compactThreshold', () => {
  it('scales with a known context window and stays conservative without one', () => {
    expect(compactThreshold(200_000)).toBe(400_000) // 200k tokens × 50% × ~4 chars
    expect(compactThreshold(1_000_000)).toBe(2_000_000)
    expect(compactThreshold(undefined)).toBe(400_000) // conservative fallback
    // Never larger than the window itself, so headroom for tools + answer always remains.
    for (const ctx of [200_000, 1_000_000]) expect(compactThreshold(ctx)).toBeLessThan(ctx * 4)
  })

  it('is used per model, so a megatoken model is not compacted like a 256k one', () => {
    // Every built-in row holds about a megatoken since Hy3 left (2026-10-01), so the small side is
    // a user model with a 256k window — the case a user's own models.json can genuinely produce.
    setUserModels({
      models: [
        {
          id: 'test/small-window',
          label: 'Small window (test)',
          descriptor: 'test',
          temperature: null,
          intelligence: null,
          agentic: null,
          vision: false,
          contextTokens: 262144,
          userAdded: true
        }
      ],
      problems: []
    })
    try {
      expect(compactThreshold(findModel('google/gemini-3.8-flash').contextTokens)).toBeGreaterThan(
        compactThreshold(findModel('test/small-window').contextTokens)
      )
    } finally {
      setUserModels({ models: [], problems: [] })
    }
  })
})

describe('failedItems', () => {
  it('counts the items a batch lost while the call itself succeeded', () => {
    // The real shape from a dropped socket: three of six processes never created, status still ok.
    expect(failedItems('{"total":6,"succeeded":3,"failed":3,"results":[]}')).toBe(3)
  })

  it('says nothing about a clean batch or a non-batch result', () => {
    expect(failedItems('{"total":4,"succeeded":4,"failed":0}')).toBeUndefined()
    expect(failedItems('{"activities":7}')).toBeUndefined()
    expect(failedItems('plain text')).toBeUndefined()
    expect(failedItems('{"failed":"lots"}')).toBeUndefined() // not a batch envelope
  })
})

describe('compactMessages', () => {
  it('keeps the last N rounds verbatim and stubs older tool results', () => {
    const msgs = conversation(6)
    const before = estimateChars(msgs)
    const shrunk = compactMessages(msgs, 3)

    expect(shrunk).toBe(3) // rounds 0..2 stubbed, the last three untouched
    expect(estimateChars(msgs)).toBeLessThan(before)
    const tools = msgs.filter((m) => m.role === 'tool')
    expect(
      tools.slice(0, 3).every((m) => m.content === '[earlier tool result omitted to fit the context]')
    ).toBe(true)
    expect(tools.slice(3).every((m) => (m.content as string).startsWith('big result'))).toBe(true)
  })

  it('never drops tool_call_id or changes roles (the request would become invalid)', () => {
    const msgs = conversation(5)
    compactMessages(msgs, 1)
    for (const m of msgs.filter((x) => x.role === 'tool')) expect(m.tool_call_id).toBeTruthy()
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toBe('sys')
    expect(msgs[1].content).toBe('do it') // the user's ask is never touched
  })

  it('is idempotent and a no-op when there is nothing old enough', () => {
    const msgs = conversation(2)
    expect(compactMessages(msgs, 3)).toBe(0)
    const many = conversation(5)
    expect(compactMessages(many, 2)).toBe(3)
    expect(compactMessages(many, 2)).toBe(0) // already stubbed
  })

  it('gives up a replaceable result before an expensive one, however old it is', () => {
    // The skill text is the OLDEST message here, so age alone would drop it first.
    const msgs = conversation(4, ['get_skill', 'search_background', 'calculate', 'calculate'])
    expect(compactMessages(msgs, 1)).toBe(2) // the two replaceable ones, not the skill

    const tools = msgs.filter((m) => m.role === 'tool')
    expect(tools[0].content).toContain('big result 0') // get_skill survived
    expect(tools[1].content).toBe(OMITTED)
    expect(tools[2].content).toBe(OMITTED)
    expect(tools[3].content).toContain('big result 3') // the kept round is untouched
  })

  it('sacrifices a protected result rather than report nothing left to shrink', () => {
    // The rescue path treats 0 as "hopeless" and surfaces the error, so protection has to yield.
    const msgs = conversation(2, ['research_web', 'calculate'])
    expect(compactMessages(msgs, 1)).toBe(1) // round 0 is protected and alone → given up anyway
    expect(msgs.filter((m) => m.role === 'tool')[0].content).toBe(OMITTED)
    expect(compactMessages(msgs, 1)).toBe(0) // and it stays idempotent afterwards
  })

  it('leaves a longer untouched prefix than age-only would, which is what the cache reads', () => {
    const msgs = conversation(4, ['get_skill', 'calculate', 'calculate', 'calculate'])
    compactMessages(msgs, 1)
    // First rewritten message decides where the shared prefix ends: later is better.
    const firstStub = msgs.findIndex((m) => m.content === OMITTED)
    expect(firstStub).toBe(5) // round 1's result, not round 0's
  })

  it('elides old canvas screenshots, which are the biggest blocks', () => {
    const msgs = conversation(4)
    // A screenshot rides along as a user message with an image part, right after round 0.
    msgs.splice(4, 0, {
      role: 'user',
      content: [
        { type: 'text', text: 'Canvas screenshot:' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
      ]
    })
    compactMessages(msgs, 1)
    expect(msgs[4].content).toBe('[earlier canvas screenshot omitted to fit the context]')
  })

  it('sets an attached PDF aside but keeps the question and the way back to the file', () => {
    const msgs = conversation(4)
    // What a user turn with an attachment looks like: the prose, the file, and its caption.
    msgs.splice(4, 0, {
      role: 'user',
      content: [
        { type: 'text', text: 'What does the datasheet say about the housing?' },
        { type: 'file', file: { filename: 'spec.pdf', file_data: 'data:application/pdf;base64,AAAA' } },
        { type: 'text', text: '[attached file: spec.pdf (80 pages) — id "abc123-spec.pdf"]' }
      ]
    })
    compactMessages(msgs, 1)
    const parts = msgs[4].content as Array<Record<string, unknown>>
    expect(Array.isArray(parts)).toBe(true)
    expect(parts.some((p) => p.type === 'file')).toBe(false) // the bytes are gone
    expect(parts[0].text).toBe('What does the datasheet say about the housing?') // the question is not
    // The caption became a stub that still names the file and its handle — without the id, the model
    // has been told the information exists and given no way to reach it.
    expect(String(parts[1].text)).toContain('abc123-spec.pdf')
    expect(String(parts[1].text)).toContain('lookup kind="source"')
  })

  it('replaces a converted spreadsheet with its stub, not with silence', () => {
    const msgs = conversation(4)
    msgs.splice(4, 0, {
      role: 'user',
      content: [
        { type: 'text', text: 'Use these masses.' },
        {
          type: 'text',
          text:
            '--- attached file: bom.xlsx (2 sheets) — id "def456-bom.xlsx" ---\n' +
            'x'.repeat(5000) +
            '\n--- end of file ---'
        }
      ]
    })
    compactMessages(msgs, 1)
    const parts = msgs[4].content as Array<Record<string, unknown>>
    expect(String(parts[1].text)).toContain('def456-bom.xlsx')
    expect(String(parts[1].text).length).toBeLessThan(500)
  })

  it('leaves a user message alone when its attachment is already a stub', () => {
    // Compaction runs repeatedly within one turn; shrinking what is already shrunk would report
    // progress that did not happen, and the rescue path reads that number.
    const msgs = conversation(4)
    msgs.splice(4, 0, {
      role: 'user',
      content: [
        { type: 'text', text: 'Use these masses.' },
        { type: 'text', text: '[attached file: bom.xlsx (2 sheets) — id "def456-bom.xlsx"]' }
      ]
    })
    const before = JSON.stringify(msgs[4].content)
    compactMessages(msgs, 1)
    expect(JSON.stringify(msgs[4].content)).toBe(before)
  })
})

describe('explicitCache flags', () => {
  it('is set for every Anthropic model (they only cache when asked)', () => {
    for (const m of AI_MODELS.filter((x) => x.id.startsWith('anthropic/'))) {
      expect(m.explicitCache, m.id).toBe(true)
    }
  })

  it('is NOT set for other providers (they cache automatically or ignore the marker)', () => {
    for (const m of AI_MODELS.filter((x) => !x.id.startsWith('anthropic/'))) {
      expect(m.explicitCache, m.id).toBeUndefined()
    }
  })

  it('covers the models the eval harness and the research sub-agent use', () => {
    // The sub-agent defaults moved from GLM 5.2 to 5.3 with the catalogue on 2026-08-27; what this
    // holds is that the id the defaults name is one the catalogue actually knows.
    for (const id of [RESEARCH_MODEL, REVIEW_MODEL]) {
      expect(findModel(id).id, id).toBe(id)
      expect(findModel(id).explicitCache, id).toBeUndefined()
    }
  })
})

/**
 * Guards added after a run in which DeepSeek V4 Pro repeated "Let me go." several hundred times and
 * another in which a round announced a batch of edits and then made no tool call at all — the run
 * ended with the model half-changed and nothing said about it.
 */
describe('runawayRepetition', () => {
  it('catches the collapse that ran unbounded in the practice test', () => {
    const loop = runawayRepetition('Now let me fix the signs.' + '. Let me go'.repeat(367))
    expect(loop).not.toBeNull()
    expect(loop!.repeats).toBeGreaterThanOrEqual(8)
    expect(loop!.unit).toContain('Let me go')
  })

  it('needs both enough repeats and enough characters, so short echoes pass', () => {
    expect(runawayRepetition('ha'.repeat(5))).toBeNull() // too short overall
    expect(runawayRepetition('x'.repeat(300))).toBeNull() // long but under the character floor
  })

  it('leaves ordinary prose, tables and long numbers alone', () => {
    const prose =
      'The packaging phase dominates the climate change result, contributing 47.3 % of the total. ' +
      'Behind that total a single dataset dominates: packaging glass production, white (DE), which ' +
      'alone carries 11.0 % of the system-wide score, arising from natural gas combustion and the ' +
      'chemical decomposition of carbonate raw materials such as soda ash, limestone and dolomite. ' +
      'Apple production is the second-largest individual process at 6.1 %, split between fossil CO2 ' +
      'from field operations and dinitrogen monoxide from fertiliser application.'
    expect(runawayRepetition(prose)).toBeNull()

    const table =
      '| Phase | Impact | Share |\n| --- | --- | --- |\n' +
      ['Packaging|0.549|47.3', 'Raw materials|0.403|34.7', 'Filling|0.135|11.6', 'End-of-life|0.071|6.2']
        .map((r) => `| ${r} |`)
        .join('\n')
    expect(runawayRepetition(table)).toBeNull()
  })

  it('does not fire on a long run of blank lines alone', () => {
    expect(runawayRepetition('done.' + '\n'.repeat(600))).toBeNull()
  })
})

describe('announcesUnfinishedWork', () => {
  it('recognises the sentence that preceded the silent stop', () => {
    expect(
      announcesUnfinishedWork(
        'I can see the full picture now.\n\nLet me execute everything now in parallel batches:'
      )
    ).toBe(true)
    expect(announcesUnfinishedWork('First, let me fix the aluminium recycling sign:')).toBe(true)
    expect(announcesUnfinishedWork("I'll add the remaining EoL processes and set the formulas.")).toBe(true)
  })

  it('does not treat a finished answer or a question back as unfinished work', () => {
    expect(announcesUnfinishedWork('The model is built: 1.16 kg CO2-Eq per litre.')).toBe(false)
    expect(announcesUnfinishedWork('Let me know if you want scenarios as well.')).toBe(false)
    expect(announcesUnfinishedWork('Packaging dominates at 47.3 %, raw materials follow at 34.7 %.')).toBe(
      false
    )
    expect(announcesUnfinishedWork('')).toBe(false)
  })
})
