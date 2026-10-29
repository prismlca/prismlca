// Report template — Network (dark).
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
//
// ---------------------------------------------------------------------------------------------------
// THE DESIGN, from the project's HTML drafts (`network-template-bright.html`, `network-template-full.html`).
//
// A monospace for everything that labels — eyebrows, headings, table heads, the running header — and a
// humanist sans for everything that is read. The cover's signature is a process network: three ranks of
// grey nodes converging left to right on a single marked node, which is the product under study. One path
// through it is drawn in the accent colour, because a life cycle is a path and this is the one the report
// is about.
//
// This file and `template-network-dark.typ` are a **pair**: they are generated from one source and differ
// only in the tone block below. Change anything else in one and change it in the other.
//
// Not taken from the draft, on purpose:
//   - The English eyebrow ("Life Cycle Assessment") over the title. A template cannot know the report's
//     language — every label that reaches a cover comes from the assembler, already translated — so a
//     hardcoded word would print English on a German report. A short accent rule holds that place instead.
//   - The highlighted and total table rows. Our table contract has no notion of "this row matters"; the
//     assembler passes headers and rows, and inventing emphasis from the data is not a theme's business.
//   - The fade at the top edge of the network. Typst has no gradient mask, and the graph's upper rows are
//     faint enough that there is no hard edge to hide.
// ---------------------------------------------------------------------------------------------------

// The colours come from the report's colour set, written by PrismLCA beside this file. One choice
// reaches every theme: a theme decides the layout, a palette decides the colour.
// A theme of your own may import this too, or declare its own colours and ignore it.
#import "palette.typ": *

// ---- tone -------------------------------------------------------------------------------------------
// THE ONLY BLOCK THAT DIFFERS between the two Network themes.
//
// The dark one. The surfaces are the theme's own — being dark *is* this theme, so they cannot come from a
// colour set built for white paper — while the two accents still come from the set, lightened: a teal that
// reads on paper is dim on near-black, and the set would otherwise reach this theme in name only.
#let net-paper = rgb("#14181c")
#let net-ink = rgb("#ecedee")
#let net-muted = rgb("#8b949c")
// Prose is brighter than the labels here, which is the opposite of the light theme's arrangement and the
// right way round on this paper: at #8b949c a page of prose sat visibly dimmer than the values in the table
// beside it, so the argument of the chapter read as the secondary thing on its own page. Labels, captions and
// the running header stay at `net-muted` — those *are* secondary.
#let net-body = rgb("#c3c9ce")
#let net-hair = rgb("#3a4149")
#let net-node = rgb("#4a545c")
#let net-accent = prism-green.lighten(38%)
#let net-mark = prism-accent2.lighten(18%)
#let net-tint = rgb("#1b2126")

/// The document frame.
#let lca-report-template(
  title: "LCA study",
  subtitle: none,
  // PDF metadata only.
  author: none,
  // Printed on the cover: a list of (label, value) pairs, already translated and already filtered of
  // empty values by the assembler. Labels do not live in the template, because a template cannot know
  // the report's language.
  meta: (),
  logo: none,
  // The client's mark, printed opposite the author's at the same height. `none` leaves that side empty.
  client-logo: none,
  //: Height of BOTH logos. One number on purpose.
  logo-height: 9.6mm,
  // This cover brings its own composition, so an uploaded picture has nowhere to go: the network *is* the
  // picture. Accepted and ignored, exactly as the two designed covers do — the UI reads that from the
  // registry and says so beside the upload control.
  cover-image: none,
  lang: "en",
  body-font: "IBM Plex Sans",
  heading-font: "JetBrains Mono",
  mono-font: "JetBrains Mono",
  body,
) = {
  set document(title: title, author: if author == none { () } else { (author,) })
  set text(font: body-font, size: 10pt, fill: net-body, lang: lang)
  // 1.75 line-height in the draft. Prose at 10pt with this much air is what makes a dense technical page
  // readable; it costs about a page in twenty, which a report can afford.
  set par(leading: 0.78em, spacing: 1.05em)
  show raw: set text(font: mono-font, size: 8.5pt, fill: net-ink)
  show strong: set text(fill: net-ink, weight: 600)
  show emph: set text(style: "italic")

  // Long tables must break across pages. A Typst figure is unbreakable by default, so the annex's
  // inventory table — 25 rows plus a caption — ran off the bottom of the page and its caption was drawn
  // on top of the last rows. Tables only: an image cannot be split anyway.
  show figure.where(kind: table): set block(breakable: true)
  // Air around a figure or a table. Typst gives a block the paragraph spacing — about 12pt here — and
  // a table or a chart is not a paragraph: it is a thing the prose refers to, and with a paragraph's gap it
  // reads as belonging to whichever paragraph it touches. 18pt on both sides makes it its own object.
  show figure: set block(above: 18pt, below: 18pt)

  // A small label style, used for everything the draft sets in the monospace: the running header, the
  // table heads, the key/value labels, the caption prefix. One function so they cannot drift apart.
  let tag(it, size: 7.5pt, fill: net-muted, weight: 500, tracking: 0.1em) = text(
    font: mono-font, size: size, weight: weight, fill: fill, tracking: tracking,
  )[#upper[#it]]

  set page(
    paper: "a4",
    fill: net-paper,
    // The draft's 20mm, with a little more at the top and bottom for the two hairline rules to sit in.
    margin: (top: 2.4cm, bottom: 2.2cm, left: 2.0cm, right: 2.0cm),
    header: context {
      // No running header on the cover page.
      if counter(page).get().first() > 1 {
        grid(
          columns: (1fr, auto),
          align(left, tag(title)),
          align(right, tag(counter(page).display(), fill: net-accent)),
        )
        v(-3pt)
        line(length: 100%, stroke: 0.5pt + net-hair)
      }
    },
    // The draft's footer, minus the page number it puts there: the number is in the header, where every
    // other theme of ours keeps it, and printing it twice on one page is a mistake, not a style. What is
    // left is the mark — three nodes and an edge, the cover's graph reduced to a glyph.
    footer: context {
      if counter(page).get().first() > 1 {
        line(length: 100%, stroke: 0.5pt + net-hair)
        v(4pt)
        align(center)[
          #box(width: 16mm, height: 2.4mm)[
            #place(horizon + left, dx: 1.1mm, line(length: 13.8mm, stroke: 0.4pt + net-hair))
            #place(horizon + left, dx: 0mm, circle(radius: 0.75mm, fill: net-node, stroke: none))
            #place(horizon + left, dx: 6.9mm, circle(radius: 0.75mm, fill: net-mark, stroke: none))
            #place(horizon + left, dx: 14.5mm, circle(radius: 0.75mm, fill: net-accent, stroke: none))
          ]
        ]
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
  // The draft's air, which the first version did not have: its h2 carries `margin-bottom: 8mm` —
  // 22.7pt — under a heading, and 6mm under the eyebrow above it. 12pt was less than half of that, and on a
  // page of dense technical prose the heading then sat *on* its text instead of over it. 20pt for a chapter,
  // 13pt for a section, 9pt for a sub-section: the draft's proportions, one notch tighter, because our
  // chapters are longer than a one-page mock-up and every heading pays its air twenty times over.
  //
  // Raised once more: the text sat too close under its heading. 26pt under a chapter, 17 under a
  // section, 12 under a sub-section — the draft's own 8mm is 22.7pt, so this is that with the sub-levels in
  // proportion rather than the two-thirds they were.
  show heading.where(level: 1): it => {
    pagebreak(weak: true)
    block(above: 0pt, below: 26pt)[
      // A short accent rule where the draft has its English eyebrow: the same rhythm above the heading,
      // without a word the template has no business choosing.
      #line(length: 7mm, stroke: 1.8pt + net-accent)
      #v(5.5pt)
      #set text(font: heading-font, size: 16pt, weight: 700, fill: net-ink)
      #it
    ]
  }
  show heading.where(level: 2): it => block(above: 22pt, below: 17pt)[
    #set text(font: heading-font, size: 11.5pt, weight: 700, fill: net-ink)
    #it
  ]
  show heading.where(level: 3): it => block(above: 18pt, below: 12pt)[
    #set text(font: body-font, size: 10.5pt, weight: 600, fill: net-ink)
    #it
  ]

  // Captions below the figure, numbered per kind, so #ref() works from the prose — with the draft's
  // monospace label as the prefix, which is where its "Table 3.1 —" lived.
  //
  // Left, not centred. Typst centres a caption under its figure; that is right for a plate in a book
  // and wrong here, where the caption starts with a monospace label and every other line on the page — the
  // table heads, the prose, the running header — begins at the same left edge. A centred label under a
  // full-width table starts nowhere in particular.
  // A table's caption goes ABOVE it, a figure's below — the convention every style guide this report
  // is measured against uses, and Typst puts both below by default.
  show figure.where(kind: table): set figure.caption(position: top)
  // …and stays on the page its table starts on: a caption left alone at the foot of a page, its table on
  // the next, reads as a heading over nothing. Sticky, it goes along with the table.
  show figure.where(kind: table): it => {
    show figure.caption: c => block(sticky: true, width: 100%, c)
    it
  }
  show figure.caption: it => align(left)[
    #set text(size: 8.5pt, fill: net-muted)
    #tag([#it.supplement #context it.counter.display(it.numbering)], size: 7pt, fill: net-accent)
    #h(4pt)
    #it.body
  ]

  // ---- cover page ----------------------------------------------------------
  {
    // Full bleed: the network has to leave the page rather than sit in a frame.
    set page(header: none, footer: none, margin: 0pt)
    let edge = 18mm // the draft's cover margin, for logos, title and meta alike

    // The two logos at the top corners — the author's mark left, the client's right. The draft has dashed
    // placeholders there; these are the real thing, and nothing is drawn where there is no logo.
    if logo != none {
      place(top + left, dx: edge, dy: 18mm, image(logo, height: logo-height))
    }
    if client-logo != none {
      place(top + right, dx: -edge, dy: 18mm, image(client-logo, height: logo-height))
    }

    // The network, under the type. Placed before the title block so the type wins where they meet, and
    // the graph's own coordinates are the draft's SVG viewBox (1000 × 740) mapped onto 230 × 172 mm at
    // (-10mm, 128mm) — wider than the page on purpose, so the leftmost nodes are cut by the edge and the
    // graph reads as a detail of something larger.
    place(top + left, dx: -10mm, dy: 128mm, block(width: 230mm, height: 172mm, {
      let nx(x) = (x / 1000.0) * 230mm
      let ny(y) = (y / 740.0) * 172mm
      let nr(r) = r * 0.23mm
    // 14 edges, 1.6 units wide
    for (a, b, c, d) in (
      (-20, 80, 240, 140),
      (40, 160, 240, 140),
      (40, 160, 260, 240),
      (-10, 260, 260, 240),
      (-10, 260, 230, 330),
      (50, 340, 230, 330),
      (50, 340, 255, 420),
      (10, 430, 255, 420),
      (10, 430, 235, 510),
      (60, 520, 235, 510),
      (60, 520, 250, 600),
      (20, 600, 250, 600),
      (70, 670, 250, 600),
      (50, 340, 260, 240),
    ) {
      place(top + left, line(start: (nx(a), ny(b)), end: (nx(c), ny(d)),
        stroke: 1.04pt + net-hair.transparentize(30%)))
    }
    // 10 edges, 1.8 units wide
    for (a, b, c, d) in (
      (240, 140, 490, 200),
      (260, 240, 490, 200),
      (260, 240, 500, 320),
      (230, 330, 500, 320),
      (230, 330, 480, 420),
      (255, 420, 480, 420),
      (255, 420, 505, 510),
      (235, 510, 505, 510),
      (250, 600, 505, 510),
      (240, 140, 500, 320),
    ) {
      place(top + left, line(start: (nx(a), ny(b)), end: (nx(c), ny(d)),
        stroke: 1.17pt + net-hair.transparentize(20%)))
    }
    // 3 edges, 2.2 units wide
    for (a, b, c, d) in (
      (490, 200, 850, 300),
      (500, 320, 850, 300),
      (505, 510, 850, 300),
    ) {
      place(top + left, line(start: (nx(a), ny(b)), end: (nx(c), ny(d)),
        stroke: 1.43pt + net-node.transparentize(15%)))
    }
    // 3 edges, 3.4 units wide
    for (a, b, c, d) in (
      (50, 340, 230, 330),
      (230, 330, 480, 420),
      (480, 420, 850, 300),
    ) {
      place(top + left, line(start: (nx(a), ny(b)), end: (nx(c), ny(d)),
        stroke: 2.22pt + net-accent.transparentize(5%)))
    }
    // 8 nodes
    for (x, y, r) in (
      (-20, 80, 9),
      (40, 160, 10),
      (-10, 260, 8),
      (50, 340, 11),
      (10, 430, 9),
      (60, 520, 10),
      (20, 600, 8),
      (70, 670, 9),
    ) {
      place(top + left, dx: nx(x) - nr(r), dy: ny(y) - nr(r),
        circle(radius: nr(r), fill: net-node.transparentize(45%), stroke: none))
    }
    // 6 nodes
    for (x, y, r) in (
      (240, 140, 12),
      (260, 240, 11),
      (230, 330, 13),
      (255, 420, 11),
      (235, 510, 12),
      (250, 600, 10),
    ) {
      place(top + left, dx: nx(x) - nr(r), dy: ny(y) - nr(r),
        circle(radius: nr(r), fill: net-node.transparentize(28%), stroke: none))
    }
    // 4 nodes
    for (x, y, r) in (
      (490, 200, 15),
      (500, 320, 14),
      (480, 420, 16),
      (505, 510, 13),
    ) {
      place(top + left, dx: nx(x) - nr(r), dy: ny(y) - nr(r),
        circle(radius: nr(r), fill: net-node.transparentize(10%), stroke: none))
    }
    // 2 nodes
    for (x, y, r) in (
      (230, 330, 13),
      (480, 420, 16),
    ) {
      place(top + left, dx: nx(x) - nr(r), dy: ny(y) - nr(r),
        circle(radius: nr(r), fill: net-accent, stroke: none))
    }
      // The product under study: the one node the whole graph converges on, in the set's second accent,
      // ringed in the paper colour so it sits *on* the graph rather than in it.
      place(top + left, dx: nx(850) - nr(26), dy: ny(300) - nr(26),
        circle(radius: nr(26), fill: net-mark, stroke: 2pt + net-paper))
    }))

    // Title block, over the graph.
    place(top + left, dx: edge, dy: 58mm, block(width: 150mm)[
      #line(length: 16mm, stroke: 2pt + net-accent)
      #v(7mm)
      #block[
        #set text(font: heading-font, size: 26pt, weight: 700, fill: net-ink)
        #set par(leading: 0.42em)
        #title
      ]
      #if subtitle != none {
        block(above: 7mm, width: 120mm)[
          #set text(size: 11pt, fill: net-muted)
          #subtitle
        ]
      }
    ])

    // The study's details at the foot, on the paper colour so the graph does not run behind the text.
    if meta.len() > 0 {
      place(bottom + left, block(width: 210mm, fill: net-paper, inset: (x: edge, top: 6mm, bottom: 18mm))[
        #line(length: 100%, stroke: 0.5pt + net-hair)
        #v(6mm)
        #let cell((label, value)) = [
          // 0.05em of tracking, not the 0.1em the running header and the table heads use: those are single
          // labels with room around them, while these stand side by side and every hundredth of an em is
          // width between a value and the next label. "CARRIED OUT BY" is 2mm narrower for it.
          #tag(label, size: 7pt, fill: net-accent, tracking: 0.05em)
          #linebreak()
          #text(size: 9.5pt, fill: net-ink)[#value]
        ]
        #context grid(
          // One column per entry — never a fixed three, which with all four (authors, carried out by,
          // commissioned by, date) sent the date onto a row of its own.
          //
          // `auto` while the entries fit side by side as they are: a fixed share put "Jane Doe" in a 58mm
          // column and left a hand's width of nothing before the next label, and auto columns are as wide as
          // their content, so short entries close up. When they do not fit — an institute's full name beside
          // three others — Typst would shrink the auto columns but keep the long one wide after its text
          // wrapped, leaving a hole beside it; then the width is shared out by what each entry holds, by the
          // square root as for table columns: text wraps, so twice the characters needs far less than twice
          // the width.
          columns: {
            let natural = meta.map(cell).map(c => measure(c).width).sum() + 7mm * (meta.len() - 1)
            if natural <= 210mm - 2 * edge { meta.map(_ => auto) } else {
              let chars(x) = if type(x) == str { x.clusters().len() } else { 20 }
              meta.map(((label, value)) => calc.sqrt(calc.max(chars(value), chars(label))) * 1fr)
            }
          },
          // `top`, spelled out: a grid centres its cells vertically by default, so as soon as one value
          // wrapped — an institute's full name is three lines in a 58mm column — the two short entries beside
          // it slid down to its middle and the three labels no longer sat on one line. The label is
          // the thing a reader scans across, so the labels are what has to align.
          align: top + left,
          row-gutter: 7mm,
          // 7mm. The gutter is not what makes the date look far from a short value — the *label* does: a column
          // is at least as wide as "CARRIED OUT BY", so a short name under it leaves the label's own overhang of
          // white before the next entry begins, and no gutter can take that back. What a gutter can do is not
          // add to it, which is why this went 8 → 11 → 7 rather than staying at 11.
          column-gutter: 7mm,
          ..meta.map(cell),
        )
      ])
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
/// from `text(lang:)`.
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

/// Key/value block — used for goal & scope and study metadata. The label in the draft's monospace, the
/// value in the reading face, which is the same pairing the cover's meta block uses.
#let lca-kv(pairs) = block(above: 6pt, below: 12pt)[
  #table(
    columns: (34%, 1fr),
    stroke: none,
    align: top + left,
    inset: (x: 0pt, y: 5pt),
    ..pairs
      .map(p => (
        [#text(font: "JetBrains Mono", size: 7.5pt, weight: 500, fill: net-accent, tracking: 0.1em)[#upper[#p.at(0)]]],
        [#text(fill: net-ink)[#p.at(1)]],
      ))
      .flatten()
  )
]

/// Data table. `align-right` lists the column indices that hold numbers.
#let lca-table(headers, rows, caption: none, align-right: (), label-name: none) = {
  let head = headers.map(h => [
    #text(font: "JetBrains Mono", size: 7pt, weight: 500, fill: net-muted, tracking: 0.08em)[#upper[#h]]
  ])
  let body-cells = rows
    .map(r => r
      .enumerate()
      .map(((i, c)) => if align-right.contains(i) { align(right)[#text(fill: net-ink)[#c]] } else { [#text(fill: net-ink)[#c]] }))
    .flatten()
  // Column widths from what the columns actually hold, not from a fixed text-or-number split. Under
  // that split a comment column of whole sentences got the same share as a unit column of "kg".
  //
  // The square root of the mean length, not the length itself — text wraps, so a column with ten times
  // the characters needs roughly three times the width, not ten. Clamped at both ends so one very long
  // cell cannot starve its neighbours, and a numeric column is capped: figures are short and do not wrap.
  let len-of(c) = if type(c) == str { c.clusters().len() } else { 12 }
  let width-of(i) = {
    let cells = rows.map(r => len-of(r.at(i, default: "")))
    let mean = if cells.len() == 0 { 0 } else { cells.sum() / cells.len() }
    let m = calc.max(calc.min(calc.max(mean, len-of(headers.at(i)) * 0.8), 64), 3)
    let w = calc.sqrt(m)
    if align-right.contains(i) { calc.min(w, 2.6) } else { w }
  }
  let tbl = table(
    // Fractions, never `auto`: `auto` sizes a column to its content, so a header carrying a full
    // ecoinvent method path made the table wider than the text block.
    columns: range(headers.len()).map(i => width-of(i) * 1fr),
    align: left,
    // Hairlines only, and a firmer one under the head — the draft's table has no vertical rules and no
    // fill on its body rows, which is what lets a long inventory table stay quiet.
    stroke: (x, y) => (
      top: if y == 0 { 0pt } else if y == 1 { 0.8pt + net-hair } else { 0.4pt + net-hair.transparentize(45%) },
      bottom: 0pt, left: 0pt, right: 0pt,
    ),
    inset: (x: 6pt, y: 5pt),
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
