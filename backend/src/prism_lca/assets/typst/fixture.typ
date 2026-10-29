// Template self-test. Compiled against a template BEFORE it is used for a real report: it exercises
// every part of the contract, so a broken or incomplete custom template is rejected with the
// compiler's own message instead of destroying someone's report.
//
// Kept deliberately small — this has to compile in milliseconds.
#import "template.typ": *

#show: lca-report-template.with(
  title: "Template self-test",
  subtitle: "Every element of the contract, once",
  author: "PrismLCA",
  meta: (("Author", "PrismLCA"), ("Commissioned by", "—"), ("Date", "2026-01-01")),
  lang: "en",
)

// Both spellings the renderer uses: bare, and with the three named switches a report's options
// send — a template whose lca-outlines takes no arguments compiled here and failed on the report.
#lca-outlines()
#lca-outlines(contents: true, figures: false, tables: true)

= Headings and prose
== Second level
=== Third level

Body text with #strong[bold], #emph[italic] and a raw span: #raw("kg CO2-eq").
A cross-reference to a table (@t-fixture), a captionless one (@t-fixture-bare) and a figure (@f-fixture) must resolve.

= Key/value block
#lca-kv((
  ("Functional unit", "1 kg of product at factory gate"),
  ("System boundaries", "Cradle to gate"),
))

= Table
#lca-table(
  ("Indicator", "Unit", "Score"),
  (("Climate change", "kg CO2-eq", "1.234"), ("Acidification", "kg SO2-eq", "0.0567")),
  caption: [Impact assessment results],
  align-right: (2,),
  label-name: "t-fixture",
)

// The same call shape a report makes through `ptable` in main.typ: headers and rows read from JSON
// (`tables.json` in an export) rather than written as literals, and no caption. A theme receives the
// same values either way; this keeps it that way.
#let _fixture-table = json(bytes("{\"headers\": [\"Group\", \"Share\"], \"rows\": [[\"Packaging\", \"60 %\"]]}"))
#lca-table(_fixture-table.headers, _fixture-table.rows, label-name: "t-fixture-data")

// A table without a caption that the text cites (the glossary: @t-fixture-bare). Themes print such a
// table bare, so `ptable` wraps it in a table figure to give the reference a target; the theme's bare
// table has to survive being wrapped.
#figure(lca-table(("Abbreviation", "Meaning"), (("GWP", "Global warming potential"),), label-name: "t-fixture-bare"), kind: table) <t-fixture-bare>

= Figure
#lca-figure("fixture-figure.svg", caption: [A figure], width: 40%, label-name: "f-fixture")
