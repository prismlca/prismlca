// Report template — Shapes and card.
//
// A copy of `template.typ` whose cover page is an editorial layout — a label and a diagonal foot —
// instead of a photograph. Unlike `template-editorial.typ`, the head carries only
// the mark, the label and the year: the title, the subtitle and the study details all live together on
// one large white card in the lower half. Only the cover differs; see the note at
// the cover block for why it is a copy.
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
  // What the document is, translated and passed in by the assembler ("LCA report", "LCA-Bericht", …).
  // Reaches only the themes that declare it, so a theme downloaded before it existed keeps compiling; `none`
  // prints nothing. A hand-written `main.typ` may pass any word it likes.
  kind: none,
  logo: none,
  // The client's mark, printed opposite the author's at the same height. `none` leaves that side empty —
  // an empty box where a client logo would be says "we forgot", a clean margin says nothing at all.
  client-logo: none,
  //: Height of BOTH logos. One number on purpose: two would let them end up at different sizes on the
  // same line, which is the one thing a pair of logos must never do.
  logo-height: 9.6mm,
  // Accepted and DELIBERATELY UNUSED. This template brings its own cover, so an uploaded image would
  // have nowhere to go without turning one design into two half-designs. It is still declared, because
  // the assembler passes it whenever a report carries one and a template that rejected the argument
  // would fail to compile. Pick the "own cover image" template to see your photograph.
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
    // The cover's own foot, on every page: the bottom 5mm of it and nothing else, as if the title page were
    // sliced off there and the rest of the sheet left white. Navy across the width with the green wedge
    // cutting in from the right — the wedge's diagonal runs from (130mm, 297mm) to (210mm, 240mm), so at
    // 292mm it stands at 137mm, which is where the slice begins.
    //
    // A page background rather than a footer: a footer sits inside the margin box and would push the text
    // block up by its height on every page, and this band is decoration, not a place for content. The
    // cover draws the same shapes over it, so there it is invisible rather than duplicated.
    background: place(bottom + left, block(width: 210mm, height: 5mm)[
      #place(top + left, rect(width: 210mm, height: 5mm, fill: prism-navy))
      #place(top + left, polygon(
        fill: prism-green.transparentize(10%),
        (137mm, 0mm), (210mm, 0mm), (210mm, 5mm), (130mm, 5mm),
      ))
    ]),
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
  //
  // THIS is the only thing that differs from `template.typ`. Everything below the cover is the same
  // file, because the contract materialises exactly one `template.typ` into the Typst project and a
  // template therefore cannot import a shared base. A change to the document *body* has to be made in
  // every template.
  //
  // An editorial cover in the shape research institutes use for a report series: the mark, then the label
  // and the heading under it on plain paper, and the study details alone on a narrow white card lapping over
  // a diagonal navy foot. The upper half is left to the type.
  //
  // Every coordinate below is the reference layout's own, which was drawn on a 210x297 grid — so the
  // numbers here are millimetres of A4 and can be compared with it directly. Font sizes too: Typst takes
  // a length, so 16mm is 16mm and not a point value someone converted once and rounded.
  {
    set page(header: none, margin: 0pt, fill: paper) // full bleed: the shapes have to leave the page
    let edge = 20mm
    let w = 210mm
    let h = 297mm

    // No dotted field, no ghost lettering and no circles: the paper is plain, the upper half is the type
    // and nothing else, and the shapes are the diagonal foot alone.

    // The kind of document arrives translated now (`kind`), from the same string table as the meta labels.
    // It used to be five strings in this file: reaching the table meant a new argument, and an argument the
    // assembler passes unconditionally breaks every theme that predates it. It is passed only to a theme that
    // declares it, which is what made the trade go the other way.

    // Label, title and subtitle at the head, hanging under the mark on the same left edge — the logo file
    // is cropped to its ink, so `edge` puts the wordmark and the words below it on one vertical.
    //
    // The block takes the full measure between the margins: nothing at the top right for the navy letters
    // to vanish into.
    place(top + left, dx: edge, dy: 40mm, block(width: w - 2 * edge)[
      // The label, naming the kind of document — which no report field carries, so it arrives as its own
      // translated word from the assembler. It stands in for a mark: with the author's own logo above it, the
      // head would carry two badges in a column and the label would be the weaker of them.
      //
      // A logo at all is now the whole question: PrismLCA's own mark used to stand in for a missing one, so
      // this had to tell the two apart by the file name the assembler gave them. A cover carries
      // the author's mark or nothing, so `!= none` says it.
      #let own-logo = logo != none
      #let label = box(
        fill: prism-green,
        inset: (x: 2.6mm, y: 1.5mm),
        radius: 1mm,
        text(font: heading-font, size: 3.2mm, weight: 700, fill: white, tracking: 0.8mm)[#upper[#if kind != none { kind }]],
      )
      // `hide` and not an `if`: the label keeps its space when it is not drawn, so the heading sits on the
      // same line whether the label is there or not. Dropping it outright pulled the title up by the
      // label's height, and the title's position is the one thing on this cover that must not move. Which is
      // why a report with no word for its kind hides the badge rather than leaving it out.
      #if kind == none or own-logo { hide(label) } else { label }
      #block(above: 7mm, below: 0pt)[
        #context {
          // Measured and stepped down until it fits the band it has. 14mm is drawn for two lines, and a
          // life-cycle title is rarely two lines — a long one costs type size, not the layout.
          let fit(size) = block(width: w - 2 * edge)[
            #set text(font: heading-font, size: size, weight: 800, fill: prism-navy, tracking: -0.2mm)
            #set par(leading: size * 0.16)
            #title
          ]
          let size = 15mm
          // The band, not just the starting size: the loop shrinks until the title fits, so raising one
          // without the other changes nothing for a title long enough to be stepped down.
          while measure(fit(size)).height > 49mm and size > 6mm { size = size * 0.92 }
          fit(size)
        }
      ]
      #if subtitle != none {
        block(above: 10.5mm)[
          // The heading's own colour, not the body grey: at this size, under a title of the same navy, the
          // grey read as a caption to the title rather than as the second half of it.
          #set text(size: 5.4mm, fill: prism-navy)
          #set par(leading: 1.8mm)
          #subtitle
        ]
      }
    ])

    // The foot: two slanted bands and a corner wedge. The pale green one behind is not parallel to the
    // navy — they meet at the right edge and part towards the left, which is what keeps the foot from
    // reading as one striped block.
    place(top + left, polygon(fill: prism-green.transparentize(80%),
      (0mm, 195mm), (w, 185mm), (w, 245mm), (0mm, 255mm)))
    place(top + left, polygon(fill: prism-navy, (0mm, 210mm), (w, 195mm), (w, h), (0mm, h)))
    place(top + left, polygon(fill: prism-green.transparentize(10%),
      (130mm, h), (w, 240mm), (w, h)))

    // The study details alone on a white card with a green spine, lapping over the navy edge — that
    // overlap is what makes the card sit *on* the composition instead of beside it. Still a column rather
    // than a page — the words that name the study are at the head on this cover and the card is only the
    // imprint — but wide enough that a firm's full name fits on one line, and set a size up from the row
    // it used to be, because a stacked list has the room for it.
    if meta.len() > 0 {
      // 3% off the width, taken from the right: the left edge stays on `edge` with the logo, the label and
      // the heading, which is the vertical the whole cover is built on.
      let card-w = 109.7mm
      let spine = 3mm
      // Less air on the spine side than on the outer one — the green bar already separates the text from
      // the page, so matching the outer padding left the column sitting further right than it looked — but
      // not flush against it either: 5mm read as a text block that had slipped off its margin.
      let pad-left = 5.8mm
      let pad = 9mm
      let inner = card-w - spine - pad-left - pad
      context {
        // Stacked, not in a row: one pair under the next, each label over its value, the way the reference
        // sets its imprint. The spacing is between the *pairs* only — a label and its value are one entry
        // and stay tight, or the column reads as eight unrelated lines instead of four.
        let content = block(width: inner)[
          #stack(spacing: 8.5mm, ..meta.map(((label, value)) => [
            #text(size: 3.4mm, weight: 700, fill: prism-navy, tracking: 0.3mm)[#upper(label)]
            #linebreak()
            #text(size: 4.1mm, fill: rgb("#2d3748"))[#value]
          ]))
        ]
        // Taller than the content needs, and the content centred in what is left: the card reaches deeper
        // into the navy band while the imprint keeps equal air above and below it. Deliberate white, not
        // padding that happened to be left over — and the height still follows the content, so a fifth
        // detail lengthens the card rather than eating the white.
        // 12mm more than the content needs, then the trims off the total (−4%, −6%, −3% in that order):
        // the card reaches into the navy band without the imprint filling it edge to edge.
        let card-h = (measure(content).height + 2 * pad + 12mm) * 0.8753
        // The top edge is a line of the layout, not a consequence of the height: it stays on 166.1mm
        // whatever the card holds. It used to be 170mm less 5% of the height, which meant every change to
        // the type or the spacing moved the top as a side effect.
        place(top + left, dx: edge, dy: 166.1mm, block(
          width: card-w, height: card-h, fill: white, radius: 1mm,
        )[
          #place(top + left, rect(width: spine, height: card-h, fill: prism-green, radius: 1mm))
          #place(left + horizon, dx: spine + pad-left, content)
        ])
      }
    }

    // One mark only, at the head on the same left edge as everything under it. No client logo on this
    // cover: its head is a single column, and a second mark beside the first would compete with the label
    // and the heading hanging under them. The registry says so (`client_logo: False`), so the report card
    // marks the control as unused by this template rather than accepting an upload that goes nowhere.
    if logo != none {
      place(top + left, dx: edge, dy: 16mm, image(logo, height: logo-height))
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
