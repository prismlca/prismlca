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
- `doctor` before every proof. It fails when the running app is not the build of the checkout as it is
  now (or its backend still runs older Python sources), when the instance belongs to another checkout,
  when any of its folders lies outside its own, or when a provider key of yours reaches it. A
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
- **Nothing that costs money** — no chat message, no report writing, no research call — unless the
  person running the check asked for it. A fresh instance has no provider key and cannot store one.

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
scope: `"css=.flowpick-modal >> role=button:Add"`. After a target, `has-text=…`, `visible` and `nth=0`
filter its matches. A target that matches several elements fails and says so — narrow it rather than
taking the first by habit.

`snapshot` prints the accessibility tree of the window (or of `--target`): every role and name in it can
be written as `role=<role>:<name>`. Option lists are folded to the chosen option; `--options` shows them.

The interface has no `data-testid` attributes and gets none: a driver uses what a person and a screen
reader use. So when a control that a check needs has no name, give it an `aria-label` — a name that
stays the same while the control's text, title or placeholder changes with the state — and use it here.
Class names are the fallback for elements that are not controls (a result bar, a table), and they are
the first thing to break.

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

Not mapped yet: Overview, Parameters, Scenarios, LCIA, Report, Settings, the setup sheet and the import
wizard. A change there gets its page in the same pull request.

## Across the app

- A first start shows the welcome tour (a dialog named "Welcome to PrismLCA", ten cards, Next … Finish)
  and then the setup sheet "Bring your background data"; nothing else is reachable before an import.
- The navigation rows on the left are not buttons: `"css=.navitem >> has-text=Results"`. Without an open
  model only Overview and LCIA work; the others are greyed out and do nothing.
- The app's own modals (new model, new process, flow picker, settings) have no dialog role: scope with
  `"css=.modal-backdrop"`. Enter in a modal's text field submits it; Escape closes it.
- The window opens maximised. At narrow widths the toolbar hides its words, so name buttons by their
  label or title, not by the word on them.
- Undo and Redo hold the steps of the running app only: after a restart both are disabled.
