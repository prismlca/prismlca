// Report template — Ribbons.
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
// The cover: eight ribbons of colour sweep in from the top right and leave at the bottom left, each a
// little wider or narrower than its neighbour, with the white of the page left free for the title — set in
// capitals, tight, with the study's year under it in the set's second colour. The study's details stand at
// the foot behind a hairline, their labels in small spaced capitals. The pages after it are quiet: Noto
// Sans, a running head in spaced capitals over a hairline, a chapter opened by its two-digit number in
// spaced capitals and a large tight title, tables with a firm rule over the head and hairlines under the
// rows.
//
// EIGHT TONES FROM THREE. The draft's ribbons run light sage → teal → petrol → dark blue → mauve → coral →
// peach: a light tint of one colour, the colour, a dark tone in the middle, a second colour and its light
// tint. That is exactly a colour set's accent, deep tone and mark, so the ramp below is computed from
// them — for every set and for colours a report picks by hand. See "the ribbons' ramp".
//
// Not taken from the draft, on purpose:
//   - The two-column body copy and the bar chart drawn in CSS. Our blocks have neither columns nor
//     charts of their own; a figure comes in as a picture the renderer drew.
//   - The lead paragraph under a chapter title. No block says "this paragraph opens the chapter".
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

// ---- the ribbons' ramp ----------------------------------------------------------------------------------
// One path through the set, in OKLCH: from a light tint of the accent, through the accent, down to a dark
// tone in the middle, up through the mark (`prism-accent2`) to a light tint of it. Lightness falls and
// rises — the dark ribbon in the middle is what holds eight colours together — and each half of the path
// turns one way, so neighbours are always related. The rules that keep it harmonious for any set:
//
//   1. The dark middle takes the deep tone's hue when the deep tone has one; otherwise the middle of the way
//      round from the accent to the mark.
//   2. Each half — accent to the dark middle, the dark middle to the mark — takes the way round that runs
//      through the least mud, the shorter on a tie; the longer way pays a step of mud per 60 degrees it adds,
//      so a little brown on the short way is not traded for a whole rainbow. Mud is a dark yellow, olive or brown (35–150 degrees
//      below middle lightness) or a khaki (70–112 degrees below light). The dark middle is the hinge: the
//      second half may turn back the way the first came, as a sunset folds through its darkest band.
//   3. The two light ends turn a little further outward, as the draft's sage and peach do: a light tint
//      reads fresher a few degrees past its colour than as a paler copy of it — unless that lands between
//      khaki and yellow-green (70–130 degrees), where a pale tint turns sandy or pistachio; then the tint
//      keeps its colour's hue.

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

#let _ribbon-anchors = {
  let (la, ca, ha) = _lch(prism-green)
  let (_, cd, hd) = _lch(prism-navy)
  let (lm, cm, hm) = _lch(prism-accent2)
  // A colour picked by hand can be as pale as paper or as saturated as a screen allows; the ramp keeps the
  // accent and the mark where a ribbon can still be seen and the middle where it can be told from black.
  let la = _clamp(la, 0.55, 0.72)
  let lm = _clamp(lm, 0.6, 0.74)
  let ca = calc.min(ca, 0.2)
  let cm = calc.min(cm, 0.2)
  let l-dark = 0.42
  let h-dark = if cd >= 0.03 and not _mud(l-dark, hd) { hd } else {
    // The middle of whichever way round from accent to mark leaves the whole path with the least mud.
    let best = none
    for deg in _ways(ha, hm) {
      let mid = ha + deg / 2
      let score = _mud-count(la, ha, l-dark, deg / 2) + _mud-count(l-dark, mid, lm, deg / 2)
      if best == none or score < best.at(0) { best = (score, mid) }
    }
    best.at(1)
  }
  // Unwrapped along the path, so the interpolation below turns the way each half chose.
  let d1 = _route(la, ha, l-dark, h-dark)
  let h-mid = ha + d1
  let d2 = _route(l-dark, h-mid, lm, hm)
  let h-mark = h-mid + d2
  let dir(d) = if d >= 0 { 1 } else { -1 }
  let outward(h, d) = if _in-band(h + d * 30, 70, 130) { h } else { h + d * 30 }
  (
    (0.84, calc.min(0.08, ca), outward(ha, -dir(d1))),
    (la, calc.min(ca, 0.16), ha),
    (l-dark, _clamp(cd, 0.05, 0.09), h-mid),
    (lm, calc.min(cm, 0.17), h-mark),
    (0.85, calc.min(0.1, cm), outward(h-mark, dir(d2))),
  )
}

// The ramp at t (0–1): between the anchors at 0, 0.28, 0.5, 0.78 and 1.
#let _ribbon-at(t) = {
  let at = (0, 0.28, 0.5, 0.78, 1.0)
  let k = if t <= at.at(1) { 0 } else if t <= at.at(2) { 1 } else if t <= at.at(3) { 2 } else { 3 }
  let u = (t - at.at(k)) / (at.at(k + 1) - at.at(k))
  let (l0, c0, h0) = _ribbon-anchors.at(k)
  let (l1, c1, h1) = _ribbon-anchors.at(k + 1)
  _fit(_lerp(l0, l1, u), _lerp(c0, c1, u), _lerp(h0, h1, u))
}

// The eight ribbons' gradients, inner (top left) to outer: each from its point on the ramp to a little
// past it, so every ribbon is shaded in itself and still steps visibly from its neighbour. Drawn from top
// right to bottom left across the ribbon, as the draft draws them.
#let rb-ribbon-paints = range(8).map(i => {
  let t = i / 7
  gradient.linear(_ribbon-at(t), _ribbon-at(calc.min(1, t + 0.08)), angle: 117deg, space: oklab)
})

// ---- colour -----------------------------------------------------------------------------------------
// The deep tone carries the type: the title, the headings, the first column of a table.
#let rb-deep = prism-navy
// The accent as small type — the eyebrows, the labels over the study's details: held at or below a middle
// lightness, so a lime or a mint still reads at 7pt.
#let rb-label = {
  let (l, c, h) = _lch(prism-green)
  _fit(calc.min(l, 0.52), c, h)
}
// The mark as large type: the year under the title.
#let rb-year = {
  let (l, c, h) = _lch(prism-accent2)
  _fit(calc.min(l, 0.68), c, h)
}
// Neutrals, as the set defines them.
#let rb-ink = prism-ink
#let rb-muted = prism-text
#let rb-hair = prism-line
#let rb-paper = paper
// Prose: between the set's ink and its text grey — the draft reads in a grey-blue, lighter than headings.
#let rb-body = prism-ink.mix((prism-text, 45%))
// Every second table row: the paper, a shade toward the deep tone.
#let rb-zebra = paper.mix((prism-navy, 4%))

// The ribbons as the draft's SVG draws them (viewBox 794 × 1123, the A4 page at 96 px per inch): eight
// closed paths, each between two of nine curves that run from the top edge to the bottom one. "m" starts
// a path, "c" is a cubic segment (two control points, then the end point), "l" a straight one.
#let _ribbons = (
  (("m", 518, -40), ("c", 459, 169, 240, 137, 107, 256), ("c", -26, 375, -24, 550, -34, 748), ("c", -44, 946, -42, 1060, -105, 1170), ("l", -78.73, 1170), ("c", -9.15, 1055.91, -13.85, 924.24, -2.75, 738.22), ("c", 8.36, 552.19, 27.27, 384.56, 159.85, 278.03), ("c", 292.43, 171.5, 501.78, 167.48, 552.86, -40)),
  (("m", 552.86, -40), ("c", 501.78, 167.48, 292.43, 171.5, 159.85, 278.03), ("c", 27.27, 384.56, 8.36, 552.19, -2.75, 738.22), ("c", -13.85, 924.24, -9.15, 1055.91, -78.73, 1170), ("l", -43.66, 1170), ("c", 35.04, 1054.13, 20.53, 911.43, 40.15, 724.33), ("c", 59.78, 537.23, 113.62, 399.02, 253.61, 302.56), ("c", 393.6, 206.09, 554.24, 182.64, 599.34, -40)),
  (("m", 599.34, -40), ("c", 554.24, 182.64, 393.6, 206.09, 253.61, 302.56), ("c", 113.62, 399.02, 59.78, 537.23, 40.15, 724.33), ("c", 20.53, 911.43, 35.04, 1054.13, -43.66, 1170), ("l", -5.03, 1170), ("c", 79.14, 1051.61, 52.15, 902.67, 82.58, 715.46), ("c", 113, 528.25, 222.17, 415.65, 370.35, 327.85), ("c", 518.53, 240.05, 615.24, 198.15, 652.46, -40)),
  (("m", 652.46, -40), ("c", 615.24, 198.15, 518.53, 240.05, 370.35, 327.85), ("c", 222.17, 415.65, 113, 528.25, 82.58, 715.46), ("c", 52.15, 902.67, 79.14, 1051.61, -5.03, 1170), ("l", 22.47, 1170), ("c", 97.56, 1044.3, 71.59, 905.73, 107, 726.51), ("c", 142.41, 547.28, 302.34, 449.36, 454.7, 356.23), ("c", 607.05, 263.11, 673.65, 187.49, 695.62, -40)),
  (("m", 695.62, -40), ("c", 673.65, 187.49, 607.05, 263.11, 454.7, 356.23), ("c", 302.34, 449.36, 142.41, 547.28, 107, 726.51), ("c", 71.59, 905.73, 97.56, 1044.3, 22.47, 1170), ("l", 50.32, 1170), ("c", 122.37, 1038.69, 87.62, 893.12, 131.6, 717.71), ("c", 175.59, 542.3, 379.43, 464.3, 529.64, 368.14), ("c", 679.85, 271.99, 718.22, 187.45, 733.8, -40)),
  (("m", 733.8, -40), ("c", 718.22, 187.45, 679.85, 271.99, 529.64, 368.14), ("c", 379.43, 464.3, 175.59, 542.3, 131.6, 717.71), ("c", 87.62, 893.12, 122.37, 1038.69, 50.32, 1170), ("l", 85.02, 1170), ("c", 161.53, 1033.99, 105.01, 859.63, 163.86, 683.22), ("c", 222.7, 506.81, 463.6, 461.17, 603.95, 365.22), ("c", 744.31, 269.26, 755.05, 202.65, 773.64, -40)),
  (("m", 773.64, -40), ("c", 755.05, 202.65, 744.31, 269.26, 603.95, 365.22), ("c", 463.6, 461.17, 222.7, 506.81, 163.86, 683.22), ("c", 105.01, 859.63, 161.53, 1033.99, 85.02, 1170), ("l", 119.33, 1170), ("c", 194.54, 1026.81, 134.52, 884.73, 200.92, 709.32), ("c", 267.32, 533.91, 501.05, 503.28, 652.27, 413.29), ("c", 803.5, 323.29, 807.99, 215.72, 815.14, -40)),
  (("m", 815.14, -40), ("c", 807.99, 215.72, 803.5, 323.29, 652.27, 413.29), ("c", 501.05, 503.28, 267.32, 533.91, 200.92, 709.32), ("c", 134.52, 884.73, 194.54, 1026.81, 119.33, 1170), ("l", 150, 1170), ("c", 228, 1015, 164, 918, 241, 702), ("c", 318, 486, 532, 556, 707, 438), ("c", 882, 320, 828, 200, 850, -40)),
)

#let _ribbon-shape(segments, paint) = {
  let p(x, y) = (x / 794 * 210mm, y / 1123 * 297mm)
  curve(
    fill: paint,
    // A hair of the same paint round each ribbon, so no paper shows through the seam between two.
    stroke: 0.25pt + paint,
    ..segments.map(s => {
      if s.at(0) == "m" { curve.move(p(s.at(1), s.at(2))) }
      else if s.at(0) == "l" { curve.line(p(s.at(1), s.at(2))) }
      else { curve.cubic(p(s.at(1), s.at(2)), p(s.at(3), s.at(4)), p(s.at(5), s.at(6))) }
    }),
    curve.close(),
  )
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
  // The author's mark and the client's, side by side at the top left of the cover, where the ribbons
  // leave the page white.
  logo: none,
  client-logo: none,
  //: Height of BOTH logos. One number on purpose.
  logo-height: 14mm,
  // This cover brings its own composition, so an uploaded picture has nowhere to go: the ribbons *are*
  // the picture. Accepted and ignored — the UI reads that from the registry and says so beside the upload.
  cover-image: none,
  lang: "en",
  body-font: "Noto Sans",
  heading-font: "Noto Sans",
  mono-font: "DejaVu Sans Mono",
  body,
) = {
  set document(title: title, author: if author == none { () } else { (author,) })
  set text(font: body-font, size: 9.5pt, fill: rb-body, lang: lang)
  set par(leading: 0.72em, spacing: 1.25em, justify: false)
  show raw: set text(font: mono-font, size: 8.5pt, fill: rb-ink)
  show strong: set text(fill: rb-deep, weight: 700)
  show emph: set text(style: "italic")
  set list(marker: text(fill: rb-label)[–], body-indent: 2.4mm)

  // Long tables must break across pages. A Typst figure is unbreakable by default, so an inventory
  // table of 25 rows would run off the bottom of the page with its caption drawn over the last rows.
  // Tables only: an image cannot be split anyway.
  show figure.where(kind: table): set block(breakable: true)
  show figure: set block(above: 16pt, below: 16pt)

  // Small spaced capitals: the running head, the eyebrows, the labels over the study's details.
  let caps(it, size: 7pt, fill: rb-muted, weight: 400, tracking: 0.09em) = text(
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
    fill: rb-paper,
    // The draft's measure: 19mm at either side, the text under a running head that starts 18mm down.
    margin: (top: 32mm, bottom: 28mm, left: 19mm, right: 19mm),
    header-ascent: 8mm,
    footer-descent: 10mm,
    header: context {
      if counter(page).get().first() > 1 {
        let chapter = current-chapter()
        grid(
          columns: (1fr, auto),
          column-gutter: 8mm,
          align(left, caps(title, weight: 700, fill: rb-deep)),
          align(right, caps(if chapter == none { [] } else { chapter })),
        )
        v(3.5mm, weak: true)
        line(length: 100%, stroke: 0.3mm + rb-hair)
      }
    },
    // A hairline, the author on the left, the folio in two digits on the right.
    footer: context {
      if counter(page).get().first() > 1 {
        line(length: 100%, stroke: 0.3mm + rb-hair)
        v(3mm, weak: true)
        let n = counter(page).get().first()
        grid(
          columns: (1fr, auto),
          align(left + bottom, text(size: 7pt, fill: rb-muted)[#if author == none { [] } else { author }]),
          align(right + bottom, text(size: 8pt, fill: rb-deep, number-width: "tabular")[#if n < 10 [0]#n]),
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
  // large and tight in the deep tone. Only the eyebrow pads the number — the contents and every
  // cross-reference keep "Chapter 6". A heading WITHOUT a number (the contents, the figure and table lists)
  // is the title alone.
  show heading.where(level: 1): it => {
    pagebreak(weak: true)
    block(above: 0pt, below: 8mm, width: 100%, {
      if it.numbering != none {
        let n = counter(heading).get().first()
        caps([#if n < 10 [0]#n], size: 7.5pt, fill: rb-label, tracking: 0.13em)
        v(3mm, weak: true)
      }
      set text(font: heading-font, size: 22pt, weight: 700, fill: rb-deep, tracking: -0.03em)
      set par(leading: 0.3em)
      it.body
    })
  }
  show heading.where(level: 2): it => block(above: 8mm, below: 3.5mm, sticky: true)[
    #set text(font: heading-font, size: 11.5pt, weight: 700, fill: rb-deep)
    #if it.numbering == none { it.body } else [#counter(heading).display(it.numbering)#h(0.6em)#it.body]
  ]
  show heading.where(level: 3): it => block(above: 6mm, below: 2.5mm, sticky: true)[
    #set text(font: heading-font, size: 10pt, weight: 700, fill: rb-deep)
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
    #set text(size: 7.5pt, fill: rb-muted)
    #set par(leading: 0.5em)
    #text(weight: 700, fill: rb-deep)[#it.supplement #context it.counter.display(it.numbering) ·]
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
    let list-style(body) = text(weight: 700, fill: rb-deep, body)
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
            text(weight: 700, fill: rb-label)[#prefix]
          } else {
            text(fill: rb-muted)[#prefix]
          })
        } else if prefix != none {
          box(width: hang, list-style(prefix))
        }
        if lvl == 1 and is-heading { text(weight: 700, fill: rb-deep)[#it.body()] } else { text(fill: rb-body)[#it.body()] }
        h(3mm)
        box(width: 1fr, baseline: -2pt, line(length: 100%, stroke: (paint: rb-hair, thickness: 0.5pt, dash: "dotted")))
        h(3mm)
        text(size: 8.5pt, fill: rb-muted)[#it.page()]
      })
    }))
  }

  // ---- cover page ----------------------------------------------------------
  {
    set page(header: none, footer: none, margin: 0pt)
    let edge = 19mm

    // The ribbons first, so the type wins where they meet.
    for (i, segments) in _ribbons.enumerate() {
      place(top + left, _ribbon-shape(segments, rb-ribbon-paints.at(i)))
    }

    // The logos at the top left, where the ribbons leave the page white: the author's first, the
    // client's beside it. Nothing is drawn where there is no logo.
    let marks = (logo, client-logo).filter(m => m != none)
    if marks.len() > 0 {
      place(top + left, dx: edge, dy: edge, stack(
        dir: ltr,
        spacing: 8mm,
        ..marks.map(m => box(height: calc.min(logo-height, 18mm), image(m, height: calc.min(logo-height, 18mm), fit: "contain"))),
      ))
    }

    // The year, out of the study's own details: the last four-digit year in any of the values. Drawn only
    // when one is there — a cover that invents a year is worse than a cover without one.
    let year = {
      let hits = ()
      for pair in meta { hits += str(pair.at(1)).matches(regex("(?:19|20)\d{2}")) }
      if hits.len() > 0 { hits.last().text } else { none }
    }

    // The title block in the white below the ribbons: the kind of document in spaced capitals, the title in
    // tight capitals, the year, the subtitle. Anchored at its top; a long title steps down so the block
    // still ends above the details. The character count stands in for the line count.
    let n = if type(title) == str { title.clusters().len() } else { 30 }
    let size = if n > 90 { 17pt } else if n > 55 { 22pt } else if n > 28 { 28pt } else { 35pt }
    place(top + left, dx: 93mm, dy: 160mm, block(width: 210mm - 93mm - edge)[
      #if kind != none {
        caps(kind, size: 7pt, weight: 700, fill: rb-label, tracking: 0.13em)
        v(4mm, weak: true)
      }
      #block[
        // Lines as close as the draft's .96: capitals have no descenders to keep apart.
        #set text(font: heading-font, size: size, weight: 700, fill: rb-deep, tracking: -0.045em)
        #set par(leading: 0.25em, justify: false)
        #upper(title)
      ]
      #if year != none {
        block(above: 3mm)[
          #set text(font: heading-font, size: size, weight: 400, fill: rb-year, tracking: -0.035em)
          #year
        ]
      }
      #if subtitle != none {
        block(above: 6mm, width: 82mm)[
          #set text(size: 10.5pt, fill: rb-body)
          #set par(leading: 0.6em)
          #subtitle
        ]
      }
    ])

    // The study's details at the foot, behind a hairline: labels in small spaced capitals in the accent,
    // values in the reading face. One column each up to three; four go two by two, because four columns
    // in 113mm would break every value onto three lines.
    if meta.len() > 0 {
      let cols = if meta.len() == 4 { 2 } else { meta.len() }
      place(bottom + left, dx: 78mm, dy: -20mm, block(width: 210mm - 78mm - edge)[
        #line(length: 100%, stroke: 0.3mm + rb-hair)
        #v(5mm, weak: true)
        #grid(
          columns: range(cols).map(_ => 1fr),
          column-gutter: 5mm,
          row-gutter: 5mm,
          // Top, spelled out: a grid centres its cells vertically, so a value that wraps — an institute's
          // full name — pushed the labels beside it down to its middle. The labels are what a reader scans
          // across, so they are what has to line up.
          align: top + left,
          ..meta.map(((label, value)) => [
            #caps(label, size: 6.7pt, weight: 700, fill: rb-label)
            #v(2.5mm, weak: true)
            #text(size: 8pt, fill: rb-body)[#value]
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
        [#text(size: 7pt, weight: 700, fill: rb-label, tracking: 0.09em)[#upper(p.at(0))]],
        [#text(fill: prism-ink)[#p.at(1)]],
      ))
      .flatten()
  )
]

/// Data table. `align-right` lists the column indices that hold numbers.
#let lca-table(headers, rows, caption: none, align-right: (), label-name: none) = {
  // The draft's table: a firm rule in the deep tone over the head, the head in small spaced capitals, a
  // hairline under the head and under every row, every second row a shade toward the deep tone, the first
  // column in the deep tone.
  let head = headers.enumerate().map(((i, h)) => {
    let cell = text(size: 7pt, weight: 700, fill: rb-deep, tracking: 0.05em)[#upper(h)]
    if align-right.contains(i) { align(right + bottom, cell) } else { align(left + bottom, cell) }
  })
  let body-cells = rows
    .map(r => r
      .enumerate()
      .map(((i, c)) => {
        let ink = if i == 0 { rb-deep } else { rb-body }
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
    set text(size: 8.7pt, number-width: "tabular")
    table(
      // Fractions, never `auto`: `auto` sizes a column to its content, so a header carrying a full
      // ecoinvent method path made the table wider than the text block.
      columns: range(headers.len()).map(i => width-of(i) * 1fr),
      align: left,
      fill: (x, y) => if y > 0 and calc.rem(y, 2) == 0 { rb-zebra } else { none },
      stroke: (x, y) => (
        top: if y == 0 { 0.45mm + rb-deep } else { 0pt },
        bottom: if y == 0 { 0.3mm + rb-hair } else { 0.25mm + rb-hair },
        left: 0pt, right: 0pt,
      ),
      inset: (x: 5pt, y: 5.5pt),
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
