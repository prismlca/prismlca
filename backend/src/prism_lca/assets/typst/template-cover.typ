// Report template — the PrismLCA look with a DESIGNED cover (no cover image needed).
//
// A copy of `template.typ` whose cover page is built from the shapes of the PrismLCA mark instead of a
// photograph. Only the cover differs; see the note at the cover block for why it is a copy.
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

  // The cover's wave, hoisted out of the cover block so the running band at the foot of every page can be
  // literally the *same* shape: the band is this drawing at full page height, clipped to its bottom 5mm.
  // Slicing rather than re-drawing means the two can never drift apart — change the curve and the band
  // follows. Coordinates are absolute page millimetres, which is why it takes no size arguments.
  let cover-wave(shift, fill) = place(
    top + left,
    curve(
      fill: fill,
      curve.move((139mm - shift, 0mm)),
      curve.cubic((156mm - shift, 62mm), (152mm - shift, 205mm), (75mm - shift, 297mm)),
      curve.line((210mm, 297mm)),
      curve.line((210mm, 0mm)),
      curve.close(),
    ),
  )
  // All three tones, outermost first, as the cover stacks them.
  let cover-art = {
    cover-wave(27mm, prism-muted)
    cover-wave(22mm, prism-green)
    cover-wave(0mm, prism-navy)
  }

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
    // The cover's own foot on every page, 5mm tall — the same height the main theme uses, so the two look
    // like one family of documents. Made by slicing, exactly so: the whole cover drawing is
    // placed at full height inside a 5mm window and clipped, so what shows is the bottom 5mm of the title
    // page and nothing else. At that height the wave has swept left, so the band reads white, a thin pale
    // saum, green, then navy across the rest — the cover's own order.
    //
    // A page background rather than a footer: a footer lives inside the margin box and would push the text
    // block up on every page, and this band is decoration, not a place for content. On the cover the art is
    // drawn over it at full bleed, so there it is covered rather than duplicated.
    background: place(bottom + left, block(width: 210mm, height: 5mm, clip: true)[
      #place(top + left, dy: -292mm, block(width: 210mm, height: 297mm, cover-art))
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
  // The cover the reference is built on: one wave running the full height down the RIGHT side, in three
  // nested tones, with the white it leaves on the left carrying the logo, the title and the study
  // details. The curve is measured, not guessed — it meets the top edge at 66% of the width, bulges out
  // to 72% at a fifth of the height, then sweeps left and leaves the bottom edge at 36%, so the coloured
  // field is widest at the foot and the white column narrows as it goes down.
  {
    set page(header: none, margin: 0pt) // full bleed: the wave has to leave the page, not sit in a frame
    let edge = 2.4cm // the body's left margin, so the title lines up with every page after it

    // Three nested tones, each shifted left of the one before, so they nest like the reference instead of
    // sitting side by side; drawn outermost first, the solid navy closing the stack. The visible width of a
    // tone is the gap to the next shift: a thin pale saum, a broad band of the accent, then the solid field.
    // The shape lives above (`cover-art`) because the running band at the foot of every page is the bottom
    // 5mm of this very drawing.
    cover-art

    // Logo, title and details all live in the white column on the left.
    if logo != none {
      // Same dx as the title block below, and the file is cropped to its ink, so the wordmark
      // starts on the same vertical as the heading rather than 1.2mm of padding to the right.
      place(top + left, dx: edge, dy: 22mm, image(logo, height: logo-height))
    }
    // The client's mark opposite the author's, on the same baseline and at the same height. Nothing is
    // drawn when there is none: an empty frame would announce a missing logo.
    if client-logo != none {
      place(top + right, dx: -edge, dy: 22mm, image(client-logo, height: logo-height))
    }

    place(
      top + left,
      dx: edge,
      dy: 46%,
      block(width: 86mm)[ // stays clear of the wave at this height
        #line(length: 26mm, stroke: 3pt + prism-green)
        #block(above: 16pt, below: 0pt)[
          #set text(font: heading-font, size: 26pt, weight: 700, fill: prism-navy)
          #title
        ]
        #if subtitle != none {
          block(above: 12pt)[#set text(size: 12pt, fill: prism-text); #subtitle]
        }
      ],
    )

    // The study details in the navy field at the foot, right-aligned against the same margin the logo
    // uses. Under the title they competed with it for the same corner; down here they close the page
    // where the colour is at its widest, and the eye goes title → foot instead of reading one block of
    // four sizes. Right-aligned because the wave's edge runs down to the left of them: ragged-left text
    // follows that edge instead of fighting it.
    //
    // Reversed colours, because this text sits ON the navy: labels in green, values in white. Black on
    // navy is the one thing that would not be legible, and the block is placed where the field is at
    // least 100mm wide at every line, so nothing can slide off the colour onto the paper.
    if meta.len() > 0 {
      place(
        bottom + right,
        dx: -edge,
        dy: -edge,
        block(width: 70mm)[
          #set align(right)
          #set text(size: 9.5pt, fill: white)
          #for (label, value) in meta {
            block(above: 7pt, below: 0pt)[
              #text(size: 8pt, weight: 600, fill: prism-green)[#upper(label)]
              #linebreak()
              #value
            ]
          }
        ],
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
