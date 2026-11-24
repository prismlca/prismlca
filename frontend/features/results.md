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
- "Save charts" (PNG files) and "Export Excel".
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

- Tabs: `"role=tab:Results"`, `"role=tab:Decomposition tree"`, `"role=tab:Sensitivity analysis"`.
- The rail's groups are buttons whose name starts with the group: `"role=button:/^Subjects/"`,
  `"role=button:/^Chart display/"`, `"role=button:/^Indicators/"`.
- Indicator rows are buttons named "+ <indicator> <unit>" (with ★ for recommended ones, ✓ once chosen);
  the family chooser is `"css=select.ind-family"`, the filter `"placeholder=Filter indicators…"`.
- `"role=button:Save charts"` and `"role=button:Export Excel"` are disabled until there is a result.
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
  (`wait download /\.xlsx$/`). "Save charts" writes one PNG per chart there too, with no folder dialog —
  in normal use it asks for a folder.
- Clicking the Results row in the navigation always opens the "Results" tab, whichever tab was open.
