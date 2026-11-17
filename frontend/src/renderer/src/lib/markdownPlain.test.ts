import { describe, expect, it } from 'vitest'
import { plainFromMarkdown } from './markdownPlain'

describe('plainFromMarkdown', () => {
  it('takes the marks off blocks: headings, quotes, list items, task boxes', () => {
    expect(plainFromMarkdown('## Result ##\n\nAbout 75 kg.')).toBe('Result:\nAbout 75 kg.')
    expect(plainFromMarkdown('> Quoted\n> > - nested item')).toBe('Quoted\nnested item')
    expect(plainFromMarkdown('- one\n  * two\n+ [x] three\n- [ ] four')).toBe('one\ntwo\nthree\nfour')
    expect(plainFromMarkdown('1. First\n2. Second')).toBe('First\nSecond')
    // A mark needs its space; without it these are words.
    expect(plainFromMarkdown('#hashtag\n-5 °C\n*Note:* x')).toBe('#hashtag\n-5 °C\nNote: x')
  })

  it('sets a heading off from what follows, and only when something follows and it has no stop', () => {
    expect(plainFromMarkdown('# Summary\n\n')).toBe('Summary')
    expect(plainFromMarkdown('## Done!\nText')).toBe('Done!\nText')
    expect(plainFromMarkdown('### Result (per bottle)\nText')).toBe('Result (per bottle):\nText')
    expect(plainFromMarkdown('Title\n=====\nText')).toBe('Title:\nText')
    expect(plainFromMarkdown('#\nText')).toBe('\nText')
  })

  it('drops what is only layout, and reads a table row by row', () => {
    expect(plainFromMarkdown('Above\n\n---\n* * *\n___\n\nBelow\n> ---\n> Quoted')).toBe(
      'Above\nBelow\nQuoted'
    )
    expect(plainFromMarkdown('| Stage | kg |\n|:---|---:|\n| Production | 60 |')).toBe(
      'Stage | kg\nProduction | 60'
    )
    expect(plainFromMarkdown('| Result |\n| --- |\n| 75 kg | 999 kg |\n| |')).toBe('Result\n75 kg\n')
    expect(plainFromMarkdown('About 75 kg[^1]\n\n[^1]: Source')).toBe('About 75 kg')
  })

  it('keeps the words of emphasis, links and code', () => {
    expect(plainFromMarkdown('**Rund 75 kg** and __bold__, *it* and _it_, ~~gone~~, ***both***')).toBe(
      'Rund 75 kg and bold, it and it, gone, both'
    )
    expect(plainFromMarkdown('The [steel frame](prism:process/ab%20c) carries most')).toBe(
      'The steel frame carries most'
    )
    expect(plainFromMarkdown('Mostly [electricity [CH]](prism:process/p1)')).toBe('Mostly electricity [CH]')
    expect(
      plainFromMarkdown('See [Lund](https://en.wikipedia.org/wiki/Lund_(city)) and ![a chart](x.png)')
    ).toBe('See Lund and a chart')
    expect(plainFromMarkdown('Mail <mailto:a@b.org> or <https://b.org>')).toBe(
      'Mail mailto:a@b.org or https://b.org'
    )
    expect(plainFromMarkdown('Run `pet_bottle *x*` and ``a ` b``')).toBe('Run pet_bottle *x* and a ` b')
  })

  it('leaves the characters the chat shows as text', () => {
    expect(plainFromMarkdown('2 * 3 * 4 kg')).toBe('2 * 3 * 4 kg')
    expect(plainFromMarkdown('pet_bottle_v2 and snake__case__name')).toBe(
      'pet_bottle_v2 and snake__case__name'
    )
    expect(plainFromMarkdown('\\*not emphasis\\* and \\[not a link\\](x)')).toBe(
      '*not emphasis* and [not a link](x)'
    )
    expect(plainFromMarkdown('~75 kg to ~80 kg')).toBe('~75 kg to ~80 kg')
    expect(plainFromMarkdown('|−5|')).toBe('|−5|')
    expect(plainFromMarkdown('a <br> b')).toBe('a <br> b')
  })

  it('quotes code as written: fenced, indented, and a code span that only looks like a fence', () => {
    expect(plainFromMarkdown('Formula:\n```python\n# mass **total**\nm = a * b\n```\nEnd')).toBe(
      'Formula:\n# mass **total**\nm = a * b\nEnd'
    )
    expect(plainFromMarkdown('```\ncode **x**\n~~~\n```')).toBe('code **x**\n~~~')
    expect(plainFromMarkdown('    - 5')).toBe('- 5')
    expect(plainFromMarkdown('```75 kg CO2e``` in total')).toBe('75 kg CO2e in total')
  })
})
