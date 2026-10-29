// Report template — Gradient strip.
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
// The cover: a strip of colour down the left edge, light at the top and dark at the foot, with soft
// patches of its own tones laid over it so it reads as light rather than as a fill. The title is set in
// bold capitals on bars of paper that start on the strip and run out across the page, its letters
// coloured along the same ramp; the subtitle steps in under it, and the study's details stand at the foot
// in two columns behind a rule. The pages after it are set in IBM Plex Sans: a chapter opens with a large
// two-digit number beside its title over a rule, a table has a solid head in the set's deep tone, and the
// footer rule is the cover's ramp turned on its side.
//
// FOUR COLOURS FROM THREE. The draft's strip runs through four tones — dark teal, teal, sky, lavender —
// and a colour set has one accent, one deep tone and one mark. The ramp below completes the set instead
// of asking it for colours it does not have: it is computed in OKLCH from the accent, so it works for
// every set and for colours a report picks by hand. See "the ramp" for the rules.
//
// Not taken from the draft, on purpose:
//   - The film grain over the strip. It is an SVG noise filter; Typst has no noise, and a tiled picture
//     of one would be a second file the template contract cannot carry.
//   - The findings list beside a chart and the bars inside a table cell. Our blocks have no notion of
//     "the three findings of this chart", and a theme that invented one from the data would be writing
//     the study.
//   - Captions above figures. A figure's caption goes below it here, as in every other theme; only a
//     table's goes above.
// ---------------------------------------------------------------------------------------------------

// The colours come from the report's colour set, written by PrismLCA beside this file. One choice
// reaches every theme: a theme decides the layout, a palette decides the colour.
// A theme of your own may import this too, or declare its own colours and ignore it.
#import "palette.typ": *

// ---- the ramp ---------------------------------------------------------------------------------------
// Four tones from the set's accent, its deep tone and its mark, in OKLCH: lightness rises steadily from
// the dark end to the light one, the hue turns through about 80 degrees around the accent, and chroma
// peaks at the accent. Lightness and hue are what make a gradient read as one family — mixing two colours
// in RGB runs through grey, mixing them in hue keeps them saturated. Three rules keep it harmonious for
// any set:
//
//   1. The light end turns AWAY from the mark (`prism-accent2`). The mark is the colour a page points
//      with; a strip that drifted into it would take its voice.
//   2. …unless that way runs through khaki. Hues from 70 to 112 degrees at middle lightness are mustard
//      and olive; then the light end turns the other way.
//   3. The dark end leans toward the deep tone when the deep tone has a hue, and never lands in the
//      brown band (35–120 degrees): a dark orange or olive is mud. It is moved to the edge of the band on
//      the accent's side, so the way down from the accent does not cross it either.

// A colour as OKLCH floats: lightness 0–1, chroma, hue in degrees.
#let _lch(c) = {
  let (l, ch, h) = c.oklch().components(alpha: false)
  (l / 100%, ch, h.deg())
}
#let _wrap(h) = calc.rem(calc.rem(h, 360) + 360, 360)
// The signed shortest turn from hue a to hue b, in degrees.
#let _turn(a, b) = calc.rem(b - a + 540, 360) - 180
#let _in-band(h, lo, hi) = { let h = _wrap(h); h >= lo and h <= hi }
// Whether turning `deg` degrees from h0 passes through the band.
#let _passes(h0, deg, lo, hi) = range(0, 21).any(i => _in-band(h0 + deg * i / 20, lo, hi))
#let _lerp(a, b, t) = a + (b - a) * t
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

// The four anchors as (l, c, h): dark, accent, high, light.
#let _anchors = {
  let (la, ca, ha) = _lch(prism-green)
  let (_, cd, hd) = _lch(prism-navy)
  let (_, _, hm) = _lch(prism-accent2)
  // An accent picked by hand can be as light as paper or as dark as ink; the middle of the ramp stays in
  // the middle, or the strip would have nowhere to rise to. And it may sit on the edge of what a screen
  // can show — a pure #0000ff — where the tones just above it cannot follow and the strip would show a hard
  // band. None of the shipped sets comes near either limit.
  let la = calc.max(0.42, calc.min(la, 0.76))
  let ca = calc.min(ca, 0.22)
  let sweep = 80
  let s = if _turn(ha, hm) > 0 { -1 } else { 1 }
  if _passes(ha + s * 15, s * (sweep - 15), 70, 112) and not _passes(ha - s * 15, -s * (sweep - 15), 70, 112) {
    s = -s
  }
  let h-dark = if cd >= 0.03 { ha + calc.max(-40, calc.min(40, _turn(ha, hd) * 0.4)) } else { ha - s * 25 }
  if _in-band(h-dark, 35, 120) {
    h-dark = if calc.abs(_turn(ha, 22)) <= calc.abs(_turn(ha, 140)) { 22 } else { 140 }
  }
  // A grey accent stays grey: the ramp may not be more colourful than the colour it was made from.
  let lc = calc.min(0.13, ca)
  (
    (0.27, calc.max(calc.min(ca, 0.05), calc.min(ca * 0.8, 0.12)), h-dark),
    (la, ca, ha),
    (_lerp(la, 0.82, 0.55), calc.min(calc.max(ca * 0.85, 0.12), ca), ha + s * sweep * 0.5),
    (0.83, lc, ha + s * sweep),
  )
}

// The ramp as gradient stops from dark (0 %) to light (100 %), sampled densely along the anchors so the
// hue follows its turn rather than whatever path the gradient's own interpolation would take.
#let _ramp-stops(anchors, at: (0, 0.42, 0.72, 1.0), n: 18) = range(n + 1).map(i => {
  let t = i / n
  let k = if t <= at.at(1) { 0 } else if t <= at.at(2) { 1 } else { 2 }
  let u = (t - at.at(k)) / (at.at(k + 1) - at.at(k))
  let (l0, c0, h0) = anchors.at(k)
  let (l1, c1, h1) = anchors.at(k + 1)
  (_fit(_lerp(l0, l1, u), _lerp(c0, c1, u), h0 + _turn(h0, h1) * u), t * 100%)
})

// The ramp's four tones as colours, dark to light, for the patches on the strip.
#let gs-tones = _anchors.map(((l, c, h)) => _fit(l, c, h))
// The strip, top (light) to bottom (dark).
#let gs-strip = gradient.linear(
  .._ramp-stops(_anchors).rev().map(((c, p)) => (c, 100% - p)), angle: 90deg, space: oklab,
)
// The same ramp lying down, dark on the left: the footer rule of every page.
#let gs-rule = gradient.linear(.._ramp-stops(_anchors), space: oklab)
// The title's letters: the same hues held dark enough to read on paper at a glance.
#let gs-title-ink = {
  let (d, a, _, l) = _anchors
  // The far end as colourful as the accent allows, so a grey set keeps a grey title.
  let c-end = calc.min(0.16, a.at(1) * 1.5)
  gradient.linear(
    .._ramp-stops(
      ((0.30, d.at(1), d.at(2)), (calc.min(a.at(0), 0.55), a.at(1), a.at(2)), (0.53, c-end, l.at(2)), (0.53, c-end, l.at(2))),
      at: (0, 0.52, 0.99, 1.0),
    ),
    space: oklab,
  )
}

// ---- colour -----------------------------------------------------------------------------------------
// The deep tone carries the type: headings, the meta values, the head of a table.
#let gs-deep = prism-navy
// The accent as a figure on paper: the chapter numbers and the list dots. Held at or below a middle
// lightness, so a lime or a mint still reads at 26pt.
#let gs-mark = {
  let (l, c, h) = _lch(prism-green)
  _fit(calc.min(l, 0.6), c, h)
}
// Text on the deep tone. White, unless a hand-picked deep tone is light enough to need ink instead.
#let gs-on-deep = if _lch(prism-navy).at(0) > 0.62 { prism-ink } else { white }
// Neutrals, as the set defines them — a derived grey is a plausible grey, and plausible is not what a
// client document needs.
#let gs-ink = prism-ink
#let gs-muted = prism-text
#let gs-hair = prism-line
#let gs-paper = paper
// Every second table row: the paper, a shade toward the deep tone. Mixed into the paper rather than
// lightened from the deep tone, so it stays darker than an off-white paper instead of glowing on it.
#let gs-zebra = paper.mix((prism-navy, 5%))
// Prose: the set's ink, softened a little towards its text grey.
#let gs-body = prism-ink.mix((prism-text, 20%))

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
  // The author's mark and the client's, each on a white card at the top right of the cover; the author's
  // also stands small in the running header.
  logo: none,
  client-logo: none,
  //: Height of BOTH logos. One number on purpose. The card around a logo is 18mm high with 3mm of
  //: padding, so this is also as tall as a mark can be drawn on the cover.
  logo-height: 12mm,
  // This cover brings its own composition, so an uploaded picture has nowhere to go: the strip *is* the
  // picture. Accepted and ignored — the UI reads that from the registry and says so beside the upload.
  cover-image: none,
  lang: "en",
  body-font: "IBM Plex Sans",
  heading-font: "IBM Plex Sans",
  mono-font: "DejaVu Sans Mono",
  body,
) = {
  set document(title: title, author: if author == none { () } else { (author,) })
  set text(font: body-font, size: 10pt, fill: gs-body, lang: lang)
  set par(leading: 0.68em, spacing: 1.2em, justify: false)
  show raw: set text(font: mono-font, size: 8.5pt, fill: gs-ink)
  show strong: set text(fill: gs-deep, weight: 600)
  show emph: set text(style: "italic")
  // The draft's bullets: a small round dot in the accent instead of a dash.
  set list(marker: box(baseline: -0.32em, circle(radius: 0.8mm, fill: gs-mark, stroke: none)), body-indent: 2.4mm)

  // Long tables must break across pages. A Typst figure is unbreakable by default, so an inventory
  // table of 25 rows would run off the bottom of the page with its caption drawn over the last rows.
  // Tables only: an image cannot be split anyway.
  show figure.where(kind: table): set block(breakable: true)
  show figure: set block(above: 16pt, below: 16pt)

  // The small label face: the running header and footer, the meta labels, the caption prefix.
  let label-text(it, size: 8pt, fill: gs-muted, weight: 400) = text(
    font: heading-font, size: size, weight: weight, fill: fill,
  )[#it]

  // The chapter a page is in, for the running header when there is no logo to put there.
  let current-chapter() = {
    let here = counter(page).get().first()
    let before = query(heading.where(level: 1)).filter(h => h.location().page() <= here)
    if before.len() == 0 { return none }
    let hd = before.last()
    if hd.numbering == none { hd.body } else {
      [#numbering(hd.numbering, ..counter(heading).at(hd.location())) #h(0.5em) #hd.body]
    }
  }

  set page(
    paper: "a4",
    fill: gs-paper,
    // The draft's measure, 2mm wider at either side for a 10pt body: the text starts under a 10mm running head.
    margin: (top: 31mm, bottom: 26mm, left: 20mm, right: 20mm),
    header-ascent: 7mm,
    footer-descent: 9mm,
    header: context {
      if counter(page).get().first() > 1 {
        let chapter = current-chapter()
        grid(
          columns: (1fr, auto),
          column-gutter: 8mm,
          align: horizon,
          align(left, label-text(title)),
          align(right, if logo != none {
            box(height: 8mm, image(logo, height: calc.min(logo-height, 8mm), fit: "contain"))
          } else {
            label-text(if chapter == none { [] } else { chapter })
          }),
        )
      }
    },
    // A hairline in the cover's ramp, the author on the left, the folio on the right.
    footer: context {
      if counter(page).get().first() > 1 {
        block(width: 100%, height: 0.5mm, fill: gs-rule)
        v(2.2mm, weak: true)
        grid(
          columns: (1fr, auto),
          align(left, label-text(if author == none { [] } else { author })),
          align(right, label-text(counter(page).display(), size: 8.5pt, fill: gs-deep, weight: 600)),
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

  // The chapter heading: the number large in the accent, two digits as in the draft, the title beside it
  // on the same baseline, a rule in the deep tone underneath. Only the heading shows the zero — the
  // contents and every cross-reference keep "Chapter 6". A heading WITHOUT a number (the contents, the
  // figure and table lists) is the title alone over the same rule.
  show heading.where(level: 1): it => {
    pagebreak(weak: true)
    block(above: 0pt, below: 6mm, width: 100%, stroke: (bottom: 0.4mm + gs-deep), inset: (bottom: 2.4mm))[
      #set text(font: heading-font, size: 17pt, weight: 700, fill: gs-deep)
      #set par(leading: 0.35em)
      #if it.numbering == none { it.body } else {
        let n = counter(heading).get().first()
        grid(
          columns: (auto, 1fr),
          column-gutter: 3.5mm,
          align: bottom + left,
          text(size: 26pt, fill: gs-mark, number-width: "tabular")[#if n < 10 [0]#n],
          it.body,
        )
      }
    ]
  }
  show heading.where(level: 2): it => block(above: 7mm, below: 3mm, sticky: true)[
    #set text(font: heading-font, size: 12pt, weight: 700, fill: gs-deep)
    #if it.numbering == none { it.body } else [#counter(heading).display(it.numbering)#h(0.6em)#it.body]
  ]
  show heading.where(level: 3): it => block(above: 5.5mm, below: 2.5mm, sticky: true)[
    #set text(font: heading-font, size: 10.5pt, weight: 600, fill: gs-deep)
    #if it.numbering == none { it.body } else [#counter(heading).display(it.numbering)#h(0.6em)#it.body]
  ]

  // Captions as the draft sets them: small and quiet, "Table 1 –" in the deep tone. A table's caption goes
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
    #set text(size: 8.5pt, fill: gs-muted)
    #set par(leading: 0.45em)
    #label-text([#it.supplement #context it.counter.display(it.numbering) –], size: 8.5pt, fill: gs-deep, weight: 600)
    #h(3pt)
    #it.body
  ]

  // The contents: chapter lines in bold with the number in the accent, section lines indented under
  // them, a dotted leader, the page number in grey. An entry WITHOUT a number — the figure and table lists
  // — starts at the left edge rather than where the numbered titles start.
  //
  // Every level's number starts exactly where the title of the level above starts: a level is indented by
  // the number columns of the levels before it, and each column is as wide as its deepest number needs
  // ("1", "1.1", "1.1.1"). Set in code mode, so no space slips in between the number column and the title —
  // in markup the line break between the two was one, and it pushed every title a space past the numbers
  // under it.
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
    let list-style(body) = text(weight: 600, fill: gs-deep, body)
    let hang = if prefix == none { 0pt } else if is-heading { num-width } else {
      _list-number-width(it.element, list-style) + 2.5mm
    }
    link(it.element.location(), block(above: above, below: 1.3mm, width: 100%, inset: (left: indent), {
      set text(size: 10pt)
      // A title too long for one line goes on under its own first word, not under its number, and its
      // lines sit as close as the entries do. An explicit paragraph: inline content alone in a block is
      // not one, and a hanging indent only applies to a paragraph.
      par(hanging-indent: hang, leading: 0.45em, {
        if prefix != none and is-heading {
          box(width: hang, if lvl == 1 {
            text(weight: 700, fill: gs-mark)[#prefix]
          } else {
            text(fill: gs-muted)[#prefix]
          })
        } else if prefix != none {
          box(width: hang, list-style(prefix))
        }
        if lvl == 1 and is-heading { text(weight: 700, fill: gs-deep)[#it.body()] } else { text(fill: gs-body)[#it.body()] }
        h(3mm)
        box(width: 1fr, baseline: -2pt, line(length: 100%, stroke: (paint: gs-hair, thickness: 0.5pt, dash: "dotted")))
        h(3mm)
        text(size: 9pt, fill: gs-muted)[#it.page()]
      })
    }))
  }

  // ---- cover page ----------------------------------------------------------
  {
    set page(header: none, footer: none, margin: 0pt)
    let strip-w = 62mm
    let edge-r = 16mm

    // The strip: the ramp from top to foot, and over it four soft patches of its own tones at alternating
    // edges — the light tone in the top corner, the dark one at the foot — which is what turns a fill into
    // light. Each patch is an ellipse given in the strip's width and height, as the draft sizes them.
    {
      let (dark, accent, high, light) = gs-tones
      let patch(tone, x, y, rx, ry, reach) = place(
        top + left, dx: x * strip-w - rx * strip-w, dy: y * 297mm - ry * 297mm,
        rect(
          width: 2 * rx * strip-w, height: 2 * ry * 297mm, stroke: none,
          fill: gradient.radial((tone, 0%), (tone.transparentize(100%), reach), (tone.transparentize(100%), 100%)),
        ),
      )
      place(top + left, block(width: strip-w, height: 297mm, fill: gs-strip, clip: true, {
        patch(light, 0, 0, 1.1, 0.38, 70%)
        patch(high, 1, 0.30, 1.2, 0.40, 70%)
        patch(accent, 0, 0.62, 1.2, 0.42, 72%)
        patch(dark, 1, 1, 1.3, 0.40, 75%)
      }))
    }

    // The logo cards at the top right: white, a hairline, rounded — always white, whatever the paper, so a
    // mark on a transparent background sits on the ground it was designed for. The author's in the corner,
    // the client's beside it. Nothing is drawn where there is no logo.
    let card(img) = box(
      width: 46mm, height: 18mm, fill: white, stroke: 0.5pt + gs-hair, radius: 1.5mm, inset: 3mm,
      align(center + horizon, image(img, height: calc.min(logo-height, 12mm), fit: "contain")),
    )
    if logo != none { place(top + right, dx: -edge-r, dy: 15mm, card(logo)) }
    if client-logo != none {
      place(top + right, dx: if logo != none { -edge-r - 46mm - 5mm } else { -edge-r }, dy: 15mm, card(client-logo))
    }

    // The title: capitals in bold on bars of paper, one per line, starting on the strip. A long title steps
    // down so it still stops above the details; the block is anchored at its top and grows downwards. The
    // character count stands in for the line count — at 40pt about 16 capitals fit a line.
    let n = if type(title) == str { title.clusters().len() } else { 30 }
    let size = if n > 110 { 7mm } else if n > 70 { 9mm } else if n > 40 { 11mm } else { 14mm }
    let title-x = 44mm
    let title-y = 100mm

    // The kind of document over the title, where the subtitle starts: a short run of the ramp and the word.
    if kind != none {
      place(top + left, dx: title-x + 30mm, dy: title-y - 12mm, box[
        #box(width: 9mm, height: 0.6mm, fill: gs-rule, baseline: -0.35em)
        #h(2.5mm)
        #text(font: heading-font, size: 8.5pt, weight: 600, fill: gs-deep, tracking: 0.12em)[#upper(kind)]
      ])
    }

    place(top + left, dx: title-x, dy: title-y, block(width: 210mm - title-x - edge-r)[
      // The bar is the line box of the type: from the descender to just above the capitals, so lines of
      // capitals sit on bars with a narrow gap of paper — or strip — between them.
      #block(width: 100%)[
        #set text(font: heading-font, size: size, weight: 700, fill: gs-title-ink, tracking: 0.01em)
        #set par(leading: 0.72em, justify: false)
        #highlight(fill: gs-paper, top-edge: 1.0em, bottom-edge: -0.3em, extent: 4mm, upper(title))
      ]
      #if subtitle != none {
        block(above: 9mm, inset: (left: 30mm), width: 100%)[
          #block(width: 100mm)[
            #set text(size: 13pt, weight: 500, fill: gs-deep)
            #set par(leading: 0.5em)
            #subtitle
          ]
        ]
      }
    ])

    // The study's details at the foot: two columns behind a rule in the deep tone, label small and grey,
    // value in the deep tone. Two columns, not one row, because the four fields include an address-length
    // organisation and a list of authors.
    if meta.len() > 0 {
      place(bottom + left, dx: 76mm, dy: -24mm, block(
        width: 210mm - 76mm - edge-r, stroke: (left: 0.6mm + gs-deep), inset: (left: 5mm),
        grid(
          columns: (1fr, 1fr),
          column-gutter: 8mm,
          row-gutter: 6mm,
          // Top, spelled out: a grid centres its cells vertically, so an organisation that wraps pushed the
          // label beside it down to its middle. The labels are what a reader scans across.
          align: top + left,
          ..meta.map(((label, value)) => [
            #label-text(label, size: 7.5pt)
            #v(1.2mm, weak: true)
            #text(size: 10pt, weight: 600, fill: gs-deep)[#value]
          ])
        ),
      ))
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

/// Key/value block — used for goal & scope and study metadata. The label in the deep tone and bold, the
/// value in the reading face, a hairline between the pairs.
#let lca-kv(pairs) = block(above: 6pt, below: 12pt)[
  #table(
    columns: (32%, 1fr),
    stroke: (x, y) => (bottom: 0.4pt + prism-line, top: 0pt, left: 0pt, right: 0pt),
    align: top + left,
    inset: (x: 0pt, y: 5pt),
    ..pairs
      .map(p => (
        [#text(size: 9pt, weight: 600, fill: gs-deep)[#p.at(0)]],
        [#text(fill: prism-ink)[#p.at(1)]],
      ))
      .flatten()
  )
]

/// Data table. `align-right` lists the column indices that hold numbers.
#let lca-table(headers, rows, caption: none, align-right: (), label-name: none) = {
  // The draft's table: a solid head in the deep tone with its labels in white, a hairline under every
  // row, no vertical rules, and every second row a shade toward the deep tone.
  let head = headers.enumerate().map(((i, h)) => {
    let cell = text(size: 8pt, weight: 600, fill: gs-on-deep)[#h]
    if align-right.contains(i) { align(right + bottom, cell) } else { align(left + bottom, cell) }
  })
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
  let tbl = {
    // Figures in a column line up digit under digit.
    set text(size: 9pt, number-width: "tabular")
    table(
      // Fractions, never `auto`: `auto` sizes a column to its content, so a header carrying a full
      // ecoinvent method path made the table wider than the text block.
      columns: range(headers.len()).map(i => width-of(i) * 1fr),
      align: left,
      fill: (x, y) => if y == 0 { gs-deep } else if calc.rem(y, 2) == 0 { gs-zebra } else { none },
      stroke: (x, y) => (
        top: 0pt,
        bottom: if y == 0 { 0pt } else { 0.4pt + prism-line },
        left: 0pt, right: 0pt,
      ),
      inset: (x: 5.5pt, y: 4.8pt),
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
