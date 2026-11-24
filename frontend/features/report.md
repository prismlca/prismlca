# Report

The Report page has two tabs. "Full reports (AI)" are stored reports whose chapters the AI writer drafts;
"Short reports (w/o AI)" are built from the model's data alone, every time, and are not stored. This page
maps the short report; writing a full report costs money and is not driven in a check.

## Sub-features

- Short report: title and language; subject (reference process, amount of the functional unit, scenarios
  to compare with); indicators (a family chooser and tick boxes); breakdown and charts; contents (which
  chapters); appearance (theme and palette).
- "Generate" typesets it into a preview with page navigation and zoom; "Save PDF" writes the file.
- Full reports: create, delete, update data, export sources, preview, render PDF — the chapters
  themselves are written by the AI writer.

## How to get there

The "Report" row in the navigation, once a model is open. The page opens on "Full reports (AI)".

## Driving it with control-prism

A short report of the seeded `bottle` model (see model.md) on GWP100, saved as PDF:

```sh
node scripts/control-prism.mjs click "css=.navitem >> has-text=Report"
node scripts/control-prism.mjs click "role=tab:Short reports (w/o AI)"
node scripts/control-prism.mjs select "role=combobox:Reference process" bottle
node scripts/control-prism.mjs click "role=button:/^Indicators/"
node scripts/control-prism.mjs click "role=button:+ Add indicator >> visible"
node scripts/control-prism.mjs select "role=combobox:Method family >> visible" "IPCC 2021"
node scripts/control-prism.mjs click "role=checkbox:★ climate change / global warming potential (GWP100) kg CO2-Eq"
node scripts/control-prism.mjs click "role=button:Done"
node scripts/control-prism.mjs click "role=button:Generate"
node scripts/control-prism.mjs wait enabled "role=button:Save PDF" --timeout 300000
node scripts/control-prism.mjs click "role=button:Save PDF"
node scripts/control-prism.mjs wait download "/\.pdf$/"
```

The PDF lands in the session's download folder as "<model> — LCA report.pdf"; `pdftotext` shows its
numbers (the result table reads "climate change / global warming potential (GWP100) kg CO2-Eq 2" for the
recipe in model.md). Doubling "Amount (functional unit)" doubles them.

- The rail's groups are buttons whose name starts with the group, as on the Results page:
  `"role=button:/^Subject/"`, `"role=button:/^Indicators/"`; one is open at a time.
- The preview is images of the pages (`"role=img:/^Page 1 of/"`), so its text is not in the
  accessibility tree: check the saved PDF.
- `"role=spinbutton:Amount (functional unit)"` takes the amount; scenarios to compare are tick boxes
  named by the scenario.

## Gotchas

- **The reference process starts on the model's first reference candidate,** which is not always the
  one the Results page uses: choose it.
- The indicator picker here has tick boxes, unlike the Results page's "+ …" buttons.
- Generating takes a few seconds; wait for "Save PDF" to become enabled, not on time.
- "Upload" in the title-page settings opens a file dialog: manual. Full reports' writing costs money:
  not driven.
