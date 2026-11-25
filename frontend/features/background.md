# Background data

Where a workspace gets what it calculates against: the setup screen a fresh workspace opens on, the
import wizard for ecoinvent and BAFU:20XY, and the Background data sheet (inventory, impact methods, the
library of your own datasets, starting over).

## Sub-features

- Setup screen "Bring your background data": shown while a workspace holds nothing; "Import ecoinvent"
  and "Import BAFU" open the wizard, the workspace switcher sits below them.
- Import wizard ("Import ecoinvent" / "Import BAFU:20XY"): the workspace name (only in Brightway's empty
  "default"), the release or download folder, for ecoinvent the LCIA workbook and the release it read
  from the files, then "Start import". A progress bar with the time running, "Cancel import" while the
  import can still stop, and afterwards what was imported, "Start" and "Also import …".
- Background data sheet: four figures, the Inventory cards (each with "Remove…"), the offers to import
  what is missing, Impact methods (add an LCIA workbook to an inventory imported without one), Your
  library (imports of your own datasets, removable one by one) and Start over (a code the backend issues).
- A running import shows in both, whichever started it: opened during an import (also after the window
  was reloaded) the wizard and the sheet follow it. A failed status request is retried; once the engine
  has stopped, they say so and that PrismLCA has to be restarted.

## How to get there

The setup screen appears by itself in a workspace without background data. The sheet: the "Background"
button in the Overview's toolbar. The wizard: a choice on the setup screen, or an offer on the sheet.

## Driving it with control-prism

The wizard needs a folder from the native dialog, which is not driven (`launch --seed` answers it in the
main process, as preparation only). To watch an import, start it from the window and open the sheet:

```sh
node scripts/control-prism.mjs launch --seed
node scripts/control-prism.mjs read 'window.prism.api("POST","/api/v1/setup/background",{source:"ecoinvent",path:"/path/to/release/datasets",lcia_xlsx:"/path/to/LCIA Implementation 3.13.xlsx",version:null})'
node scripts/control-prism.mjs click "title=Background data: import ecoinvent or BAFU, add impact methods, remove a database, or start over"
node scripts/control-prism.mjs wait visible "role=dialog:Background data >> role=progressbar:Import progress"
node scripts/control-prism.mjs wait disabled "role=dialog:Background data >> role=button:/^Import ecoinvent/"
```

An engine that stops under the import: end the backend process `doctor` names while the import reads.

```sh
node scripts/control-prism.mjs doctor
kill <backend pid>
node scripts/control-prism.mjs wait text "role=dialog:Background data >> role=alert" "Restart PrismLCA" --timeout 15000
```

- The progress is a `role=status` with a `"role=progressbar:Import progress"`; the stopped engine's
  message is the sheet's or wizard's `role=alert`.
- The wizard's dialog is named by its title: `"role=dialog:Import ecoinvent"`,
  `"role=dialog:Import BAFU:20XY"`. Its main button reads "Start import", "Importing…" while a job runs,
  and "Start" once it is done.
- The sheet's sections are buttons in `"role=navigation:Sections"`; a removal asks first ("Keep it" or
  "Remove <name>"), Start over asks for the code it shows (`"Confirmation code"`).

## Gotchas

- **An ecoinvent import is heavy:** several GB of memory and about five minutes for a full release. Agree
  a slot with the other sessions before starting one, and stop it (or the instance) when the proof is done.
- **Only one import runs at a time**, in one workspace: the offers, "Remove…", "Start over…" and the
  wizard's Start stay disabled while one runs, and the backend refuses a second one.
- **A stopped engine stays stopped:** the shell does not start it again. After a proof that ends the
  backend, `restart` before the next one; `console` lists the requests that failed in between.
- **An import cut off while writing** leaves an empty database ("empty — the import was interrupted" on
  its card); the next ecoinvent import refuses to start beside it until "Remove…" has taken it away.
- "Choose folder…" and "Choose workbook…" open native dialogs: manual.
