// Report template — Serif and rule.
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
// THE DESIGN, from the HTML draft `study-cover-draft-A.html` ("Measured").
//
// The quiet one. White paper, a serif title, and a measuring rule under the subtitle — a scale with a tick
// every five millimetres and one accent mark at its origin, which is the whole signature: this is a document
// that measures things. The study's details stand in columns above the foot, and an accent bar runs along the
// bottom edge of every page, so the cover and the pages after it are recognisably one document.
//
// Serif for what is spoken (title, chapter headings, the page number), sans for what is read, and the small
// uppercase label in the accent for everything that names a thing — a column, a table, a section.
//
// Not taken from the draft, on purpose:
//   - Nothing about the type. The serif *is* Source Serif 4 (Adobe, OFL 1.1) since it ships with the app:
//     the draft embedded it as a 42 kB subset, which would have printed holes wherever a report reaches past
//     Western European text, so the family was fetched whole from Adobe's own release — see
//     `assets/fonts/NOTICE.md`.
//   - The English eyebrow ("Study") over the title. A template cannot know the report's language — every
//     label that reaches a cover comes from the assembler, already translated — so a hardcoded word would
//     print English on a German report. A short accent rule holds that place instead, as in Network.
//   - The footer's "Institute Name · July 2026". The template receives the study details as a list of
//     already-translated (label, value) pairs and cannot tell which pair is the organisation; guessing at one
//     would print the commissioner's name under half the reports. The page number stands there alone.
//   - The draft's `--petrol` for small type. The accent comes from the report's colour set, and a set may
//     lead with a lime — readable as a rule, not as 7pt uppercase on white. Small type takes a darkened
//     accent (see the tone block), rules and bars take the accent itself.
// ---------------------------------------------------------------------------------------------------

// The colours come from the report's colour set, written by PrismLCA beside this file. One choice
// reaches every theme: a theme decides the layout, a palette decides the colour.
// A theme of your own may import this too, or declare its own colours and ignore it.
#import "palette.typ": *

// ---- tone -------------------------------------------------------------------------------------------
#let m-paper = paper
#let m-ink = prism-ink
#let m-muted = prism-text
#let m-hair = prism-line
#let m-tint = prism-muted
#let m-accent = prism-green
// The accent as small type. Every set's accent works as a 2mm rule; not every set's works at 7pt on white —
// the PrismLCA set leads with a lime. Darkened once here rather than in each of the eight places that set a
// label, a caption prefix or a page number.
#let m-accent-ink = prism-green.darken(28%)
// Prose is the ink, not the secondary grey: this design puts one column of dense technical text on a page,
// and that column is the thing being read. The draft says the same with its `#243038`.
#let m-body = prism-ink

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
  // This cover is a composition of type and rules, so an uploaded picture has nowhere to go: accepted and
  // ignored, as in the other designed covers. The UI reads that from the registry and says so beside the
  // upload control instead of taking a file that then goes nowhere.
  cover-image: none,
  lang: "en",
  body-font: "Noto Sans",
  // The draft's own serif, bundled. Libertinus Serif (embedded in the compiler) stood in
  // for it before and is still a one-word swap for anyone editing this theme.
  heading-font: "Source Serif 4",
  mono-font: "DejaVu Sans Mono",
  body,
) = {
  set document(title: title, author: if author == none { () } else { (author,) })
  set text(font: body-font, size: 10pt, fill: m-body, lang: lang)
  // The draft's 1.7 line-height. Prose at 10pt with this much air is what makes a dense technical page
  // readable; it costs about a page in twenty, which a report can afford.
  set par(leading: 0.72em, spacing: 1.05em)
  show raw: set text(font: mono-font, size: 8.5pt, fill: m-ink)
  show strong: set text(fill: m-ink, weight: 600)
  show emph: set text(style: "italic")

  // Long tables must break across pages: a Typst figure is unbreakable by default, so a 25-row inventory
  // table ran off the bottom and drew its caption over the last rows. Tables only — an image cannot split.
  show figure.where(kind: table): set block(breakable: true)
  // A table or a chart is not a paragraph: it is a thing the prose refers to, and with a paragraph's gap it
  // reads as belonging to whichever paragraph it touches.
  show figure: set block(above: 18pt, below: 18pt)

  // The small label, in the accent and in the reading face: the running header, the table heads, the
  // key/value labels, the caption prefix, the meta columns. One function so they cannot drift apart.
  let tag(it, size: 7pt, fill: m-accent-ink, weight: 600, tracking: 0.16em) = text(
    size: size, weight: weight, fill: fill, tracking: tracking,
  )[#upper[#it]]

  // The measuring rule: a hairline with a tick every 5mm and the accent mark at its origin. `w` is an
  // absolute length because the ticks are counted, not repeated by a gradient.
  let scale-rule(w) = box(width: w, height: 8mm)[
    #place(top + left, line(length: w, stroke: 0.4mm + m-ink))
    #for i in range(int(w / 5mm) + 1) {
      place(top + left, dx: i * 5mm, dy: 0.4mm,
        line(start: (0mm, 0mm), end: (0mm, 3mm), stroke: 0.25mm + m-hair))
    }
    #place(top + left, rect(width: 0.7mm, height: 7mm, fill: m-accent, stroke: none))
  ]

  set page(
    paper: "a4",
    fill: m-paper,
    // The draft's asymmetric margins: more on the left, where the chapter numbers hang. 2.5cm at the top
    // against 2.0 before: the run-head's hairline sat on the first line of text. `header-ascent` is
    // what actually opens that gap — the header is laid out inside the top margin, and the ascent is the
    // distance from its foot down to where the body begins.
    margin: (top: 2.5cm, bottom: 2.2cm, left: 2.4cm, right: 2.0cm),
    header-ascent: 8mm,
    // The accent bar along the bottom edge, on every page including the cover — the one thing that says
    // the pages after the cover belong to it. In the background, so it survives a full-bleed cover.
    background: place(bottom + left, rect(width: 100%, height: 3mm, fill: m-accent)),
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
          align(left, tag(title, fill: m-muted)),
          align(right, if current != none { tag(current, fill: m-muted) }),
        )
        v(-3pt)
        line(length: 100%, stroke: 0.25mm + m-hair)
      }
    },
    // The page number in the serif, in the accent, where the draft puts it. Alone: the draft's second line
    // there names the institute, which this template has no way to know (see the header comment).
    footer: context {
      if counter(page).get().first() > 1 {
        align(right)[
          #text(font: heading-font, size: 12pt, fill: m-accent-ink)[#counter(page).display()]
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
  // The draft's chapter opening: the number in the serif accent, hanging beside the title in the same size.
  show heading.where(level: 1): it => {
    pagebreak(weak: true)
    block(above: 0pt, below: 18pt)[
      #set text(font: heading-font, size: 19pt, weight: 400, fill: m-ink)
      #set par(leading: 0.5em)
      // Only numbered chapters hang a number — and only they get the number column. The outline's
      // own "Contents" heading and the figure/table lists have `numbering: none`; displaying the
      // counter anyway printed a bare "0", and keeping the empty 10 mm column
      // left their titles indented as if a number stood there. So an unnumbered
      // chapter is set flush left, without the grid.
      #if it.numbering == none { it.body } else {
        grid(
          columns: (10mm, 1fr),
          align: left + top,
          text(fill: m-accent-ink)[#counter(heading).display()],
          it.body,
        )
      }
    ]
  }
  // A section: the same serif, quieter, and without the hanging number — the draft has one heading level
  // under the chapter and sets it in type, not in a number.
  show heading.where(level: 2): it => block(above: 20pt, below: 11pt)[
    #set text(font: heading-font, size: 13.5pt, weight: 400, fill: m-ink)
    #it
  ]
  // The draft's `h3`: the small uppercase label, promoted to a heading. It names what follows rather than
  // announcing it, which is what a sub-section does in a technical report. Without its number, as in the
  // draft — and because a chapter that goes straight from level 1 to level 3, which ours do, would have
  // Typst print "1.0.1" here.
  show heading.where(level: 3): it => block(above: 16pt, below: 10pt)[
    #tag(it.body, size: 8pt, tracking: 0.18em)
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
    #set text(size: 8.5pt, fill: m-muted)
    #tag([#it.supplement #context it.counter.display(it.numbering)], size: 7pt)
    #h(4pt)
    #it.body
  ]

  // ---- cover page ----------------------------------------------------------
  {
    set page(header: none, footer: none, margin: 0pt)
    let edge-l = 24mm // the draft's cover padding: 24 left, 20 right, 22 top
    let edge-r = 20mm

    // The two logos at the top corners — the author's mark left, the client's right. The draft has dashed
    // placeholders there; these are the real thing, and nothing is drawn where there is no logo.
    if logo != none {
      place(top + left, dx: edge-l, dy: 22mm, image(logo, height: logo-height))
    }
    if client-logo != none {
      place(top + right, dx: -edge-r, dy: 22mm, image(client-logo, height: logo-height))
    }

    // Title, rule and details are one stack, bottom-aligned — the draft's flex column with a spacer above
    // the title. So the measuring rule sits where it belongs, directly over the columns it measures, and a
    // long title grows upward into the white instead of pushing the details off the page.
    place(bottom + left, dx: edge-l, dy: -24mm, block(width: 210mm - edge-l - edge-r)[
      // The draft's eyebrow, in the report's own language, over the short accent rule.
      #if kind != none {
        tag(kind, size: 8pt, tracking: 0.24em)
        v(3mm)
      }
      #line(length: 14mm, stroke: 1.6mm + m-accent)
      #v(9mm)
      #block(width: 150mm)[
        #set text(font: heading-font, size: 32pt, weight: 400, fill: m-ink)
        #set par(leading: 0.34em)
        #title
      ]
      #if subtitle != none {
        block(above: 7mm, width: 135mm)[
          #set text(size: 12pt, fill: m-muted)
          #set par(leading: 0.62em)
          #subtitle
        ]
      }
      #v(12mm)
      #scale-rule(150mm)
      #if meta.len() > 0 {
        block(above: 7mm)[
          #grid(
            // `auto`, not equal shares: a fixed share puts a two-word name in a 55mm column and leaves a
            // hand's width of nothing before the next label. Typst shrinks auto columns when their total
            // exceeds the block, so a long institute name wraps instead of running off the page.
            columns: (auto, auto, auto, auto),
            // `top`, spelled out: a grid centres its cells, so one wrapped value would drop the labels
            // beside it to its middle — and the labels are the line a reader scans across.
            align: top + left,
            row-gutter: 7mm,
            column-gutter: 9mm,
            ..meta.map(((label, value)) => [
              #tag(label, size: 7pt, tracking: 0.2em)
              #linebreak()
              #text(size: 9.5pt, fill: m-ink)[#value]
            ])
          )
        ]
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
/// reading face: the same pairing the cover's meta columns use.
#let lca-kv(pairs) = block(above: 6pt, below: 12pt)[
  #table(
    columns: (34%, 1fr),
    stroke: none,
    align: top + left,
    inset: (x: 0pt, y: 5pt),
    ..pairs
      .map(p => (
        [#text(size: 7pt, weight: 600, fill: m-accent-ink, tracking: 0.16em)[#upper[#p.at(0)]]],
        [#text(fill: m-ink)[#p.at(1)]],
      ))
      .flatten()
  )
]

/// Data table. `align-right` lists the column indices that hold numbers.
#let lca-table(headers, rows, caption: none, align-right: (), label-name: none) = {
  let head = headers.map(h => [
    #text(size: 7pt, weight: 600, fill: m-muted, tracking: 0.14em)[#upper[#h]]
  ])
  let body-cells = rows
    .map(r => r
      .enumerate()
      .map(((i, c)) => if align-right.contains(i) { align(right)[#text(fill: m-ink)[#c]] } else { [#text(fill: m-ink)[#c]] }))
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
    // The draft's table: no vertical rules, no fill, a firm rule under the head and a hairline between
    // rows. What lets a long inventory table stay quiet.
    stroke: (x, y) => (
      top: if y == 0 { 0pt } else if y == 1 { 0.4mm + m-ink } else { 0.2mm + m-hair },
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
