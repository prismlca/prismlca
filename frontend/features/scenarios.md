# Scenarios

The Scenarios page: named sets of parameter overrides laid over the open model's baseline. A scenario
changes nothing in the model; the Results page and reports calculate it beside the baseline.

## Sub-features

- "Scenario" opens the editor: name, description, and every parameter with a tick box and an override
  (a number or a formula). Create stays disabled while an override breaks its parameter's allowed
  values; an override equal to the baseline is refused with a reason.
- The list on the left; selecting a scenario shows its overrides ("mass 4 kg → 8 kg") in the side panel.
- Per scenario: "Edit scenario" (changes are stored as they are made, there is no Save), "Duplicate
  scenario", "Delete scenario" (with a confirmation; Undo brings it back).
- "Template" downloads an Excel template; "Import" reads one back (a file dialog).

## How to get there

The "Scenarios" row in the navigation, once a model is open. Without parameters the editor has nothing
to tick: add them on the Parameters page first.

## Driving it with control-prism

A scenario that doubles `mass` (see parameters.md, `mass` = 4), compared on the Results page:

```sh
node scripts/control-prism.mjs click "css=.navitem >> has-text=Scenarios"
node scripts/control-prism.mjs click "role=button:Scenario"
node scripts/control-prism.mjs type "role=textbox:Name" heavy
node scripts/control-prism.mjs click "role=checkbox:/^mass/"
node scripts/control-prism.mjs type "css=.modal-backdrop >> role=textbox:mass override" 8
node scripts/control-prism.mjs click "css=.modal-backdrop >> role=button:Create"
node scripts/control-prism.mjs wait hidden "css=.modal-backdrop"
node scripts/control-prism.mjs click "text=/^heavy$/ >> nth=0"
node scripts/control-prism.mjs wait text "css=.scen-side" "/→\s*8 kg/"
node scripts/control-prism.mjs click "css=.navitem >> has-text=Results"
node scripts/control-prism.mjs wait visible "role=tab:Results"
node scripts/control-prism.mjs click "role=checkbox:/ heavy$/"
node scripts/control-prism.mjs click "role=button:/^Indicators/"
node scripts/control-prism.mjs click "role=button:+ Add indicator"
node scripts/control-prism.mjs select "css=select.ind-family" "IPCC 2021"
node scripts/control-prism.mjs click "role=button:+ ★ climate change / global warming potential (GWP100) kg CO2-Eq"
node scripts/control-prism.mjs click "role=button:Done"
node scripts/control-prism.mjs click "css=.results-rail >> role=button:Calculate"
node scripts/control-prism.mjs wait visible "role=row:/^heavy 8\.0+$/" --timeout 120000
```

Edit it, then take the edit back:

```sh
node scripts/control-prism.mjs click "css=.navitem >> has-text=Scenarios"
node scripts/control-prism.mjs click "text=/^heavy$/ >> nth=0"
node scripts/control-prism.mjs click "css=.scen-side >> role=button:Edit scenario"
node scripts/control-prism.mjs type "css=.modal-backdrop >> role=textbox:mass override" 12 --commit
node scripts/control-prism.mjs press Escape
node scripts/control-prism.mjs wait text "css=.scen-side" "/→\s*12 kg/"
node scripts/control-prism.mjs click "role=button:Undo"
```

- A parameter's tick box is named by the parameter, its baseline and its override
  (`"role=checkbox:/^mass 4 kg/"`); a regex on the start is steadier.
- The override field is named "<parameter> override", disabled and ticked alike (a parameter with a list
  rule has a dropdown of that name instead): scope it to the dialog.
- The side panel is `"css=.scen-side"`; it carries the overrides and the audit log. The list rows and
  the side panel both have Edit, Duplicate and Delete — scope to `.scen-side` for the selected one.
- The editor has two buttons named Close (✕ and the one at the bottom): Escape is simpler.

## Gotchas

- **One edit and Escape (or ✕, or a click beside the dialog) stores the edit twice** in the audit log:
  the first Undo then changes nothing visible, the second takes the edit back. Count Undo steps
  accordingly.
- Edits are stored about half a second after typing stops; closing the editor sends a pending one at
  once. Wait on the side panel's text, not on the dialog.
- The Results page shows a scenario under the model's selected process; after an edit there, its
  result is outdated until Calculate.
- "Template" lands in the session's download folder (`wait download /\.xlsx$/`); "Import" needs a file
  dialog: manual.
