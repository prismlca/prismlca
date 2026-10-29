// Report template — Panel and year.
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
// THE DESIGN, from the HTML draft `study-cover-draft-B.html` ("Field").
//
// The loud one, and the counterpart to Serif and rule: no serif, no hairlines, one hard horizontal edge.
// The upper two thirds are white and carry a title set as large as it will go — bold, uppercase, tight. Under
// it the page turns over into a block of the set's deep tone that holds the study's details, with the year of
// the study cut out of it as an outline big enough to leave the page. Inside, the same contrast: a thick
// accent rule under the running header, a filled table head, and the page number in a dark square.
//
// The year is read out of the study details (the assembler passes the date as one of the translated pairs)
// and drawn only when there is one to draw — a cover that invents a year is worse than a cover without one.
//
// Not taken from the draft, on purpose:
//   - Nothing about the type. The display face *is* Noto Sans CondensedBold since it ships with the app —
//     one file from the same Noto release as the prose faces, same version, same licence. The draft embedded
//     it as a 42 kB subset with its name table flattened to "Noto Sans / Regular"; only the width class gave
//     it away. Fetched whole instead, see `assets/fonts/NOTICE.md`.
//   - The English eyebrow ("Study") over the title, and "Chapter n" over the headings. A template cannot know
//     the report's language — every label that reaches a cover comes from the assembler, already translated —
//     so a hardcoded word would print English on a German report. The draft's accent underline holds the
//     eyebrow's place on the cover, and inside, the chapter's own number does.
//   - The draft's two greens (`--sap` on the panel, `--olive` on white). A colour set names one accent, so
//     the second is derived here: the accent itself on the dark panel, a darkened one for small type on
//     white. Doing it the other way round — one colour for both — either dims the panel or makes 7pt lime
//     unreadable, depending on the set.
//   - The zebra fill under the table body. It reads well over eight rows and turns a 25-row annex table into
//     a barcode; the row hairline does the same work at any length.
// ---------------------------------------------------------------------------------------------------

// The colours come from the report's colour set, written by PrismLCA beside this file. One choice
// reaches every theme: a theme decides the layout, a palette decides the colour.
// A theme of your own may import this too, or declare its own colours and ignore it.
#import "palette.typ": *

// ---- tone -------------------------------------------------------------------------------------------
#let f-paper = paper
#let f-ink = prism-ink
#let f-muted = prism-text
#let f-gray = prism-gray
#let f-hair = prism-line
#let f-tint = prism-muted
// The panel: the set's deep tone. It is the one surface in this design, and "deep" is what that name is for.
#let f-panel = prism-navy
#let f-accent = prism-green
// The accent as small type on white. Every set's accent works as a 1mm rule; not every set's works at 7pt
// on paper — the PrismLCA set leads with a lime. Darkened once here rather than in each place that sets a
// label, a kicker or a caption prefix.
#let f-accent-ink = prism-green.darken(30%)
// And as small type on the panel, where the same colour has to come the other way: a set that leads with a
// deep teal is nearly invisible on its own deep tone.
#let f-accent-lit = prism-green.lighten(30%)
// Prose is the ink: this design puts one column of dense technical text on a page and that column is the
// thing being read. The draft says the same with its `#2b3a35`.
#let f-body = prism-ink

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
  // What the document is, translated and passed in by the assembler ("LCA report", "Ökobilanzbericht", …).
  // The draft's eyebrow said "Study" in English; this is that slot, in the report's own language. `none`
  // prints nothing, which is what an older report or a theme of your own gets.
  kind: none,
  logo: none,
  // The client's mark, printed opposite the author's at the same height. `none` leaves that side empty.
  client-logo: none,
  //: Height of BOTH logos. One number on purpose.
  logo-height: 9.6mm,
  // This cover is a composition of type and one colour field, so an uploaded picture has nowhere to go:
  // accepted and ignored, as in the other designed covers. The UI reads that from the registry and says so
  // beside the upload control instead of taking a file that then goes nowhere.
  cover-image: none,
  lang: "en",
  body-font: "Noto Sans",
  // Also "Noto Sans" — the width is asked for separately, in `display` below. Naming the file's full name
  // ("Noto Sans Condensed") finds nothing: a font's family, as far as Typst is concerned, is its
  // *typographic* family (name ID 16), and for the condensed cut that is "Noto Sans" with a width class of
  // its own. Getting that wrong is silent — the compiler falls back to a face that exists and the title
  // prints in a serif — which is why `test_every_theme_asks_for_a_font_it_can_actually_get` exists.
  heading-font: "Noto Sans",
  mono-font: "JetBrains Mono",
  body,
) = {
  set document(title: title, author: if author == none { () } else { (author,) })
  set text(font: body-font, size: 10pt, fill: f-body, lang: lang)
  // The draft's 1.62 line-height.
  set par(leading: 0.66em, spacing: 1.0em)
  show raw: set text(font: mono-font, size: 8.5pt, fill: f-ink)
  show strong: set text(fill: f-ink, weight: 600)
  show emph: set text(style: "italic")

  // Long tables must break across pages: a Typst figure is unbreakable by default, so a 25-row inventory
  // table ran off the bottom and drew its caption over the last rows. Tables only — an image cannot split.
  show figure.where(kind: table): set block(breakable: true)
  // A table or a chart is not a paragraph: it is a thing the prose refers to, and with a paragraph's gap it
  // reads as belonging to whichever paragraph it touches.
  show figure: set block(above: 18pt, below: 18pt)

  // The small label: the running header, the table heads, the key/value labels, the caption prefix, the
  // kicker over a heading. One function so they cannot drift apart.
  let tag(it, size: 7pt, fill: f-accent-ink, weight: 600, tracking: 0.18em) = text(
    size: size, weight: weight, fill: fill, tracking: tracking,
  )[#upper[#it]]

  // The display face: the draft's condensed, bold, uppercase and tight. `stretch` is what picks the
  // condensed cut — 75% is the OS/2 width class the file carries (3 of 9).
  let display(it, size: 21pt, fill: f-ink, leading: 0.16em) = block[
    #set text(font: heading-font, stretch: 75%, size: size, weight: 700, fill: fill, tracking: -0.01em)
    #set par(leading: leading)
    #upper[#it]
  ]

  set page(
    paper: "a4",
    fill: f-paper,
    // 2.6cm at the top and the bottom, against 2.0 before: the run-head's accent rule sat on the
    // first line of text, and the page number's square sat under the last one. `header-ascent` is what
    // actually opens the gap under the rule — the header is laid out inside the top margin, and the ascent
    // is the distance from its foot down to where the body begins.
    margin: (top: 2.6cm, bottom: 2.6cm, left: 2.0cm, right: 2.0cm),
    header-ascent: 9mm,
    footer-descent: 10mm,
    header: context {
      // No running header on the cover page.
      if counter(page).get().first() > 1 {
        // Left the study, right the chapter this page belongs to — the draft's two run-head slots.
        //
        // The last chapter that *starts on or before this page*, not `.before(here())`: a header is laid out
        // at the top of its page, before the body under it exists, so on the page where a chapter opens the
        // query saw the previous chapter — every chapter's first page carried the one before it in its head.
        let n = counter(page).get().first()
        let current = none
        for h in query(heading.where(level: 1)) {
          if h.location().page() <= n { current = h.body }
        }
        grid(
          columns: (1fr, auto),
          // Both cells from the top: a long study title wraps to two lines in a 7pt head, and a
          // horizon-aligned grid then dropped the chapter beside it onto the second one.
          align: top,
          align(left, tag(title, fill: f-ink)),
          align(right, if current != none { tag(current, fill: f-gray) }),
        )
        v(-2pt)
        // The draft's thick accent rule, which is what makes this run-head part of the design rather than a
        // line of small caps above the text.
        line(length: 100%, stroke: 1mm + f-accent)
      }
    },
    // The page number in a filled square, as in the draft. Alone: the draft's second line there names the
    // institute, and the template receives the study details as translated pairs with no way to tell which
    // pair that is — guessing would print the commissioner under half the reports.
    footer: context {
      if counter(page).get().first() > 1 {
        align(right)[
          #box(width: 11mm, height: 11mm, fill: f-panel)[
            #align(center + horizon)[
              #text(size: 10pt, weight: 600, fill: f-paper)[#counter(page).display()]
            ]
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
  // A chapter: the number in front of the title rather than over it, in the accent — so the number
  // is read as part of the line it belongs to instead of as a label above it. An inner `text(fill:)` beats
  // the `set text` inside `display`, which is what lets one line carry two colours.
  show heading.where(level: 1): it => {
    pagebreak(weak: true)
    block(above: 0pt, below: 18pt)[
      // The number only where the heading HAS one: the outline's "Contents" carries
      // `numbering: none`, and displaying the counter anyway put a bare "0" in front of it.
      #if it.numbering != none {
        display([#text(fill: f-accent-ink)[#counter(heading).display()]#h(0.42em)#it.body], size: 21pt)
      } else {
        display(it.body, size: 21pt)
      }
    ]
  }
  show heading.where(level: 2): it => block(above: 20pt, below: 11pt)[
    #display(it, size: 14pt)
  ]
  // The draft's `h3`: the small uppercase label, promoted to a heading. It names what follows rather than
  // announcing it, which is what a sub-section does in a technical report. Without its number, as in the
  // draft — and because a chapter that goes straight from level 1 to level 3, which ours do, would have
  // Typst print "1.0.1" here.
  show heading.where(level: 3): it => block(above: 16pt, below: 10pt)[
    #tag(it.body, size: 8pt)
  ]

  // Captions above their table, as in the draft, and below a figure, where a picture wants its legend.
  // Numbered per kind, so #ref() works from the prose.
  show figure.where(kind: table): set figure.caption(position: top)
  // …and stays on the page its table starts on: a caption left alone at the foot of a page, its table on
  // the next, reads as a heading over nothing. Sticky, it goes along with the table.
  show figure.where(kind: table): it => {
    show figure.caption: c => block(sticky: true, width: 100%, c)
    it
  }
  show figure.caption: it => align(left)[
    #set text(size: 8.5pt, fill: f-muted)
    #tag([#it.supplement #context it.counter.display(it.numbering)], size: 7pt)
    #h(4pt)
    #it.body
  ]

  // ---- cover page ----------------------------------------------------------
  {
    set page(header: none, footer: none, margin: 0pt)
    let edge = 20mm

    // The year, out of the study's own details: the last four-digit number in any of the values. Drawn only
    // when one is there — on a report with no date the panel simply holds its columns.
    let year = {
      let hits = ()
      for pair in meta { hits += str(pair.at(1)).matches(regex("(?:19|20)\d{2}")) }
      if hits.len() > 0 { hits.last().text } else { none }
    }

    // The two logos at the top corners — the author's mark left, the client's right, the same way round as
    // every other theme. The draft has dashed placeholders there; these are the real thing, and nothing is
    // drawn where there is no logo.
    if logo != none {
      place(top + left, dx: edge, dy: 20mm, image(logo, height: logo-height))
    }
    if client-logo != none {
      place(top + right, dx: -edge, dy: 20mm, image(client-logo, height: logo-height))
    }

    // The title zone, in the white upper two thirds.
    place(top + left, dx: edge, dy: 62mm, block(width: 210mm - 2 * edge)[
      // The draft's eyebrow and the thick accent rule under it.
      #if kind != none {
        tag(kind, size: 8pt, fill: f-ink, tracking: 0.22em)
        v(2.5mm)
      }
      #line(length: 16mm, stroke: 1mm + f-accent)
      #v(9mm)
      #block(width: 160mm)[
        #display(title, size: 40pt, leading: 0.1em)
      ]
      #if subtitle != none {
        block(above: 9mm, width: 130mm)[
          #set text(size: 12.5pt, fill: f-gray)
          #set par(leading: 0.6em)
          #subtitle
        ]
      }
    ])

    // The panel: the lower band of the page, with the year cut out of it and the details on top.
    place(bottom + left, block(width: 210mm, height: 68mm, fill: f-panel, clip: true)[
      #if year != none {
        // Outlined, not filled: the draft's `-webkit-text-stroke` on a transparent fill. It runs off the
        // corner on purpose — `clip` on the block is what cuts it. Placed from the panel's top edge, because
        // `dy` runs downward: from the bottom, 150pt of numeral ended up almost entirely under the page.
        place(top + right, dx: 20mm, dy: 24mm)[
          #text(font: heading-font, size: 150pt, weight: 700, tracking: -0.02em,
                fill: rgb(0, 0, 0, 0), stroke: 0.5mm + f-accent.transparentize(62%))[#year]
        ]
      }
      #if meta.len() > 0 {
        place(top + left, dx: edge, dy: 16mm, block(width: 210mm - 2 * edge)[
          #grid(
            // `auto`, not equal shares: a fixed share puts a two-word name in a 55mm column and leaves a
            // hand's width of nothing before the next label. Typst shrinks auto columns when their total
            // exceeds the block, so a long institute name wraps instead of running off the page.
            columns: (auto, auto, auto, auto),
            // `top`, spelled out: a grid centres its cells, so one wrapped value would drop the labels
            // beside it to its middle — and the labels are the line a reader scans across.
            align: top + left,
            row-gutter: 8mm,
            column-gutter: 10mm,
            ..meta.map(((label, value)) => [
              // The draft's hairline over each label, in the paper colour at a whisper.
              #line(length: 100%, stroke: 0.3mm + f-paper.transparentize(72%))
              #v(1.6mm)
              #tag(label, size: 7pt, fill: f-accent-lit, tracking: 0.2em)
              #linebreak()
              #text(size: 9.5pt, fill: f-paper)[#value]
            ])
          )
        ])
      }
    ])
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

/// Key/value block — used for goal & scope and study metadata. The label in the accent, the value in the
/// reading face: the same pairing the cover's panel uses.
#let lca-kv(pairs) = block(above: 6pt, below: 12pt)[
  #table(
    columns: (34%, 1fr),
    stroke: none,
    align: top + left,
    inset: (x: 0pt, y: 5pt),
    ..pairs
      .map(p => (
        [#text(size: 7pt, weight: 600, fill: f-accent-ink, tracking: 0.18em)[#upper[#p.at(0)]]],
        [#text(fill: f-ink)[#p.at(1)]],
      ))
      .flatten()
  )
]

/// Data table. `align-right` lists the column indices that hold numbers.
#let lca-table(headers, rows, caption: none, align-right: (), label-name: none) = {
  let head = headers.map(h => [
    #text(size: 7pt, weight: 600, fill: paper, tracking: 0.14em)[#upper[#h]]
  ])
  let body-cells = rows
    .map(r => r
      .enumerate()
      .map(((i, c)) => if align-right.contains(i) { align(right)[#text(fill: f-ink)[#c]] } else { [#text(fill: f-ink)[#c]] }))
    .flatten()
  // Column widths from what the columns actually hold, not from a fixed text-or-number split. The square
  // root of the mean length, not the length itself — text wraps, so a column with ten times the characters
  // needs roughly three times the width. Clamped at both ends so one very long cell cannot starve its
  // neighbours, and a numeric column is capped: figures are short and do not wrap.
  let len-of(c) = if type(c) == str { c.clusters().len() } else { 12 }
  let width-of(i) = {
    let cells = rows.map(r => len-of(r.at(i, default: "")))
    let mean = if cells.len() == 0 { 0 } else { cells.sum() / cells.len() }
    let m = calc.max(calc.min(calc.max(mean, len-of(headers.at(i)) * 0.8), 64), 3)
    let w = calc.sqrt(m)
    if align-right.contains(i) { calc.min(w, 2.6) } else { w }
  }
  let tbl = table(
    // Fractions, never `auto`: `auto` sizes a column to its content, so a header carrying a full ecoinvent
    // method path made the table wider than the text block.
    columns: range(headers.len()).map(i => width-of(i) * 1fr),
    align: left,
    // The draft's filled head, and a hairline between body rows (its zebra fill does not survive a 25-row
    // annex table — see the header).
    fill: (x, y) => if y == 0 { f-panel } else { none },
    stroke: (x, y) => (
      top: if y <= 1 { 0pt } else { 0.2mm + f-hair },
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
