# Results

The Results page compares subjects — processes of this model, scenarios, other models, background
datasets — across LCIA indicators. Three tabs: "Results" (the comparison), "Decomposition tree" (one
subject and one indicator, broken down), and "Sensitivity analysis" (tornado and parameter curve).

## Sub-features

- Subjects: the model's reference process is chosen on arrival; "+ Add from this model", "+ Add from
  other model", "+ Add from database"; scenarios and a Baseline row when the model has scenarios; a
  colour per subject.
- Indicators: "+ Add indicator" opens a picker by method family, with a filter, "Select all" and
  "Deselect all"; chosen indicators show as chips.
- Chart display: values on bars, decimals, difference to a reference subject in %, stacked bars split by
  ISIC, CPC or a tag group.
- Calculate, with progress and Cancel; a score table (click a header to sort) and a bar chart per
  indicator; Radar and Heatmap from two subjects on; "Per indicator" / "Normalized".
- "Save charts" (PNG files) and "Export Excel" (a "Results" sheet, and the inventory as a second sheet "LCI").
- "Life cycle inventory (LCI)", folded at the foot of the page after a calculation: one row per elementary
  flow (flow, compartment, unit), one amount column per subject — the baseline and each scenario side by
  side. A filter, a click on a header sorts, a double-click copies an amount, "Export LCI" writes the rows as
  shown.
- Decomposition tree: method family and indicator, cutoff, depth, group by tag; an SVG tree with zoom,
  "Expand all" / "Collapse all", PNG export; an elementary-flows panel with Excel export.
- Sensitivity analysis: a tornado over the model's parameters and a curve for one parameter, each with
  its own Calculate.

## How to get there

The "Results" row in the navigation (`"role=navigation:Pages >> role=button:Results"`), once a model is
open (without one it is disabled). The page opens on the "Results" tab with the open model's reference
process as the subject. Each tab keeps its settings per model.

## Driving it with control-prism

Compare the seeded `bottle` model (see model.md) on one indicator:

```sh
node scripts/control-prism.mjs click "role=navigation:Pages >> role=button:Results"
node scripts/control-prism.mjs wait visible "role=tab:Results"
node scripts/control-prism.mjs click "role=button:/^Indicators/"
node scripts/control-prism.mjs click "role=button:+ Add indicator"
node scripts/control-prism.mjs select "css=select.ind-family" "IPCC 2021"
node scripts/control-prism.mjs click "role=button:+ ★ climate change / global warming potential (GWP100) kg CO2-Eq"
node scripts/control-prism.mjs click "role=button:Done"
node scripts/control-prism.mjs click "role=button:Calculate >> visible"
node scripts/control-prism.mjs wait text "css=.calc-stale >> visible" "Computed" --timeout 120000
node scripts/control-prism.mjs snapshot --target "css=table.results-table >> visible"
```

The table's rows are named by subject and score (`row "bottle 4.00"`), so a value can be checked with
`wait visible "role=row:bottle 4.00"`.

The inventory of the same run sits folded under the charts:

```sh
node scripts/control-prism.mjs click "role=button:/^Life cycle inventory/"
node scripts/control-prism.mjs snapshot --target "role=table:Life cycle inventory"
```

Its rows are named by flow, compartment, unit and one amount per subject, so an amount can be checked the
same way (`wait visible "role=row:/^Carbon dioxide, fossil air/"`).

- Tabs: `"role=tab:Results"`, `"role=tab:Decomposition tree"`, `"role=tab:Sensitivity analysis"`.
- The rail's groups are buttons whose name starts with the group: `"role=button:/^Subjects/"`,
  `"role=button:/^Chart display/"`, `"role=button:/^Indicators/"`.
- Indicator rows are buttons named "+ <indicator> <unit>" (with ★ for recommended ones, ✓ once chosen);
  the family chooser is `"css=select.ind-family"`, the filter `"placeholder=Filter indicators…"`.
- `"role=button:Save charts"` and `"role=button:Export Excel"` are disabled until there is a result.
- LCI table: the header toggles with `"role=button:/^Life cycle inventory/"` (its name ends with the flow
  count); the column heads are buttons named by the column — `"role=button:Flow"`, `"role=button:Unit"`, or
  a subject's label — and sort on each click (ascending, descending, back to name order); the filter is
  `"placeholder=Filter flows…"`, the export `"role=button:Export LCI"`. Only the first 200 rows of the filtered
  and sorted list are drawn; `"role=button:/^Show all/"` draws the rest (the export writes them all anyway).
- Decomposition tree: the subjects are radios, one per process of this model on its list (it starts
  with the model's first reference process; "+ Add from this model" adds others);
  `"role=button:/^Impact category/"` opens the group with `"role=combobox:Method family"` and
  `"role=combobox:Indicator"`; after Calculate, `"role=button:Expand all"`, `"Zoom in"`, `"Zoom out"`,
  `"Fit to view"`, and the tree's summary line `"css=.ctree3-meta"`.

## Gotchas

- **Two tabs have a "Calculate" button,** and a tab once visited stays in the page, hidden: add
  `>> visible` (as above) or scope to the visible tab.
- **Only one rail group is open at a time,** and the controls of a closed group are not in the page:
  open the group first.
- **Charts are drawn on a canvas,** so they are not in the accessibility tree: check the table, or the
  tree's summary line, not the bars.
- Radar and Heatmap appear only with two subjects or more, and the heatmap is a second
  `table.results-table`: narrow to `"css=table.results-table:not(.heatmap) >> visible"`.
- After any change to the model, its parameters or scenarios, the shown result is outdated (a banner,
  and the status line "Selection changed — shown results are outdated."): calculate again.
- The page remembers the chosen indicators and display options per model and in the window's storage,
  so a second run in the same session may not start from the defaults.
- "Export Excel" downloads `prism-results.xlsx` into the session's download folder
  (`wait download /\.xlsx$/`), "Export LCI" `prism-lci.xlsx`. "Save charts" writes one PNG per chart there too, with no folder dialog —
  in normal use it asks for a folder.
- Clicking the Results row in the navigation always opens the "Results" tab, whichever tab was open.
- The LCI section is there only once a run has finished and remembers whether it was left open; its rows are
  not in the page while it is folded. A subject's label is also a column head, so `"role=button:<label>"` can
  match its row in the Subjects group too: narrow with `"role=table:Life cycle inventory >> role=button:…"`.
