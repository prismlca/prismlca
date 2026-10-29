import { describe, expect, it } from 'vitest'
import { canonicalArgs, makeRepeatGuard, stripOwnClosingTags, toolNamesInArgs, xmlInArgs } from './toolGuards'

describe('xmlInArgs — tags glued into JSON strings (V326)', () => {
  it('names the field and the tag for the shape MiniMax M3 sent', () => {
    const args = {
      action: 'add',
      activity_database:
        'zz-transport-eval</activity_code>01746453d4e044b39137e1336467fee1</activity_code><input_database>ecoinvent-3.12-cutoff</input_database>'
    }
    const msg = xmlInArgs(args)
    expect(msg).toContain('activity_database')
    expect(msg).toContain('</activity_code>')
    expect(msg).toContain('Send plain JSON')
  })

  it('looks into nested arrays and objects', () => {
    expect(xmlInArgs({ exchanges: [{ comment: 'fine' }, { comment: 'bad <item>x</item>' }] })).toContain(
      'exchanges[1].comment'
    )
  })

  it('names EVERY offending field in one message (V436)', () => {
    // Sonnet 5.5 over the server-tool wrapper: the model fixed the one field the message
    // named and fell over the next one in the following call.
    const msg = xmlInArgs({
      cutoff_criteria: 'x</cutoff_criteria>',
      allocation: 'fine',
      system_allocation: 'y</system_allocation>\n<parameter name="add_limitations">[{'
    })
    expect(msg).toContain('cutoff_criteria holds "</cutoff_criteria>"')
    expect(msg).toContain('system_allocation holds "</system_allocation>"')
  })

  it('leaves ordinary text alone — comparisons, units and prose are not tags', () => {
    expect(xmlInArgs({ comment: 'mass < 5 kg and > 2 kg', formula: 'a<b', note: '1 t = 1000 kg' })).toBeNull()
    expect(xmlInArgs({ pairs: [{ from: 'Hamburg', to: 'Prague' }] })).toBeNull()
    expect(xmlInArgs('plain string')).toBeNull()
    expect(xmlInArgs(42)).toBeNull()
  })
})

describe('makeRepeatGuard', () => {
  it('blocks the fourth identical call and lets a different one through', () => {
    const g = makeRepeatGuard('answer the user.')
    for (let i = 0; i < 3; i++) expect(g.block('calculate', '{"a":1}')).toBeNull()
    expect(g.block('calculate', '{"a":1}')).toMatch(/Blocked/)
    expect(g.block('calculate', '{"a":2}')).toBeNull()
  })

  it('counts a re-ordered or re-spaced spelling of the same arguments as the same call', () => {
    const g = makeRepeatGuard('answer the user.')
    expect(g.block('calculate', '{"a":1,"b":[1,2]}')).toBeNull()
    expect(g.block('calculate', '{ "b": [1, 2], "a": 1.0 }')).toBeNull()
    expect(g.block('calculate', '{"b":[1,2],"a":1}')).toBeNull()
    expect(g.block('calculate', '{"a":1,"b":[1,2]}')).toMatch(/Blocked/)
    // A different value is a different call.
    expect(g.block('calculate', '{"a":1,"b":[2,1]}')).toBeNull()
  })

  it('still compares the bytes when the arguments are not JSON', () => {
    const g = makeRepeatGuard('x')
    for (let i = 0; i < 3; i++) expect(g.block('t', 'not json')).toBeNull()
    expect(g.block('t', 'not json')).toMatch(/Blocked/)
    expect(g.block('t', 'not  json')).toBeNull()
  })
})

describe('canonicalArgs', () => {
  it('sorts keys at every depth and drops whitespace', () => {
    expect(canonicalArgs('{"z": {"b": 1, "a": 2}, "a": [ {"y":1,"x":2} ]}')).toBe(
      '{"a":[{"x":2,"y":1}],"z":{"a":2,"b":1}}'
    )
  })
})

describe('toolNamesInArgs (V408b)', () => {
  const tools = ['research_bom', 'distances', 'edit_parameter', 'search_background']
  it('names a tool written into a comment the report prints', () => {
    const remark = toolNamesInArgs(
      {
        parameters: [
          { name: 'm_cart_pp', value: 2.6, comment: 'Einhell 2,8 kg (idealo, über research_bom ermittelt)' }
        ]
      },
      tools
    )
    expect(remark).toMatch(/research_bom \(in "comment"\)/)
    expect(remark).toMatch(/never the tool that fetched it/)
  })
  it('leaves codes, names and non-printed fields alone', () => {
    expect(toolNamesInArgs({ name: 'research_bom_mass', comment: 'from the OBI listing' }, tools)).toBeNull()
    expect(toolNamesInArgs({ action: 'set', activity_code: 'research_bom' }, tools)).toBeNull()
    // A tool name without an underscore is an ordinary word (distances) — not matched.
    expect(toolNamesInArgs({ comment: 'the distances come from the port catalogue' }, tools)).toBeNull()
  })
})

describe('stripOwnClosingTags — the one leak that is unambiguous (V436)', () => {
  it('strips a closing tag that names the field itself and ends the value', () => {
    const args = {
      action: 'set',
      cutoff_criteria: 'Verluste: pauschal 1 % Mehreinsatz.</cutoff_criteria>',
      goal: 'ok'
    }
    expect(stripOwnClosingTags(args)).toEqual(['cutoff_criteria'])
    expect(args.cutoff_criteria).toBe('Verluste: pauschal 1 % Mehreinsatz.')
    expect(xmlInArgs(args)).toBeNull()
  })

  it('leaves a tag that is followed by more content, or that names another field, for the refusal', () => {
    const args = {
      system_allocation: 'vergeben.</system_allocation>\n<parameter name="add_limitations">[{"kind": "x"}]',
      allocation: 'Keine Allokation.</cutoff_criteria>'
    }
    expect(stripOwnClosingTags(args)).toEqual([])
    expect(xmlInArgs(args)).toContain('system_allocation holds')
    expect(xmlInArgs(args)).toContain('allocation holds "</cutoff_criteria>"')
  })

  it('works inside batch items and never touches prose', () => {
    const args = { items: [{ comment: 'A</comment>' }, { comment: 'mass < 5 kg' }] }
    expect(stripOwnClosingTags(args)).toEqual(['items[0].comment'])
    expect(args.items[0].comment).toBe('A')
    expect(args.items[1].comment).toBe('mass < 5 kg')
  })
})
