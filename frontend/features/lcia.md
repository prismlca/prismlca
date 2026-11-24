# LCIA

The LCIA page: the impact methods of this workspace. "Compare factors" puts up to three indicators of one
family side by side, flow by flow; "Manage methods" makes and edits methods of your own. The shipped
methods are read-only.

## Sub-features

- Compare factors: a family list, its indicators (pick up to three), the family's description and
  reference link, and a table of characterisation factors with "Filter flows…", sortable columns and
  "Export" (an Excel file).
- Manage methods: "New method" (an empty indicator in a family of your own), "Duplicate method" (copy
  shipped indicators into your family), "New family"; per family "Edit family" and "Delete family", per
  method "Rename method" and Delete (with a confirmation that says it cannot be undone).
- A custom method's factor table: change a factor in place, "Add a flow — search biosphere…", remove a
  flow. Custom methods appear in every method chooser of the app, at the end.

## How to get there

The "LCIA" row in the navigation. It works without an open model.

## Driving it with control-prism

Look up a factor whose value is known — CO2 counts 1 in every GWP:

```sh
node scripts/control-prism.mjs click "css=.navitem >> has-text=LCIA"
node scripts/control-prism.mjs select "role=listbox" "IPCC 2021"
node scripts/control-prism.mjs click "role=button:+ ★ climate change / global warming potential (GWP100) kg CO2-Eq"
node scripts/control-prism.mjs type "placeholder=Filter flows…" "carbon dioxide, fossil"
node scripts/control-prism.mjs wait visible "role=row:/^Carbon dioxide, fossil air kilogram 1$/"
node scripts/control-prism.mjs click "role=button:Export"
node scripts/control-prism.mjs wait download "/\.xlsx$/"
```

A copy of GWP100 that counts CO2 twice:

```sh
node scripts/control-prism.mjs click "role=tab:Manage methods"
node scripts/control-prism.mjs click "role=button:Duplicate method"
node scripts/control-prism.mjs select "role=combobox:From family" "IPCC 2021"
node scripts/control-prism.mjs type "css=.modal-backdrop >> placeholder=Filter indicators…" GWP100
node scripts/control-prism.mjs click "css=.modal-backdrop >> role=checkbox:climate change / global warming potential (GWP100) kg CO2-Eq"
node scripts/control-prism.mjs type "role=textbox:/^Name for/" "GWP100 doubled CO2"
node scripts/control-prism.mjs click "role=button:/^Duplicate \d/"
node scripts/control-prism.mjs wait hidden "css=.modal-backdrop" --timeout 60000
node scripts/control-prism.mjs type "role=row:/^Carbon dioxide, fossil air [0-9.]+ Remove flow$/ >> role=textbox" 2 --commit
node scripts/control-prism.mjs click "css=.navitem >> has-text=Model"
node scripts/control-prism.mjs select "LCIA method" "★ My methods · GWP100 doubled CO2"
node scripts/control-prism.mjs click "css=.react-flow__node >> has-text=bottle"
node scripts/control-prism.mjs click "role=button:/^(Calculate|Compute LCIA)$/"
node scripts/control-prism.mjs wait text "css=.result-bar b >> nth=0" "/^4(\.0+)? kg/"
```

With the recipe in model.md (2 kg of CO2) the copy gives 4 kg CO2-Eq, twice the GWP100 result.

- Tabs: `"role=tab:Compare factors"`, `"role=tab:Manage methods"`. The family list is a listbox without
  a name: `"role=listbox"` (one on the page).
- Indicators to compare are buttons "+ <indicator> <unit>" (with ★ for recommended ones, ✓ once chosen);
  `"Remove indicator"` (×) takes one off.
- The duplicate dialog's indicators are checkboxes named "<indicator> <unit>", with the indicator named as
  on Compare factors. Each ticked one gets a field `"role=textbox:/^Name for/"`, pre-filled with the same
  parts joined by a dash: "climate change: biogenic – global warming potential (GWP100)".
- The factor table's rows are named "<flow> <compartment> <unit> <factor>…", so a value can be checked
  with `wait visible "role=row:…"`. In a custom method the row's name ends in the factor and
  "Remove flow".
- New method: `"role=textbox:Indicator name"`, `"role=textbox:Unit (e.g. kg CO2-eq)"`, family field
  pre-filled with "My methods". Create stays disabled while the name or the family is empty. A taken
  name keeps the dialog open with the reason as `"role=alert"` inside it; the same holds for New family,
  Edit family, Rename method and Duplicate (where copies already made leave the selection).

## Gotchas

- **A factor is stored when its field loses the focus** (Enter or Tab), not while typing, and its row's
  name carries the value: name the row with a pattern over the number, as above, and use
  `type … --commit`. A row named with the old value is gone once the field changes. The page has no Undo
  button; a calculation shows the effect.
- **An indicator is named by its category where that names one indicator, by the whole path below the
  family where it does not** — EF v3.1's GWP100 is "climate change", IPCC 2021's is "climate change /
  global warming potential (GWP100)", one of eight GWP100s there. Both tabs and the copy's default name
  follow that rule, so a target that names the last part alone finds nothing.
- **Deleting a custom method shifts the Model page's method choice** to the next method in the list (or
  back to the first of all). Check the Model page's chooser after deleting one.
- An empty filter result shows "0 of … flows" and an empty table.
- The method reference links open a browser.
