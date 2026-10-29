# PrismLCA

Desktop software for life cycle assessment (LCA), built on **Brightway 2.5**: an Electron app over a local
Python/FastAPI backend, with an internal **AI assistant** and an **MCP server** built in from the start.
PrismLCA aims to be as approachable as a modern desktop app and as capable as the Brightway engine underneath.

> **Status: beta.** Windows and Linux (AppImage, deb); macOS is planned. Website and user handbook:
> [prismlca.com](https://www.prismlca.com).
>
> **Licence:** [AGPL-3.0-only](LICENSE) — see [Licence](#licence).

## What it does

- **Work with an AI assistant.** A chat assistant that models, calculates and explains through the same audited,
  undoable commands as you do — every change it makes lands in the audit log and can be taken back. It
  researches bills of materials on the web, looks up transport distances and end-of-life statistics, and drafts
  report chapters that you review and release. You choose the provider and bring your own key (OpenRouter or
  OpenAI); nothing is sent until you switch it on.
- **Let external agents drive it (MCP).** The built-in MCP server gives agents such as Claude Code, Codex or
  Claude Desktop the same tools as the chat assistant; the app sets up the client connection in one click.
- **Model on a canvas.** Processes and their flows as a graph, with parameters and formulas, scenarios, tags,
  undo/redo and a per-model audit log.
- **Calculate and read results.** LCIA with the methods of your background database, contribution analysis by
  process, tag or region, and comparisons across variants and scenarios.
- **Write the report.** ISO 14040/44-oriented study reports typeset with Typst, short reports, Excel and CSV
  exports, and `.prism` model bundles to pass a model on.
- **Bring your data.** Import inventories from SimaPro, openLCA (JSON-LD), EcoSpold and ILCD into your own
  library; background data comes from ecoinvent or BAFU (see [Background data](#background-data)).

## Install

Installers are on the [releases page](https://github.com/prismlca/prismlca/releases/latest): the `.exe` for
Windows 10 and 11 (64-bit), the `.AppImage` or the `.deb` for Linux (x64). `SHA256SUMS` lists the checksum of
every file, and every file carries a build provenance attestation
(`gh attestation verify <file> --repo prismlca/prismlca`).

- **Windows:** releases before 0.9.1 are not code-signed, so Windows shows "Windows protected your PC". Compare
  the installer with `SHA256SUMS` first (`Get-FileHash .\<installer>.exe` in PowerShell), then choose
  *More info → Run anyway*. By default it installs for your user only, without administrator rights.
- **Linux:** check with `sha256sum -c SHA256SUMS --ignore-missing`, then make the AppImage executable and start
  it, or install the deb with `sudo apt install ./<package>.deb`.

PrismLCA looks for a new version only when you click *Check for updates* on its About page. The Windows
installation and the AppImage update in place; with the deb you install the new package yourself.

## Privacy

PrismLCA runs on your computer and makes no network request on its own: no account, no telemetry, no crash
reporting. Every feature that reaches a server — the AI providers you key in, the routing and statistics APIs,
the news feed, the manual update check, the one-time search-model download — is listed in
[`PRIVACY.md`](PRIVACY.md) with what it sends and to whom. The app shows the same text as *Privacy notice* on the
start page and under Settings.

## Background data

**PrismLCA ships the importers, not the data.** A workspace needs one background database; you bring the files
and, where one is required, the licence:

- **ecoinvent** — you need a valid ecoinvent licence and the files of your release: the ecoSpold2 `datasets`
  folder and the *LCIA Implementation* workbook (without it there are no impact methods). PrismLCA imports them
  from your local disk — no online login, nothing is uploaded. ecoinvent data is never bundled with the app or
  committed to this repository.
- **BAFU:2026** — the free Swiss life cycle inventory database. Download it yourself from the
  [openLCA Nexus](https://nexus.openlca.org/database/BAFU) (free account; BAFU's terms of use apply: no resale,
  and studies cite *"Life Cycle Inventory database of the Swiss Federal Administration, BAFU:2026"*), then import
  its `ecoSpold files` folder.

Import on first start, or later under *Background*. A workspace holds at most one database per provider; with
both, ecoinvent's flow list and methods are the reference and BAFU is mapped onto them. Every other data source
the app ships or reads is recorded in [`docs/DATENHERKUNFT.md`](docs/DATENHERKUNFT.md).

## Repository layout

```
backend/    Python 3.12 · FastAPI · Brightway 2.5. Managed with uv.
frontend/   Electron · React · TypeScript · electron-vite. Managed with npm.
design/     Design tokens (prism-theme.css).
docs/       Architecture (ARCHITEKTUR.md), data provenance (DATENHERKUNFT.md), the AI tool manifest.
.github/    Workflows: CI and the release build.
```

## Development

Prerequisites: [uv](https://docs.astral.sh/uv/) (provisions Python 3.12) and Node.js 22 with npm.

```bash
# backend
cd backend
uv sync --extra dev
uv run pytest -n auto -q          # tests, one process per core
uv run ruff check src tests scripts

# frontend (starts the backend from ../backend through uv)
cd frontend
npm ci
npm run dev
npx vitest run                    # tests
npm run typecheck && npm run lint
```

`./start.sh` starts the app from the repository root; `--restart` replaces a running instance and `--status`
says what is running and why a start would refuse.

Parallel backend tests are safe: each worker imports `tests/conftest.py` and gets its own throwaway
`BRIGHTWAY2_DIR`, and every test creates a uniquely named project inside it. The tests need no background
database.

### Background data for development

The quickest start is **BAFU**: download it as above and import it in the running app. For ecoinvent the same
importer works; `backend/scripts/` also has headless helpers that set up a project without the UI — with your own
licensed files, into a throwaway directory, never for distribution:

```bash
cd backend
# 1) inventory and, with the workbook, the LCIA methods (the same engine code the app's importer uses)
BRIGHTWAY2_DIR=/path/to/brightway uv run --no-sync python scripts/import_ecoinvent.py \
    /path/to/datasets "/path/to/LCIA Implementation 3.12.xlsx"
# 2) semantic search index: embed all activities with bge-m3 (CPU; hours for the full database)
BRIGHTWAY2_DIR=/path/to/brightway OMP_NUM_THREADS=8 uv run --no-sync python scripts/embed_ecoinvent.py
```

### The backend on its own

`uv run prism-lca-backend` binds to `127.0.0.1` on a free port and prints a one-line JSON handshake (host, port,
token) to stdout. Every route except `GET /api/v1/system/health` needs the token in the `X-Prism-Token` header;
the interactive API documentation is served at `http://127.0.0.1:<port>/docs`.

Search runs locally on `BAAI/bge-m3` embeddings (sentence-transformers, CPU) fused with BM25. The model is
downloaded once, after the user agrees, at a pinned revision. `PRISM_EMBEDDING_BACKEND` switches to `local`
(fastembed, no PyTorch), `openai` or `openrouter` (key via `PRISM_OPENAI_API_KEY` / `PRISM_OPENROUTER_API_KEY`).

## Packaging

```bash
# 1) bundle the backend (PyInstaller, onedir)
cd backend && uv run --extra build pyinstaller prism_backend.spec --noconfirm
dist/prism-lca-backend/prism-lca-backend --solver-check   # must report Intel oneMKL PARDISO
dist/prism-lca-backend/prism-lca-backend --bundle-check   # every on-demand library imports
# 2) build the installers (the backend travels via extraResources)
cd ../frontend && npm run dist:linux     # or dist:win
```

Targets: **NSIS** (Windows), **AppImage + deb** (Linux). Local builds are unsigned and have the update check
switched off. Releases are built by the release workflow from a version tag and published on GitHub Releases;
PrismLCA looks for updates only when you click *Check for updates* (Settings → About).

The backend bundles **CPU-only PyTorch** (no CUDA) for the local search model and Intel oneMKL as the sparse
solver, which makes the onedir backend about 1.9 GB. On Fedora, electron-builder's `fpm` needs `libcrypt.so.1`
for the deb target (`sudo dnf install libxcrypt-compat`); the AppImage has no such dependency.

## Licence

PrismLCA — Copyright (C) 2026 Jonas Harth.

This program is free software: you can redistribute it and/or modify it under the terms of the
**GNU Affero General Public License** as published by the Free Software Foundation, version 3
(`AGPL-3.0-only`). It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even
the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [`LICENSE`](LICENSE) for the
full text; the app shows it under *Licence: AGPL-3.0* on the start page and the splash screen, next to
*Third-party notices*.

The licence carries one **additional permission under AGPL §7**: PrismLCA may be conveyed combined with the
Intel oneAPI runtime libraries (oneMKL and friends, pulled in by `pypardiso` as the sparse solver), whose Intel
licences are not AGPL-compatible on their own. The wording follows the licence text, at the end of `LICENSE`. The Intel runtime libraries
in the installers — oneMKL and oneTBB, and on Windows the Intel OpenMP runtime that PyTorch brings along — are
licensed under Intel's terms, reproduced in the third-party notices, not under the AGPL: reverse engineering,
decompiling or disassembling them is not permitted.

Third-party libraries and data keep their own licences. The complete, versioned list with every licence text is
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md), generated by `backend/scripts/third_party_notices.py` and
shipped inside every installer (a test fails when a dependency changes without regenerating it).

## Contributing

Contributions need a one-time Contributor License Agreement ([`CLA.md`](CLA.md), or
[`CLA-ENTITY.md`](CLA-ENTITY.md) for organisations; Harmony 1.0) — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
