# PrismLCA — Architecture

> Architecture overview and decision records. The numbered sections below are referred to from code
> comments; keep their numbers stable. Where a decision was later replaced or only partly realised,
> the ADR says so.

## 1. Overview

PrismLCA is a **desktop app made of two processes**, delivered as **one** atomically versioned
artefact:

- **Electron frontend** (React + TypeScript strict + Vite). The *renderer* is the presentation and
  interaction layer. The Electron *main process* additionally hosts the AI assistant (agent loop,
  provider clients, tool catalogue), the report writer, the MCP server for external agents, the
  update check and the OS integration (dialogs, key storage, spell checking).
- **Python backend** (FastAPI) — encapsulates Brightway 2.5 and holds all domain logic.

The frontend talks to the backend **only** through a local, versioned HTTP API. The renderer never
speaks HTTP itself: it calls `window.prism` (preload bridge), which forwards to the main process over
IPC, and the main process makes the authenticated HTTP request. There is **no** function that is
reachable only through the UI: the assistant tools in the main process and the MCP server call the
same API endpoints as the UI does (ADR-003, ADR-011).

```
┌───────────────────────────────────────────────────────────────────────┐
│  Electron                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ Renderer (Chromium, context isolation)                          │   │
│  │  React UI (tables, editors) · React Flow (canvas) ·             │   │
│  │  ECharts / D3 (result charts)                                   │   │
│  └──────────────────────────────┬──────────────────────────────────┘   │
│                       window.prism (preload) ── IPC                    │
│  ┌──────────────────────────────┴──────────────────────────────────┐   │
│  │ Main process                                                    │   │
│  │  backend supervisor + HTTP client (holds the token) ·           │   │
│  │  AI agent loop / providers / tools · report writer ·            │   │
│  │  MCP server · updater · key storage (safeStorage) · settings    │   │
│  └──────────────────────────────┬──────────────────────────────────┘   │
└─────────────────────────────────┼─────────────────────────────────────┘
        HTTP  127.0.0.1:<os-assigned port>  + X-Prism-Token header
┌─────────────────────────────────┴─────────────────────────────────────┐
│  Python backend (FastAPI, bundled with PyInstaller)                     │
│  ┌───────────────────────────────────────────────────────────────┐     │
│  │ API layer (routers, Pydantic schemas, OpenAPI, errors + hints) │     │
│  ├───────────────────────────────────────────────────────────────┤     │
│  │ Command bus  →  undo/redo stacks  →  audit log (JSON Lines)    │     │
│  ├───────────────────────────────────────────────────────────────┤     │
│  │ Guardrails (read-only background, pre-write validation,        │     │
│  │  delete preview, model-health linter)                          │     │
│  ├───────────────────────────────────────────────────────────────┤     │
│  │ Domain services (model, search, LCIA, scenarios, parameters,   │     │
│  │  Monte Carlo, contribution, report, import/export, tags)       │     │
│  ├───────────────────────────────────────────────────────────────┤     │
│  │ Brightway 2.5 (bw2data / bw2calc / bw2io / bw_processing /     │     │
│  │  matrix_utils), reached through the lazy accessors in          │     │
│  │  engine/bootstrap.py; repository interface for project and     │     │
│  │  database lifecycle                                            │     │
│  └───────────────────────────────────────────────────────────────┘     │
│  Side stores: JSON files in the workspace's `prism_meta/` (studies,     │
│  tags, views, chats, reports, …), JSONL audit log, NumPy vector index   │
│  for semantic search                                                    │
└─────────────────────────────────────────────────────────────────────────┘
```

## 2. Layers and responsibilities

1. **API layer** — thin. Translates HTTP to command/query, validates with Pydantic, produces
   OpenAPI. Error messages always carry a hint on how to fix the problem. Operations are atomic and
   clearly named, so that both a person and an LLM can drive them.
2. **Command bus** — every state-changing operation is a command with `execute()`/`undo()`. It runs
   the guardrail checks and writes an audit entry (ADR-004).
3. **Guardrail layer** — see ADR-005; encapsulates the Brightway pitfalls.
4. **Domain services** (`backend/src/prism_lca/engine/`) — the actual LCA logic, independent of
   HTTP.
5. **Repository interface** (`repository/base.py`, implemented in `engine/brightway_repository.py`)
   — the contract for workspace (project) and foreground-database lifecycle. It is only part of the
   engine seam: most domain modules reach Brightway directly through `get_bd()` (ADR-002).

### Persistence

- **Brightway 2.5** holds the inventory data (background read-only, foreground editable), the
  parameters (as `DatabaseParameter` rows) and the biosphere/method data.
- **PrismLCA side stores** hold what Brightway does not represent cleanly. They are plain JSON files
  in the workspace's `prism_meta/` directory, written atomically (temporary file plus rename), and
  registered once in `engine/_store.py` so that rename/delete of a model cascades over all of them:
  study metadata (`prism_meta/studies/`), tags (`tags.json`), views and canvas layout
  (`views.json`), chats and plans, reports and so on. Unknown keys are preserved on write, so an
  older version does not delete what a newer one stored.
- The **audit log** is an append-only JSON Lines file per workspace (`engine/audit_store.py`).
- **Semantic search** uses a persisted NumPy cosine-similarity index (`search/index.py`), brute force,
  which is adequate at ecoinvent scale. Embeddings come from a local model (bge-m3, downloaded on
  the user's consent) or, if the user chooses, from an API provider. There is no vector database.
- Application-level settings and provider keys live in the Electron user-data directory
  (`settings.json`; keys through `safeStorage`), not in the browser's `localStorage`, which is only a
  cache for the renderer.

## 3. Process and runtime model

- On launch, Electron starts the bundled backend as a child process, bound to `127.0.0.1` on an
  OS-assigned free port — no Windows firewall prompts, no port collisions.
- Handshake: the backend prints one JSON line on stdout (`prism-backend-ready` with host, port,
  token, version). The main process attaches the token as `X-Prism-Token` to every request. It polls
  `/health` for readiness and compares the backend version with its own; a mismatch is reported as
  `version-mismatch` — **no version drift**.
- One backend per data directory: the backend takes an OS advisory lock on startup and refuses to
  start if another instance already uses the directory (`engine/instance_lock.py`). It also checks
  the data format version and leaves a directory written by a newer PrismLCA untouched. If the shell
  is killed, the backend notices and exits (parent watchdog); on a normal quit the shell asks it to
  shut down in order.
- Next to an existing Brightway installation, whose projects PrismLCA must never change: the app takes
  its Brightway directory from its own settings (`PRISM_BRIGHTWAY_DIR`, else `brightway` in the data
  directory) and never opens an inherited `BRIGHTWAY2_DIR`, which usually points at the user's own
  Brightway or Activity Browser projects (`engine/brightway_dir.py`); nor any folder with files it did not
  create, whatever variable names it — only an empty one (marked as its own before anything goes in), a
  marked one, or the `brightway` folder of a PrismLCA data directory. Workspaces an earlier version kept in a shared directory are copied into the app's own one on
  its first start (`engine/workspace_carryover.py`) — read only, never through SQLite or bw2data, with
  Windows sharing modes that let the other program go on writing, and accepted only when nothing changed
  while it was read (`engine/foreign_read.py`). The backend pins pypardiso to its own
  Intel MKL and the threading layer it ships, overriding `PYPARDISO_MKL_RT`, `MKL_THREADING_LAYER` and
  `MKL_INTERFACE_LAYER` (`mkl_runtime.py`, before NumPy is imported). The frozen backend works in its
  own folder, so bw2data's `brightway-*.env` files in the folder it was started from do not apply, and
  it ignores `PYTHONPATH`, `PYTHONHOME` and the user's site-packages.
- Long calculations do not block the UI. A long LCIA run (a whole method family, or a deep model)
  is a **background job** that is started, polled, read back and cancelled between methods
  (`engine/calc_jobs.py`); the background import works the same way (start, then poll a status).
  There is no WebSocket channel.

### Security boundary: renderer ↔ main process

The renderer talks to the main process only through the preload bridge (`window.prism`, context
isolation on); the page itself cannot reach `ipcRenderer`. The token for the backend never reaches
the renderer. What the main process does for the renderer with its own privileges is bound where that
is possible.

**Chat attachments (`ai:attach`).** The main process reads a path only if the user handed it over in
this session, and exactly once per hand-over (`main/attachGrants.ts`). A grant is stored under the
path as given and under its real path (`realpath`, symlinks resolved). When a grant is redeemed, the
named path is first looked up: without a grant the request is rejected before the disk (or, for a
UNC path, the network) is touched. Only then is the path resolved again, compared with the grant's
real path, and read — the resolved path is what is read, so a symlink swapped in between leads to a
rejection, and so does a path deleted in the meantime. Resolution is asynchronous, so a slow network
share does not stall the main process.

- **File dialog** (`prism:pickFiles`, the chat's paperclip): the main process remembers what the OS
  dialog returned before it hands the paths back. That path never comes from the renderer, so the
  binding holds even against a hostile page. `prism:pickFile` (setup, background data) grants nothing;
  the chat does not use it.
- **Drag and drop**: the preload resolves the dropped `File` objects with `webUtils.getPathForFile`
  and reports the paths through `prism:grantDropped`. The page only passes `File` objects, never
  paths, and a `File` a script builds itself has no disk path. The preload calls no method of the
  object it is given (no `map`/`filter`/iterator — a forged object could otherwise supply its own
  paths); it reads the length and the elements by index and sends each through `getPathForFile`, and
  the length counts only as a primitive finite number, without conversion (so no page-supplied
  `valueOf` runs in the preload). A script in the page therefore cannot unlock an arbitrary path.
  A drop reads at most 50 files; the rest are counted and shown as a rejected attachment ("n more
  files were not attached …") rather than silently lost.
- **Deliberately not bound**: code running in the preload, or a compromised renderer process, can
  send any IPC message, including `prism:grantDropped` with an arbitrary path. No registration
  that starts at the renderer protects against that; the only complete protection would be to remove
  drag and drop. This is the accepted residual risk — PrismLCA loads no third-party content into the
  renderer. Size and format limits (`ai/attachments.ts`) apply in addition. If third-party content
  ever enters the renderer (web preview, foreign HTML), this must be reassessed. Also not checked is
  the **sender** of an IPC message (`event.senderFrame`): PrismLCA has one window; with a second
  window or embedded frames this check belongs here. A narrow time window between `realpath` and the
  read remains: whoever swaps a directory on the resolved path for a symlink at exactly that moment
  needs write access to the file system for it. `realpath` does not normalise case: the same file
  picked as `A.pdf` and named as `a.pdf` is rejected (safe, not friendly). Windows and UNC paths are
  untested.

## 4. Data model (summary; details in ADR-009)

A pure process graph: **activities** (Brightway 2.5 nodes) plus **exchanges** (typed: production /
technosphere / biosphere) plus **provider-typed links**. On top sits a **tag dimension**
(`(dimension, value)` per process, and per input from outside the model) for grouping and
aggregation. The technosphere is assembled **on demand** as a matrix from the exchange graph (no
frozen product system).

A **workspace** is a Brightway project holding the background databases; a **model** is one
foreground database in it (ADR-014).

## 5. Result formats (details in ADR-010)

Results follow the compact `meta + lookups + tree` envelope (short field names, names stored once in
`lookups`). Export: JSON (canonical), CSV/XLSX, SVG/PNG. The study report is typeset with Typst; it
stores its definition and its written chapters, not results, and computes the results from the model
at render time (ADR-016).

## 6. Where the larger subsystems are decided

- **The assistant** (agent loop, providers, context, sub-agents, durability, model fence): ADR-015;
  its tools and the MCP server: ADR-011.
- **The study report and its writer** (chapters, placeholders and pins, the second reader, staleness):
  ADR-016.
- **The `.prism` model bundle** (sections, compatibility, licensed data, import): ADR-017.
- **The library "My processes"** (the user's own and imported datasets): ADR-018.

---

# Architecture Decision Records (ADRs)

Format of each ADR: **Context · Decision · Alternatives · Consequences**.

## ADR-001 — Engine: Brightway 2.5
- **Context**: bw2-legacy is frozen; Brightway 2.5 (`bw2data` 4.x, `bw2calc` 2.x, `bw2io` 0.9.x,
  `bw_processing`, `matrix_utils`) is the future, and premise and the Activity Browser are converging
  on it.
- **Decision**: PrismLCA builds on **Brightway 2.5** (`backend/pyproject.toml` pins the lines above).
- **Alternatives**: bw2-legacy (frozen, migration debt); a non-Brightway engine (discards the core
  vision).
- **Consequences**: datapackages instead of presamples; integer node IDs in `bw2calc` have to be
  respected; `pypardiso` (Intel MKL) as the fast solver, which is why the installers ship MKL and
  its notices.

## ADR-002 — Engine behind a repository/service interface (no monkey-patching)
- **Context**: The Activity Browser couples its UI directly to patched Brightway objects and has
  been stuck in the bw2→bw2.5 migration for years.
- **Decision**: Brightway is encapsulated: no monkey-patching, no Brightway objects in API
  responses, and a repository interface (`LcaRepository`) with a Brightway implementation and an
  in-memory stub for API-shape tests.
- **Alternatives**: the Activity Browser pattern (rejected — demonstrably failed).
- **Consequences**: the engine is replaceable at the API boundary and testable. *Status: partly
  realised.* The repository interface covers workspace and foreground-database lifecycle only;
  the domain modules in `engine/` import Brightway themselves, through the lazy accessors in
  `engine/bootstrap.py` (which must set `BRIGHTWAY2_DIR` before `bw2data` is first imported).
  Narrowing this seam further is deferred. What holds today: no monkey-patching, and Brightway is
  reached only through those accessors — no module imports `bw2data` at load time, though some API
  routes and the search index call `get_bd()` themselves.

## ADR-003 — API-first (local FastAPI over HTTP)
- **Context**: AI readiness from day one; no UI-only path.
- **Decision**: All functions go through a **versioned** FastAPI (`/api/v1`) with OpenAPI and Pydantic
  schemas. The UI is a client, and so are the assistant's tools and the MCP server (ADR-011).
- **Alternatives**: Electron IPC straight to Python (no machine-readable contract); embedding Python
  in Electron's Node (unrealistic for the scientific stack).
- **Consequences**: a little overhead per call (negligible locally); a clear, testable, AI-capable
  contract; a per-process auth token and loopback binding are required. The renderer's response types
  are hand-written (`renderer/src/lib/server/routes.ts`); a client generated from OpenAPI is not
  used.

## ADR-004 — Command bus + undo/redo + audit log
- **Context**: The Activity Browser has no undo; ISO 14040/44 asks for traceability; AI changes must
  be reviewable and reversible.
- **Decision**: Every mutation is a command with `execute()`/`undo()`. Undo/redo stacks are kept
  per model for the session. The audit log records time, source (user, an AI client label, import)
  and what changed, and groups the changes of one assistant turn so they can be taken back together.
- **Alternatives**: no undo (Activity Browser); full event sourcing (excessive).
- **Consequences**: every mutation must be modelled as a command (discipline); this enables "show
  what the agent changed, and undo step 3". The audit log is persisted (JSON Lines, append-only) and
  survives restarts; the undo stacks hold Python objects with pre-change snapshots and do **not** —
  after a restart the log remains but the ability to undo does not.

## ADR-005 — Guardrail layer
- **Context**: The typical Brightway pitfalls should be prevented by the architecture, not by user
  discipline.
- **Decision**: Binding protections: (a) **background databases are hard read-only** (a
  `prism_read_only` flag in the database metadata, default on) — a change goes through an explicit
  copy into the foreground; (b) **pre-write validation** (unit consistency, no unlinked/orphaned
  references, exactly one reference product, circularity detected and warned about, no duplicate
  codes); (c) **delete preview** listing dependants, cascade only after confirmation; (d) a
  **model-health linter** (read-only sweep: unlinked inputs, reference-product problems, sign
  conventions, dimension and unit slips, formulas evaluating to zero, self-loops and cycles,
  duplicate supply, unused parameters, unmatched imported rows, unrecorded scope, and more);
  (e) a manual **workspace backup/restore** (`/projects/backup`, `/projects/restore`) for use before
  risky operations; (f) a guard on the workspace a request refers to (`X-Prism-Project`), so a
  client that has been working on another workspace cannot write into the one the user has since
  switched to.
- **Alternatives**: guardrails in the UI (rejected — AI access through the API alone would bypass
  them).
- **Consequences**: the guardrails sit in the backend and apply to the UI **and** to AI clients
  alike. The read-only check is called from the entry points in `model.*` and from a set of
  commands; it is not enforced mechanically on every possible write path, so a new write path must
  use one of those entry points or call `assert_writable` itself. Automatic snapshots before imports
  and bulk changes were part of the original plan and are not implemented; the manual backup is the
  mechanism today.

## ADR-006 — Frontend: Electron + React + TypeScript + Vite
- **Context**: A modern, dense data app; canvas and publication-quality charts; Windows primary,
  Linux equally supported; a heavy Python sidecar.
- **Decision**: **Electron + React + TypeScript (strict) + Vite** (electron-vite); canvas with
  **React Flow** (`@xyflow/react`, layout with dagre); charts with **ECharts** (performance and
  density) plus **D3** for specialised graphics.
- **Alternatives**: **Tauri** — lighter, but the Python sidecar dominates the size anyway, and Linux
  webview fragmentation and a less mature updater argue against it. Qt (rejected — Activity Browser
  aesthetics and coupling).
- **Consequences**: the Chromium baseline (~100 MB) is accepted; consistent rendering, a mature
  `electron-updater`, a huge ecosystem for tables and charts. Beyond the renderer, the Electron main
  process carries real logic (assistant, MCP server, updater), which is kept Electron-free where
  possible so it can be tested under plain Node.

## ADR-007 — Packaging, delivery and updates *(revised; replaces the original feed design)*
- **Context**: A public open-source release (AGPL) for Windows (primary) and Linux; frontend and
  backend must not drift; no network access without a user action (see `PRIVACY.md`). The original
  design (a `generic` update feed on a network drive) is obsolete.
- **Decision**: The backend is bundled with **PyInstaller (onedir)** into `electron-builder`
  `extraResources`; targets are **NSIS** (Windows x64) and **AppImage + deb** (Linux x64); macOS is
  planned, not shipped. Delivery is through **GitHub Releases** (`publish: github`), built by the
  release workflow (`.github/workflows/release.yml`) from a version tag. The update check runs **only
  on a click**; the download starts after confirmation; installation on "Restart and install" or on
  the next normal quit. The request carries the program version and the user's IP address, no
  device ID (electron-updater's installation ID is neutralised). Windows signing uses **Certum Open
  Source Code Signing** on a self-hosted release runner (Windows VM). **One** versioned artefact; the
  backend version is checked against the shell's at startup. The procedure is in the workflow and in
  `frontend/scripts/release/`.
- **Alternatives**: conda-pack, a uv venv (packaging); SignPath Foundation (forbids proprietary
  components such as Intel MKL), paid SignPath (cost), Azure Artifact Signing (individuals only in
  the USA/Canada); a self-run update server (operation, a second channel).
- **Consequences**: one installer per version, hence no drift; two instances on one data directory
  are prevented with a clear message (ADR-003 runtime model); UTF-8 is forced (Windows console);
  every signed Windows release needs a maintainer's SimplySign login (one-time code), so signing
  never runs unattended. The backend is stopped in order before the installer replaces program files,
  a failed install is reported (immediately, or on the next start), a `.deb` install is refused by the
  in-app updater, and the AppImage is swapped atomically.

## ADR-008 — ecoinvent provisioning: import from local ecoSpold2 files (no login)
- **Context**: Raw ecoinvent data must never be shipped (EULA). The import takes ~10–40 minutes.
  Users should **not** need an ecoinvent online login; anyone with a licence has the ecoSpold2 files
  (3.12 cut-off plus the LCIA implementation) locally.
- **Decision**: The first-run assistant lets the user pick the **path to the ecoinvent 3.12
  ecoSpold2 files** (local or on a network drive) and imports through **bw2io** (multiprocessing),
  then caches locally, so the import happens once. **No** `ecoinvent_interface`/online login. (The
  `ecoinvent_interface` route could be added optionally later.)
- **Alternatives**: `ecoinvent_interface` with per-user credentials (rejected — everyone would need a
  login); a central bw2.5 project archive (contains inventories → licence grey area).
- **Consequences**: raw data never enters the installer or the repository; everyone imports from
  their **licensed** copy. How users obtain their files is governed by their ecoinvent licence, not by
  the software.
- **Implementation — three steps, all from the same release** (`engine/ecoinvent.py`): the
  biosphere from `MasterData/ElementaryExchanges.xml`, the inventory from `datasets/`, the LCIA
  methods from the "LCIA Implementation" workbook. Because everything comes from one release,
  **nothing has to be matched by name** across versions — every characterisation factor finds its
  flow exactly (3.12: 484 598 of 484 598).
- **`bw2setup()` is never called**: it installs bw2io's bundled **3.9** flow list (4 709 flows
  against 9 850 in 3.12) and 3.9 LCIA methods that fail in this bw2io/bw2data combination. bw2io's own
  `import_ecoinvent_release` does the same as we do for biosphere and inventory — it just downloads
  the release with a login, which this ADR excludes. An **existing** biosphere is **patched** to the
  release's flow list (missing flows added), not skipped; otherwise the error would only surface
  steps later as "N unlinked exchanges", without pointing at the cause. The provenance
  (`prism_biosphere_revision`, source, flow count) and a `prism_import_complete` flag are stored on
  the database.
- **Entry point and rollback** (`views/BackgroundData.tsx`, `GET /setup/background`): the import is
  reached through *Overview → Background* — a page about the workspace, not about a model. The panel
  first reports (inventory, flows with revision, methods including custom ones, models) and then
  offers import, method top-up and **"start over"**. The reset deletes the background databases, the
  biosphere, **all** methods (custom ones too — their factors hang on flows that disappear), the
  **search indices** of the deleted databases (an index without its database returns hits that do not
  resolve) and the LCA cache. Models stay; how many exchanges would thereby point nowhere is shown
  **before** the confirmation. Confirmation is a four-digit code issued **by the backend** (single
  use, valid for 5 minutes, a typo does not burn it) — server-side, so the gate is not window
  dressing.
- **No suspicion of an aborted import without evidence**: a missing `prism_import_complete` does
  *not* mean "broken" — databases from before the flag carry their activities perfectly well. Only an
  **empty** registered database is the fingerprint of an aborted write. The stricter reading would have
  locked every existing installation out of its own workspace.
- **Nothing half-linked is written**: unlinked exchanges or unresolvable characterisation factors
  abort the import. For CFs the message names the missing flow **and the nearest candidates in the
  same compartment** — deliberately as a hint, not as an automatic replacement the way bw2io does it
  by name distance: a wrong pick would silently write the wrong factor into every result that uses
  the method.
- **Further background databases** (added later): a second provider (BAFU) can be imported beside
  ecoinvent; see ADR-014. Its elementary flows are mapped onto ecoinvent's flow list, and the mapping
  tables live in the repository as names only — no ecoinvent nomenclature is shipped, matching runs at
  runtime against the user's own ecoinvent.

## ADR-009 — Data model: pure process graph + free tags
- **Context**: Accessibility versus model complexity. SimaPro's product-stage BOM is powerful, but it
  is a parallel object model that hides the graph.
- **Decision**: A **pure process graph** (activities + exchanges + provider-typed links, Brightway
  2.5 as the source of truth). Grouping through **generic free tags** (several dimensions), assignable
  one by one or through a canvas box; aggregation by any tag dimension. **No** product-stage/BOM object
  model. openLCA patterns (separating flow, amount and unit; provider-typed links; user-defined data
  quality) are adopted where they fit. The technosphere is an on-demand matrix.
- **Alternatives**: a SimaPro BOM layer (rejected — double mental model); a fixed stage list
  (rejected — too rigid, tags are more general).
- **Consequences**: "life-cycle phase" is a standard tag dimension; canvas regions are a tagging tool
  (grouping follows tags). Tags can be assigned through the API (AI-capable, undoable, audited). The
  study metadata (ISO 14040/44) holds the **functional unit** as a field of its own, plus goal,
  scope, system boundaries, cut-off criteria, process allocation and system (end-of-life)
  allocation as recorded statements (`engine/study.py`); allocation is documented there, not modelled
  as a separate per-procedure factor set.
- **Addendum — tags on inputs**: A tag sits on a process of a model, or on a single input
  (technosphere exchange) whose supplier lies outside the model (background, library, another model);
  it is stored in `tags.json` under the consumer's key plus the exchange uid. Background datasets and
  the library carry no tags: a tag on the dataset would act in every supply chain of every model.
  Splitting by tags is solved exactly (foreground as a small system of equations over process × value,
  background through the adjoint unit impacts), with a rule per step: tag on the input before tag of
  the supplier before inherited value. On the canvas, an outside dataset appears once per tag
  combination of its inputs (one node per occurrence); so a material can physically hang on the
  processing step and still count as a raw-material phase.

## ADR-010 — Compact result envelope `meta + lookups + tree`
- **Context**: Results must be machine- and LLM-friendly, compact and uniform (a pattern taken from
  the `ecoinvent-bw` MCP server).
- **Decision**: All result formats follow `meta + lookups + tree` with short fields
  (`c,n,g,a,u,imp,dir,shr,…,ch`), names and tag values stored once in `lookups`. Sibling shapes exist
  for comparison and multi-method results. Export as JSON, CSV/XLSX, SVG/PNG.
- **Alternatives**: verbose JSON per result (rejected — token and bandwidth waste).
- **Consequences**: the frontend and AI share one schema; rendering is a pure presentation layer.

## ADR-011 — AI readiness: the assistant and an MCP server as API wrappers
- **Context**: An AI should be able to do everything the UI can, without a rebuild.
- **Decision**: AI tools are **thin wrappers around the same API endpoints**. Every design is checked
  against the question: "Can an agent do this through the API, and can the user review it (diff) and
  undo it (undo/audit)?" Two consumers share **one tool catalogue**:
  the in-app assistant (agent loop in the Electron main process) and an **MCP server** that the app
  hosts for external agents (Claude Code, Codex, Cowork and similar). The MCP server speaks
  Streamable HTTP on `127.0.0.1` with a random port and a bearer token (no remote bind, no OAuth,
  DNS-rebinding protection on); clients that only speak stdio start `PrismLCA --mcp-proxy`, a bridge
  that finds or launches the running app. The catalogue is defined once (`main/ai/tools`); what the
  MCP server does not expose (the assistant's sub-agents, planning list and chat-title tool, whose
  job belongs to the external client) is listed with reasons in `main/mcp/catalog.ts`, and a parity
  test holds both sides to `docs/ai-tool-manifest.json`. MCP calls are audited under the client's
  name and can be undone in the app.
- **Alternatives**: a separate AI path (rejected — divergence and maintenance risk).
- **Consequences**: the API has to be atomic, clearly named and well documented; the command/audit
  system is a prerequisite for AI review. Tool texts and prompt rules are changed together for chat
  and MCP.

## ADR-012 — Background: lazy expansion + copy-on-write localisation *(revised; replaces the path copy)*
- **Context**: Users want to explore background chains (ecoinvent) on the canvas and adapt individual
  background processes for their own study — without violating the read-only background database
  (ADR-005) and without flooding the canvas with huge chains.
- **Decision**:
  - The canvas shows the foreground plus **tier 1** (directly linked datasets from outside the
    model). Further tiers are loaded **lazily on click** (`POST /model/expand`, `engine/background.py`):
    the clicked dataset's direct technosphere inputs, each with the number of its own inputs. The
    endpoint can also compute each input's share for a method and drop those below a cut-off; the
    canvas does not use that and expands plain tier 1.
  - A dataset from outside the model — background or library (ADR-018) — becomes editable through
    **Localise** (`POST /model/activities/copy` with `relink_consumers`, `CopyToForegroundCommand`):
    the dataset is copied into the model, and the model's inputs that drew on it draw on the copy
    instead — all of them, or only the inputs named by uid (one box on the canvas). Inputs in other
    models keep the original, and every input of the copy still points where the original's did, so
    the result is unchanged until the copy is edited.
  - **Depth 2** also copies the dataset's direct suppliers and points the copy at those copies; the
    supplier copies keep drawing on the background. At most 30 suppliers
    (`LOCALIZE_SUPPLIER_LIMIT`), refused before anything is written. A dataset's input on itself (an
    electricity market's losses) becomes the copy's input on itself, at either depth.
  - Going deeper is the same step again: the copy's inputs carry uids, so localising one supplier of
    the copy moves only that input and the chain stays connected.
  - Tags: when all moved inputs carry the same tags, those become the copy's process tags; differing
    tags stay on the inputs.
  - One command per Localise: one undo takes the copies and the relinking back, and redo rebuilds them
    under the same codes and uids, so later entries on the undo stack still find them. Where a copy
    came from is recorded in the audit entry (the source database is a related database), not on the
    copy.
  - The canvas and the assistant's `localize_dataset` tool use this one path; Duplicate and Move to
    library share its exchange copy, which writes the rows in one transaction.
- **Alternatives**: in-place editing of the background database (rejected — violates ADR-005,
  destroys data provenance); rendering all tiers at once (rejected — performance and legibility);
  copying the whole **path from the functional unit to the dataset** (the original design,
  `POST /model/localize`, `LocalizePathCommand`, which stamps `prism_localized_from` on each copy) —
  replaced by copying one dataset and moving its consumers, which leaves the model's structure as it
  is and can be repeated one level at a time. The path command and its endpoint still exist with a
  backend test, but nothing in the product calls them.
- **Consequences**: a new write path that copies a dataset goes through `CopyToForegroundCommand`
  rather than its own copy, so relinking, tags, undo and the one-transaction write stay in one place.

## ADR-013 — Parameter and variable model (mapped onto Brightway + scenario overrides)
- **Context**: Central, structured, API-operable variables for amounts and formulas in foreground
  processes; some valid across scenarios, some scenario-specific.
- **Decision**: PrismLCA variables are a **registry/UI layer over Brightway's native parameter
  engine** (formulas evaluated topologically, with cycle detection) — **not** a separate
  "substitute before calculation" mechanism. **Parameters are scoped to a model**: each foreground
  database owns its named variables, stored as `DatabaseParameter` rows, so two models can reuse a
  name with independent values. Exchange amounts can be driven by a `formula` referencing them.
  **Scenarios** are named sets of parameter overrides (a number or a formula) of one model; computing
  a scenario applies the overrides, recalculates the parameterised exchanges, runs the LCIA and
  restores the baseline. Variables carry group/category, unit, description and **uncertainty** (→
  Monte Carlo). The central screen is a **parameter dashboard** with a dependency graph. Everything
  is available through the API (AI-ready).
- **Alternatives**: a separate substitution layer (rejected — duplicates engine logic, loses Monte
  Carlo propagation); process-local parameters only (rejected — no scope across scenarios).
- **Consequences**: the formula language is Brightway's (asteval); guardrails: no orphaned parameter
  references, no formula cycles. The apply/restore of overrides is done in-process in a guarded window
  (`engine/param_window.py`; an interrupted window is recovered at the next start and flagged by the
  health linter). The original plan to implement scenarios as Superstructure columns / `ParameterRedef`
  sets was not followed; a datapackage-based implementation could replace apply/restore later with an
  identical result.

## ADR-014 — Workspace = background environment, foreground database = model/study
- **Context**: ecoinvent is large and expensive to import, and in Brightway it is **bound to a
  project** (databases cannot be shared across projects). At the same time a user needs several
  models/studies that share one background. An early version fixed the foreground database name to
  `"foreground"` (only one model possible) and kept study metadata **per project** (only one study per
  project) — architecturally inconsistent.
- **Decision**: A **Brightway project = one working environment**, bound to **one background stack**,
  **imported once and shared by all models in it**. A **foreground database = exactly one model/study**,
  **named by the user** (e.g. `pet-bottle-2025`), **several per project**. **Study metadata (ISO
  14040/44) lives per foreground database** (`prism_meta/studies/<readable>~<hash>.json`, the hash being
  that of the exact model name — earlier versions used `<db>.json`, which merged "Model A" and
  "Model_A"), not per project. The active-foreground-database switch is the **model picker**; the project
  switch selects the background. The canvas **never** loads a large read-only background database — it
  is reached only through search and "Copy" into the foreground. (A pattern like the Activity Browser's,
  but with a clean model↔database relation.)
- **Alternatives**: *a project per study* (rejected — an ecoinvent re-import or copy per study,
  gigabytes of duplicates); *one fixed foreground per project* (rejected — no multiple models, no
  sensible study binding).
- **Consequences**: `create_foreground_database(name)` accepts arbitrary names (several allowed);
  `/study` is parameterised by database; the report uses the study metadata of the model database. A
  "study" is thus first-class bound to the foreground database. Migration: existing per-project
  `study.json` files are not taken over automatically (early test data).
- **Addendum (BAFU:20XY):** "one background stack" has since meant **one biosphere, one method set,
  at most one database per provider** (ecoinvent, BAFU). ecoinvent is the master: BAFU is mapped onto
  ecoinvent's flow list; if ecoinvent arrives later, everything existing is rewritten onto ecoinvent.
  A registry `prism_background` sits on the database metadata.
- **Addendum (naming):** In everything users or the model read (UI, handbook, tool and error texts,
  privacy notice), the Brightway project is called **"Workspace"**. Reason: in SimaPro, openLCA,
  Umberto and One Click LCA "project" means the *study* — which is the model here; openLCA also calls
  the comparison of several product systems a "project". Only Brightway and the Activity Browser mean
  the data container by it. Technical identifiers stay (`/api/v1/projects`, `X-Prism-Project`,
  `project_*`, Brightway directories).

## ADR-015 — The assistant: an agent loop in the main process, durable and fenced to its model
- **Context**: For many users the assistant is the main way into a model: from a description, a bill
  of materials or a datasheet to a linked, calculated and documented model. It acts on real data with
  real costs (the user's own provider account), runs for many minutes and often a hundred tool calls
  or more, and works with models of very different strength from several providers. Four things have
  to hold: the user stays in control (sees, steers, stops, approves, undoes); a run survives an abort
  or a restart without losing its thread; the bill stays predictable; and a run cannot spill outside
  the model it was opened in. ADR-011 covers the tool contract it shares with the MCP server; this
  record covers the chat itself.
- **Decision — where it runs**: The agent loop (`main/ai/agent.ts`, `runAgent`) runs in the Electron
  main process. The provider keys stay there (`main/secrets.ts`, encrypted with `safeStorage`, never
  sent to the renderer or into a log), a run survives a reload of the window, and tools reach the
  backend through the same authenticated HTTP API as the UI. Tools that act on the window (canvas
  screenshot, question card, chat title) make a round trip to the renderer (`main/ipc/uiBridge.ts`).
  One executor (`main/ai/execute.ts`) runs every tool call for the chat and the MCP server alike, in
  a fixed order: unknown or switched-off tool → model fence → argument validation against the tool's
  JSON schema (`argSchema.ts`: the message names the field, what was expected, what came and how to
  fix it; `null` on an optional field counts as not given; the schema is never bent to suit a model
  that sends the wrong shape) → repeat guard → effect.
- **Decision — a turn**: A turn runs in rounds: the model answers, its tool calls run, the results go
  back. Read-only tools from a fixed set (`PARALLEL_SAFE_TOOLS`: research, search, process details,
  method list, distances, Eurostat) run concurrently when the model calls several at once; every other
  call runs alone, in order. A turn ends with one of ten outcomes (`RunOutcome`, `shared/plan.ts`):
  answered; round limit (150 by default); cost limit (15 USD by default, summed over every model the
  turn calls, sub-agents included, checked between rounds); repetition (a reply looping on itself);
  stalled (three rounds in a row without a successful tool call earn one nudge, six end the run);
  empty; output limit; cancelled; error; interrupted (the app closed mid-run, marked at the next
  start). A fourth call with the same canonical arguments is refused until a write moves the model on.
- **Decision — the user in the loop**: A message typed during a run is delivered at the next round
  boundary (`ai:steer`) and quoted in the answer, so a turn stays one assistant message. Every tool
  and action is declared read, write or irreversible (`tools/effects.ts`); an irreversible one shows
  an approval card first (`main/ai/approval.ts`). Undo (`history`) is exempt in the chat because the
  user is present and redo exists; it stays irreversible for MCP. `ask_user` puts a question card in
  the chat. Every write goes through the command bus — audited under the assistant's label, grouped
  per turn, undoable (ADR-004).
- **Decision — providers**: Three transports behind one contract (`main/ai/providers/`): OpenRouter (the
  default, many vendors), OpenAI directly (Responses API) and Google directly (Interactions API — Google's
  default interface; its OpenAI-compatible endpoint has no Google Search, and `generateContent` is
  legacy). All three are plain HTTP + SSE without a vendor SDK, so streaming, stall detection, retries
  with backoff and exactly one usage record per request are shared (`providers/engine.ts`). Privacy flags
  are set wherever a provider has them: on OpenRouter `data_collection: deny` and zero data retention,
  with per-vendor exceptions the user can switch; on OpenAI and Google `store: false` on every request
  (neither has a per-request retention switch, and Settings says so). Google's stateless mode needs the
  model's signed thought steps back with every tool round; they ride on the assistant message as opaque
  `replay` data. There is no PrismLCA key and no proxy: the user is the provider's customer. Cost is
  taken from the provider where it reports it and otherwise computed from prices kept by hand
  (`main/ai/directModels.ts`, with announced price changes dated in), marked as estimated. Reasoning
  effort is sent only at the levels a vendor documents for that model.
- **Decision — context and cost**: Prompt caching, not context size, decides the bill, so the context
  is shaped for the cache. The system prompt is byte-identical across the turns of a chat; facts that
  change per turn (study language, the request to title a new chat, the note after an abort) ride at
  the top of the current user message. Explicit cache markers are set where a provider needs them. The
  context is not pruned to save tokens — that breaks the cached prefix and costs more than it saves at
  our sizes. Compaction runs only when the projected prompt exceeds half the model's window: older
  tool results become stubs, oldest first, except the expensive and irreplaceable ones (skills,
  research, review), which go last; the same model summarises what was dropped; the newest plan is
  never stubbed. A context overflow reported by the provider triggers up to two harder compactions.
  Tool results are cut structurally when written (`resultBudget.ts`), and narrow tool modes
  (summaries, recommended entries only) keep large results out in the first place.
- **Decision — tools and skills**: One catalogue (ADR-011) under a hard ceiling (`tools.test.ts`,
  currently 54 tools): tool choice gets worse as the list grows, so new capability first extends a
  consolidated tool (an action or mode, implemented in `IMPL`). Tools that do not apply — a feature
  switched off, no web access, no vision, the plan tool for a model that does not need it — are left
  out of the request and the prompt instead of being refused at call time. Method knowledge lives in
  **skills**, Markdown files the model loads on demand with `get_skill`
  (`backend/src/prism_lca/assets/skills/`: model building, proxy selection, parameters, goal and scope,
  bills of materials, end-of-life scenarios, sea distances, interpretation, review, the app itself),
  plus skills the user writes; the prompt lists them, the text arrives when needed.
- **Decision — sub-agents**: Three tools are another model behind a tool (`main/ai/subagent.ts`):
  `research_web` (parallel legs, one per question, each with its own round and time budget; findings
  carry their sources), `research_bom` (a bill of materials checked by a mass balance) and
  `review_model` (one pass over a deterministic dossier — health check, hotspots, goal and scope,
  backgrounds — without tools; logged against the model state, so whether a review is stale is
  arithmetic). They run on cheaper default models per provider and can be set separately, so the
  reviewer can be another model than the builder. Web access is opt-in per chat under an app-wide
  switch; with it off, the research tools are not offered.
- **Decision — durability**: A run's state lives in the backend, not in memory: the chat with its
  messages, plan and run state (`engine/chat_store.py`, per model) and the full tool transcript
  (`engine/chat_transcripts.py`, `prism_meta/ai_transcripts/`, written at every exit of a run; at most
  6 MiB per chat and 60 MiB per workspace, oldest evicted; a transcript over the limit is refused,
  never cut). **Continue** resumes any run that did not end with an answer: the transcript is used
  when it matches the visible history exactly, otherwise the model rebuilds from the prose; either way
  it is told that the previous run stopped and to check the model's state before going on, since the
  last step may be half applied. The **plan** (`shared/plan.ts`, tool `plan`) is a step list the model
  keeps — the whole list on every call, at most one step in progress, `blocked` and `skipped` need a
  note — shown as a card and stored with the chat. It is offered per catalogue row (`planTool`): the
  strongest models keep track of their work without it, weaker ones hold the thread better with it.
  Durability does not depend on the plan.
- **Decision — the model fence**: The chat works on the model it was opened in
  (`main/ai/modelScope.ts`; in the backend `engine/model_scope.py`, through the `X-Prism-Model`
  header). It reads and writes that model and may rename it; it reads comparison models that the user
  linked in the study and switched on in this chat; it links inputs from backgrounds and the library.
  It does not create, copy, open, import or delete models, does not link inputs from another model and
  does not write into the library. Reads are fenced in the main process, writes in the backend as
  well. Workspace-wide resources (custom methods, the tag vocabulary) stay reachable. MCP sessions
  carry no fence: an external agent works across models on purpose. Per chat, the user releases what
  the assistant may see beyond its model — the library, each background, comparison models, web
  access, distances, Eurostat.
- **Decision — inputs**: Attachments (PDF and images go to the model natively, other documents are
  converted to Markdown by the backend; at most 10 files and 30 MB per message) under the path-grant
  rules of §3; speech to text through the user's provider; canvas screenshots for models with vision.
- **Alternatives**: the loop in the backend (rejected — the keys would have to leave the main process,
  and the window tools would need a channel back); the loop in the renderer (rejected — keys in a web
  context, and a reload ends the run); pruning the context continuously (rejected — see above); the
  plan tool for every model (rejected — the strongest models kept their thread without it in measured
  runs); an automatic health check after every batch of writes (not done — the model and the user
  call it when it helps); a chat that works across models like an MCP client (rejected — work done
  in another model would sit under a chat the user does not see there).
- **Consequences**: a new tool declares its effect per action (and gets the approval card for free if
  it is irreversible), names its model argument `database` or `*_database` so the fence sees it, fits
  under the ceiling, and comes with a decision on what MCP gets (ADR-011). A new backend command
  declares the models it touches (`test_model_scope.py` holds the line). A new stop reason is a
  `RunOutcome` member with its resume reason and label. Whatever is added to the system prompt must
  stay identical across a chat's turns. Evaluations that spend provider money are opt-in
  (`PRISM_EVAL_LIVE`). Chats travel in a bundle only in the `full` preset and without the transcript
  (ADR-017).

## ADR-016 — The study report: deterministic chapters, written chapters, and a gate that owns the numbers
- **Context**: The study report is where a model's numbers reach a reader outside PrismLCA — a client,
  a reviewer, the public. Part of it is tables and figures that code can build exactly; part is prose
  (introduction, interpretation, summary, conclusions, the inventory narrative) that a language model
  can draft. Model-written prose has three failure modes that matter more than style: a wrong figure
  (typed, rounded, calculated, or standing next to the wrong name); text that silently goes stale when
  the model changes; and text about the tool instead of about the study. A report is also regenerated
  many times while a model evolves, and chapters the author has accepted must not be rewritten
  without cause.
- **Decision — a stored definition, computed at render**: Reports are stored per model in the
  workspace's side store (`engine/report_store.py`, `prism_meta/reports.json`), several per model. A
  report is an ordered list of sections, each with a chapter kind, its settings and — for written
  chapters — the stored text with its bindings. There are seventeen chapter kinds
  (`engine/report_kinds.py`): thirteen built by code (abbreviations, goal and scope, system model,
  inventory, methods, LCIA, contribution, interpretation checks, limitations, appendix, datasets,
  references, provenance) and four written by a model (introduction, interpretation, summary,
  conclusions). A chapter built by code may carry a written comment under its tables; the inventory
  chapter's default is a text written from the foreground process notes rather than the notes
  themselves, which are written while modelling and not for a reader. Results are **not** stored with
  the report: every render computes the LCA, contributions and hotspots from today's model
  (`engine/report_pipeline.py`), cached on the model's state, so a report never prints numbers older
  than its model. Rendering is Typst (`engine/report_typst.py`, `engine/typst_render.py`): twelve
  themes and nine colour palettes ship and users can add their own; five report languages (English,
  German, French, Spanish, Portuguese) with offline spell-check dictionaries; the front matter order is
  fixed (summary, then contents and the lists of figures and tables, then abbreviations).
- **Decision — the model proposes, the backend decides**: The writer runs in the Electron main process
  (`main/ai/reportWriter.ts`, `main/ai/writer/`) from a button on the report page; it is not a chat
  tool. The backend builds each chapter's brief (`engine/report_prompts.py`, `build_brief`): the chapter
  prompt; the author's own instructions, repeated last so they have the final word; invariant rules
  appended to whatever prompt is in force, so an edited prompt cannot drop them; the study record; the
  facts the chapter may draw on (results, contributions, hotspots, inventory, checks, foreground
  processes, parameters, scenarios, exchange notes; the research and review records only for the
  chapters that use them); and the placeholders it may cite. The writer may look things up with a few
  read-only tools within a budget per chapter kind. The backend owns the gate (`engine/report_gate.py`).
- **Decision — numbers are placeholders, pinned to members**: A written chapter contains no computed
  figure as a literal. It cites placeholders such as `{{contribution.groups.0.share_text}}`, and
  derived figures (sum, difference, percent, change, factor, rank) are placeholders too — the model
  never calculates. Each placeholder is bound to the member it meant (that dataset, that indicator,
  that phase), not to a position (`engine/report_bindings.py`), so a recomputation that reorders the
  hotspots cannot move a figure under another name; a pin moves only when the sentence citing it is
  rewritten. The name standing in front of a figure is checked against its pin
  (`report_claims.misbound_names`). A typed figure that matches exactly one placeholder is replaced by
  it; one that cannot be matched becomes an open point for the author, and a report with open points
  cannot be approved (`engine/report_typed_numbers.py`).
- **Decision — a second reader**: Every written chapter is read by a second model before it is stored
  (`main/ai/writer/dialogue.ts`, `reviewer.ts`). The reader sees the chapter as it will print, the same
  brief, the neighbouring chapters and the author's earlier answers; it has no tools, every objection
  must quote the chapter (a quote that is not in the text is dropped), and it may put a question to the
  author with a proposed answer. Writer and reader converse for at most three readings. Contract
  findings — an unresolved or malformed placeholder, an unknown reference, a unit mismatch, a literal
  number, an empty chapter, an emoji (`CONTRACT_FINDINGS`) — block whatever the reader says; every
  other finding is a hint the reader decides on. If the reader fails, the gate decides alone and every
  finding blocks. Answering the reader's question updates that chapter at once.
- **Decision — staleness is arithmetic**: Whether a chapter still holds is computed, not judged by a
  model (`engine/report_staleness.py`): its cited members, bindings, selection and the bands and ranks
  of its figures are compared with what it was based on, and the remedy is graded — none (the
  placeholders carry the change), review, or rewrite. An update hands the writer the chapter **rebased
  into today's positions** (`engine/report_rebase.py`); a pinned member that has left the results reads
  `{{gone:…}}`, which the gate refuses until that sentence is rewritten. The writer returns exact
  replacements, not a new chapter, and the gate runs as on a first write. "Write all" plans each
  chapter (write, update or keep), writes the other chapters in parallel lanes, then the conclusions,
  then the summary, and takes the summarising chapters along whenever another chapter changed. The
  author's "reviewed" mark lapses when the wording or the numbers move.
- **Decision — it reads as if a person wrote it**: The invariants forbid naming the assistant, a
  language model, tools, automated checks, internal reviews, research runs or the software in any
  written chapter — negations included — and a researched fact is stated with its source. The one
  exception is a critical review under ISO 14044 §7.3.3, which names a person on record. Written text
  carries no headings, tables or links, no absolute value judgements and no claims of climate
  neutrality.
- **Decision — literature, export, short report**: The introduction and the interpretation may call
  the research sub-agent (ADR-015) twice per chapter, switchable per chapter; findings go into the
  model's research log and the References chapter prints the sources. Export refuses a report with
  unresolved gaps or chapters waiting for review; "Export anyway" stamps every page DRAFT in the report
  language. The short report (`engine/report_short.py`) is a definition built from its settings and
  never stored; it contains only chapters built by code and prints nothing a model wrote. Only one
  writer works on a chapter at a time (`main/ipc/chapterClaims.ts`), and writing counts against the
  same cost limit as the chat.
- **Alternatives**: letting the model type numbers and checking them afterwards (rejected — a rounded
  or misattributed figure passes many checks; with placeholders a wrong figure cannot be typed in the
  first place); pinning placeholders to positions (rejected — a recomputation that reorders members
  prints another member's figure under a sentence that still reads right); handing the writer the
  chat transcript as material (rejected — far too large per call, full of literal numbers, with no
  staleness and no provenance, and the stored chat keeps only previews of tool results; the study
  record, the exchange notes and the research and review logs carry the modelling judgement instead);
  a model judging staleness (rejected — arithmetic over the pins is cheaper, deterministic and
  testable); word lists as the gate (kept only as hints for the reader and as the fallback when the
  reader fails).
- **Consequences**: anything a chapter should say about the model reaches the writer through the
  brief and a placeholder path, chosen in the backend (`brief_facts`), so the gate judges against the
  same evidence the writer saw. A change to bindings, rebase or staleness has to answer what happens to
  the pins of sentences it does not touch. Each written chapter costs a writer call and at least one
  reader call; evaluations that spend provider money are opt-in. Reports travel in bundles with their
  chapters (ADR-017).

## ADR-017 — The `.prism` model bundle: an additive, deterministic format without licensed data
- **Context**: A model has to travel — to a colleague, to another computer, into an archive — together
  with everything that makes it a study: parameters, scenarios, tags, study metadata, canvas, reports,
  the research and review records. Three constraints shape the file: it must never carry licensed
  background data (EULA, ADR-008); it must keep importing for as long as PrismLCA exists, so every
  release has to read every older file; and it must survive a round trip through an *older* PrismLCA
  without losing what a newer one wrote.
- **Decision**: A `.prism` file is a ZIP of `manifest.json` plus one `<section>.json` per section
  (`engine/bundle.py`). The container has a format number (`FORMAT = 1`) that changes only if the
  manifest or the member layout changes; each section carries its own `schema` number and a SHA-256
  in the manifest. The sections are one registry, `SECTIONS`, in a fixed order:

  | Section | Carries |
  |---|---|
  | `graph` (required) | the model's activities and exchanges, classifications and documentation; tags on an input ride on its row; every input from outside the model as a **reference** |
  | `library` | the closure of "My processes" datasets the model draws on, with provenance (ADR-018) |
  | `parameters` | parameters with formulas, groups and rules |
  | `tags` | process tags |
  | `scenarios` | named override sets; schema 2 only when an override is a formula, otherwise declared 1 so older readers still take it |
  | `study` | the ISO 14040/44 study record, including limitations |
  | `view` | canvas layout and results setup |
  | `reports` | reports with their chapters (ADR-016) |
  | `research_log`, `review_log` | what was researched and reviewed while modelling |
  | `chats`, `audit` | only in the `full` preset (below) |

  The rules of the format:
  - **Additive only.** Something new to store is a new registry entry or a new optional field; an
    existing writer is never changed and no field is renamed within a schema. A section that changes
    shape gets a higher `schema`, and the reader names a newer schema it does not know
    (`newer_sections`) instead of guessing at it — a newer *required* section refuses the import.
    A container newer than the reader is refused (`bundle_too_new`); older bundles always import.
  - **Golden bundles.** One fixture per released section schema lives in
    `backend/tests/fixtures/bundles/` and stays there for good; a parametrised test imports every
    one of them. This is the compatibility guarantee that does not depend on intentions.
  - **Unknown sections are kept.** A section this version does not know is stored verbatim under
    `prism_meta/imported_unknown/<hash of the model name>/` (`engine/bundle_unknown.py`) and written
    out again with the model's next export, under its original schema and `required` flag. The
    folder name is a hash because the model name comes from a foreign file.
  - **Deterministic.** Two exports of the same model are byte-identical: canonical JSON with sorted
    keys, `written_at` always null, a fixed ZIP date for every member, members in registry order and
    rows sorted. A test holds it.
  - **No licensed data.** Every dataset outside the model is a reference — database, code and a
    fingerprint (name, reference product, location, unit) plus the background's version — never its
    content. `requires.backgrounds` lists the databases, versions and providers a model needs.
    Exporting a read-only (background) database is refused. The library section is the user's own
    data and travels; it never follows a link into a background.
  - **Presets.** `model` (the default) carries every section except `chats` and `audit`; `full`
    adds them; `graph` carries the graph alone. Chats and the audit trail stay out by default because
    they hold costs and conversation the recipient has no use for. A chat travels with its messages and
    plan, its run reset to idle, without the tool transcript; the audit trail arrives as appended
    history notes that can be read but not undone.
- **Import**: `/bundle/inspect` is a dry run and `/bundle/import` writes; both use the same reader and
  the same resolver, so the preview is what the import will do. References are resolved by a ladder
  (`engine/bundle_resolve.py`, a pure function): the exact `(database, code)`; the same code in another
  installed database; a single fingerprint match in a database of the same version; several matches
  for the user to choose from; otherwise missing. A reference found only in **another background
  version** is refused — also when a database of the same name holds that other version, which is the
  quietest route to numbers that look calculated as modelled. The cross-version stages of the ladder
  are built and tested but switched off (`allow_cross_version=False`); turning them on is a release
  decision. Nothing is written while a reference is unresolved. The import itself is one command
  (`ImportBundleCommand`), so it is one audit entry and one undo: the library lands first, then the
  graph, then the other sections in registry order; a name clash lands as a new model (`name (2)`),
  never a merge; any failure takes everything this import wrote back.
- **Alternatives**: a Brightway project archive or a database export (carries background inventories →
  licence; no study, reports or scenarios); copying background datasets into the bundle (licence);
  versioned migrations of old files (rejected — a frozen reader per schema plus golden files is cheaper
  and cannot regress silently); relinking across ecoinvent versions by name (rejected for now — a wrong
  match silently changes every result).
- **Consequences**: adding something to a model's stored state means deciding whether it belongs in a
  bundle and, if so, adding a section or an optional field — with a golden fixture when a schema goes
  up. A bundle opens only where the recipient has the same background versions installed. The
  separate two-sheet spreadsheet export is a lossier exchange path, not a second bundle format.

## ADR-018 — The library "My processes": one writable, live-linked collection per workspace
- **Context**: Users build datasets of their own (a supplier's process, a measured machine) and bring in
  datasets from other tools — EcoSpold 1/2, SimaPro CSV, openLCA JSON-LD, ILCD
  (`engine/dataimport/`). Several models use the same such dataset, and when it is corrected, the
  correction should reach all of them. The background databases are read-only (ADR-005) and a model is
  one study (ADR-014), so neither is the place for them.
- **Decision**: One fixed, writable database per workspace, **"My processes"** (`engine/library.py`,
  `LIBRARY_DB`). It is created once the workspace has a background (at startup and on every workspace
  switch; before that, an empty workspace still opens the first-start import). Models link to its
  datasets **live**: an edit reaches every model that draws on the dataset at its next calculation.
  - **Not a model, not a background.** `kind: "library"` keeps it out of the model list and the model
    picker, the delete path refuses it (`library_protected`), and the active-model fallback never lands
    on it. It is not read-only: the user edits its datasets like a model's processes.
  - **What lands in it**: datasets built by hand; everything a data import brings in; and processes
    moved out of a model (**Move to library**, `MoveToLibraryCommand`). A move relinks the model's
    consumers to the library copy and moves the process's tags onto those consumers' inputs; a process
    with formulas is refused, because parameters belong to a model and the library has none.
  - **Provenance on the dataset, not the database**: source, format, batch and its label, and the date
    of an import sit on each activity (`prism_import_*`), because the database is permanent and mixes
    many deliveries. Removing an import deletes its batch — refused while a model or another library
    dataset still draws on it, unless forced. A re-import recognises datasets it brought before.
  - **Unmatched flows are parked, not dropped**: an import's flows that match nothing in the
    workspace's biosphere are kept as a note on the activity (`prism_unmatched`), counted in the
    process details and the health check — never as placeholder activities, which would calculate as
    zero and show up in search. A dropped emission would make a dataset look better than it is.
  - **Written so that ids stay put**: datasets are written with `new_activity().save()`, never with
    `Database.write()`, which empties and re-inserts the database and gives every activity a new id —
    the processed datapackages of every model that draws on the library would silently go stale.
  - **No tags on the library**: a tag on a library dataset would act in every model; tags go on the
    consuming input instead (ADR-009).
  - **The assistant** sees the library only when the user releases it for a chat (off by default); its
    hits are marked as library datasets, and the chat may link them but not write into the library
    (ADR-015). **The report** names a linked library dataset with its origin — imported from which
    source on which date, or built by hand — so the writer can say so (ADR-016).
  - **Bundles** carry the closure of the library datasets a model uses (ADR-017).
- **Alternatives**: copying a dataset into each model when it is first used (rejected — a correction
  would have to be repeated in every model, and copies drift apart); one read-only database per import
  (rejected — many databases, nothing to edit, and a correction means a re-import); a library shared
  across workspaces (not possible — Brightway binds databases to a project, ADR-014).
- **Consequences**: a finished study's numbers move when a library dataset it uses is edited — that is
  the point of linking live. A state is frozen by localising the dataset into the model (ADR-012) or by
  exporting a bundle. A new write path into the library writes activity by activity and stamps
  provenance; a new view of the workspace treats the library as neither a model nor a background.
