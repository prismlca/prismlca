// Report template — Planes.
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
// THE DESIGN, from an HTML draft.
//
// The cover is a few large planes of flat colour on warm paper, set off-balance: a slanted field rising from
// the left, a great disc cut by the right edge, and a dark arc closing the foot, where the slanted field
// shows through in a tone of its own. Above them the title in a large, light-weight sans, the subtitle in a
// serif; on the dark arc the study's details in white. The pages after it pair the same two faces — Libre
// Franklin for everything that labels, Libre Baskerville for everything that is read — under a running
// head with a rule in three of the cover's colours.
//
// FOUR TONES FROM THREE. The draft's planes are a sage, an apricot, a dark ink and the sage seen through
// the ink. They come from the colour set: the deep tone is the arc, a quiet light tint of the accent the
// slanted field, a soft tint of the mark the disc, and the field under the arc the two mixed. Tints and a
// mix rather than the set's colours themselves, because planes this large in full strength would shout —
// the draft's are all soft but one.
//
// Not taken from the draft, on purpose:
//   - The organisation's name at the top left: no report field is the organisation alone, and the details
//     at the foot carry it. The kind of document stands there instead.
//   - The bar chart drawn in CSS and the lead paragraph: a figure comes in as a picture the renderer drew,
//     and no block says "this paragraph opens the chapter".
// ---------------------------------------------------------------------------------------------------

// The colours come from the report's colour set, written by PrismLCA beside this file. One choice
// reaches every theme: a theme decides the layout, a palette decides the colour.
// A theme of your own may import this too, or declare its own colours and ignore it.
#import "palette.typ": *

// ---- colour helpers -----------------------------------------------------------------------------------
// The same helpers as the Gradient strip, Ribbons and Flows themes: a theme is one file, so it carries
// its own copy.

// A colour as OKLCH floats: lightness 0–1, chroma, hue in degrees.
#let _lch(c) = {
  let (l, ch, h) = c.oklch().components(alpha: false)
  (l / 100%, ch, h.deg())
}
#let _wrap(h) = calc.rem(calc.rem(h, 360) + 360, 360)
// The signed shortest turn from hue a to hue b, in degrees.
#let _turn(a, b) = calc.rem(b - a + 540, 360) - 180
#let _in-band(h, lo, hi) = { let h = _wrap(h); h >= lo and h <= hi }
#let _lerp(a, b, t) = a + (b - a) * t
#let _clamp(x, lo, hi) = calc.max(lo, calc.min(x, hi))
// Whether an OKLCH colour lies inside sRGB, by the OKLab matrices of CSS Color Module Level 4.
#let _in-gamut(l, c, h) = {
  let a = c * calc.cos(h * 1deg)
  let b = c * calc.sin(h * 1deg)
  let l3 = calc.pow(l + 0.3963377774 * a + 0.2158037573 * b, 3)
  let m3 = calc.pow(l - 0.1055613458 * a - 0.0638541728 * b, 3)
  let s3 = calc.pow(l - 0.0894841775 * a - 1.2914855480 * b, 3)
  let r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
  let g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
  let bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3
  let e = 0.0005
  r >= -e and r <= 1 + e and g >= -e and g <= 1 + e and bl >= -e and bl <= 1 + e
}
// The colour at (l, c, h), its chroma reduced until it prints. Clipping the channels instead would bend
// the hue, and a ramp that bends at its brightest point no longer reads as one.
#let _fit(l, c, h) = {
  let h = _wrap(h)
  if _in-gamut(l, c, h) { return oklch(l * 100%, c, h * 1deg) }
  let lo = 0.0
  let hi = c
  for _ in range(14) {
    let mid = (lo + hi) / 2
    if _in-gamut(l, mid, h) { lo = mid } else { hi = mid }
  }
  oklch(l * 100%, lo, h * 1deg)
}

// ---- the planes ------------------------------------------------------------------------------------
// The arc: the deep tone itself.
#let pl-arc = prism-navy
// The slanted field: a light, quiet tint of the accent — the draft's sage is a teal almost greyed out.
#let pl-field = {
  let (_, c, h) = _lch(prism-green)
  _fit(0.8, calc.min(c * 0.45, 0.06), h)
}
// The disc: a soft tint of the mark. Kept out of khaki: a mustard at this lightness reads as dust, so a mark
// in the yellows (70–112 degrees) goes up to a butter instead.
#let pl-disc = {
  let (l, c, h) = _lch(prism-accent2)
  let l = _clamp(l, 0.72, 0.8)
  if _in-band(h, 70, 112) { l = 0.85 }
  _fit(l, calc.min(c, 0.11), h)
}
// Where the field runs under the arc: the two mixed, a tone between them that reads as the field in shadow.
#let pl-under = color.mix((pl-field, 45%), (pl-arc, 55%), space: oklab)
// The study's details stand on the arc and on the field under it: white, unless a deep tone picked by hand
// is light enough that white would vanish on either.
#let pl-on-arc = if calc.max(_lch(pl-arc).at(0), _lch(pl-under).at(0)) > 0.66 { prism-ink } else { white }

// ---- colour -----------------------------------------------------------------------------------------
// The deep tone carries the type: the title, the headings, the first column of a table.
#let pl-deep = prism-navy
// The accent as small type — the eyebrows, the labels: held at or below a middle lightness.
#let pl-label = {
  let (l, c, h) = _lch(prism-green)
  _fit(calc.min(l, 0.5), c, h)
}
// Neutrals, as the set defines them.
#let pl-ink = prism-ink
#let pl-muted = prism-text
#let pl-hair = prism-line
// The cover sits on the set's paper; the pages after it a step lighter, as the draft sets them.
#let pl-paper = paper
#let pl-page = paper.mix((white, 55%))
// Prose: between the set's ink and its text grey.
#let pl-body = prism-ink.mix((prism-text, 45%))
// The head of a table and every second row: the page, a shade toward the field.
#let pl-tint = pl-page.mix((pl-field, 35%))

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
  // Printed at the top left of the cover. `none` prints nothing there.
  kind: none,
  // The author's mark at the top right of the cover, the client's beside it.
  logo: none,
  client-logo: none,
  //: Height of BOTH logos. One number on purpose.
  logo-height: 14mm,
  // This cover brings its own composition, so an uploaded picture has nowhere to go: the planes *are* the
  // picture. Accepted and ignored — the UI reads that from the registry and says so beside the upload.
  cover-image: none,
  lang: "en",
  // The prose face. Everything that labels — headings, tables, captions, the running head — is set in
  // `heading-font`.
  body-font: "Libre Baskerville",
  heading-font: "Libre Franklin",
  mono-font: "DejaVu Sans Mono",
  body,
) = {
  set document(title: title, author: if author == none { () } else { (author,) })
  // Baskerville is set small and open, as the draft sets it: a wide serif at 9pt on a long leading reads
  // as easily as a sans at 10.
  set text(font: body-font, size: 8.8pt, fill: pl-body, lang: lang)
  set par(leading: 0.95em, spacing: 1.4em, justify: false)
  show raw: set text(font: mono-font, size: 8pt, fill: pl-ink)
  show strong: set text(fill: pl-deep, weight: 700)
  show emph: set text(style: "italic")
  set list(marker: text(font: heading-font, fill: pl-label)[–], body-indent: 2.4mm)

  // Long tables must break across pages. A Typst figure is unbreakable by default, so an inventory
  // table of 25 rows would run off the bottom of the page with its caption drawn over the last rows.
  // Tables only: an image cannot be split anyway.
  show figure.where(kind: table): set block(breakable: true)
  show figure: set block(above: 16pt, below: 16pt)

  // Small spaced capitals in the label face: the running head, the eyebrows, the labels.
  let caps(it, size: 7pt, fill: pl-muted, weight: 400, tracking: 0.07em) = text(
    font: heading-font, size: size, weight: weight, fill: fill, tracking: tracking,
  )[#upper(it)]

  // The chapter a page is in, for the right half of the running head.
  let current-chapter() = {
    let here = counter(page).get().first()
    let before = query(heading.where(level: 1)).filter(h => h.location().page() <= here)
    if before.len() == 0 { return none }
    before.last().body
  }

  set page(
    paper: "a4",
    fill: pl-page,
    // The draft's measure: 19mm at either side, the text under a running head that starts 17mm down and
    // the rule beneath it.
    margin: (top: 34mm, bottom: 28mm, left: 19mm, right: 19mm),
    header-ascent: 8mm,
    footer-descent: 10mm,
    header: context {
      if counter(page).get().first() > 1 {
        let chapter = current-chapter()
        grid(
          columns: (1fr, auto),
          column-gutter: 8mm,
          align(left, caps(title, size: 7.2pt, weight: 700, fill: pl-deep)),
          align(right, caps(if chapter == none { [] } else { chapter }, size: 7.2pt)),
        )
        v(4mm, weak: true)
        // The rule in three of the cover's planes, in the draft's proportions: the arc, the field, the disc.
        grid(
          columns: (63.7%, 23.4%, 1fr),
          block(width: 100%, height: 2mm, fill: pl-arc),
          block(width: 100%, height: 2mm, fill: pl-field),
          block(width: 100%, height: 2mm, fill: pl-disc),
        )
      }
    },
    // A hairline, the author on the left, the folio in two digits on the right.
    footer: context {
      if counter(page).get().first() > 1 {
        line(length: 100%, stroke: 0.25mm + pl-hair)
        v(3mm, weak: true)
        let n = counter(page).get().first()
        set text(font: heading-font)
        grid(
          columns: (1fr, auto),
          align(left + bottom, text(size: 6.8pt, fill: pl-muted)[#if author == none { [] } else { author }]),
          align(right + bottom, text(size: 8pt, weight: 700, fill: pl-deep, number-width: "tabular")[#if n < 10 [0]#n]),
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

  // A chapter opens on its own page: its number in two digits as an eyebrow in the accent, then the title
  // large and tight in Libre Franklin in the deep tone. Only the eyebrow pads the number — the contents and
  // every cross-reference keep "Chapter 6". A heading WITHOUT a number (the contents, the figure and table
  // lists) is the title alone.
  show heading.where(level: 1): it => {
    pagebreak(weak: true)
    block(above: 0pt, below: 8mm, width: 100%, {
      if it.numbering != none {
        let n = counter(heading).get().first()
        caps([#if n < 10 [0]#n], size: 7.5pt, weight: 700, fill: pl-label, tracking: 0.1em)
        v(3mm, weak: true)
      }
      set text(font: heading-font, size: 24pt, weight: 600, fill: pl-deep, tracking: -0.03em)
      set par(leading: 0.35em)
      it.body
    })
  }
  show heading.where(level: 2): it => block(above: 8mm, below: 3.5mm, sticky: true)[
    #set text(font: heading-font, size: 11pt, weight: 600, fill: pl-deep)
    #if it.numbering == none { it.body } else [#counter(heading).display(it.numbering)#h(0.6em)#it.body]
  ]
  show heading.where(level: 3): it => block(above: 6mm, below: 2.5mm, sticky: true)[
    #set text(font: heading-font, size: 9.5pt, weight: 600, fill: pl-deep)
    #if it.numbering == none { it.body } else [#counter(heading).display(it.numbering)#h(0.6em)#it.body]
  ]

  // Captions as the draft sets them: small and grey in the label face, "Figure 1 ·" in the deep tone. A
  // table's caption goes ABOVE it, a figure's below — the convention every style guide this report is
  // measured against uses, and Typst puts both below by default.
  show figure.where(kind: table): set figure.caption(position: top)
  // …and stays on the page its table starts on: a caption left alone at the foot of a page, its table on
  // the next, reads as a heading over nothing. Sticky, it goes along with the table.
  show figure.where(kind: table): it => {
    show figure.caption: c => block(sticky: true, width: 100%, c)
    it
  }
  show figure.caption: it => align(left)[
    #set text(font: heading-font, size: 7pt, fill: pl-muted)
    #set par(leading: 0.5em)
    #text(weight: 700, fill: pl-deep)[#it.supplement #context it.counter.display(it.numbering) ·]
    #h(2pt)
    #it.body
  ]

  // The contents in the label face: chapter lines in bold, section lines indented under them, a dotted
  // leader, the page number in grey. Every level's number starts exactly where the title of the level above
  // starts — a level is indented by the number columns before it — and the entry is set in code mode, so no
  // space slips in between a number column and its title. An entry WITHOUT a number — the figure and table
  // lists — starts at the left edge.
  show outline.entry: it => {
    let lvl = it.level
    let prefix = it.prefix()
    let is-heading = it.element.func() == heading
    let columns = (9mm, 12mm, 14mm, 16mm)
    let depth = calc.min(lvl, columns.len())
    let num-width = columns.at(depth - 1)
    let indent = columns.slice(0, depth - 1).fold(0mm, (a, b) => a + b)
    let above = if lvl == 1 and is-heading { 3.6mm } else { 1.3mm }
    // "Figure 10" in the figure and table lists: in a column as wide as the list's widest number.
    let list-style(body) = text(weight: 700, fill: pl-deep, body)
    let hang = if prefix == none { 0pt } else if is-heading { num-width } else {
      _list-number-width(it.element, list-style) + 2.5mm
    }
    link(it.element.location(), block(above: above, below: 1.3mm, width: 100%, inset: (left: indent), {
      set text(font: heading-font, size: 9.5pt)
      // A title too long for one line goes on under its own first word, not under its number, and its
      // lines sit as close as the entries do. An explicit paragraph: inline content alone in a block is
      // not one, and a hanging indent only applies to a paragraph.
      par(hanging-indent: hang, leading: 0.45em, {
        if prefix != none and is-heading {
          box(width: hang, if lvl == 1 {
            text(weight: 700, fill: pl-label)[#prefix]
          } else {
            text(fill: pl-muted)[#prefix]
          })
        } else if prefix != none {
          box(width: hang, list-style(prefix))
        }
        if lvl == 1 and is-heading { text(weight: 700, fill: pl-deep)[#it.body()] } else { text(fill: pl-body)[#it.body()] }
        h(3mm)
        box(width: 1fr, baseline: -2pt, line(length: 100%, stroke: (paint: pl-hair, thickness: 0.5pt, dash: "dotted")))
        h(3mm)
        text(size: 8.5pt, fill: pl-muted)[#it.page()]
      })
    }))
  }

  // ---- cover page ----------------------------------------------------------
  {
    set page(header: none, footer: none, margin: 0pt, fill: pl-paper)
    let edge = 17mm
    // The draft's planes on its 794 × 1123 grid (the A4 page at 96 px per inch).
    let p(x, y) = (x / 794 * 210mm, y / 1123 * 297mm)

    // The slanted field rising from the left.
    place(top + left, polygon(fill: pl-field, p(0, 510), p(450, 750), p(590, 1123), p(0, 1123)))
    // The disc, cut by the right edge: centre (860, 730), radius 330.
    place(top + left, dx: p(860 - 330, 0).at(0), dy: p(0, 730 - 330).at(1), circle(radius: 330 / 794 * 210mm, fill: pl-disc))
    // The dark arc at the foot.
    place(top + left, curve(
      fill: pl-arc,
      curve.move(p(0, 914)),
      curve.cubic(p(218, 801), p(496, 786), p(794, 936)),
      curve.line(p(794, 1123)),
      curve.line(p(0, 1123)),
      curve.close(),
    ))
    // The field where it runs under the arc, in a tone of its own: the arc's curve up to where it meets the
    // field's right edge (t = 0.64 on the curve, split there), then that edge down to the foot.
    place(top + left, curve(
      fill: pl-under,
      curve.move(p(0, 914)),
      curve.cubic(p(139.55, 841.66), p(303.69, 809.49), p(481.92, 835.04)),
      curve.line(p(590, 1123)),
      curve.line(p(0, 1123)),
      curve.close(),
    ))

    // The kind of document at the top left, the marks at the top right — the author's in the corner, the
    // client's beside it.
    if kind != none {
      place(top + left, dx: edge, dy: 20mm, caps(kind, size: 7.2pt, weight: 600, fill: pl-deep, tracking: 0.08em))
    }
    let marks = (client-logo, logo).filter(m => m != none)
    if marks.len() > 0 {
      place(top + right, dx: -edge, dy: 17mm, stack(
        dir: ltr,
        spacing: 6mm,
        ..marks.map(m => image(m, height: calc.min(logo-height, 16mm), fit: "contain")),
      ))
    }

    // The title in a large, light-weight sans and the subtitle in the serif, from 48mm down. Measured and
    // stepped down until it fits the band above the planes, so a long title costs type size, not layout.
    place(top + left, dx: edge, dy: 48mm, block(width: 210mm - 2 * edge)[
      #context {
        let fit(size) = block(width: 210mm - 2 * edge)[
          #set text(font: heading-font, size: size, weight: 500, fill: pl-deep, tracking: -0.04em)
          #set par(leading: size * 0.3, justify: false)
          #title
        ]
        let size = 60pt
        while measure(fit(size)).height > 50mm and size > 20pt { size = size * 0.92 }
        fit(size)
      }
      #if subtitle != none {
        block(above: 10mm, width: 128mm)[
          #set text(size: 9.5pt, fill: pl-body)
          #set par(leading: 0.9em)
          #subtitle
        ]
      }
    ])

    // The study's details at the foot, in white, as the draft sets them: the last one — the date, in the
    // order the assembler passes them — in a column of its own that starts past the edge where the field
    // under the arc ends, so it stands wholly on the dark arc; the others share the field's width up to that
    // edge (143mm at this height, 148mm at the foot). All hang from one top line, so the labels stay on one
    // line however many lines a value wraps to.
    if meta.len() > 0 {
      let line-top = 262mm
      let cell(pair) = {
        let (label, value) = pair
        set text(font: heading-font)
        // A white only a touch softer than the values: any softer and the labels sink into the lighter plane.
        caps(label, size: 6.7pt, weight: 600, fill: pl-on-arc.transparentize(10%), tracking: 0.08em)
        v(2.5mm, weak: true)
        text(size: 8.2pt, fill: pl-on-arc)[#value]
      }
      let rest = if meta.len() > 1 { meta.slice(0, -1) } else { meta }
      place(top + left, dx: edge, dy: line-top, block(width: 140mm - edge, grid(
        columns: rest.map(_ => 1fr),
        column-gutter: 6mm,
        align: top + left,
        ..rest.map(cell),
      )))
      if meta.len() > 1 {
        place(top + left, dx: 152mm, dy: line-top, block(width: 210mm - 152mm - edge, cell(meta.last())))
      }
    }
    pagebreak()
  }

  body
}

/// Contents, figures and tables. All three are native to Typst, which also localises their titles
/// from `text(lang:)`.
#let lca-outlines(contents: true, figures: true, tables: true) = {
  // `indent: 0pt`: the entry show rule above does its own indenting, per level and only when there is a
  // number to indent under.
  if contents { outline(indent: 0pt) }
  // The figure and table lists carry their own localised titles: Typst's auto-title says "Contents"
  // whatever the target. And an EMPTY list would print a lone heading over nothing, so each list
  // only appears when the document actually contains a figure or table.
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

/// Key/value block — used for goal & scope and study metadata. The label in small spaced capitals in the
/// accent, the value in the reading face, a hairline between the pairs.
#let lca-kv(pairs) = block(above: 6pt, below: 12pt)[
  #table(
    columns: (32%, 1fr),
    stroke: (x, y) => (bottom: 0.25mm + prism-line, top: 0pt, left: 0pt, right: 0pt),
    align: top + left,
    inset: (x: 0pt, y: 6pt),
    ..pairs
      .map(p => (
        [#text(font: "Libre Franklin", size: 7pt, weight: 700, fill: pl-label, tracking: 0.08em)[#upper(p.at(0))]],
        [#text(fill: prism-ink)[#p.at(1)]],
      ))
      .flatten()
  )
]

/// Data table. `align-right` lists the column indices that hold numbers.
#let lca-table(headers, rows, caption: none, align-right: (), label-name: none) = {
  // The draft's table, in the label face: a firm rule in the deep tone over a head on a light tint, the
  // head in small spaced capitals, a hairline under every row, every second row on the same tint, the
  // first column in the deep tone.
  let head = headers.enumerate().map(((i, h)) => {
    let cell = text(size: 6.8pt, weight: 700, fill: pl-deep, tracking: 0.035em)[#upper(h)]
    if align-right.contains(i) { align(right + bottom, cell) } else { align(left + bottom, cell) }
  })
  let body-cells = rows
    .map(r => r
      .enumerate()
      .map(((i, c)) => {
        let ink = if i == 0 { pl-deep } else { pl-body }
        if align-right.contains(i) { align(right)[#text(fill: ink)[#c]] } else { [#text(fill: ink)[#c]] }
      }))
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
  let tbl = {
    // The label face, and figures that line up digit under digit.
    set text(font: "Libre Franklin", size: 8.5pt, number-width: "tabular")
    set par(leading: 0.6em)
    table(
      // Fractions, never `auto`: `auto` sizes a column to its content, so a header carrying a full
      // ecoinvent method path made the table wider than the text block.
      columns: range(headers.len()).map(i => width-of(i) * 1fr),
      align: left,
      fill: (x, y) => if y == 0 or calc.rem(y, 2) == 0 { pl-tint } else { none },
      stroke: (x, y) => (
        top: if y == 0 { 0.4mm + pl-deep } else { 0pt },
        bottom: 0.25mm + pl-hair,
        left: 0pt, right: 0pt,
      ),
      inset: (x: 6pt, y: 5.5pt),
      table.header(..head),
      ..body-cells
    )
  }
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
