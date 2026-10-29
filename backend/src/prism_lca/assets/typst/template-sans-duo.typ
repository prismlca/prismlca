// Report template — Flows.
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
// The cover is colour from edge to edge: eight bands stacked down the page, each ending at the right in
// an arrowhead that laps over the band below, the stack running from a light tone of the accent at the top
// to a dark one at the foot. The title, the subtitle and the study's details stand on it in white. The
// pages after it pair two sans faces — Montserrat for the title and the headings, Open Sans for everything
// that is read: a running head in spaced capitals over a bar running from the accent to the deep tone, a
// chapter opened by its two-digit number and a large heading, tables under a solid head in the deep tone.
//
// EIGHT TONES FROM TWO. The draft's bands run from turquoise to a dark navy — the accent, lightened, to the
// deep tone, darkened. The ramp below computes them from the set's accent and deep tone in OKLCH, for every
// set and for colours a report picks by hand. See "the bands' ramp".
//
// Not taken from the draft, on purpose:
//   - The bar chart drawn in CSS: a figure comes in as a picture the renderer drew.
//   - The lead paragraph under a chapter title: no block says "this paragraph opens the chapter".
//   - The variable fonts embedded in the draft: the report uses the projects' own static cuts, bundled
//     with the app, which Typst sets by weight reliably.
// ---------------------------------------------------------------------------------------------------

// The colours come from the report's colour set, written by PrismLCA beside this file. One choice
// reaches every theme: a theme decides the layout, a palette decides the colour.
// A theme of your own may import this too, or declare its own colours and ignore it.
#import "palette.typ": *

// ---- colour helpers -----------------------------------------------------------------------------------
// The same helpers as the Gradient strip theme: a theme is one file, so it carries its own copy.

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

// ---- the bands' ramp ------------------------------------------------------------------------------------
// From the accent, lightened, at the top of the cover to the deep tone, darkened, at its foot, in OKLCH:
// lightness falls evenly, so the white type on the bands stays legible from the third band down, and the hue
// turns from the accent's to the deep tone's. The way round is the one with the least mud — a dark yellow,
// olive or brown, or a khaki — the longer way paying a step of mud per 60 degrees it adds; Ribbons uses the
// same rule. A deep tone with even a trace of hue (a blue-grey slate) hands that hue down to the foot; a
// true neutral lets the accent's hue run there. If that hue is mud in the dark — a brown or olive deep tone,
// or a brick or matcha accent running down — the foot turns out of the band to the edge nearer the accent,
// a wine or a dark teal, so the stack stays one family instead of ending in mud.

#let _mud(l, h) = (_in-band(h, 35, 150) and l < 0.56) or (_in-band(h, 70, 112) and l < 0.78)
// How many of eleven steps of a turn by `deg` from (l0, h0) towards lightness l1 lie in mud.
#let _mud-count(l0, h0, l1, deg) = range(1, 12).filter(i => _mud(_lerp(l0, l1, i / 12), h0 + deg * i / 12)).len()
// The two ways round from hue a to hue b: the shorter first.
#let _ways(a, b) = {
  let short = _turn(a, b)
  (short, if short >= 0 { short - 360 } else { short + 360 })
}
// The way from (l0, h0) to (l1, h1) through the least mud, the longer way paying for what it adds; the
// shorter on a tie.
#let _route(l0, h0, l1, h1) = {
  let (short, long) = _ways(h0, h1)
  let detour = (calc.abs(long) - calc.abs(short)) / 60
  if _mud-count(l0, h0, l1, long) + detour < _mud-count(l0, h0, l1, short) { long } else { short }
}

#let _band-ends = {
  let (la, ca, ha) = _lch(prism-green)
  let (ld, cd, hd) = _lch(prism-navy)
  // A grey accent stays grey: no chroma floor.
  let top = (_clamp(la + 0.08, 0.6, 0.68), calc.min(ca, 0.13), ha)
  let foot-l = calc.min(ld, 0.28)
  let target = if cd >= 0.012 { hd } else { ha }
  if _mud(foot-l, target) {
    target = if calc.abs(_turn(ha, 25)) <= calc.abs(_turn(ha, 160)) { 25 } else { 160 }
  }
  let foot-h = ha + _route(top.at(0), ha, foot-l, target)
  (top, (foot-l, calc.min(cd, 0.1), foot-h))
}
// The ramp at t (0 at the top of the cover, 1 at its foot), `dl` added to the lightness.
#let _band-at(t, dl: 0) = {
  let ((l0, c0, h0), (l1, c1, h1)) = _band-ends
  _fit(_lerp(l0, l1, t) + dl, _lerp(c0, c1, t), _lerp(h0, h1, t))
}
// The eight bands, top to bottom.
#let sd-bands = range(8).map(i => _band-at(i / 7))
// What shows between the arrowheads at the right edge: the same ramp a step darker, so the heads stand out.
#let sd-ground = gradient.linear(
  _band-at(0, dl: -0.06), _band-at(0.5, dl: -0.06), _band-at(1, dl: -0.04), angle: 90deg, space: oklab,
)
// The bar under the running head: the ramp lying down, accent to deep.
#let sd-rule = gradient.linear(_band-at(0), _band-at(1), space: oklab)

// ---- colour -----------------------------------------------------------------------------------------
// The deep tone carries the type: the headings, the head of a table, the first column.
#let sd-deep = prism-navy
// The accent as small type — the eyebrows, the labels of a key/value block: held at or below a middle
// lightness, so a lime or a mint still reads at 7pt.
#let sd-label = {
  let (l, c, h) = _lch(prism-green)
  _fit(calc.min(l, 0.52), c, h)
}
// Text on the cover's bands: white, and a softer white for what is secondary.
#let sd-on = white
#let sd-on-soft = white.transparentize(22%)
#let sd-on-faint = white.transparentize(38%)
// Neutrals, as the set defines them.
#let sd-ink = prism-ink
#let sd-muted = prism-text
#let sd-hair = prism-line
#let sd-paper = paper
// Prose: between the set's ink and its text grey — the draft reads in a slate, lighter than headings.
#let sd-body = prism-ink.mix((prism-text, 40%))
// Every second table row: the paper, a shade toward the deep tone.
#let sd-zebra = paper.mix((prism-navy, 5%))

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
  // Printed over the title. `none` prints nothing there.
  kind: none,
  // The author's mark and the client's, side by side at the top left of the cover, each on a white card:
  // the bands under them are colour, and a mark drawn for white paper would vanish into a dark one.
  logo: none,
  client-logo: none,
  //: Height of BOTH logos. One number on purpose. The card is 19mm high with 3mm of padding.
  logo-height: 13mm,
  // This cover brings its own composition, so an uploaded picture has nowhere to go: the bands *are* the
  // picture. Accepted and ignored — the UI reads that from the registry and says so beside the upload.
  cover-image: none,
  lang: "en",
  body-font: "Open Sans",
  heading-font: "Montserrat",
  mono-font: "DejaVu Sans Mono",
  body,
) = {
  set document(title: title, author: if author == none { () } else { (author,) })
  set text(font: body-font, size: 9.5pt, fill: sd-body, lang: lang)
  set par(leading: 0.75em, spacing: 1.3em, justify: false)
  show raw: set text(font: mono-font, size: 8.5pt, fill: sd-ink)
  show strong: set text(fill: sd-deep, weight: 700)
  show emph: set text(style: "italic")
  set list(marker: text(fill: sd-label)[–], body-indent: 2.4mm)

  // Long tables must break across pages. A Typst figure is unbreakable by default, so an inventory
  // table of 25 rows would run off the bottom of the page with its caption drawn over the last rows.
  // Tables only: an image cannot be split anyway.
  show figure.where(kind: table): set block(breakable: true)
  show figure: set block(above: 16pt, below: 16pt)

  // Small spaced capitals in the reading face: the running head, the eyebrows, the labels.
  let caps(it, size: 7pt, fill: sd-muted, weight: 400, tracking: 0.07em) = text(
    font: body-font, size: size, weight: weight, fill: fill, tracking: tracking,
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
    fill: sd-paper,
    // The draft's measure: 19mm at either side, the text under a running head that starts 17mm down and
    // the bar beneath it.
    margin: (top: 34mm, bottom: 28mm, left: 19mm, right: 19mm),
    header-ascent: 8mm,
    footer-descent: 10mm,
    header: context {
      if counter(page).get().first() > 1 {
        let chapter = current-chapter()
        grid(
          columns: (1fr, auto),
          column-gutter: 8mm,
          align(left, caps(title, size: 7.2pt, weight: 700, fill: sd-deep)),
          align(right, caps(if chapter == none { [] } else { chapter }, size: 7.2pt)),
        )
        v(4mm, weak: true)
        block(width: 100%, height: 2mm, fill: sd-rule)
      }
    },
    // A hairline, the author on the left, the folio in two digits on the right.
    footer: context {
      if counter(page).get().first() > 1 {
        line(length: 100%, stroke: 0.25mm + sd-hair)
        v(3mm, weak: true)
        let n = counter(page).get().first()
        grid(
          columns: (1fr, auto),
          align(left + bottom, text(size: 6.8pt, fill: sd-muted)[#if author == none { [] } else { author }]),
          align(right + bottom, text(size: 8pt, weight: 700, fill: sd-deep, number-width: "tabular")[#if n < 10 [0]#n]),
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
  // large in Montserrat in the deep tone. Only the eyebrow pads the number — the contents and every
  // cross-reference keep "Chapter 6". A heading WITHOUT a number (the contents, the figure and table lists)
  // is the title alone.
  show heading.where(level: 1): it => {
    pagebreak(weak: true)
    block(above: 0pt, below: 8mm, width: 100%, {
      if it.numbering != none {
        let n = counter(heading).get().first()
        caps([#if n < 10 [0]#n], size: 7.5pt, weight: 700, fill: sd-label, tracking: 0.1em)
        v(3mm, weak: true)
      }
      set text(font: heading-font, size: 22pt, weight: 600, fill: sd-deep, tracking: -0.025em)
      set par(leading: 0.35em)
      it.body
    })
  }
  show heading.where(level: 2): it => block(above: 8mm, below: 3.5mm, sticky: true)[
    #set text(font: heading-font, size: 11pt, weight: 600, fill: sd-deep)
    #if it.numbering == none { it.body } else [#counter(heading).display(it.numbering)#h(0.6em)#it.body]
  ]
  show heading.where(level: 3): it => block(above: 6mm, below: 2.5mm, sticky: true)[
    #set text(font: heading-font, size: 9.5pt, weight: 600, fill: sd-deep)
    #if it.numbering == none { it.body } else [#counter(heading).display(it.numbering)#h(0.6em)#it.body]
  ]

  // Captions as the draft sets them: small and grey, "Figure 1 ·" in the deep tone. A table's caption goes
  // ABOVE it, a figure's below — the convention every style guide this report is measured against uses,
  // and Typst puts both below by default.
  show figure.where(kind: table): set figure.caption(position: top)
  // …and stays on the page its table starts on: a caption left alone at the foot of a page, its table on
  // the next, reads as a heading over nothing. Sticky, it goes along with the table.
  show figure.where(kind: table): it => {
    show figure.caption: c => block(sticky: true, width: 100%, c)
    it
  }
  show figure.caption: it => align(left)[
    #set text(size: 7.5pt, fill: sd-muted)
    #set par(leading: 0.5em)
    #text(weight: 700, fill: sd-deep)[#it.supplement #context it.counter.display(it.numbering) ·]
    #h(2pt)
    #it.body
  ]

  // The contents: chapter lines in bold, section lines indented under them, a dotted leader, the page
  // number in grey. Every level's number starts exactly where the title of the level above starts — a
  // level is indented by the number columns before it — and the entry is set in code mode, so no space
  // slips in between a number column and its title. An entry WITHOUT a number — the figure and table lists
  // — starts at the left edge.
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
    let list-style(body) = text(weight: 700, fill: sd-deep, body)
    let hang = if prefix == none { 0pt } else if is-heading { num-width } else {
      _list-number-width(it.element, list-style) + 2.5mm
    }
    link(it.element.location(), block(above: above, below: 1.3mm, width: 100%, inset: (left: indent), {
      set text(size: 9.5pt)
      // A title too long for one line goes on under its own first word, not under its number, and its
      // lines sit as close as the entries do. An explicit paragraph: inline content alone in a block is
      // not one, and a hanging indent only applies to a paragraph.
      par(hanging-indent: hang, leading: 0.45em, {
        if prefix != none and is-heading {
          box(width: hang, if lvl == 1 {
            text(weight: 700, fill: sd-label)[#prefix]
          } else {
            text(fill: sd-muted)[#prefix]
          })
        } else if prefix != none {
          box(width: hang, list-style(prefix))
        }
        if lvl == 1 and is-heading { text(weight: 700, fill: sd-deep)[#it.body()] } else { text(fill: sd-body)[#it.body()] }
        h(3mm)
        box(width: 1fr, baseline: -2pt, line(length: 100%, stroke: (paint: sd-hair, thickness: 0.5pt, dash: "dotted")))
        h(3mm)
        text(size: 8.5pt, fill: sd-muted)[#it.page()]
      })
    }))
  }

  // ---- cover page ----------------------------------------------------------
  {
    set page(header: none, footer: none, margin: 0pt, fill: sd-ground)
    let edge = 19mm

    // The eight bands, as the draft draws them on a 794 × 1123 grid (the A4 page at 96 px per inch): each
    // a shaft to 660 and an arrowhead to the right edge whose shoulders stand 48 units beyond the shaft.
    // Drawn top to bottom, so every band's head laps over the band above it, the way the draft overlaps.
    let p(x, y) = (x / 794 * 210mm, y / 1123 * 297mm)
    let band-h = 1123 / 8
    for (i, tone) in sd-bands.enumerate() {
      let y0 = i * band-h
      let y1 = y0 + band-h
      place(top + left, polygon(
        fill: tone,
        // A hair of the same tone round each band, so no ground shows through the seam between two.
        stroke: 0.25pt + tone,
        p(0, y0), p(660, y0), p(660, y0 - 48), p(794, (y0 + y1) / 2), p(660, y1 + 48), p(660, y1), p(0, y1),
      ))
    }

    // Text never sits on the line between two bands, nor touches it: everything below is placed by band, with
    // `clear` kept from both edges of the band it stands in.
    let band-h = 297mm / 8
    let clear = 4.5mm
    let measure-w = 210mm - edge - 39mm

    // The logos at the top left, each on a white card, the author's first — centred in the first band.
    let marks = (logo, client-logo).filter(m => m != none)
    if marks.len() > 0 {
      let card(img) = box(
        height: 19mm, inset: 3mm, fill: white, radius: 1mm,
        align(horizon, image(img, height: calc.min(logo-height, 13mm), fit: "contain")),
      )
      place(top + left, dx: edge, dy: (band-h - 19mm) / 2, stack(dir: ltr, spacing: 5mm, ..marks.map(card)))
    }

    // The kind of document in spaced capitals over the title in Montserrat, as one group centred in the fifth
    // band — the draft's height for the title. The character count picks the largest size a title may take;
    // from there it steps down until the group fits inside the band, so a title of two lines, or of four,
    // stays within one arrow. The measured block ends at the last baseline, so the descenders below it are
    // added before centring.
    let n = if type(title) == str { title.clusters().len() } else { 30 }
    let largest = if n > 100 { 18pt } else if n > 60 { 23pt } else if n > 32 { 29pt } else { 35pt }
    let sizes = (35pt, 32pt, 29pt, 26pt, 23pt, 20pt, 18pt, 16pt, 14pt, 12pt).filter(x => x <= largest)
    let heading-group(size) = block(width: measure-w, {
      if kind != none {
        caps(kind, size: 7pt, weight: 700, fill: sd-on-faint, tracking: 0.1em)
        v(4mm, weak: true)
      }
      block({
        set text(font: heading-font, size: size, weight: 600, fill: sd-on, tracking: -0.025em)
        set par(leading: 0.42em, justify: false)
        title
      })
    })
    context {
      let seen(size) = measure(heading-group(size)).height + 0.24 * size
      let fits = sizes.filter(x => seen(x) <= band-h - 2 * clear)
      let size = if fits.len() > 0 { fits.first() } else { sizes.last() }
      place(top + left, dx: edge, dy: 4 * band-h + (band-h - seen(size)) / 2, heading-group(size))
    }

    // The subtitle in the band under the title, hanging from `clear` below its upper edge — close enough to
    // read with the title, never on the line between.
    if subtitle != none {
      place(top + left, dx: edge, dy: 5 * band-h + clear, block(width: 135mm)[
        #set text(size: 11pt, fill: sd-on-soft)
        #set par(leading: 0.6em)
        #subtitle
      ])
    }

    // The study's details in the last band, hanging from `clear` below its upper edge: labels in small spaced
    // capitals, values in white. One column each up to four — the band is 152mm wide. Top-aligned, so a value
    // that wraps leaves the labels beside it on one line. Should the details be taller than the band leaves
    // room for — an organisation named with institute, department and university wraps to a dozen lines in
    // its column — they rise until they end 12mm above the foot of the page instead of running off it.
    if meta.len() > 0 {
      let details = block(width: measure-w, grid(
        columns: range(meta.len()).map(_ => 1fr),
        column-gutter: 6mm,
        align: top + left,
        ..meta.map(((label, value)) => {
          caps(label, size: 6.7pt, weight: 700, fill: sd-on-faint, tracking: 0.08em)
          v(2mm, weak: true)
          text(size: 8pt, fill: sd-on)[#value]
        })
      ))
      context {
        let lowest = 297mm - 12mm - measure(details).height
        place(top + left, dx: edge, dy: calc.min(7 * band-h + clear, lowest), details)
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
        [#text(size: 7pt, weight: 700, fill: sd-label, tracking: 0.08em)[#upper(p.at(0))]],
        [#text(fill: prism-ink)[#p.at(1)]],
      ))
      .flatten()
  )
]

/// Data table. `align-right` lists the column indices that hold numbers.
#let lca-table(headers, rows, caption: none, align-right: (), label-name: none) = {
  // The draft's table: a solid head in the deep tone with its labels in white spaced capitals, a hairline
  // under every row, every second row a shade toward the deep tone, the first column in the deep tone.
  let on-deep = if _lch(prism-navy).at(0) > 0.62 { prism-ink } else { white }
  let head = headers.enumerate().map(((i, h)) => {
    let cell = text(size: 6.8pt, weight: 700, fill: on-deep, tracking: 0.035em)[#upper(h)]
    if align-right.contains(i) { align(right + bottom, cell) } else { align(left + bottom, cell) }
  })
  let body-cells = rows
    .map(r => r
      .enumerate()
      .map(((i, c)) => {
        let ink = if i == 0 { sd-deep } else { sd-body }
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
    // Figures in a column line up digit under digit.
    set text(size: 8.5pt, number-width: "tabular")
    table(
      // Fractions, never `auto`: `auto` sizes a column to its content, so a header carrying a full
      // ecoinvent method path made the table wider than the text block.
      columns: range(headers.len()).map(i => width-of(i) * 1fr),
      align: left,
      fill: (x, y) => if y == 0 { sd-deep } else if calc.rem(y, 2) == 0 { sd-zebra } else { none },
      stroke: (x, y) => (
        top: 0pt,
        bottom: if y == 0 { 0pt } else { 0.25mm + sd-hair },
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
