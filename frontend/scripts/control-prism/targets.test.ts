import { describe, expect, it } from 'vitest'
import { parseArgs, UsageError } from './args'
import { foldOptions, normaliseKeys } from './actions'
import { parseTarget, TargetError } from './targets'

describe('parseTarget', () => {
  it('reads a bare string as an exact aria-label, also with spaces and quotes', () => {
    expect(parseTarget('Model info')).toEqual([{ by: 'aria', match: { kind: 'exact', value: 'Model info' } }])
    expect(parseTarget('Say "hi"')).toEqual([{ by: 'aria', match: { kind: 'exact', value: 'Say "hi"' } }])
  })

  it('reads role and accessible name as snapshot prints them', () => {
    expect(parseTarget('role=button:Calculate')).toEqual([
      { by: 'role', role: 'button', name: { kind: 'exact', value: 'Calculate' } }
    ])
    expect(parseTarget('role=tab')).toEqual([{ by: 'role', role: 'tab' }])
    const [s] = parseTarget('role=button:/^(Calculate|Compute LCIA)$/')
    expect(s).toMatchObject({ by: 'role', role: 'button', name: { kind: 'regex' } })
  })

  it('keeps a colon inside the name', () => {
    expect(parseTarget('role=button:Chat model: GPT')).toEqual([
      { by: 'role', role: 'button', name: { kind: 'exact', value: 'Chat model: GPT' } }
    ])
  })

  it('takes ~= as a substring and /…/ as a regular expression', () => {
    expect(parseTarget('title~=Undo')).toEqual([{ by: 'title', match: { kind: 'contains', value: 'Undo' } }])
    const [s] = parseTarget('title=/^Undo: Set amount/')
    expect(s.by).toBe('title')
    expect(s.by === 'title' && s.match.kind === 'regex' && s.match.value.test('Undo: Set amount x')).toBe(
      true
    )
  })

  it('chains parts with >> and applies the modifiers', () => {
    expect(parseTarget('css=.flowpick-row >> has-text=air >> visible >> nth=0')).toEqual([
      { by: 'css', selector: '.flowpick-row' },
      { by: 'has-text', match: { kind: 'exact', value: 'air' } },
      { by: 'visible' },
      { by: 'nth', index: 0 }
    ])
  })

  it('rejects what it cannot read, saying how to write it', () => {
    expect(() => parseTarget('nth=0')).toThrow(/starts with a modifier/)
    expect(() => parseTarget('button=Run')).toThrow(/not a target prefix.*aria=button=Run/)
    expect(() => parseTarget('nth=first >> x')).toThrow(TargetError)
    expect(() => parseTarget('css=.a >>  >> x')).toThrow(/empty part/)
    expect(() => parseTarget('role=Button:x')).toThrow(/needs a role/)
    expect(() => parseTarget('title=')).toThrow(/names nothing/)
    expect(() => parseTarget('text=/(/')).toThrow(/not a valid regular expression/)
  })

  it('reads an aria-label that contains "=" when written with aria=', () => {
    expect(parseTarget('aria=a=b')).toEqual([{ by: 'aria', match: { kind: 'exact', value: 'a=b' } }])
  })
})

describe('parseArgs', () => {
  it('separates command, arguments and flags', () => {
    expect(parseArgs(['type', 'label=Name', 'bottle', '--commit', '--timeout', '5000'])).toEqual({
      cmd: 'type',
      args: ['label=Name', 'bottle'],
      flags: { commit: true, timeout: '5000' }
    })
    expect(parseArgs(['shot', '--target=css=.result-bar']).flags).toEqual({ target: 'css=.result-bar' })
  })

  it('passes text that starts with -- after a bare --', () => {
    expect(parseArgs(['type', 'x', '--', '--not-a-flag']).args).toEqual(['x', '--not-a-flag'])
  })

  it('refuses unknown flags and missing values', () => {
    expect(() => parseArgs(['click', 'x', '--force'])).toThrow(UsageError)
    expect(() => parseArgs(['wait', 'visible', 'x', '--timeout'])).toThrow(/needs a value/)
    expect(() => parseArgs(['stop', '--keep=yes'])).toThrow(/takes no value/)
  })

  it('defaults to help', () => {
    expect(parseArgs([]).cmd).toBe('help')
  })
})

describe('normaliseKeys', () => {
  it('spells modifiers the way Playwright knows them', () => {
    expect(normaliseKeys('Ctrl+z')).toBe('Control+z')
    expect(normaliseKeys('cmd+shift+Z')).toBe('Meta+Shift+Z')
    expect(normaliseKeys('esc')).toBe('Escape')
    expect(normaliseKeys('enter')).toBe('Enter')
  })
})

describe('foldOptions', () => {
  it('keeps the selected option and counts the rest, per list', () => {
    const tree = [
      '- combobox "Method":',
      '  - option "A"',
      '  - \'option "B: b"\' [selected]',
      '  - option "C"',
      '- combobox "Family":',
      '  - option "X"',
      '- button "Calculate"'
    ].join('\n')
    expect(foldOptions(tree)).toBe(
      [
        '- combobox "Method":',
        '  - \'option "B: b"\' [selected]',
        '  - (2 more options; --options lists them)',
        '- combobox "Family":',
        '  - (1 more option; --options lists them)',
        '- button "Calculate"'
      ].join('\n')
    )
  })
})
