# Overview

The start page: the list of models in this workspace with its folders, the figures of the workspace, the
models opened last, the news card and the What's new panel. The workspace box at the foot of the
navigation sits on every page but is described here.

## Sub-features

- Models panel: "Find a model…" filters by name (and opens the folders that hold a match); folders
  ("Unsorted" holds the rest) fold open and shut,
  "Folder" creates one, each folder can be renamed and deleted (only an empty one asks first). A model
  moves into another folder by dragging its row onto that folder.
- A model row opens the model; its buttons are Model info, Duplicate model, Export model (a save
  dialog) and Delete model (with a confirmation that says it cannot be undone).
- "Model" in the panel and in the toolbar opens the New model dialog: name, "Duplicate from", folder,
  goal and scope. Creating opens the new model on the Model page.
- Import: the download-icon "Model" button takes a `.prism` file or a PrismLCA workbook, "Processes"
  takes SimaPro, openLCA, GaBi, EcoSpold or ILCD — both start with a file dialog.
- Figures: models, background databases, My processes, elementary flows, LCIA indicators.
- Last models: the models opened most recently, with their folder and process count.
- Latest news loads only on "Load news from prismlca.com", or at every start when that is switched on
  under Settings → General. What's new lists every feature entry.
- Workspace box: switch workspace, "＋" for a new one (it starts at the setup sheet), back up and restore
  (file dialogs), delete the workspace you are in (with a confirmation).
- "Take the tour again" replays the welcome tour.

## How to get there

The app opens on the Overview; afterwards the "Overview" row in the navigation. The toolbar's "Model"
button and the workspace box are on every page.

## Driving it with control-prism

Create a model with a goal, find it, and see its row:

```sh
node scripts/control-prism.mjs click "css=button.ov-wide"
node scripts/control-prism.mjs type "label=Model name (e.g. pet-bottle-2025)" bottle
node scripts/control-prism.mjs type "label=Goal (optional — the AI assistant reads this as its brief)" "One bottle"
node scripts/control-prism.mjs click "css=.modal-backdrop >> role=button:Create"
node scripts/control-prism.mjs wait hidden "css=.modal-backdrop"
node scripts/control-prism.mjs click "css=.navitem >> has-text=Overview"
node scripts/control-prism.mjs click "role=button:Expand"
node scripts/control-prism.mjs type "placeholder=Find a model…" bot
node scripts/control-prism.mjs wait visible "css=aside >> nth=1 >> role=button:/^bottle Model info/"
node scripts/control-prism.mjs type "placeholder=Find a model…" ""
```

A folder, a duplicate, deleting the duplicate (Cancel first), and filing the model into the folder:

```sh
node scripts/control-prism.mjs click "title=New folder — group the models by what they are for"
node scripts/control-prism.mjs type "placeholder=Folder name…" Packaging --enter
node scripts/control-prism.mjs wait visible "css=aside >> nth=1 >> text=Packaging"
node scripts/control-prism.mjs click "css=aside >> nth=1 >> role=button:/^bottle Model info/ >> role=button:Duplicate model"
node scripts/control-prism.mjs click "css=.modal-backdrop >> role=button:Duplicate"
node scripts/control-prism.mjs wait visible "css=aside >> nth=1 >> text=/^bottle \(copy\)$/" --timeout 60000
node scripts/control-prism.mjs click "css=aside >> nth=1 >> role=button:/^bottle \(copy\)/ >> role=button:Delete model"
node scripts/control-prism.mjs click "css=.modal-backdrop >> role=button:Cancel"
node scripts/control-prism.mjs click "css=aside >> nth=1 >> role=button:/^bottle \(copy\)/ >> role=button:Delete model"
node scripts/control-prism.mjs click "css=.modal-backdrop >> role=button:Delete"
node scripts/control-prism.mjs wait hidden "css=aside >> nth=1 >> text=/^bottle \(copy\)$/" --timeout 60000
node scripts/control-prism.mjs drag "css=.ov-folder.loose .ov-model >> has-text=bottle" "css=.ov-folder >> has-text=Packaging"
node scripts/control-prism.mjs wait text "css=.ov-folder >> has-text=Packaging >> css=.ov-folder-count" 1 --exact
```

A second workspace, and back:

```sh
node scripts/control-prism.mjs click "New workspace"
node scripts/control-prism.mjs type "label=Workspace name (e.g. ecoinvent-3.11 for a second release)" second --enter
node scripts/control-prism.mjs wait visible "role=heading:Bring your background data" --timeout 120000
node scripts/control-prism.mjs select "role=combobox:/^Switch workspace/" Main
node scripts/control-prism.mjs wait app-ready --timeout 120000
```

- Three buttons say "Model": the toolbar's and the panel's create (title "Create another model, or
  duplicate an existing one" — the panel's is `"css=button.ov-wide"`), the import is
  `"title=Import a model from a .prism file or from the spreadsheet PrismLCA exports"`.
- A model row is one button named by everything in it ("bottle Model info Duplicate model … 1
  foreground process"); scope its own buttons inside it, as above. The Last models card's rows are
  buttons too: `"role=region:Last models >> role=button:/^bottle/"`.
- A folder's "Rename folder" and "Delete folder" show only while the pointer is over its heading:
  `hover` the heading first. Rename opens a text field with "Rename the folder" (✓) and "Discard the
  new name" (✕).
- Workspace box: `"New workspace"`, `"Delete workspace"`, `"Back up this workspace"`,
  `"Restore a workspace backup"`, and the switcher `"role=combobox:/^Switch workspace/"`.

## Gotchas

- **The process counts lag.** A model's row and its Last models entry count processes from the model
  list, which is not re-read when a process is added: check them after a restart or another model-level
  action, not right after building.
- **Create with an empty name closes the dialog** without creating anything and without a message; the
  goal and scope typed into it are gone. A refused name (an existing one) also closes the dialog and
  shows the reason in the red banner at the top of the page.
- **A search hides every folder without a match,** a new empty one included: clear "Find a model…"
  before looking for a folder.
- **The tour has no way out but Finish:** no close button, no Escape (on purpose). Ten cards — click
  `"role=dialog:Welcome to PrismLCA >> role=button:Next"` nine times, then Finish. Its "Load news …
  at every start" switch is a network switch: leave it alone.
- **Deleting the workspace you are in lands on Brightway's empty "default"** with the setup sheet; your
  other workspaces are in the switcher below it.
- Handbook, GitHub, Open in browser, Subscribe, the lead developer's name and "Check for updates" open a
  browser or go online; "Load news from prismlca.com" goes online. Export model, Import, Back up and
  Restore open native file dialogs: manual.
