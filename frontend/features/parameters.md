# Parameters

The Parameters page: the open model's named values — a mass, a distance, a rate — that exchange
formulas use. A parameter has a value or a formula of its own, a unit, a comment, an allowed range and
a group; "Used by" lists the processes and parameters that read it.

## Sub-features

- "Parameter" opens the add form (name, value or formula, unit, group, allowed values); it stays open
  for the next one until Cancel. A name the model already has is refused there ("… already exists —
  edit it in its row"); the form creates and never overwrites.
- In a row: the value field (Enter stores it), "Edit parameter" (formula, unit, comment, allowed
  values), "Delete parameter" (with a confirmation; refused while a formula or scenario uses it — the
  refusal names the page where that use is changed),
  "Add a comment…", and the "Used by" links.
- Allowed values: any number, only positive, only negative, a range, or a list. A value outside is
  refused at the field.
- Groups: "Group" creates one; a group's heading folds it, adds a parameter to it, renames or deletes it
  (its parameters move to Ungrouped). A row moves into a group by dragging its name onto the group.
- "Search parameters…" filters the rows; "Recalculate" re-evaluates every formula.
- A formula on an exchange (the fx toggle in the Model page's inspector) names a parameter; an unknown
  name is refused with a suggestion ("did you mean …").

## How to get there

The "Parameters" row in the navigation, once a model is open (without one it is greyed out).

## Driving it with control-prism

Bind the seeded `bottle` model's CO2 (see model.md) to a parameter and double it:

```sh
node scripts/control-prism.mjs click "css=.navitem >> has-text=Parameters"
node scripts/control-prism.mjs click "role=button:Parameter"
node scripts/control-prism.mjs type "role=textbox:Name" mass
node scripts/control-prism.mjs type "role=textbox:Value" 2
node scripts/control-prism.mjs type "role=textbox:Unit" kg
node scripts/control-prism.mjs click "role=button:Add parameter"
node scripts/control-prism.mjs click "role=button:Cancel"
node scripts/control-prism.mjs click "css=.navitem >> has-text=Model"
node scripts/control-prism.mjs click "css=.react-flow__node >> has-text=bottle"
node scripts/control-prism.mjs click "role=tab:/Outputs/"
node scripts/control-prism.mjs click "css=.flow-list >> role=button:fx"
node scripts/control-prism.mjs type "placeholder=e.g. mass * (1 - recycled_share)" mass --enter
node scripts/control-prism.mjs wait attr "role=button:Undo" title "/Set formula/"
node scripts/control-prism.mjs click "css=.navitem >> has-text=Parameters"
node scripts/control-prism.mjs type "css=.prow input.num" 4 --enter
node scripts/control-prism.mjs wait attr "role=button:Undo" title "/mass' = 4/"
node scripts/control-prism.mjs click "css=.navitem >> has-text=Model"
node scripts/control-prism.mjs click "css=.react-flow__node >> has-text=bottle"
node scripts/control-prism.mjs click "role=button:/^(Calculate|Compute LCIA)$/"
node scripts/control-prism.mjs wait text "css=.result-bar b >> nth=0" "/^4(\.0+)? kg/"
```

The refusal, and a formula parameter:

```sh
node scripts/control-prism.mjs click "css=.navitem >> has-text=Parameters"
node scripts/control-prism.mjs click "Delete parameter"
node scripts/control-prism.mjs click "css=.modal-backdrop >> role=button:Delete"
node scripts/control-prism.mjs wait visible "text=/Not deleted: 'mass' is still used/"
node scripts/control-prism.mjs click "role=button:Parameter"
node scripts/control-prism.mjs type "role=textbox:Name" mass
node scripts/control-prism.mjs wait visible "text=/mass. already exists/"
node scripts/control-prism.mjs type "role=textbox:Name" co2
node scripts/control-prism.mjs type "role=textbox:Or formula" "mass * 1.5"
node scripts/control-prism.mjs click "role=button:Add parameter"
node scripts/control-prism.mjs wait text "css=.prow >> has-text=ƒ" "/co2\s*6\s*ƒ/"
```

A group, and a parameter dragged into it:

```sh
node scripts/control-prism.mjs click "role=button:Group"
node scripts/control-prism.mjs type "placeholder=Group name…" Transport --enter
node scripts/control-prism.mjs wait visible "css=.pgrp-head >> has-text=Transport"
node scripts/control-prism.mjs drag "css=.pc-name[title=mass]" "css=.pgrp >> has-text=Transport >> css=.pgrp-head"
node scripts/control-prism.mjs wait attr "role=button:Undo" title "/Move parameter 'mass' to group 'Transport'/"
```

- The value field in a row has no name: `"css=.prow input.num"`, narrowed with `has-text=` once
  there are several (`"css=.prow >> has-text=kg >> css=input.num"`). A formula parameter shows its value
  and "ƒ = …" as text, with no field.
- Row buttons: `"Edit parameter"`, `"Delete parameter"`; group headings: `"Delete group"`,
  `"Rename group"`, `"Add parameter to group"`. The group form is `"placeholder=Group name…"`, Enter
  creates it.
- A row drags only from its name (`"css=.pc-name[title=mass]"`), not from its value field; drop it on
  the group's heading. `has-text=mass` would also match a row whose formula reads `mass`.
- In the edit form, `"role=combobox:Allowed"` picks the rule; a refused value is not stored, and the
  note under the row names it and the rule ("Not stored: “-1” must be greater than 0.").

## Gotchas

- After a refused value the field shows the stored value again, and the note under the row stays until
  the next edit.
- Undo's title is the backend's confirmation of a stored value, as on the Model page: wait for it.
- A changed parameter makes the Model page's result stale: Calculate again before reading it.
