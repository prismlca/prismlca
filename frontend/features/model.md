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
- Link a background dataset: search in the left panel, "Select" places it as a locked reference box,
  and dragging the hit onto the canvas places it where it is dropped; "Localize (edit)" in its context
  menu makes an editable copy.
- Link two boxes by dragging from one box's right handle to another's left handle (an "Add exchange"
  dialog asks for the amount); click an arrow to edit its amount. Dragging a box moves it.
- Canvas tools: auto-layout, pan mode, tag highlight, colour brush, groups, expand/collapse upstream.
- Calculate the selected process with the chosen LCIA method; the result bar above the canvas shows the
  score and turns "Outdated" after any change to the model. Each model keeps its own method across
  restarts; a model nobody chose one for starts on climate change of the newest EF family.
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
node scripts/control-prism.mjs wait hidden "role=dialog:New model"
node scripts/control-prism.mjs click "title=Add a new process to the model"
node scripts/control-prism.mjs type "label=Name" bottle --enter
node scripts/control-prism.mjs wait hidden "role=dialog:New process"
node scripts/control-prism.mjs wait visible "css=.react-flow__node >> has-text=bottle"
node scripts/control-prism.mjs click "role=tab:/Outputs/"
node scripts/control-prism.mjs click "role=button:+ Add output flow"
node scripts/control-prism.mjs type "css=.flowpick-search" "carbon dioxide, fossil"
node scripts/control-prism.mjs click "role=button:Carbon dioxide, fossil air kilogram"
node scripts/control-prism.mjs type "role=textbox:Amount" 2
node scripts/control-prism.mjs click "role=button:Add"
node scripts/control-prism.mjs wait hidden "role=dialog:Add output flow"
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

Survive a restart — the model and its LCIA method come back, the selection and the undo history do not:

```sh
node scripts/control-prism.mjs restart
node scripts/control-prism.mjs wait app-ready
node scripts/control-prism.mjs click "role=navigation:Pages >> role=button:Model"
node scripts/control-prism.mjs select "Active model" bottle
node scripts/control-prism.mjs wait text "css=select[aria-label='LCIA method'] >> css=option:checked" "/CML v4.8 2016 · climate change/"
node scripts/control-prism.mjs click "css=.react-flow__node >> has-text=bottle"
```

Link two boxes by drag — a second process "glass" into "bottle" — and see the link stored:

```sh
node scripts/control-prism.mjs click "title=Add a new process to the model"
node scripts/control-prism.mjs type "label=Name" glass --enter
node scripts/control-prism.mjs wait visible "css=.react-flow__node >> has-text=glass"
node scripts/control-prism.mjs drag "css=.react-flow__node >> has-text=glass >> css=.react-flow__handle-right" "css=.react-flow__node >> has-text=bottle >> css=.react-flow__handle-left"
node scripts/control-prism.mjs wait visible "role=dialog:Add exchange"
node scripts/control-prism.mjs type "role=dialog:Add exchange >> role=spinbutton" 3
node scripts/control-prism.mjs click "role=dialog:Add exchange >> role=button:Add"
node scripts/control-prism.mjs wait attr "role=button:Undo" title "/Add input 'glass' \(3 unit\) to 'bottle'/"
```

Drop a search hit onto the canvas — it lands as a locked reference box with its top-left corner at the
drop point:

```sh
node scripts/control-prism.mjs type "placeholder=e.g. electricity" widget
node scripts/control-prism.mjs click "role=button:Search"
node scripts/control-prism.mjs wait visible "css=.res >> has-text=Test widget, at plant" --timeout 240000
node scripts/control-prism.mjs drag "css=.res >> has-text=Test widget, at plant" "css=.react-flow__pane" --to-offset 120,120
node scripts/control-prism.mjs wait visible "css=.pnode.external >> has-text=Test widget"
```

Tag a box — a tag group with one tag, chosen in the box's tag menu — and close the menu again:

```sh
node scripts/control-prism.mjs click "css=.react-flow__node >> has-text=bottle >> title=Assign tags"
node scripts/control-prism.mjs type "placeholder=New group (e.g. \"Life-cycle phase\")…" "Life-cycle phase" --enter
node scripts/control-prism.mjs click "title~=Add a tag to \"Life-cycle phase\""
node scripts/control-prism.mjs type "placeholder~=New tag for" Production --enter
node scripts/control-prism.mjs select "css=.tagmenu-row >> has-text=Life-cycle phase >> role=combobox" Production
node scripts/control-prism.mjs wait visible "css=.react-flow__node >> has-text=bottle >> has-text=Production"
node scripts/control-prism.mjs press Escape
node scripts/control-prism.mjs wait hidden "css=.tagmenu"
```

- Toolbar: `"Active model"` and `"LCIA method"` are the two choosers; `"Model info"`, `"Export model"`,
  `"Dark mode"` are named buttons; `"role=button:Undo"` and `"role=button:Redo"` carry the step they
  would take back in their title ("Undo: Set amount … (Ctrl+Z)", or "Nothing to undo").
- Boxes: `"css=.react-flow__node >> has-text=<name>"`; inside it, `.pnode` carries the class `sel` when
  the box is selected and `external` when it is a locked background reference. Inside a box:
  `"title=Assign tags"`, `"title=Colour-code this process"`, and the two link handles
  `"css=.react-flow__handle-left"` (in) and `"css=.react-flow__handle-right"` (out).
- Inspector: `"role=tab:/Inputs/"`, `"role=tab:/Outputs/"` (the tab names carry a count), a flow's
  amount field `"css=.flow-list .flow >> has-text=Carbon dioxide >> css=input >> nth=0"`, and
  `"role=button:Comment on this flow"`. The Name and Description fields have no accessible name yet:
  `"css=.efield:has(label:text-is('Name')) input"`.
- Flow picker: `"role=dialog:Add output flow"` (or "Add input flow"), its search field
  `"css=.flowpick-search"`, each flow a button named "<name> <compartment> <unit>", the amount
  `"role=textbox:Amount"`, `"role=button:Add"`, and `"Close"`.
- Search panel: `"placeholder=e.g. electricity"`, `"role=button:Search"`, a database's checkbox by its
  name, each hit `"css=.res >> has-text=<name>"` (what `drag` takes), and on each hit
  `"role=button:Select"` (scope it to the hit: several are on screen).
- The empty canvas, as a drop target: `"css=.react-flow__pane"`.

## Gotchas

- **A location keeps no round brackets:** "Russia (Asia)" is stored as "Russia [Asia]", and a note under the
  Location field says so. Imports of models and of datasets into "My processes" do the same and say so in the
  log; background databases keep their own locations.
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
- **A chosen method that was deleted stays chosen**: the chooser reads "⚠ <name> — no longer available"
  (the combobox is marked invalid) and Calculate is disabled, its title naming the method, until another
  method is chosen. Nothing else is picked in its place.
- **A drag's answer is not its proof.** It says whether the page followed the pointer itself (a link
  between handles, moving a box) or an HTML5 drag ran (a search hit), and for the latter whether the
  drop was taken. The proof is the effect: the "Add exchange" dialog and the Undo title naming the
  link, the new box on the canvas.
- A link starts on a box's right handle and ends on another box's left handle.
- `--to-offset` counts from the pane's top-left corner, and a dropped hit's box puts its own top-left
  corner there; drop on an empty spot. Dragging a box itself (`drag` from the box onto the pane, grabbed
  at its centre) puts its centre at the drop point, give or take the 2 px the drag starts with.
- Search hits are gone once you leave the Model page: search again after coming back.
- **A search-index build belongs to its workspace.** Switching workspace stops it before its next batch
  (a minute or two with the local model) and it starts again from the beginning when that workspace is
  opened. Meanwhile the other workspace's search panel says "Pausing the search index of workspace …"
  instead of showing its progress; its own databases waiting behind it read "queued".
- A hit whose region is not picked yet does not drag (its title says "Pick a region first").
- "Export model" and workspace backups open native save dialogs: manual.
- Delete and Control+Z do nothing while a modal is open or a field has the focus — press Escape or
  click the canvas first.
- **The tag menu stays open after a choice**, for the next group, and its backdrop takes every click in
  the window until it closes: a click on the toolbar or the navigation only closes the menu, and
  `click` waits on such a target until it gives up, naming the backdrop. Press Escape (or click
  `"css=.ctx-backdrop"`) before the next step. A box of an outside dataset is the exception: its tag
  gives it a new identity, so its menu closes by itself.
