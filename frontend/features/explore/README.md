# Exploring at random: the Bombadil spec

`control-prism explore` lets [Bombadil](https://github.com/antithesishq/bombadil) (a property-based UI tester)
drive the app at random before a release, beside the agent's run (see "Exploring before a release" in
[../README.md](../README.md)). The two find different things: the agent finds wrong meaning — a wrong number, a
wrong method, a silent overwrite — and Bombadil finds what breaks under unusual input and order: a slash in a
name, calculating a model without flows, a render loop, a page that never stops loading.

```sh
node scripts/control-prism.mjs explore                     # 6 runs of 5 minutes, about 40 minutes
node scripts/control-prism.mjs explore --minutes 5 --runs 1
node scripts/control-prism.mjs explore --control all       # the positive controls, after a change here
```

Several short runs rather than one long one: in fresh sessions three runs of 5 minutes reached more of the app than
one of 15 (blocks 22 and 18 % against 16 and 15 %, 28 and 33 dialog types against 25 and 26, in two rounds).

Each run starts a fresh `launch --seed --sealed` session, runs `doctor`, builds the model of [../model.md](../model.md)
(its first recipe, read from the page), and lets Bombadil drive the window for the run's time at 1920×1080. Then it
keeps the record a person would keep — `doctor`, `console --all`, `refused`, a screenshot, `status`, the session's
logs, the trace — and stops the session. Linux and macOS on Apple silicon only: Bombadil has no Windows binary.
The release is pinned in `scripts/control-prism/bombadil.ts` with its SHA-256 and fetched on first use into
`~/.cache/prismlca/bombadil/`.

## What counts as a finding

Three sources:

1. **The spec's properties** (below), from Bombadil's verdict on every state.
2. **Every `Unhandled error` in the session's backend log**, grouped by exception and place. The window shows
   such an error only as a red banner, and its console stays clean.
3. **A visible "Unexpected server error"**, as a property (`noServerErrorBanner`), so the trace has the state.

| Property | Goes red when | Positive control |
|---|---|---|
| `noConsoleErrors`, `noUncaughtExceptions`, `noUnhandledPromiseRejections` | Bombadil's defaults | `synthetic` |
| `restAfterInput` | an observation of 15 windows of 1 s without input never comes to rest (≤ 3 React commits) | `rest` (canvas render loop) |
| `restWasMeasured` | an observation had no commit counter to read, so it measured nothing | `synthetic` |
| `loadEnds` | "Loading…" stays longer than 30 s in the same document, page and dialog | `load` (report page loop) |
| `calculationEnds` | a `.spinner` stays longer than 120 s | `synthetic` |
| `busyEnds` | Busy dots, a BusyClock or `aria-busy` stay longer than 120 s | `synthetic` |
| `startEnds` | "Starting backend…" stays longer than 60 s | `synthetic` |
| `noServerErrorBanner` | the window shows "Unexpected server error" | `server-error` (with the backend log) |

Left out on purpose: `noHttpErrorCodes` reads only the status of the page's own navigation (a `file://` URL here)
and never fires; a DOM-growth alarm fired only when a large page opened legitimately.

## The report

`.cache/control-prism/explore/<time>/report.md`, with `report.json` and a folder per run. Findings first, each with
the state it began in (time, page, dialog, section), the action before it, a screenshot of that state, and for a
rest violation the named functions that ran while nothing was put in — for the canvas render loop that list had
`Workbench.onSelectionChange` in it. Then per run: pages and their shares, dialog types, coverage of the renderer's
blocks, rest observations, loading episodes, what the seal refused, console errors, the machine's load. Last, what
the runs reached together.

A run that broke off is **open**, not green: the report says whether Bombadil broke (the window still answered
afterwards) or the app (it did not), with Bombadil's last error. What it saw until then still counts. A run whose
evidence is incomplete is open as well — no trace, a trace that cannot be read to its end, Bombadil reporting a
violation the trace does not show, no backend log, or a session that `stop` could not end. `explore` exits 1 on any
finding or open run.

## Reproducing a finding

By hand with control-prism, from the trace: `bombadil browser inspect <run>/trace.bin` shows each state with its
screenshot and the action that led to it; `bombadil trace --json --state A..B <run>/trace.bin` prints them. Start
from `launch --seed --sealed` and the model recipe, then drive what led to the state. Bombadil's own `--reproduce`
is not used: on this app a replay leaves the recorded path within seconds — layout differs by fractions of a pixel,
React Flow's ids are new in every session, and content that loads after an action is offered later or earlier.

## The spec

- `properties.ts`: the properties, defined once. `explore.ts` exports all of them, and each control re-exports
  the ones it turns red — so a control tests exactly what a run checks.
- `explore.ts`: the weighted actions. In each state exactly one group offers something: the
  startup (one reload so Bombadil instruments the bundle, then the Model page), an open rest observation (its next
  1-s window, nothing else), or the exploration: clicks on the topmost element only, typing, `<select>` options a
  person can reach, scrolling panels, Escape, a click anywhere (popovers close on it), rarely "New workspace",
  starting a rest observation, and waiting while something loads.
- `lib.ts`: what explore.ts and the controls share — the extractors the report reads (`where`, `rest`, `loading`,
  `serverErrorBanner`), the startup, the rest measurement, the click and select targets.
- Bombadil gives every command 5 s, its own actions included, so nothing here waits longer than 4 s at a time:
  a rest observation is a chain of 1-s windows, and waiting for loading is a chain of up to 4 s.
- A block list keeps the run out of what would swallow it (deleting the only workspace, the welcome tour); the seal
  keeps everything inside the computer, so links, news and the outward controls are clicked like the rest.

## Positive controls

A property that was never seen to go red may be unable to. `controls/controls.json` lists a control for each one:

- **With a patch** (`rest`, `load`, `server-error`): the patch brings back a bug that was fixed. The control runs its
  spec on a throwaway, detached checkout of HEAD with the patch applied — every property it names must go red — and
  on this checkout as it is, where nothing may go red.
- **Without** (`synthetic`): the spec causes each condition itself — an error logged, an exception thrown, a promise
  rejected, the commit counter removed, indicators that stay.

`explore --control all` runs them (about half an hour) and, when all pass, writes `controls/verified.json` with a
fingerprint of this folder. `scripts/control-prism/controls.test.ts` fails when the folder no longer matches it, and
when a property of `properties.ts` has no control, or a control defines a property of its own instead of
re-exporting the shipped one. So a change to the spec, a control or a patch runs the controls
again and commits the new `verified.json` with it. A patch that no longer applies says so; refresh it against HEAD.

## Not covered

Links between boxes (Bombadil has no drag), right-click menus, what lies behind native dialogs (the seal cancels
them), the chat with a key, persistence over a restart, and Windows. These stay with the agent's run and the
end-to-end tests; nothing here fakes them.
