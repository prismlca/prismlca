# PrismLCA — Architecture

> Architecture overview and decision records. The numbered sections below are referred to from code
> comments; keep their numbers stable. Where a decision was later replaced or only partly realised,
> the ADR says so.

## 1. Overview

PrismLCA is a **desktop app made of two processes**, delivered as **one** atomically versioned
artefact:

- **Electron frontend** (React + TypeScript strict + Vite). The *renderer* is the presentation and
  interaction layer. The Electron *main process* additionally hosts the AI assistant (agent loop,
  provider clients, tool catalogue), the MCP server for external agents, the update check and the
  OS integration (dialogs, key storage, spell checking).
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
│  │  AI agent loop / providers / tools · MCP server ·               │   │
│  │  updater · key storage (safeStorage) · settings                 │   │
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
`lookups`). Export: JSON (canonical), CSV/XLSX, SVG/PNG. A written study report is typeset with Typst
from the same stored results.

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

## ADR-012 — Background: lazy expansion + copy-on-write localisation
- **Context**: Users want to explore background chains (ecoinvent) on the canvas and adapt individual
  background processes for their own study — without violating the read-only background database
  (ADR-005) and without flooding the canvas with huge chains.
- **Decision**:
  - The canvas shows the foreground plus **tier 1** (directly linked background processes). Further
    tiers are loaded **lazily on click**, **controlled by a contribution cut-off** (only branches above
    a contribution threshold, tied to the latest LCIA result; `POST /model/expand`).
  - A background process becomes editable through **"Localise"** (`POST /model/localize`): the **path
    from the functional unit to this node** is copied into the foreground (copy-on-write), each copy
    re-linked to the changed predecessor and every off-path input still pointing at the background.
    A full command with a **diff preview** (affected activities and their number) → confirmation →
    undo/audit.
  - **Scope**: the copied path only (branch-local). An option to localise every use of the dataset in
    a study was part of the original design and is not implemented.
  - Localised copies carry a provenance note (`prism_localized_from`).
- **Alternatives**: in-place editing of the background database (rejected — violates ADR-005,
  destroys data provenance); rendering all tiers at once (rejected — performance and legibility).
- **Consequences**: builds on `CopyToForegroundCommand`, extended by path propagation and re-linking
  (`LocalizePathCommand`); needs the contribution analysis for the expansion cut-off.

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
