import { describe, expect, it } from 'vitest'
import { CitationMarkerFilter } from './citationMarkers'

const MARK = 'citeturn539023search3turn435104view0'

/** Feed the pieces one by one and return what the chat would show. */
function shown(pieces: string[]): string {
  const f = new CitationMarkerFilter()
  return pieces.map((p) => f.push(p)).join('') + f.flush()
}

describe('CitationMarkerFilter', () => {
  it('drops a citation marker that arrives in one piece', () => {
    expect(shown([`at 30 °C and 60 °C. ${MARK}`])).toBe('at 30 °C and 60 °C. ')
  })

  it('drops a marker cut across pieces at any point', () => {
    const text = `machine**. ${MARK} Next sentence.`
    for (let cut = 1; cut < text.length; cut++) {
      for (let cut2 = cut; cut2 < text.length; cut2++) {
        expect(shown([text.slice(0, cut), text.slice(cut, cut2), text.slice(cut2)])).toBe(
          'machine**.  Next sentence.'
        )
      }
    }
  })

  it('drops a file citation, keeps text without markers as it is', () => {
    expect(shown(['afileciteturn0file1b'])).toBe('ab')
    expect(shown(['plain ', 'text — 25 °C'])).toBe('plain text — 25 °C')
  })

  it('passes other spans on unchanged', () => {
    const other = 'entity["company","Henkel"]'
    expect(shown([`by ${other}.`])).toBe(`by ${other}.`)
  })

  it('drops an unfinished citation marker at the end of the text', () => {
    expect(shown(['done. citeturn1sea'])).toBe('done. ')
    expect(shown(['done. ci'])).toBe('done. ')
  })

  it('gives held text back when it cannot be a marker', () => {
    expect(shown(['x  not a marker'])).toBe('x  not a marker')
    const long = 'cite' + 'y'.repeat(3000)
    expect(shown([long, ' tail'])).toBe(long + ' tail')
  })
})
