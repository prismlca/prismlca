// Report template — Declining emissions.
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
// THE DESIGN, from the HTML draft (`draft/studienbericht-vorlage-v2.html`).
//
// A classic study report: white paper, a geometric sans (Instrument Sans) for everything that labels —
// the title, the headings, the contents, the table heads, the running header — and a humanist sans
// (Source Sans 3) for everything that is read. The cover is typographic: a small square in the accent
// colour, the kind of document, a rule, the title in 43pt, the subtitle in the accent's ink, the study's
// details in a row, and at the foot three curves falling from left to right — an abstracted reduction
// path — in gradations of the one accent colour.
//
// ONE HUE. The draft has a petrol, a mint and a sand; the design rule is that the accent of the
// colour set — the small square — is the one colour, and everything else coloured is a gradation of it.
// The set's second accent and its deep tone are not used here at all. So every coloured thing on these
// pages is `st-accent` itself, darkened for type (`st-accent-ink`) or lightened for a fill (`st-tint`,
// `st-tint-2`), and the curves at the foot of the cover run from the darkened tone to the accent.
//
// THE KIND LINE MOVES. With one or two logos the cards sit at the top and the kind-of-document rule sits
// under them at 48mm. Without any logo the rule moves up to the top margin; the title and
// everything below it stay exactly where they are.
//
// Not taken from the draft, on purpose:
//   - "Projekt-Nr. · Endfassung" on the right of the kind line. No report field carries a project number
//     or a status, so the right-hand side is empty.
//   - The lead paragraph and the highlighted total row. Our block and table contracts have no notion of
//     "this paragraph opens the chapter" or "this row is the sum", and inventing emphasis from the data is
//     not a theme's business.
//   - The table stripes that reach 2.5mm beyond the text block on either side. Typst tables sit in the
//     block; the stripes stop at its edges.
// ---------------------------------------------------------------------------------------------------

// The colours come from the report's colour set, written by PrismLCA beside this file. One choice
// reaches every theme: a theme decides the layout, a palette decides the colour.
// A theme of your own may import this too, or declare its own colours and ignore it.
#import "palette.typ": *

// ---- colour -----------------------------------------------------------------------------------------
// The square on the cover, exactly the set's accent. Everything else coloured is derived from it.
#let st-accent = prism-green
// The accent as a text colour: the set's accent is chosen to be seen against paper as a *shape*, and a
// lime or a mint at 10pt on white is not legible. Darkened by a fixed share so the hue stays and the
// contrast arrives — the subtitle, the chapter numbers, the caption prefixes, the head rule of a table.
#let st-accent-ink = prism-green.darken(38%)
// Two fills: every second table row, and the head of the meta block on the cover.
#let st-tint = prism-green.lighten(90%)
#let st-tint-2 = prism-green.lighten(80%)
// Neutrals, as the set defines them — a derived grey is a plausible grey, and plausible is not what a
// client document needs.
#let st-ink = prism-ink
#let st-muted = prism-text
#let st-hair = prism-line
#let st-paper = paper
// Prose: the set's ink, softened a little towards its text grey. The draft reads in a near-black
// (#1E2A27 against an ink of #0F2320): darker than a grey, lighter than a heading.
#let st-body = prism-ink.mix((prism-text, 25%))

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

/// The document frame.
#let lca-report-template(
  title: "LCA study",
  subtitle: none,
  // PDF metadata, and the left half of the running footer.
  author: none,
  // Printed on the cover: a list of (label, value) pairs, already translated and already filtered of
  // empty values by the assembler. Labels do not live in the template, because a template cannot know
  // the report's language.
  meta: (),
  // The kind of document — "LCA report", "LCA-Bericht" — translated by the assembler like the meta labels.
  // Printed beside the accent square on the cover's first rule. `none` leaves the rule alone.
  kind: none,
  // The author's mark and the client's, each on a white card at the top of the cover. The draft puts the
  // commissioning party's card on the left and the author's on the right, and so does this.
  logo: none,
  client-logo: none,
  //: Height of BOTH logos. One number on purpose. The card around a logo is 20mm high with 3.5mm of
  //: padding, so this is also as tall as a mark can be drawn.
  logo-height: 12mm,
  // This cover brings its own composition, so an uploaded picture has nowhere to go: the curves *are*
  // the picture. Accepted and ignored — the UI reads that from the registry and says so beside the
  // upload control.
  cover-image: none,
  lang: "en",
  body-font: "Source Sans 3",
  heading-font: "Instrument Sans",
  mono-font: "DejaVu Sans Mono",
  body,
) = {
  set document(title: title, author: if author == none { () } else { (author,) })
  // 10.5pt on a 1.55 line — the draft's measure. Source Sans 3 is compact, so this is a comfortable
  // body size rather than a large one.
  set text(font: body-font, size: 10.5pt, fill: st-body, lang: lang)
  set par(leading: 0.62em, spacing: 1.15em, justify: false)
  show raw: set text(font: mono-font, size: 8.5pt, fill: st-ink)
  show strong: set text(fill: st-ink, weight: 600)
  show emph: set text(style: "italic")

  // Long tables must break across pages. A Typst figure is unbreakable by default, so an inventory
  // table of 25 rows would run off the bottom of the page with its caption drawn over the last rows.
  // Tables only: an image cannot be split anyway.
  show figure.where(kind: table): set block(breakable: true)
  // Air around a figure or a table: a table is a thing the prose refers to, not a paragraph, and with a
  // paragraph's gap it reads as belonging to whichever paragraph it touches.
  show figure: set block(above: 18pt, below: 16pt)

  // The label face: Instrument Sans, small. Used for the running header and footer, the meta labels, the
  // table heads, the caption prefix — one function so they cannot drift apart.
  let label-text(it, size: 8.5pt, fill: st-muted, weight: 500) = text(
    font: heading-font, size: size, weight: weight, fill: fill,
  )[#it]

  // The chapter a page is in, for the running header: the last level-1 heading at or before this page,
  // numbered as the contents number it. Nothing before the first chapter — the contents pages carry the
  // title alone.
  let current-chapter() = {
    let here = counter(page).get().first()
    let before = query(heading.where(level: 1)).filter(h => h.location().page() <= here)
    if before.len() == 0 { return none }
    let hd = before.last()
    if hd.numbering == none { hd.body } else {
      [#numbering(hd.numbering, ..counter(heading).at(hd.location())) #h(0.6em) #hd.body]
    }
  }

  set page(
    paper: "a4",
    fill: st-paper,
    // The draft's text block: 24mm on the binding side, 20mm outside, the head starting 34mm from the
    // top under the running header and stopping 28mm above the foot.
    margin: (top: 34mm, bottom: 28mm, left: 24mm, right: 20mm),
    // The running header is drawn at the draft's 18mm from the top edge, with its hairline 2.5mm under
    // the text; `header-ascent` is measured from the text block's top edge to the header's bottom edge.
    header-ascent: 11mm,
    footer-descent: 16mm,
    header: context {
      if counter(page).get().first() > 1 {
        let chapter = current-chapter()
        grid(
          columns: (1fr, auto),
          column-gutter: 8mm,
          align(left, label-text(title, weight: 400)),
          align(right, label-text(if chapter == none { [] } else { chapter }, weight: 400)),
        )
        v(2.5mm, weak: true)
        line(length: 100%, stroke: 0.5pt + st-hair)
      }
    },
    // The draft's footer: a hairline, the author on the left, the folio in the label face on the right.
    footer: context {
      if counter(page).get().first() > 1 {
        line(length: 100%, stroke: 0.5pt + st-hair)
        v(2.5mm, weak: true)
        grid(
          columns: (1fr, auto),
          align(left, label-text(if author == none { [] } else { author }, weight: 400)),
          align(right, label-text(counter(page).display(), size: 9.5pt, fill: st-ink, weight: 600)),
        )
      }
    },
  )

  // Numbering that drops a level nobody used. Typst counts the levels that *exist*, so a heading which
  // starts at level 2 — a chapter whose text opens with a sub-heading — is numbered "0.1", and a level-3
  // one "0.0.1". A leading zero in a client document reads as a defect, because it is one.
  set heading(numbering: (..n) => {
    let parts = n.pos()
    while parts.len() > 1 and parts.first() == 0 { parts = parts.slice(1) }
    numbering("1.1", ..parts)
  })

  // The chapter heading with its hanging number: 13mm for the number in the accent's ink, the title
  // beside it — and a heading WITHOUT a number (the contents, the figure and table lists) starts at the
  // left edge instead of being indented as if it had one.
  show heading.where(level: 1): it => {
    pagebreak(weak: true)
    block(above: 0pt, below: 7mm, width: 100%)[
      #set text(font: heading-font, size: 20pt, weight: 600, fill: st-ink, tracking: -0.018em)
      #set par(leading: 0.3em)
      #if it.numbering == none { it.body } else {
        grid(
          columns: (13mm, 1fr),
          align: top + left,
          text(fill: st-accent-ink)[#counter(heading).display(it.numbering)],
          it.body,
        )
      }
    ]
  }
  show heading.where(level: 2): it => block(above: 7mm, below: 3mm)[
    #set text(font: heading-font, size: 12.5pt, weight: 600, fill: st-ink)
    #if it.numbering == none { it.body } else [#counter(heading).display(it.numbering)#h(0.6em)#it.body]
  ]
  show heading.where(level: 3): it => block(above: 6mm, below: 2.5mm)[
    #set text(font: heading-font, size: 11pt, weight: 600, fill: st-ink)
    #if it.numbering == none { it.body } else [#counter(heading).display(it.numbering)#h(0.6em)#it.body]
  ]

  // Captions: the draft's "Tabelle 3-1:" in the label face and the accent's ink, the text beside it in
  // the set's ink. A table's caption goes ABOVE it, a figure's below — the convention every style guide
  // this report is measured against uses, and Typst puts both below by default.
  show figure.where(kind: table): set figure.caption(position: top)
  // …and stays on the page its table starts on: a caption left alone at the foot of a page, its table on
  // the next, reads as a heading over nothing. Sticky, it goes along with the table.
  show figure.where(kind: table): it => {
    show figure.caption: c => block(sticky: true, width: 100%, c)
    it
  }
  show figure.caption: it => align(left)[
    #set text(size: 9pt, fill: st-ink)
    #set par(leading: 0.4em)
    #label-text([#it.supplement #context it.counter.display(it.numbering):], size: 9pt, fill: st-accent-ink, weight: 600)
    #h(4pt)
    #it.body
  ]

  // The contents, as the draft sets them: chapter lines in the label face with the number in the
  // accent's ink, section lines in the reading face indented under them, a dotted leader, the page
  // number in grey. An entry WITHOUT a number — the figure and table lists — starts at the left edge
  // rather than where the numbered titles start, which is the whole reason this is not `indent: auto`.
  show outline.entry: it => {
    let lvl = it.level
    let prefix = it.prefix()
    let is-heading = it.element.func() == heading
    let num-width = if lvl == 1 { 9mm } else { 12mm }
    let indent = if lvl == 1 { 0mm } else { 11mm * (lvl - 1) }
    let above = if lvl == 1 and is-heading { 3.4mm } else { 1.2mm }
    // "Table 1", "Figure 12" in the figure and table lists: in a column as wide as the list's widest
    // number, then a gap.
    let list-style(body) = label-text(body, size: 10pt, fill: st-accent-ink, weight: 600)
    let hang = if prefix == none { 0pt } else if is-heading { num-width } else {
      _list-number-width(it.element, list-style) + 2.5mm
    }
    // Set in code mode, so no space slips in between the number column and the title.
    link(it.element.location(), block(above: above, below: 1.2mm, width: 100%, inset: (left: indent), {
      set text(size: 10.5pt)
      // A title too long for one line goes on under its own first word, not under its number, and its
      // lines sit as close as the entries do. An explicit paragraph: inline content alone in a block is
      // not one, and a hanging indent only applies to a paragraph.
      par(hanging-indent: hang, leading: 0.45em, {
        if prefix != none and is-heading {
          // A chapter or section number, in a column of its own so the titles line up.
          box(width: hang, if lvl == 1 {
            label-text(prefix, size: 10.5pt, fill: st-accent-ink, weight: 600)
          } else {
            text(fill: st-muted)[#prefix]
          })
        } else if prefix != none {
          box(width: hang, list-style(prefix))
        }
        if lvl == 1 and is-heading { label-text(it.body(), size: 10.5pt, fill: st-ink, weight: 600) } else { text(fill: st-body)[#it.body()] }
        h(3mm)
        box(width: 1fr, baseline: -2pt, line(length: 100%, stroke: (paint: st-hair, thickness: 0.5pt, dash: "dotted")))
        h(3mm)
        text(size: 9.5pt, fill: st-muted)[#it.page()]
      })
    }))
  }

  // ---- cover page ----------------------------------------------------------
  {
    // Full bleed: the curves leave the page at the sides and the foot.
    set page(header: none, footer: none, margin: 0pt)
    let edge-l = 24mm
    let edge-r = 20mm
    let width = 210mm - edge-l - edge-r
    let edge-t = 18mm

    // The curves at the foot, first, so the type wins where they meet. The draft's SVG (viewBox
    // 1200 × 620) is scaled to cover a strip 118mm high: 228mm wide, centred, bottom-aligned — 9mm of it
    // off each side of the sheet, which is what makes the curves read as passing through rather than
    // fitted in.
    {
      let art-w = 228mm
      let art-h = 117.8mm
      let sx(x) = x / 1200 * art-w
      let sy(y) = y / 620 * art-h
      // The draft's two gradients. The first runs dark → accent → light with the light tone only at the far
      // right (stops at 0 %, 62 % and 100 %, so the pale tone is a corner, not half the page); the second
      // has no light tone at all and carries the lowest band. A gradient cannot be made transparent after
      // the fact, so the stops carry the alpha themselves.
      let across(alpha) = gradient.linear(
        (st-accent-ink.transparentize(alpha), 0%),
        (st-accent.transparentize(alpha), 62%),
        (st-accent.lighten(30%).transparentize(alpha), 100%),
      )
      let across-2(alpha) = gradient.linear(st-accent-ink.transparentize(alpha), st-accent.transparentize(alpha))
      let band(pts, paint) = curve(
        fill: paint,
        curve.move((sx(pts.at(0)), sy(pts.at(1)))),
        curve.cubic((sx(pts.at(2)), sy(pts.at(3))), (sx(pts.at(4)), sy(pts.at(5))), (sx(pts.at(6)), sy(pts.at(7)))),
        curve.cubic((sx(pts.at(8)), sy(pts.at(9))), (sx(pts.at(10)), sy(pts.at(11))), (sx(pts.at(12)), sy(pts.at(13)))),
        curve.line((sx(1200), sy(620))),
        curve.line((sx(0), sy(620))),
        curve.close(),
      )
      let stroke-path(pts, paint, thickness) = curve(
        stroke: (paint: paint, thickness: thickness),
        curve.move((sx(pts.at(0)), sy(pts.at(1)))),
        curve.cubic((sx(pts.at(2)), sy(pts.at(3))), (sx(pts.at(4)), sy(pts.at(5))), (sx(pts.at(6)), sy(pts.at(7)))),
        curve.cubic((sx(pts.at(8)), sy(pts.at(9))), (sx(pts.at(10)), sy(pts.at(11))), (sx(pts.at(12)), sy(pts.at(13)))),
      )
      let c1 = (0, 86, 210, 86, 320, 158, 540, 232, 760, 306, 930, 392, 1200, 432)
      let c2 = (0, 196, 230, 196, 350, 282, 570, 344, 790, 406, 960, 468, 1200, 516)
      let c3 = (0, 312, 250, 312, 390, 398, 630, 448, 870, 498, 1010, 544, 1200, 574)
      let c4 = (0, 142, 220, 142, 335, 218, 555, 288, 775, 358, 945, 430, 1200, 474)
      let c5 = (0, 252, 240, 252, 370, 338, 600, 396, 830, 454, 985, 506, 1200, 546)
      place(bottom + left, dx: (210mm - art-w) / 2, block(width: art-w, height: art-h, {
        place(top + left, band(c1, across(93%)))
        place(top + left, band(c2, across(89%)))
        place(top + left, band(c3, across-2(84%)))
        place(top + left, stroke-path(c1, across(50%), 1.2pt))
        place(top + left, stroke-path(c2, across(55%), 1.2pt))
        place(top + left, stroke-path(c3, across-2(60%), 1.2pt))
        place(top + left, stroke-path(c4, st-accent-ink.transparentize(78%), 0.7pt))
        place(top + left, stroke-path(c5, st-accent-ink.transparentize(80%), 0.7pt))
      }))
    }

    // The logo cards: white, a hairline, rounded — always white, whatever the paper, so a mark on a
    // transparent background sits on the ground it was designed for. The client's on the left, the
    // author's on the right, as in the draft. Nothing is drawn where there is no logo.
    let has-logos = logo != none or client-logo != none
    let card(img) = box(
      width: 48mm, height: 20mm, fill: white, stroke: 0.5pt + st-hair, radius: 1.5mm, inset: 3.5mm,
      align(center + horizon, image(img, height: calc.min(logo-height, 13mm), fit: "contain")),
    )
    if client-logo != none { place(top + left, dx: edge-l, dy: edge-t, card(client-logo)) }
    if logo != none { place(top + right, dx: -edge-r, dy: edge-t, card(logo)) }

    // The kind line: the accent square, the kind of document, a rule the width of the text block. Under
    // the cards when there are any; at the top margin when there are none. Nothing else moves with it.
    place(top + left, dx: edge-l, dy: if has-logos { 48mm } else { edge-t }, block(width: width)[
      #set text(font: heading-font, size: 10pt, weight: 600, fill: st-ink)
      // The square sits on the baseline and reaches the cap height, as the draft's 9px inline block does
      // beside 10pt type — an inline-block with nothing in it stands on the baseline.
      #box(width: 2.4mm, height: 2.4mm, fill: st-accent, radius: 0.5mm, baseline: 0pt)
      #h(1.6mm)
      #if kind != none { kind } else { hide[.] }
      // The same rule as the running header on every page after this one — same hairline, same distance
      // under the text. The draft's heavier ink rule looked heavy on paper.
      #v(2.5mm, weak: true)
      #line(length: 100%, stroke: 0.5pt + st-hair)
    ])

    // Title and subtitle. 43pt for a title of two lines; a long title steps down so it still stops
    // above the details, which do not move. The character count is a proxy for the line count, and a
    // conservative one: at 43pt about 32 characters fit a line.
    let title-size = if type(title) != str { 43pt } else if title.clusters().len() > 96 { 26pt } else if title.clusters().len() > 64 { 32pt } else { 43pt }
    place(top + left, dx: edge-l, dy: 74mm, block(width: 210mm - edge-l - 30mm)[
      #block[
        #set text(font: heading-font, size: title-size, weight: 600, fill: st-ink, tracking: -0.022em)
        #set par(leading: 0.28em)
        #title
      ]
      #if subtitle != none {
        block(above: 7mm, width: 118mm)[
          #set text(size: 14.5pt, fill: st-accent-ink)
          #set par(leading: 0.5em)
          #subtitle
        ]
      }
    ])

    // The study's details in a row at 150mm, over a hairline: label in the label face, value in the
    // reading face. `auto` columns, so a short date closes up and a long institute name takes the room
    // it needs — Typst shrinks auto columns when their total exceeds the block, so a long value wraps
    // instead of running off the page.
    if meta.len() > 0 {
      place(top + left, dx: edge-l, dy: 150mm, block(width: width)[
        #line(length: 100%, stroke: 0.5pt + st-hair)
        #v(5mm, weak: true)
        #grid(
          columns: meta.map(_ => auto),
          align: top + left,
          column-gutter: 8mm,
          ..meta.map(((label, value)) => [
            #label-text(label, size: 8.5pt, fill: st-muted, weight: 500)
            #v(1.5mm, weak: true)
            #text(size: 11pt, fill: st-ink)[#value]
          ])
        )
      ])
    }
    pagebreak()
  }

  body
}

/// Contents, figures and tables. All three are native to Typst, which also localises their titles
/// from `text(lang:)`.
#let lca-outlines(contents: true, figures: true, tables: true) = {
  // `indent: none`: the entry show rule above does its own indenting, per level and only when there is a
  // number to indent under.
  if contents { outline(indent: 0pt) }
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
      outline(title: none, indent: 0pt, target: figure.where(kind: image))
    }
    if tables and query(figure.where(kind: table)).len() > 0 {
      heading(level: 1, numbering: none, lot)
      outline(title: none, indent: 0pt, target: figure.where(kind: table))
    }
  }
  if contents or figures or tables { pagebreak(weak: true) }
}

/// Key/value block — used for goal & scope and study metadata. The label in the label face, the value in
/// the reading face, which is the pairing the cover's meta row uses.
#let lca-kv(pairs) = block(above: 6pt, below: 12pt)[
  #table(
    columns: (34%, 1fr),
    stroke: (x, y) => (bottom: 0.4pt + prism-line.transparentize(40%), top: 0pt, left: 0pt, right: 0pt),
    align: top + left,
    inset: (x: 0pt, y: 5pt),
    ..pairs
      .map(p => (
        [#text(font: "Instrument Sans", size: 8.8pt, weight: 600, fill: prism-ink)[#p.at(0)]],
        [#text(fill: prism-ink)[#p.at(1)]],
      ))
      .flatten()
  )
]

/// Data table. `align-right` lists the column indices that hold numbers.
#let lca-table(headers, rows, caption: none, align-right: (), label-name: none) = {
  let head = headers.map(h => [
    #text(font: "Instrument Sans", size: 8.8pt, weight: 600, fill: prism-ink)[#h]
  ])
  let body-cells = rows
    .map(r => r
      .enumerate()
      .map(((i, c)) => if align-right.contains(i) { align(right)[#text(fill: prism-ink)[#c]] } else { [#text(fill: prism-ink)[#c]] }))
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
    // The draft's table: a firm rule under the head in the accent's ink, a hairline under every row,
    // no vertical rules, and every second data row on a whisper of the accent.
    fill: (x, y) => if y > 0 and calc.rem(y, 2) == 0 { prism-green.lighten(90%) } else { none },
    stroke: (x, y) => (
      top: if y == 0 { 0pt } else if y == 1 { 1.2pt + prism-green.darken(38%) } else { 0.4pt + prism-line.transparentize(50%) },
      bottom: if y == 0 { 0pt } else { 0.4pt + prism-line.transparentize(50%) },
      left: 0pt, right: 0pt,
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
