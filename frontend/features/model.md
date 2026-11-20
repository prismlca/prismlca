# Model

The Model page: the toolbar with the model and method choosers, the process canvas, the search panel on
the left, and the inspector on the right. A model is one foreground database; its processes are the
boxes on the canvas.

## Sub-features

- Create a model (empty, or a duplicate of another), switch the active model, open Model info.
- Add a process (toolbar, or right-click on the empty canvas → "＋ New process here"); edit its name,
  description, location, classification (ISIC, CPC) and reference product in the inspector.
- Inputs and outputs of the selected process: two tabs, "+ Add input flow" / "+ Add output flow" through
  the flow picker, amounts with a formula toggle (fx), a comment per flow, remove.
- Link a background dataset: search in the left panel, "Select" places it as a locked reference box;
  "Localize (edit)" in its context menu makes an editable copy.
- Link two boxes by dragging from one box's right handle to another's left handle (an "Add exchange"
  dialog asks for the amount); click an arrow to edit its amount.
- Canvas tools: auto-layout, pan mode, tag highlight, colour brush, groups, expand/collapse upstream.
- Calculate the selected process with the chosen LCIA method; the result bar above the canvas shows the
  score and turns "Outdated" after any change to the model.
- Undo and Redo of every stored step; the audit log under the inspector lists them.
- Delete a process (Delete/Backspace or the context menu, with a confirmation; a second one when other
  processes use it).

## How to get there

Open a model: click its card on the Overview, or the "Model" row in the navigation once a model exists.
The toolbar's "Model" button (title "Create another model, or duplicate an existing one") creates one;
the "Process" button adds a process. Calculate sits at the right end of the toolbar.

Keys: Delete or Backspace deletes the selected processes, Control+Z undoes, Control+Shift+Z or Control+Y
redoes, Escape leaves pan mode and closes canvas menus — none of them while a text field has the focus
or a modal is open.

## Driving it with control-prism

A model with one process that emits 2 kg of fossil CO2, calculated with GWP100, on a seeded instance:

```sh
node scripts/control-prism.mjs launch --seed
node scripts/control-prism.mjs doctor
node scripts/control-prism.mjs click "title=Create another model, or duplicate an existing one >> nth=0"
node scripts/control-prism.mjs type "label=Model name (e.g. pet-bottle-2025)" bottle --enter
node scripts/control-prism.mjs wait hidden "css=.modal-backdrop"
node scripts/control-prism.mjs click "title=Add a new process to the model"
node scripts/control-prism.mjs type "label=Name" bottle --enter
node scripts/control-prism.mjs wait visible "css=.react-flow__node >> has-text=bottle"
node scripts/control-prism.mjs click "role=tab:/Outputs/"
node scripts/control-prism.mjs click "role=button:+ Add output flow"
node scripts/control-prism.mjs type "css=.flowpick-search" "carbon dioxide, fossil"
node scripts/control-prism.mjs click "role=button:Carbon dioxide, fossil air kilogram"
node scripts/control-prism.mjs type "role=textbox:Amount" 2
node scripts/control-prism.mjs click "role=button:Add"
node scripts/control-prism.mjs wait hidden "css=.flowpick-modal"
node scripts/control-prism.mjs select "LCIA method" "★ CML v4.8 2016 · climate change · global warming potential (GWP100)"
node scripts/control-prism.mjs click "role=button:/^(Calculate|Compute LCIA)$/"
node scripts/control-prism.mjs wait text "css=.result-bar b >> nth=0" "/^2(\.0+)? kg/"
```

Change an amount and see the backend store it, then the result go stale:

```sh
node scripts/control-prism.mjs type "css=.flow-list .flow >> has-text=Carbon dioxide >> css=input >> nth=0" 4 --enter
node scripts/control-prism.mjs wait attr "role=button:Undo" title "/Set amount .* to 4/"
node scripts/control-prism.mjs wait visible "css=.result-bar.stale"
```

Survive a restart — the model comes back, the selection and the undo history do not:

```sh
node scripts/control-prism.mjs restart
node scripts/control-prism.mjs wait app-ready
node scripts/control-prism.mjs click "css=.navitem >> has-text=Model"
node scripts/control-prism.mjs select "Active model" bottle
node scripts/control-prism.mjs click "css=.react-flow__node >> has-text=bottle"
```

- Toolbar: `"Active model"` and `"LCIA method"` are the two choosers; `"Model info"`, `"Export model"`,
  `"Dark mode"` are named buttons; `"role=button:Undo"` and `"role=button:Redo"` carry the step they
  would take back in their title ("Undo: Set amount … (Ctrl+Z)", or "Nothing to undo").
- Boxes: `"css=.react-flow__node >> has-text=<name>"`; a selected box has the class `sel`, a locked
  background reference `external`. Inside a box: `"title=Assign tags"`, `"title=Colour-code this process"`.
- Inspector: `"role=tab:/Inputs/"`, `"role=tab:/Outputs/"` (the tab names carry a count), a flow's
  amount field `"css=.flow-list .flow >> has-text=Carbon dioxide >> css=input >> nth=0"`, and
  `"role=button:Comment on this flow"`. The Name and Description fields have no accessible name yet:
  `"css=.efield:has(label:text-is('Name')) input"`.
- Flow picker: `"css=.flowpick-modal"`, its search field `"css=.flowpick-search"`, each flow a button
  named "<name> <compartment> <unit>", the amount `"role=textbox:Amount"`, `"role=button:Add"`, and
  `"Close"`.
- Search panel: `"placeholder=e.g. electricity"`, `"role=button:Search"`, a database's checkbox by its
  name, and on each hit `"role=button:Select"` (scope it to the hit: several are on screen).

## Gotchas

- **Calculate needs exactly one selected process** and at least one method; otherwise it is disabled and
  its title says why ("Select one process as the functional unit"). After a restart nothing is selected:
  click the box first.
- **Fields commit on Enter or when the focus leaves them**, not while typing: use `type … --enter` for
  amounts, `type … --commit` for names and descriptions. What the field shows afterwards is not yet
  stored; wait for the Undo button's title to name the step — that is the backend's confirmation.
- **A result after an edit is stale** until calculated again: the bar gets the class `stale` and says
  "Outdated — recalculate". Calculate once and wait for the value; a check that accepts the stale value
  proves nothing.
- The Inputs tab is open after every selection change; switch to Outputs before adding an output.
- Selecting another box rebuilds the inspector: text typed but not committed is lost.
- The method chooser lists hundreds of methods; `select` takes the exact label or a `/regex/` that
  matches exactly one. A changed choice may read back the old value for a moment — wait on its effect.
- Dragging a search hit onto the canvas and dragging between handles need a real pointer drag, which
  control-prism does not drive yet: place datasets with the hit's "Select" button. Linking two of your
  own processes by drag is manual for now.
- "Export model" and workspace backups open native save dialogs: manual.
- Delete and Control+Z do nothing while a modal is open or a field has the focus — press Escape or
  click the canvas first.
