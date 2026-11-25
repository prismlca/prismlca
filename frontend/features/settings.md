# Settings

The Settings sheet: everything applies the moment it changes and is stored on this computer — there is
no Save. "Reset" puts the page shown back to its defaults. It opens over whatever page is showing.

## Sub-features

- General: rounding (significant digits) for the canvas arrows, Flow Properties, Inputs / Outputs,
  Parameters and Results; the start page's news switch; keeping the computer awake during long tasks.
- Language: spell-checking dictionaries (bundled, nothing is downloaded).
- Modelling: free-text units, what the canvas arrows show (amount, product), the preferred background
  database when a chat has several.
- Reporting: your name, company and logo for report title pages.
- Transport distances (a group): API provider (openrouteservice key and the geocoder), DAF, Limits,
  Usage & costs.
- AI (a group): Provider, Models, Limits, Chat, MCP, Skills, Tools, Usage & costs.
- About: version ("Copy version info"), licence and privacy notices, and the update check.

## How to get there

The gear button at the right end of the toolbar, on every page.

## Driving it with control-prism

Show parameters with two significant digits, see the effect, and reset:

```sh
node scripts/control-prism.mjs click "role=button:Settings"
node scripts/control-prism.mjs type "role=spinbutton:Parameters" 2 --commit
node scripts/control-prism.mjs press Escape
node scripts/control-prism.mjs click "css=.navitem >> has-text=Parameters"
node scripts/control-prism.mjs type "css=.prow >> has-text=kg >> css=input.num" 1.23456 --enter
node scripts/control-prism.mjs wait value "css=.prow >> has-text=kg >> css=input.num" 1.2
node scripts/control-prism.mjs click "role=button:Settings"
node scripts/control-prism.mjs click "css=.modal-backdrop >> role=button:Reset"
node scripts/control-prism.mjs wait value "role=spinbutton:Parameters" 6
node scripts/control-prism.mjs press Escape
```

A setting survives a restart:

```sh
node scripts/control-prism.mjs click "role=button:Settings"
node scripts/control-prism.mjs click "css=.modal-backdrop >> role=navigation >> role=button:Modelling"
node scripts/control-prism.mjs click "role=checkbox:Show the product"
node scripts/control-prism.mjs press Escape
node scripts/control-prism.mjs restart
node scripts/control-prism.mjs wait app-ready
node scripts/control-prism.mjs click "role=button:Settings"
node scripts/control-prism.mjs click "css=.modal-backdrop >> role=navigation >> role=button:Modelling"
node scripts/control-prism.mjs wait unchecked "role=checkbox:Show the product"
```

- The pages are buttons in the sheet's navigation:
  `"css=.modal-backdrop >> role=navigation >> role=button:Modelling"`. A group's heading (Transport
  distances, AI) only folds its pages in and out; its pages are buttons named with a leading "└":
  `"role=button:/Provider$/"`.
- Rounding fields are spinbuttons named by their row: `"role=spinbutton:Parameters"`,
  `"role=spinbutton:Results"`. A value below 1 is stored as 1.
- The sheet has two Close buttons (✕ and the one at the bottom): press Escape instead.

## Gotchas

- **Several controls here reach the network or another program; a check leaves them alone unless the
  session is sealed** (`launch --sealed`, which refuses them and lists them under `refused`): the
  "Load news from prismlca.com at every start" switch (General, and on the tour's card), the provider
  key links under AI → Provider (they open the provider's key page in a browser), the account links under
  Transport distances, the links on About, and "Check for updates" (disabled outside the installed app).
- **No key can be stored in a control-prism instance** unless it was launched with `--keys`, and typing a
  key into a provider field may send it to the provider to check it: leave the key fields empty.
- The logo "Upload" opens a file dialog: manual (a sealed session cancels it).
- Reset only resets the page shown, not the whole sheet.
