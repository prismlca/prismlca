// Default report template — the PrismLCA look.
//
// TEMPLATE CONTRACT. A custom template must provide exactly these five things; how they look is
// entirely up to it. The assembler only calls them, so any Typst layout is fair game:
//
//   lca-report-template(..., body)  — the show rule: page setup, cover page, running header
//   lca-outlines()                  — contents, and the figure and table lists when the report asks
//   lca-kv(pairs)                   — a key/value block (goal & scope, metadata)
//   lca-table(headers, rows, ..)    — a data table with an optional caption
//   lca-figure(path, caption)       — an image with a caption
//
// A template is validated by compiling assets/typst/fixture.typ against it before first use; if that
// fails, the template is rejected with the compiler's message instead of breaking the report.
//
// NOT part of the contract: the PrismLCA colophon. The assembler writes it straight into main.typ using
// built-in Typst only, so no template can suppress it.

// The colours come from the report's colour set, written by PrismLCA beside this file. One choice
// reaches every theme: a theme decides the layout, a palette decides the colour.
// A theme of your own may import this too, or declare its own colours and ignore it.
#import "palette.typ": *

/// The document frame. `body-font` may be switched to "Libertinus Serif" (shipped inside the Typst
/// compiler) for a classical, serif report without needing any extra font files.
#let lca-report-template(
  title: "LCA study",
  subtitle: none,
  // PDF metadata only.
  author: none,
  // Printed on the cover: a list of (label, value) pairs, already translated and already filtered of
  // empty values by the assembler. Labels do not live in the template, because a template cannot know
  // the report's language — an earlier version hardcoded English ones and every German report carried
  // "Author / Commissioned by / Date" on its cover.
  meta: (),
  logo: none,
  // The client's mark, printed opposite the author's at the same height. `none` leaves that side empty —
  // an empty box where a client logo would be says "we forgot", a clean margin says nothing at all.
  client-logo: none,
  //: Height of BOTH logos. One number on purpose: two would let them end up at different sizes on the
  // same line, which is the one thing a pair of logos must never do.
  logo-height: 9.6mm,
  // An optional cover image, as a path inside the project. The cover has two deliberate looks rather
  // than one look with a hole in it: without an image the title block sits against generous white space
  // and the metadata anchors the foot of the page; with one, the image takes the lower two fifths and
  // the type block tightens above it. A report whose cover was designed for an image and then shown
  // without one looks unfinished, which is why both are laid out on purpose.
  cover-image: none,
  lang: "en",
  body-font: "Noto Sans",
  heading-font: "Noto Sans",
  mono-font: "DejaVu Sans Mono",
  body,
) = {
  set document(title: title, author: if author == none { () } else { (author,) })
  set text(font: body-font, size: 10.5pt, fill: prism-text, lang: lang)
  show raw: set text(font: mono-font, size: 9.5pt)

  // Long tables must break across pages. A Typst figure is unbreakable by default, so the annex's
  // inventory table — 25 rows plus a caption — ran off the bottom of the page and its caption was drawn
  // on top of the last rows.
  //
  // Tables only. An image cannot be split anyway, so a breakable image figure gains nothing and loses
  // something: the radar chart stayed on one page while its caption was pushed to the next, leaving a
  // caption alone at the top of a page under no figure. Whoever reads that sees a broken document.
  show figure.where(kind: table): set block(breakable: true)
  // Air around a figure or a table. Typst gives a
  // block the paragraph spacing — about 12pt here — which is the gap between two paragraphs, and a table or a
  // chart is not a paragraph: it is a thing the prose refers to, and it reads as belonging to whichever
  // paragraph it touches. 18pt on both sides is half again, enough to make it its own object without opening
  // a hole in the page.
  show figure: set block(above: 18pt, below: 18pt)

  set page(
    paper: "a4",
    margin: (top: 2.6cm, bottom: 2.2cm, left: 2.4cm, right: 2.4cm),
    header: context {
      // No running header on the cover page.
      if counter(page).get().first() > 1 {
        set text(size: 8.5pt, fill: prism-gray)
        grid(
          columns: (1fr, auto),
          align(left)[#title],
          align(right)[#counter(page).display()],
        )
        line(length: 100%, stroke: 0.5pt + prism-line)
      }
    },
  )

  // Numbering that drops a level nobody used. Typst counts the levels that *exist*, so a heading which
  // starts at level 2 — a chapter whose text opens with a sub-heading, which happens when a chapter is
  // written rather than assembled — is numbered "0.1", and a level-3 one "0.0.1". A leading zero in a
  // client document reads as a defect, because it is one.
  set heading(numbering: (..n) => {
    let parts = n.pos()
    while parts.len() > 1 and parts.first() == 0 { parts = parts.slice(1) }
    numbering("1.1", ..parts)
  })
  show heading.where(level: 1): it => {
    pagebreak(weak: true)
    block(above: 0pt, below: 14pt)[
      #set text(font: heading-font, size: 17pt, weight: 700, fill: prism-navy)
      #it
      #v(-6pt)
      // As long as the heading itself, not a fixed 42%: the rule then belongs to the words above it
      // instead of being a decoration that happens to end somewhere. Measured at the heading's natural
      // width and capped at the text block, so a heading that wraps gets a full-width rule rather than
      // one running off the page.
      #layout(size => context {
        line(length: calc.min(measure(it).width, size.width), stroke: 2.5pt + prism-green)
      })
    ]
  }
  show heading.where(level: 2): it => block(above: 18pt, below: 8pt)[
    #set text(font: heading-font, size: 12.5pt, weight: 650, fill: prism-navy)
    #it
  ]
  show heading.where(level: 3): it => block(above: 14pt, below: 6pt)[
    #set text(font: heading-font, size: 11pt, weight: 650, fill: prism-ink)
    #it
  ]

  // Figures and tables: numbered per kind, so #ref() works from the prose.
  // A table's caption goes ABOVE it, a figure's below — the convention every style guide this report
  // is measured against uses, and Typst puts both below by default.
  show figure.where(kind: table): set figure.caption(position: top)
  // …and stays on the page its table starts on: a caption left alone at the foot of a page, its table on
  // the next, reads as a heading over nothing. Sticky, it goes along with the table.
  show figure.where(kind: table): it => {
    show figure.caption: c => block(sticky: true, width: 100%, c)
    it
  }
  show figure.caption: it => {
    set text(size: 9pt, fill: prism-gray)
    it
  }

  // ---- cover page ----------------------------------------------------------
  {
    set page(header: none)
    let has-image = cover-image != none
    // 8.2mm of *mark*, and the image box IS the mark: the file is cropped to its ink, so a height means
    // what it says and the left edge of the wordmark sits exactly on the text column. It carried 30px of
    // near-white padding before, which rendered as 1.1mm — enough to make the logo look indented against
    // the heading below it. (An earlier version was worse: a 1520x863 canvas whose wordmark filled 292
    // rows, so 1.5cm of box gave 0.5cm of logo.)
    // The pair on one line: the author's mark left, the client's right, both at `logo-height`. A grid
    // rather than two placements, because this cover keeps its content in the normal flow.
    if logo != none or client-logo != none {
      block(above: 0pt, below: if has-image { 20pt } else { 26pt })[
        #grid(
          columns: (auto, 1fr, auto),
          align: horizon,
          if logo != none { image(logo, height: logo-height) } else { [] },
          [],
          if client-logo != none { image(client-logo, height: logo-height) } else { [] },
        )
      ]
    } else {
      v(logo-height)
    }
    line(length: 100%, stroke: 3pt + prism-green)
    block(above: 20pt, below: 4pt)[
      #set text(font: heading-font, size: if has-image { 24pt } else { 27pt }, weight: 700, fill: prism-navy)
      #title
    ]
    if subtitle != none {
      block(above: 10pt, below: if has-image { 16pt } else { 22pt })[
        #set text(size: 13pt, fill: prism-text); #subtitle
      ]
    }
    // The free space goes ABOVE the image, so the picture and the study details form one block at the
    // foot of the page. Putting it below instead left the image floating mid-page over a large gap
    // whenever the metadata was empty — which is exactly the state a working document is in.
    v(1fr)
    if has-image {
      // The picture FILLS the band, cropped rather than distorted or letterboxed. The band is 41% of the
      // page, which at full width is close to the 1.74 of the shipped photograph, so almost nothing is
      // cut off it; a cover picture that does not share those proportions loses a little top and bottom,
      // which is what a photograph can afford and thin white slivers beside it are not.
      block(width: 100%, height: 41%, clip: true, radius: 2pt)[
        #image(cover-image, fit: "cover", width: 100%, height: 100%)
      ]
    }
    set text(size: 10pt)
    if meta.len() > 0 {
      // A thin rule above the metadata when an image is present: without it the block reads as a caption
      // to the photograph rather than as the study's own details.
      if has-image {
        v(14pt)
        line(length: 100%, stroke: 0.5pt + prism-line)
        v(8pt)
      }
      grid(
        columns: (auto, 1fr),
        row-gutter: 6pt,
        column-gutter: 14pt,
        ..meta.map(((label, value)) => (strong[#label], [#value])).flatten()
      )
    }
    pagebreak()
  }

  body
}

// The widest number a list of figures or tables prints, set by `style` the way its entries are — the column
// every entry's number stands in, so the titles line up whether the list counts to 9 or to 12. Digits count
// as zeros: in a face with proportional figures "10" is narrower than "00", and the column must hold any of
// them. Needs context: it reads how many there are.
#let _list-number-width(el, style) = {
  // An unnumbered figure has no number to make room for.
  if el.numbering == none { return 0pt }
  let last = counter(figure.where(kind: el.kind)).final().first()
  let num = numbering(el.numbering, calc.max(last, 1))
  let widest = if type(num) == str { num.replace(regex("\d"), "0") } else { num }
  measure(style([#el.supplement #widest])).width
}

// A list of figures or tables on Typst's own entries, but with the number in a column as wide as the list's
// widest one: Typst's entry let "Figure 10" eat the gap before its title.
#let _figure-list(target) = {
  show outline.entry: it => link(
    it.element.location(),
    it.indented(box(width: _list-number-width(it.element, b => b), it.prefix()), it.inner(), gap: 0.8em),
  )
  outline(title: none, target: target)
}

/// Contents, figures and tables. All three are native to Typst, which also localises their titles
/// from `text(lang:)` — generating them ourselves (or asking a model for them) would be redundant and
/// would go stale the moment a chapter moves.
#let lca-outlines(contents: true, figures: true, tables: true) = {
  if contents { outline(indent: auto) }
  // The figure and table lists carry their own localised titles: Typst's auto-title says "Contents"
  // whatever the target. And an EMPTY list would print a lone heading over nothing, so each list
  // only appears when the document actually contains a figure or table — the page numbers come from
  // the same outline machinery as the table of contents and can never drift from it.
  context {
    let lof = (de: "Abbildungsverzeichnis", fr: "Liste des figures", es: "Índice de figuras", pt: "Lista de figuras").at(text.lang, default: "List of Figures")
    let lot = (de: "Tabellenverzeichnis", fr: "Liste des tableaux", es: "Índice de tablas", pt: "Lista de tabelas").at(text.lang, default: "List of Tables")
    // Real (unnumbered) headings instead of outline titles, so both lists appear as entries in the
    // table of contents itself — an outline's own title is never outlined.
    if figures and query(figure.where(kind: image)).len() > 0 {
      heading(level: 1, numbering: none, lof)
      _figure-list(figure.where(kind: image))
    }
    if tables and query(figure.where(kind: table)).len() > 0 {
      heading(level: 1, numbering: none, lot)
      _figure-list(figure.where(kind: table))
    }
  }
  if contents or figures or tables { pagebreak(weak: true) }
}

/// Key/value block — used for goal & scope and study metadata.
#let lca-kv(pairs) = block(above: 6pt, below: 12pt)[
  #table(
    columns: (34%, 1fr),
    stroke: none,
    inset: (x: 0pt, y: 5pt),
    ..pairs
      .map(p => (
        [#set text(fill: prism-ink, weight: 600); #p.at(0)],
        [#p.at(1)],
      ))
      .flatten()
  )
]

/// Data table. `align-right` lists the column indices that hold numbers.
#let lca-table(headers, rows, caption: none, align-right: (), label-name: none) = {
  let head = headers.map(h => [#set text(fill: prism-navy, weight: 650); #h])
  let body-cells = rows
    .map(r => r
      .enumerate()
      .map(((i, c)) => if align-right.contains(i) { align(right)[#c] } else { [#c] }))
    .flatten()
  // Column widths from what the columns actually hold, not from a fixed text-or-number split. Under
  // that split a comment column of whole sentences got the same share as a unit column of "kg": the
  // sentences wrapped over five lines while "kg" sat in a field several times wider than it needs.
  //
  // The square root of the mean length, not the length itself — text wraps, so a column with ten times
  // the characters needs roughly three times the width, not ten. Clamped at both ends so one very long
  // cell cannot starve its neighbours and an empty column still gets something to sit in, and a numeric
  // column is capped: figures are short, right-aligned and do not wrap, so width past that is waste.
  let len-of(c) = if type(c) == str { c.clusters().len() } else { 12 }
  let width-of(i) = {
    let cells = rows.map(r => len-of(r.at(i, default: "")))
    let mean = if cells.len() == 0 { 0 } else { cells.sum() / cells.len() }
    // The header keeps a narrow column from being crushed under a long title, at 80%: a header wraps
    // as willingly as a cell does.
    let m = calc.max(calc.min(calc.max(mean, len-of(headers.at(i)) * 0.8), 64), 3)
    let w = calc.sqrt(m)
    if align-right.contains(i) { calc.min(w, 2.6) } else { w }
  }
  let tbl = table(
    // Fractions, never `auto`. `auto` sizes a column to its content, so a header carrying a full
    // ecoinvent method path made the table wider than the text block — the 1fr column then collapsed
    // to nothing and printed on top of its neighbour. With fractions everything wraps and the table
    // always fits the text block, whatever the weights say.
    columns: range(headers.len()).map(i => width-of(i) * 1fr),
    align: left,
    stroke: (x, y) => (
      top: if y == 0 { 0pt } else if y == 1 { 1.5pt + prism-green } else { 0.5pt + prism-line },
      bottom: 0pt, left: 0pt, right: 0pt,
    ),
    fill: (x, y) => if y == 0 { prism-muted } else { none },
    inset: (x: 7pt, y: 5pt),
    // A header, not a first row: it repeats on every page a long table runs onto, and Typst does
    // not leave it alone at the foot of a page.
    table.header(..head),
    ..body-cells
  )
  if caption == none { tbl } else {
    let f = figure(tbl, caption: caption, kind: table)
    if label-name == none { f } else { [#f #label(label-name)] }
  }
}

/// Figure with caption. Vector (SVG) or raster — Typst embeds either.
#let lca-figure(path, caption: none, width: 100%, label-name: none) = {
  let f = figure(image(path, width: width), caption: caption, kind: image)
  if label-name == none { f } else { [#f #label(label-name)] }
}
