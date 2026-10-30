# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**PrismLCA** — modern desktop LCA (life cycle assessment) software built on **Brightway 2.5**.
Goal: more approachable than the Activity Browser, as capable as Brightway, AI-ready (MCP) from day one.
Architecture and decision records: `docs/ARCHITEKTUR.md`; data provenance: `docs/DATENHERKUNFT.md`.

Core decisions the code alone does not explain: Brightway 2.5 encapsulated behind a repository interface
(no monkey-patching as in the Activity Browser); API-first with command bus, undo, audit log and a
guardrail layer; a pure process-graph data model plus generic free tags; ecoinvent imported from local
ecoSpold2 files (no login); packaging with PyInstaller + electron-builder, delivery through GitHub Releases
with an update check only on click, Windows signing through Certum Open Source
(`.github/workflows/release.yml`, `frontend/scripts/release/`); the standard result format is the compact
`meta+lookups+tree` schema.

## Databases

`databases/` holds licensed ecoinvent data (e.g. `ecoinvent 3.12_cutoff_ecoSpold02.7z`,
`ecoinvent 3.12_LCIA_implementation.7z`). These files are large and licensed and are **never** committed —
`.gitignore` excludes them.

## Design / colour scheme (binding)

All UI and designs in this project use the **PrismLCA colour scheme**. The tokens are CSS custom properties
in `design/prism-theme.css` — reference them there (each token's role is in its comment), never hard-code
hex values. App styles: `frontend/src/renderer/src/index.css` is only the import list of `styles/*.css`;
the order matters for the cascade (some base rules come *after* their specialisations). New rules go at the
end of the fitting sheet; never reorder sheets, never move a rule between sheets without checking for
overlapping selectors. CSS is deliberately not formatted by Prettier.

## Rules

- **Keep `.gitignore` current**: when new file types, build artefacts, data directories, caches or tool
  output enter the project and must not be versioned, add them to `.gitignore` without being asked —
  especially large or licensed data under `databases/` and backend (Python) and frontend (Electron/Node)
  artefacts.
- **The product name is "PrismLCA"**: one word, in every text — UI strings, handbook, What's-new, feed,
  docs, comments. Never "Prism LCA" with a space and never shortened to "Prism". Only technical identifiers
  (`prism-lca`, `prism_lca`, `prism.*` keys, paths) stay as they are. Fix old spellings in a file you touch.
- **The UI language is English**: every label, hint and error message — no German strings in the product
  (i18n-ready). Translate old German strings in a file you touch.
- **Comments and public docs speak as a team**: "we" or neutral; code comments in English. No personal
  names, no decision attributions like "(name, date)", no review handles (A1, CR06, FE-VIEW-02), no
  references to internal documents or test runs — a comment carries its reason itself, the history belongs
  in the commit message. V-numbers may stay (like ticket numbers), but the sentence must make sense without
  them. Legally required names (copyright, CLA, privacy controller, credits) stay.
- **Keep What's-new current**: every new **feature** (no bug fixes or chores) gets an entry at the top of
  `frontend/src/renderer/src/assets/whats-new.json` in the same commit (`{date, title, details}`, English,
  short title). The Overview page shows the complete list (unlimited, the panel scrolls); do not backfill.
  Two limits that keep needing enforcement: *no bug fixes and no small tweaks* — unless several are
  combined into **one** entry. And `details` stays at **two to three sentences** (≈ 300–450 characters,
  hard limit ~500): what readers need to find and use the thing — the reasoning belongs in the commit
  message. Length tends to drift upwards; whoever writes an entry counts the characters.
- **Chat and MCP share tools and prompt**: one catalogue, opt-out in `frontend/src/main/mcp/catalog.ts`
  (`MCP_EXCLUDED_TOOLS`), a parity test against the manifest. Whoever changes a tool, a prompt rule or an
  effect declaration (`tools/effects.ts`) decides in the same commit what the MCP server gets of it, and
  writes the reason next to the exclusion list when the answer is "nothing". Loop behaviour (compaction,
  nudges, transcript, focus mode, Continue) belongs to the chat; an MCP client brings its own.
- **No new giant files**: such files grow by accretion — every feature puts its block where the state
  already lives, until a component has 2000 lines and only a dedicated refactoring round helps. So decide
  before writing where new code belongs:
  - A self-contained building block (panel, card, chart, dialog) gets its own file in its view's folder —
    `views/results/`, `views/settings/` and `chat/` are the models — not a second component in the
    container's file.
  - Pure helpers (formatting, parsing, clamping) go into a `*.ts` next to it or into `lib/`, not into a
    component file; in the main process and the backend into topical neighbour modules instead of next to
    the orchestration.
  - A component above ~300 lines or ~15 hooks gets its logic split into hooks by responsibility (loading,
    opening effects, run control); the order of effects stays intact at the call site.
  - Whoever adds to a file above ~800 lines (Python ~1000) first cuts the new part out — or says in the
    commit why not.
  - Flat catalogues of uniform entries and pure data (`engine/commands.py`, `components/icons.tsx`) are
    exempt: length is not the problem there, mixed responsibility would be.
  - A count is met by cutting, never by squeezing: deleting comments, joining lines, dropping checks or
    shortening names hides the size and makes the file worse. Deleting is right only where it improves the
    file on its own — code nothing calls any more.
  - Cut along a responsibility, never along the count: the new module's docstring says what it is
    responsible for — "moved here because X had no room" is the sign the cut followed the number. Move the
    callers rather than leaving a forwarding stub, and when a file shrinks, lower its ceiling in the same commit.
  - A **tripwire** holds the line: `frontend/src/fileSize.test.ts` and `backend/tests/test_file_size.py`.
    New files stay below 800 or 1000 lines; every current large file has a ceiling (line count + 25 for
    wiring) that may only go down. Raising it is allowed when the new lines belong in that file — with a
    comment saying why they cannot live elsewhere. Both run in the normal suites, so run `npx vitest run`
    and `uv run pytest -n auto` before every commit that touches code. A commit that changes only docs,
    text, images or CSS may leave them to CI (`.github/workflows/ci.yml`, on every push to `main` and every
    pull request) — and a red CI run on `main` is the next thing to fix.
- **The full BAFU test is opt-in**: the normal suite writes one of bw2io's bundled methods per family, not
  all 762 (a minute on its own). Whoever changes the BAFU import (`engine/backgrounds/`) or bumps bw2io or
  bw2data also runs `PRISM_FULL_BAFU=1 uv run pytest tests/test_backgrounds_bafu.py` before committing.

## Privacy (notice: `PRIVACY.md`)

- **No network access without an explicit user action**: a switch, a click or a key. No channel is open on
  first start. A new channel needs, in the same commit: a switch that defaults to off, one sentence at the
  switch, a line on the tour card "What leaves this computer", and a paragraph in `PRIVACY.md` (and its
  copy `frontend/src/renderer/src/assets/privacy-notice.md`; a test keeps both identical).
- **No PrismLCA key, no proxy, no relay.** Users remain the contracting party of their provider; we are a
  tool, not a controller.
- **No device, installation or user ID in any request.** The program version yes, nothing else.
- **No telemetry, no crash reporting.** If ever wanted: opt-in, viewable locally before sending, and the
  paragraph in `PRIVACY.md` is rewritten.
- **Own servers in the EU**, hosts with a data-processing agreement, server logs kept at most seven days.
- **Always set the provider's privacy flags** where they exist (`data_collection: deny`, ZDR,
  `store: false`), and claim in the notice only what the code sets.
- Libraries that phone home on their own (Hugging Face telemetry, safetensors auto-conversion) are switched
  off at process start — `backend/src/prism_lca/server.py` is the place; a new dependency is checked for
  this before it goes in.
