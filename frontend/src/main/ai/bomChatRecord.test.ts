import { describe, expect, it } from 'vitest'
import { chatRecord, loggedVerdicts, onChatRecord, researchAnswers, vouchedPages } from './bomChatRecord'

/**
 * What backs the page of a known part, replayed without a model: a lookup backs it, nothing else upgrades it, a
 * logged "not backed" survives weighing again, and unknown stays unknown.
 */
const record = (over: { lookups?: any[]; answers?: unknown[]; log?: unknown } = {}) =>
  chatRecord(
    over.lookups ?? [{ searches: [{ query: 'tub', results: [{ url: 'https://www.shop.example/tub/' }] }] }],
    over.answers ?? [],
    over.log ?? []
  )

describe('what backs a known part’s page', () => {
  it("is a page this chat's searches returned, a reply opened or cited — never one the provider could not open", () => {
    const r = record({
      lookups: [
        {
          searches: [{ results: [{ url: 'https://www.shop.example/tub/' }] }],
          fetched: [
            { url: 'https://maker.example/sheet.pdf' },
            { url: 'https://dead.example/x', error: 'url_not_accessible' }
          ],
          cited: [{ url: 'https://cited.example/a' }]
        }
      ]
    })
    for (const url of [
      'https://shop.example/tub',
      'https://maker.example/sheet.pdf',
      'https://cited.example/a'
    ])
      expect(onChatRecord(r, url)).toBe(true)
    expect(onChatRecord(r, 'https://dead.example/x')).toBe(false)
    expect(onChatRecord(r, 'https://invented.example/p')).toBe(false)
  })

  it('is a page a research answer vouches for — not one in a note, an alternative or a total', () => {
    const answer = {
      items: [
        { component: 'tub', source_url: 'https://cited.example/tub', cited_by_search: true },
        { component: 'grips', source_url: 'https://memory.example/grips', cited_by_search: false },
        { component: 'axle', source_url: 'https://unknown.example/axle' },
        {
          component: 'wheel',
          source_url: 'https://cited.example/wheel',
          cited_by_search: true,
          alternatives: [{ mass_kg: 2.1, source_url: 'https://alt.example/wheel' }]
        }
      ],
      unresolved: [{ component: 'feet', note: 'a sister product lists them at https://note.example/feet' }],
      totals_found: [{ mass_kg: 20.7, source_url: 'https://total.example/p' }],
      evidence: [{ url: 'https://engine.example/page' }]
    }
    expect(vouchedPages(answer).sort()).toEqual(
      ['https://cited.example/tub', 'https://cited.example/wheel', 'https://engine.example/page'].sort()
    )
    const r = record({ lookups: [{ searches: [{ results: [] }] }], answers: [answer] })
    expect(onChatRecord(r, 'https://cited.example/tub')).toBe(true)
    for (const url of [
      'https://memory.example/grips',
      'https://unknown.example/axle',
      'https://alt.example/wheel',
      'https://note.example/feet',
      'https://total.example/p'
    ])
      expect(onChatRecord(r, url)).toBe(false)
  })

  it('takes only backed log pages as backed, keeps flagged ones flagged, and lets a lookup of this chat lift a flag', () => {
    const log = [
      {
        question: 'Bill of materials: shelf',
        findings: [
          {
            text: 'boards: 5.76 kg',
            sources: ['https://www.praxis.example/10322182'],
            cited_by_search: false,
            origin: 'assistant'
          },
          { text: 'beams: 2 kg', sources: ['https://shop.example/beam'], cited_by_search: true },
          { text: 'feet: 0.04 kg', sources: ['https://unflagged.example/feet'] },
          { text: 'Alternative figure for "beams": 4 kg', sources: ['https://alt.example/beam'] }
        ],
        bom_check: { totals: [{ mass_kg: 14.1, source: 'https://total.example/box' }] }
      }
    ]
    expect(loggedVerdicts(log)).toEqual({
      backed: ['https://shop.example/beam'],
      flagged: ['https://www.praxis.example/10322182']
    })
    // A provider that names no pages: the flag survives, the backed page stays backed, the rest says nothing.
    const quiet = record({ lookups: [{ counts: { web_search_requests: 2 } }], log })
    expect(onChatRecord(quiet, 'https://praxis.example/10322182')).toBe(false)
    expect(onChatRecord(quiet, 'https://shop.example/beam')).toBe(true)
    for (const url of [
      'https://unflagged.example/feet',
      'https://alt.example/beam',
      'https://total.example/box'
    ])
      expect(onChatRecord(quiet, url)).toBeUndefined()
    // Opened in this chat since: the flag is lifted by a lookup, not by weighing again.
    const opened = record({ lookups: [{ fetched: [{ url: 'https://praxis.example/10322182' }] }], log })
    expect(onChatRecord(opened, 'https://praxis.example/10322182')).toBe(true)
  })

  it('does not take an address the user wrote as read', () => {
    const r = record()
    expect(onChatRecord(r, 'https://epd.example/door.pdf')).toBe(false)
    expect(
      onChatRecord(record({ lookups: [{ counts: {} }] }), 'https://epd.example/door.pdf')
    ).toBeUndefined()
  })

  it("parses only the research tools' answers of this chat", () => {
    expect(
      researchAnswers([
        { role: 'user', content: 'https://user.example' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'r1', type: 'function', function: { name: 'research_bom', arguments: '{}' } },
            { id: 'w1', type: 'function', function: { name: 'research_web', arguments: '{}' } },
            { id: 'd1', type: 'function', function: { name: 'get_process_details', arguments: '{}' } }
          ]
        },
        { role: 'tool', tool_call_id: 'r1', content: '{"items":[]}' },
        { role: 'tool', tool_call_id: 'w1', content: 'not json' },
        { role: 'tool', tool_call_id: 'd1', content: '{"comment":"https://comment.example"}' }
      ])
    ).toEqual([{ items: [] }])
  })
})
