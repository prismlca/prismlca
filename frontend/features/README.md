# PrismLCA feature map

What each page of the app does, how a person gets there, and how to drive it with `control-prism` — so that
whoever changes the interface can prove the change on the running app instead of guessing what "the
button in the sidebar" means. People can use the same pages as a checklist before a release.

`control-prism` runs from `frontend/`:

```sh
node scripts/control-prism.mjs help
```

## Start, check, stop

- `launch --seed` starts a fresh instance in folders of its own and imports the BAFU test fixture through
  the setup sheet (about a minute). Plain `launch` stops at the welcome tour and the empty setup sheet,
  which is what a first start looks like. `launch` builds `out/` first when the sources changed.
- `launch --copy` starts on a copy of your own PrismLCA instead: your data folder (workspaces, models,
  chats, search index) and your profile (settings, model list), in folders of the session's own. On
  btrfs, XFS and APFS the copy shares blocks with your files and takes seconds; elsewhere launch stops
  and says so, and `--full-copy` copies in full. Your PrismLCA may stay open: launch lists every file
  before and after copying and keeps the copy only if nothing changed in between — otherwise it copies
  again, and after four tries it names the files your app kept writing. The search uses the app's own
  model, as your index was built with it — over 2 GB more memory than a fresh instance.
- `--keys` (with or without `--copy`) copies your stored provider keys into the session, and nothing
  else of your keys: environment variables and the checkout's `.secrets/` stay out. Without it the
  instance has no key at all. The keys leave the session at `stop`, also with `--keep`.
- `doctor` before every proof. It fails when the running app is not the build of the checkout as it is
  now (or its backend still runs older Python sources), when the instance belongs to another checkout,
  when any of its folders lies outside its own, when a provider key of yours reaches it unasked, or when
  keys it was given cannot be decrypted. It says where a copy came from and when it was taken. A
  screenshot of a stale build proves nothing.
- `restart` quits the app as a person does and starts it again on the same data — rebuilding first when
  the sources changed. Use it after an edit, and to prove that something survives a restart.
- `stop` at the end. It ends what this session started and removes its folders (`--keep` keeps them for
  a look); the logs stay in `.cache/control-prism/logs/<session>/`. A session that is forgotten quits its
  app after an hour without commands.

Several sessions in one checkout take `--session <name>`. A session is invisible from any other checkout.

## What counts as proof

- **The user's path, with an observable effect.** Click, type and choose what a person would, then wait
  for what they would see change: a value in the inspector, a row in a table, a disabled button, a file
  in the download folder. A screenshot alone shows that something rendered, not that it works.
- **Every path the change touches:** success, and also the error, the cancel, the empty state, and the
  restart, as far as the change can affect them. When a path cannot be driven, say which and why, and
  drive the nearest one that can.
- **`read` is for looking, never the proof.** It evaluates JavaScript in the window and nothing stops an
  expression from changing what it reads. Look at state after the user's path ran, never instead of it.
  Never loop or wait inside `read`: the renderer has one thread, and a loop there freezes the window and
  the state it waits for.
- **Wait on states, never on time.** `wait` polls from outside, and every wait has a bound (30 s unless
  `--timeout` says otherwise, at most 15 minutes).
- **End with `console`.** It lists the window's errors since the launch and fails when there are any.
- **The seed is preparation, not evidence.** It answers the setup sheet's folder dialog in the main
  process. A change to setup or import is proven by driving those, with a fixture chosen by hand.
- **Native dialogs are manual:** file and folder pickers, OAuth windows, save dialogs. They are not faked
  for a proof. Downloads need no dialog: they land in the session's download folder (`wait download`).
  The same goes for drags in from another program, such as files onto the chat; drags inside the window
  are driven (see "Drags" below).
- **Nothing that costs money** — no chat message, no report writing, no research call — unless the
  person running the check asked for it. Only a session launched with `--keys` can spend at all, and
  `doctor` names the providers it would bill.

## Naming elements: the selector convention

A target names one element. In order of preference:

| Form | Matches | Example |
|---|---|---|
| bare string | exact `aria-label` | `"LCIA method"` |
| `role=<role>:<name>` | role and accessible name, as `snapshot` prints them | `"role=button:Calculate"` |
| `title=` | exact `title` | `"title=Add a new process to the model"` |
| `label=` | a form field by its label | `"label=Model name (e.g. pet-bottle-2025)"` |
| `placeholder=` | exact placeholder | `"placeholder=e.g. electricity"` |
| `text=` | visible text | `"text=Bring your background data"` |
| `css=` | a CSS selector — the fallback | `"css=.result-bar b"` |

`~=` instead of `=` matches part of the value, `/…/` is a regular expression, and ` >> ` narrows the
scope: `"role=dialog:Add output flow >> role=button:Add"`. After a target, `has-text=…`, `visible` and
`nth=0` filter its matches. A target that matches several elements fails and says so — narrow it rather
than taking the first by habit.

`snapshot` prints the accessibility tree of the window (or of `--target`): every role and name in it can
be written as `role=<role>:<name>`. Option lists are folded to the chosen option; `--options` shows them.

The interface has no `data-testid` attributes and gets none: a driver uses what a person and a screen
reader use. So when a control that a check needs has no name, give it an `aria-label` — a name that
stays the same while the control's text, title or placeholder changes with the state — and use it here.
Class names are the fallback for elements that are not controls (a result bar, a table), and they are
the first thing to break.

## Drags

`drag <from> <to>` presses on one element, nudges, moves the pointer across in steps (10 unless
`--steps` says otherwise) and lets go — the way a hand does. It covers both kinds of drag in the app:
those the page follows with its own pointer handlers (a link between two boxes' handles, moving a box)
and HTML5 drag-and-drop (a search hit onto the canvas, a model card into a folder, a parameter into a
group). An HTML5 drag carries the data the page's own dragstart put on it, so the drop handler gets
what it gets from a person — nothing is dispatched in its place.

- Both ends are named like any target and must be one element each. The press lands at the centre of
  `<from>` and the drop at the centre of `<to>`; `--from-offset x,y` and `--to-offset x,y` count from an
  element's top-left corner instead. Where something else lies on top of that point, `drag` refuses
  before the button goes down and names what is in the way.
- The answer says which kind of drag ran and, for an HTML5 drag, the kinds of data it carried and
  whether the drop was taken. That is a hint, not the proof: wait on the effect.
- A drag that breaks off with the button down is cancelled (Escape, then the button), so nothing is
  dropped by accident. If the window stops answering in the middle of a drag, it may still finish later:
  the session then refuses to drive until `restart`.
- Some elements drag only from part of themselves — a parameter row from its name column
  (`"css=.prow-item >> has-text=mass >> css=.pc-name"`), not from its value field. Pressed elsewhere,
  the page cancels the drag, and the answer says so.
- [model.md](model.md) links two boxes and drops a search hit onto the canvas,
  [overview.md](overview.md) files a model into a folder, and [parameters.md](parameters.md) moves a
  parameter into a group.

## Keeping the map current

The map changes in the same pull request as the interface it describes. `scripts/control-prism/featureMap.test.ts`
holds the line: every page has the four sections below, every command in the pages parses, and every
aria-label, title and placeholder a page names exactly still exists in the renderer's source. Rename a
control, and the test names the page to update.

Every page has the same four sections:

1. `Sub-features`
2. `How to get there`
3. `Driving it with control-prism`
4. `Gotchas`

## Pages

- [model.md](model.md) — the Model page: models, the process canvas, the inspector, calculating one process.
- [results.md](results.md) — the Results page: comparing subjects across indicators, the decomposition tree,
  sensitivity analysis.
- [chat.md](chat.md) — the assistant's chat dock on the Model page.
- [overview.md](overview.md) — the Overview: models, folders, the workspace box, the news and the tour.
- [parameters.md](parameters.md) — the Parameters page: named values, formulas, allowed values, groups.
- [scenarios.md](scenarios.md) — the Scenarios page: parameter overrides over the baseline.
- [lcia.md](lcia.md) — the LCIA page: comparing characterisation factors, methods of your own.
- [report.md](report.md) — the Report page's short report (without AI).
- [settings.md](settings.md) — the Settings sheet.

Not mapped yet: full reports (AI), the setup sheet and the import wizard. A change there gets its page
in the same pull request.

## Exploring before a release

Before each release an agent drives the app on `main`, as it is about to be released, like a person:
with `control-prism` and these pages, looking for what is broken rather than proving one change. It
reports and changes nothing — no fix, no merge. Each finding becomes an issue of its own; a map page
written on the way goes in a pull request of its own.

- **Order:** the pages with neither a map page nor an end-to-end test first, then the partly tested
  ones. End-to-end tests cover the setup sheet (first start, background import), the Model page
  (build, calculate, change an amount, Undo, restart), the Results page (comparison, decomposition tree)
  and the Report page (short report, a stored report).
- **Every path:** success, error, cancel, the empty state and a restart. `console` at the end of each
  page.
- **Numbers only against an oracle:** a known value — the recipe in model.md gives 2 kg CO2-Eq, CO2
  counts 1 in every GWP — or a relation: double the amount, double the result; Undo, the previous value;
  a localized copy scores as its original; ±10 % on a linear parameter moves the result ±10 %. "The
  number looks wrong" is not a finding.
- **One session per run, its record kept:** `export CONTROL_PRISM_SESSION=<run>`, then `status` saved
  after `launch` and again before `stop` (`stop --keep` keeps the folders but drops the record), with
  `console --all` and the logs from `.cache/control-prism/logs/<run>/`. Launching the same session again
  deletes its logs.
- **A finding carries** the `control-prism` commands that reproduce it from `launch --seed`, a
  screenshot, and whether it was reproduced in a new session. About ten per run at most: the ones that
  matter most.
- **Gaps are recorded, not worked around:** native dialogs (import, export, backup and restore, logo
  and cover uploads), drags in from another program (a file onto the chat), and everything that costs
  money — the chat, the AI report writer, research. Drags inside the window are driven (see "Drags").
- **Left alone:** anything that opens a browser or goes online — Handbook, GitHub, Open in browser,
  Subscribe, the lead developer's name, the links under Settings → About, the provider key and account
  links under Settings → AI and Transport distances, "Load news from prismlca.com", "Check for updates"
  — and the "Load news … at every start" switch on the tour's card and under Settings → General.
- **When every command answers "no answer from the app",** ask the window itself before calling it
  frozen: a page that answers a plain evaluation over its DevTools port means the driver is stuck, not
  the app. A heavily loaded machine makes the driver time out; run when it is quiet.

## Across the app

- A first start shows the welcome tour (a dialog named "Welcome to PrismLCA", ten cards, Next … Finish)
  and then the setup sheet "Bring your background data"; nothing else is reachable before an import.
- The navigation rows on the left are buttons in a navigation named "Pages":
  `"role=navigation:Pages >> role=button:Results"`. Scope them that way, because the toolbar has a "Model"
  button of its own. Tab reaches them and Enter opens the page. Without an open model only Overview and
  LCIA work; the others are disabled.
- Every modal is a dialog named by its title: `"role=dialog:New process"`, `"role=dialog:Settings"`, the
  flow picker as `"role=dialog:Add output flow"`. Scope a target inside one with it
  (`"role=dialog:Settings >> role=button:Language"`) and wait for it to go with `wait hidden "role=dialog:…"`.
  Opening a dialog moves the focus into it; closing it gives the focus back to what opened it. Enter in a
  modal's text field submits it; Escape closes it.
- The window opens maximised. At narrow widths the toolbar hides its words, so name buttons by their
  label or title, not by the word on them.
- Undo and Redo hold the steps of the running app only: after a restart both are disabled.
