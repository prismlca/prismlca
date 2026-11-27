import { describe, expect, it } from 'vitest'
import type { NoteBlock } from '../shared/updates'
import { clipNotes, decodeEntities, MAX_NOTES_CHARS, parseNotesHtml, readReleaseNotes } from './releaseNotes'

/** The start of a real release's notes as GitHub's feed carries them: Markdown rendered to HTML, every line
 *  break of the wrapped changelog a `<br>`, issue references as links with GitHub's own attributes. */
const GITHUB_NOTES = `<p>Changes since v0.9.16: <a class="commit-link" href="https://github.com/prismlca/prismlca/compare/v0.9.16...v0.9.17"><tt>v0.9.16...v0.9.17</tt></a></p>
<h3>New</h3>
<ul>
<li><strong>Life cycle inventory on the Results page.</strong> A table of every elementary flow, one column per subject, sortable,<br>
with amounts to copy; "Export Excel" adds the inventory as a second sheet (<a class="issue-link js-issue-link" data-error-text="Failed to load title" data-id="6596665842" data-permission-text="Title is private" data-url="https://github.com/prismlca/prismlca/issues/147" data-hovercard-type="pull_request" data-hovercard-url="/prismlca/prismlca/pull/147/hovercard" href="https://github.com/prismlca/prismlca/pull/147">#147</a>).</li>
<li><strong>Keyboard and screen readers.</strong> Tab reaches the pages in the navigation.</li>
</ul>
<h3>Fixes</h3>
<ul>
<li>Minor security fixes and hardening.</li>
<li>Electron 44.11.6.</li>
</ul>`

const para = (text: string): NoteBlock => ({ kind: 'paragraph', spans: [{ text }] })
const list = (...items: NoteBlock[][]): NoteBlock => ({ kind: 'list', ordered: false, items })

describe('parseNotesHtml', () => {
  it("reads GitHub's release notes into headings, paragraphs and list items with bold lead-ins and links", () => {
    expect(parseNotesHtml(GITHUB_NOTES)).toEqual([
      {
        kind: 'paragraph',
        spans: [
          { text: 'Changes since v0.9.16: ' },
          {
            text: 'v0.9.16...v0.9.17',
            code: true,
            href: 'https://github.com/prismlca/prismlca/compare/v0.9.16...v0.9.17'
          }
        ]
      },
      { kind: 'heading', spans: [{ text: 'New' }] },
      list(
        [
          {
            kind: 'paragraph',
            spans: [
              { text: 'Life cycle inventory on the Results page.', strong: true },
              {
                // The changelog's line break is a space: the sentence flows as one paragraph.
                text: ' A table of every elementary flow, one column per subject, sortable, with amounts to copy; "Export Excel" adds the inventory as a second sheet ('
              },
              { text: '#147', href: 'https://github.com/prismlca/prismlca/pull/147' },
              { text: ').' }
            ]
          }
        ],
        [
          {
            kind: 'paragraph',
            spans: [
              { text: 'Keyboard and screen readers.', strong: true },
              { text: ' Tab reaches the pages in the navigation.' }
            ]
          }
        ]
      ),
      { kind: 'heading', spans: [{ text: 'Fixes' }] },
      list([para('Minor security fixes and hardening.')], [para('Electron 44.11.6.')])
    ])
  })

  it('decodes entities once and collapses whitespace as a browser does', () => {
    expect(
      parseNotesHtml('<p>  A &amp;amp; B &lt;b&gt; it&#39;s&#x2014;fine&nbsp;now &unknown;\n\n  end </p>')
    ).toEqual([para("A &amp; B <b> it's\u2014fine\u00a0now &unknown; end")])
    expect(decodeEntities('&#0; &#xD800; &#x110000;')).toBe('&#0; &#xD800; &#x110000;')
  })

  it('keeps nested and ordered lists, loose items, and items whose </li> is missing', () => {
    const html =
      '<ol><li><p>First</p><p>More on it</p></li><li>Second<ul><li>Inner one<li>Inner two</ul></li></ol>'
    expect(parseNotesHtml(html)).toEqual([
      {
        kind: 'list',
        ordered: true,
        items: [
          [para('First'), para('More on it')],
          [para('Second'), list([para('Inner one')], [para('Inner two')])]
        ]
      }
    ])
  })

  it('continues a list nested past three levels as part of the third', () => {
    const html = '<ul><li>1<ul><li>2<ul><li>3<ul><li>4</li></ul></li><li>3b</li></ul></li></ul></li></ul>'
    expect(parseNotesHtml(html)).toEqual([
      list([para('1'), list([para('2'), list([para('3')], [para('4')], [para('3b')])])])
    ])
  })

  it('drops scripts, styles, comments and images, keeps the text of tags it does not know, and links only https', () => {
    const html = [
      '<script>alert(1)</script><style>p{color:red}</style><!-- note --><img src="x.png" alt="x">',
      '<p><span class="x">Plain</span> <a href="javascript:alert(1)">js</a> <a href="http://example.org">http</a>',
      ' <a href="/relative">rel</a> <a href=\'https://example.org/a?b=1&amp;c=2\'>ok</a> 1 < 2</p>'
    ].join('')
    expect(parseNotesHtml(html)).toEqual([
      {
        kind: 'paragraph',
        spans: [
          { text: 'Plain js http rel ' },
          { text: 'ok', href: 'https://example.org/a?b=1&c=2' },
          { text: ' 1 < 2' }
        ]
      }
    ])
  })

  it('takes the address from the href attribute itself, not from text inside another attribute', () => {
    const html =
      '<p><a title="href=https://wrong.example " data-href="https://wrong2.example" href="https://right.example">Release</a></p>'
    expect(parseNotesHtml(html)).toEqual([
      { kind: 'paragraph', spans: [{ text: 'Release', href: 'https://right.example' }] }
    ])
  })

  it('keeps the lines and indentation of a code block, also inside highlighting spans', () => {
    const plain = '<p>Run:</p><pre><code>command-one\n  indented &amp;&amp; more\n</code></pre><p>Then.</p>'
    expect(parseNotesHtml(plain)).toEqual([
      para('Run:'),
      { kind: 'code', text: 'command-one\n  indented && more' },
      para('Then.')
    ])
    const highlighted =
      '<div class="highlight highlight-source-shell"><pre>\n<span class="pl-c1">npm</span> run build\n<span class="pl-c"># then</span>\nnpm start</pre></div>'
    expect(parseNotesHtml(highlighted)).toEqual([{ kind: 'code', text: 'npm run build\n# then\nnpm start' }])
    // A block left open at the end is kept as far as it goes.
    expect(parseNotesHtml('<pre>one\ntwo')).toEqual([{ kind: 'code', text: 'one\ntwo' }])
  })

  it('reads malformed tags in one pass: a tag that never closes costs no backtracking', () => {
    const inputs = ['<' + 'a'.repeat(100_000), '<a x="'.repeat(30_000), '<a b'.repeat(30_000)]
    for (const html of inputs) {
      const started = performance.now()
      const blocks = parseNotesHtml(html)
      // Linear parsing takes milliseconds; the quadratic tokenizer this replaces took seconds to minutes here.
      expect(performance.now() - started).toBeLessThan(3000)
      expect(blocks.length).toBe(1)
    }
  })

  it('reads text outside any block as a paragraph, and drops empty lists and headings', () => {
    expect(parseNotesHtml('Just text<ul><li> </li></ul><h3> </h3>')).toEqual([para('Just text')])
    expect(parseNotesHtml('')).toEqual([])
  })
})

describe('clipNotes', () => {
  const blocks: NoteBlock[] = [
    { kind: 'heading', spans: [{ text: 'New' }] },
    list([para('a'.repeat(40))], [para('b'.repeat(40))]),
    { kind: 'heading', spans: [{ text: 'Fixes' }] },
    list([para('c'.repeat(40))])
  ]

  it('keeps everything that fits', () => {
    expect(clipNotes(blocks, 1000)).toEqual({ blocks })
  })

  it('cuts after a whole item, and drops a heading whose section was cut away', () => {
    expect(clipNotes(blocks, 90)).toEqual({
      blocks: [blocks[0], list([para('a'.repeat(40))], [para('b'.repeat(40))])],
      cut: true
    })
    expect(clipNotes(blocks, 60)).toEqual({ blocks: [blocks[0], list([para('a'.repeat(40))])], cut: true })
  })

  it('shortens a first paragraph longer than the budget, so the notes still begin', () => {
    expect(clipNotes([para('x'.repeat(50)), para('y')], 20)).toEqual({
      blocks: [para(`${'x'.repeat(20)}…`)],
      cut: true
    })
  })
})

describe('readReleaseNotes', () => {
  it('reads one release, or one heading per version from a full changelog', () => {
    expect(readReleaseNotes('<p>Faster</p>')).toEqual({ blocks: [para('Faster')] })
    expect(
      readReleaseNotes([
        { version: '1.3.0', note: '<p>Newest</p>' },
        { version: '1.2.1', note: '' },
        { version: '1.2.0', note: null },
        { note: '<p>No version</p>' },
        'junk'
      ])
    ).toEqual({
      blocks: [{ kind: 'heading', spans: [{ text: 'Version 1.3.0' }] }, para('Newest'), para('No version')]
    })
  })

  it('says nothing when there is nothing to show', () => {
    expect(readReleaseNotes(undefined)).toBeUndefined()
    expect(readReleaseNotes(null)).toBeUndefined()
    expect(readReleaseNotes('   ')).toBeUndefined()
    expect(readReleaseNotes('<p> </p>')).toBeUndefined()
    expect(readReleaseNotes([])).toBeUndefined()
  })

  it('cuts notes longer than the page shows', () => {
    const items = Array.from(
      { length: 200 },
      (_, i) => `<li>${String(i).padStart(3, '0')} ${'w'.repeat(60)}</li>`
    )
    const notes = readReleaseNotes(`<ul>${items.join('')}</ul>`)!
    expect(notes.cut).toBe(true)
    const kept = (notes.blocks[0] as Extract<NoteBlock, { kind: 'list' }>).items
    expect(kept.length).toBe(Math.floor(MAX_NOTES_CHARS / 64))
  })
})
