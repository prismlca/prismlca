# Changelog

Every PrismLCA release, newest first. Sections are drafted by `npm run release` (in `frontend/`) from the
What's-new entries since the previous release and finished by hand before the release is tagged.

## 0.9.12 — 2026-11-13

### New

- **More AI models.** Claude Fable 5.2 replaces Fable 5.1, on OpenRouter and with Anthropic directly. OpenRouter also
  offers Gemini 4 Carbon, Tencent's Hy4, MiniMax M3.1 Flash and Mistral Large 4. GPT-6 Astra, 6.1 Sol and Luna offer
  *Max* reasoning effort, and the effort picker says which level *Default* stands for. *Settings → AI → Models* rates
  models by the Artificial Analysis Intelligence Index v5.
- **Only trusted OpenRouter providers.** Under *Settings → AI → Provider*, a switch below the provider cards keeps
  OpenRouter requests to an allowlist of providers: the labs, the large clouds and established inference hosts. It is
  on by default; *Edit list* removes a provider or adds one by name, *Reset defaults* brings back our list.
- **Filter the dataset search by unit.** The search beside the canvas and in the Results has a unit filter under the
  regions. Every filter now applies at once — a type, region or unit repeats the last search without pressing Enter.
- **Searches keep the best matches outside the region.** When the assistant searches with a region, the answer also
  lists the two best datasets outside it, so a material missing from the region is no longer taken as missing
  altogether.
- **Reviews show progress and stop on time.** The run bar shows how far the reviewer has got. A review that runs past
  ten minutes starts once more with a six-minute limit and keeps what it wrote, and reviewing again in the same chat
  shows the reviewer its earlier findings and your outcomes.

### Fixes

- Renaming a model takes about a second instead of half a minute; a parameter that formulas or scenarios still use is
  not deleted, and adding one with a formula is all or nothing.
- The run bar warns when the prompt cache stops working and says when it works again. An answer that ended in an error
  keeps the reason after a reload, and canvas actions work from any page.
- A tool call a provider cut off no longer ends the run, long reasoning no longer ends in an empty reply, and rounds
  that only call tools hit the prompt cache again on models with explicit caching.
- The run bar stays in view after the window was covered, scrolling up during a run lets go of the transcript, and a
  run names its chat without waiting for the chat panel.
- Answers show no raw citation marks, and a mistyped dataset code points to the dataset it was meant to be.
- The dataset search finds a dataset named in the plural for a query in the singular, and the assistant tries other
  names before it takes a proxy or calls a dataset missing.
- As the chat model, GPT-6 Luna runs at High effort or above; at lower levels it left out whole parts of a model.
- Electron and several dependencies are updated, with minor security fixes.

**Installing.** The Windows installer is signed by *Open Source Developer Jonas Harth*. While the certificate is
new, Windows SmartScreen may still warn: check that *More info* names this publisher, compare the installer with
`SHA256SUMS` below, then choose *Run anyway*. On Linux the AppImage needs FUSE 2 (`sudo apt install libfuse2t64` on
Ubuntu 24.04); the deb and the rpm need nothing extra. PrismLCA 0.9.3 and later find this release under *Check for
updates*.

Changes since v0.9.11: https://github.com/prismlca/prismlca/compare/v0.9.11...v0.9.12

## 0.9.11 — 2026-11-08

### New

- **Google and Anthropic as AI providers.** Settings → AI → Provider has two more cards: Google, for Gemini models
  with a key from Google AI Studio, and Anthropic, for Claude models with a key from platform.claude.com. Web search
  works in the chat and in the research tools, and costs appear under *Usage & costs* in a tab per provider,
  estimated from the provider's list prices. Voice input is offered with Google, not with Anthropic.
- **Runs wait out a busy provider.** When the AI provider is overloaded, rate-limits a request or cannot be reached,
  the chat keeps trying instead of failing after a few seconds: up to two minutes for a busy provider, up to
  15 minutes without a connection. The run bar says why it waits and counts down to the next attempt; *Stop* ends
  the wait.
- **Task plan per model.** Settings → AI → Models has a switch *Task plan beside the chat* under *Reasoning effort*.
  It turns the assistant's checklist on for a model that works without it by default, or off for any other, and is
  kept per model. Plan and review now scale with the task: a quick figure needs neither.

### Fixes

- On a short screen the inspector panel scrolls instead of its fields running over *Tags* and the audit log.
- Deleting a workspace after calculating in it works on Windows again.
- Quitting asks the calculation engine to finish in order, and the engine also ends when PrismLCA is gone.
- A provider's safety-filter stop ends the round with its reason, and a reply counts as finished only when the
  provider finished it.

**Installing.** The Windows installer is signed by *Open Source Developer Jonas Harth*. While the certificate is
new, Windows SmartScreen may still warn: check that *More info* names this publisher, compare the installer with
`SHA256SUMS` below, then choose *Run anyway*. On Linux the AppImage needs FUSE 2 (`sudo apt install libfuse2t64` on
Ubuntu 24.04); the deb and the rpm need nothing extra. PrismLCA 0.9.3 and later find this release under *Check for
updates*.

Changes since v0.9.10: https://github.com/prismlca/prismlca/compare/v0.9.10...v0.9.11

## 0.9.10 — 2026-11-06

### New

- **ecoinvent 3.13.** PrismLCA imports ecoinvent 3.13 into a new workspace, from the extracted release and its LCIA
  workbook as before. The import wizard shows the release it read from the files, asks for the version only where
  they name none, and refuses a workbook from another release. The new *IPCC 2021 (GHG Protocol mandatory)* total is
  recommended beside the IPCC 2021 total.
- **Closer regional matches in search.** For a target outside Europe, a continent's dataset (North America, Latin
  America, Asia, Africa, Oceania) now ranks before the global ones, and a province or state falls back to its
  country first. European regions that leave out a country, such as "RER w/o RU", stand in for Europe unless they
  leave out the target itself.
- **Side by side with Brightway.** PrismLCA keeps its workspaces in its own data folder and no longer opens a
  Brightway directory set in `BRIGHTWAY2_DIR`, so an existing Brightway or Activity Browser installation stays
  untouched. Workspaces an earlier version kept there are copied into PrismLCA's folder on the first start; the
  originals are not changed. A large workspace can take a while, and the splash screen shows the progress.

### Fixes

- Adding ecoinvent to a workspace that began with BAFU writes its impact methods again; before, no method was
  written and the workspace kept a pending step.
- Quitting PrismLCA ends its calculation engine for good, so the next start no longer finds the data folder locked.
  Opening PrismLCA while it is still quitting starts it afresh.
- Undo and redo of a bundle import keep the chats, reports, logs and canvas the model gathered since.
- Deleting or renaming a model no longer changes the tags of another model whose name begins with the same name and
  a slash.
- A double slash in report text prints as written instead of hiding the rest of the line.
- Some minor security fixes and hardening.

**Installing.** The Windows installer is signed by *Open Source Developer Jonas Harth*. While the certificate is
new, Windows SmartScreen may still warn: check that *More info* names this publisher, compare the installer with
`SHA256SUMS` below, then choose *Run anyway*. On Linux the AppImage needs FUSE 2 (`sudo apt install libfuse2t64` on
Ubuntu 24.04); the deb and the rpm need nothing extra. PrismLCA 0.9.3 and later find this release under *Check for
updates*.

Changes since v0.9.9: https://github.com/prismlca/prismlca/compare/v0.9.9...v0.9.10

## 0.9.9 — 2026-11-03

### New

- **A signed Windows installer.** The installer, the uninstaller, PrismLCA itself and its calculation engine carry a
  timestamped code signature of *Open Source Developer Jonas Harth*, issued by Certum. Windows names this publisher
  instead of an unknown one, and an installation of 0.9.9 or later takes an update only when it carries this
  signature.

**Installing.** While the certificate is new, Windows SmartScreen may still warn: check that *More info* names the
publisher above, compare the installer with `SHA256SUMS` below, then choose *Run anyway*. On Linux the AppImage
needs FUSE 2 (`sudo apt install libfuse2t64` on Ubuntu 24.04); the deb and the rpm need nothing extra. PrismLCA
0.9.3 and later find this release under *Check for updates*.

Changes since v0.9.8: https://github.com/prismlca/prismlca/compare/v0.9.8...v0.9.9

## 0.9.8 — 2026-11-02

### New

- **Sensitivity analysis.** Results has a third tab: a tornado ranks the model's parameters by how far a step of
  ±10 % (or your own range) moves the result, and a curve follows one parameter across a range for the baseline and
  its scenarios. Every step stays within the parameter's allowed values. The first two tabs are now called
  *Results* and *Decomposition tree*.
- **Parameter tornado in reports.** Short and full reports can print a parameter tornado under the sensitivity check
  in *Interpretation checks*, and the AI writer can quote its numbers. Sensitivity runs take seconds and no longer
  hold up other calculations.
- **Allowed values for new parameters.** When the assistant creates a parameter, it gives it the rule its meaning
  fixes — a share between 0 and 1, a distance or mass above 0, a switch of 0 or 1. The rules of existing parameters
  stay yours; the health check asks about unitless values between 0 and 1 that still have no rule.
- **An rpm package for Fedora.** Besides the AppImage and the .deb, every release now has an .rpm: install it with
  `sudo dnf install` and PrismLCA appears in the application menu.

### Fixes

- Undo after deleting or localizing a process, or after removing a supplier, puts it back where it stood, in its
  colour and its group — it used to reappear elsewhere, without its colour.
- With several boxes selected, the right-click menu's *Localize*, *Expand upstream*, *Collapse upstream*, *Remove
  from canvas* and *Delete* act on all of them. Deleting several processes that others still use now asks about
  each one in turn, naming who uses it, instead of keeping them with a note.
- The contribution tree in *Decomposition tree* draws thicker connectors.

**Installing.** Windows will warn about the installer because PrismLCA is not code-signed yet: compare it with
`SHA256SUMS` below, then choose *More info → Run anyway*. On Linux the AppImage needs FUSE 2
(`sudo apt install libfuse2t64` on Ubuntu 24.04); the deb and the rpm need nothing extra. PrismLCA 0.9.3 and later
find this release under *Check for updates*.

Changes since v0.9.6: https://github.com/prismlca/prismlca/compare/v0.9.6...v0.9.8

## 0.9.6 — 2026-11-01

### New

- **Cheaper report writing and chats.** A report chapter now reuses the provider's prompt cache through every step,
  from its lookups to the corrections and the answers to the second reader; with Claude models the newest part of
  each exchange is cached too. On OpenRouter, a chat or a chapter stays with one provider while it runs, so its
  cache is found again. For that, its requests carry a random routing key that lives only in memory and says
  nothing about you or your computer — see the privacy notice of 1 November.
- **The assistant can localize datasets.** The assistant and external agents can make a background or library
  dataset an editable process of your model, like *Localize (edit)* on the canvas — on request with its direct
  suppliers, which are copied and connected too. Results stay the same until a copy is changed, and one Undo
  takes it all back.

### Fixes

- The splash screen shows the full version.

**Installing.** Windows will warn about the installer because PrismLCA is not code-signed yet: compare it with
`SHA256SUMS` below, then choose *More info → Run anyway*. On Linux the AppImage needs FUSE 2
(`sudo apt install libfuse2t64` on Ubuntu 24.04); the deb needs nothing extra. PrismLCA 0.9.3 and later find
this release under *Check for updates*.

Changes since v0.9.5: https://github.com/prismlca/prismlca/compare/v0.9.5...v0.9.6

## 0.9.5 — 2026-10-31

This release is mostly about the AI report writer: fewer chapters end up unfinished, fewer correct sentences
are flagged, and numbers written into the text stay tied to the model.

### New

- **Typed numbers no longer cost a chapter.** A figure the writer types out that is exactly a result or a share
  is now tied to that value, so it changes with the model. A figure that is only close is answered with the
  value it most likely means. A chapter left with nothing but typed numbers is saved anyway: open it to
  replace each number with the value it matches, or keep it with a reason. The report can be approved once
  every number is decided, and a kept number is raised again after the results change.
- **The significance threshold** has a placeholder of its own, so sentences about it follow the report setting.
- **Fuller reports from the start.** A new full report covers at least five core EF 3.1 indicators, compares the
  baseline with every scenario when none is ticked on the Results page, and draws the heatmap and the radar.
- **Fewer lost revisions.** When the writer answers the second reader and one sentence then fails a check, only
  that sentence is repaired; the rest of the answer is kept.
- **Fewer false alarms.** The second reader now sees every finding of a literature search, not just the first.
- **Research is reused.** The literature search of a chapter that could not be saved is used again on the next
  attempt instead of being paid for twice.
- **Plain reasons.** A chapter that could not be finished says why in plain words; the check's own text is under
  *Details*.

### Fixes

- Results page: scenarios ticked right after they were created stay ticked, and the baseline no longer switches
  itself back on.
- The life-cycle phase breakdown is named in the report language.
- A parameter's formula can be dropped when its value is set, one at a time or in a batch.
- Update page: a failed download says what went wrong and offers the release page; the Download button comes
  before the release notes.
- Electron 44.10.1, the newest patch of its line.

**Installing.** Windows will warn about the installer because PrismLCA is not code-signed yet: compare it with
`SHA256SUMS` below, then choose *More info → Run anyway*. On Linux the AppImage needs FUSE 2
(`sudo apt install libfuse2t64` on Ubuntu 24.04); the deb needs nothing extra. PrismLCA 0.9.3 finds this release
under *Check for updates*.

Changes since v0.9.3: https://github.com/prismlca/prismlca/compare/v0.9.3...v0.9.5

## 0.9.3 — 2026-10-30

First public beta.

PrismLCA is desktop software for life cycle assessment on Brightway 2.5, with an AI assistant and an MCP
server built in. This release runs on Windows 10 and 11 (64-bit) and on Linux (AppImage, deb).

**Getting started.** After installing, import a background database: BAFU:2026 is free (download it from
[openLCA Nexus](https://nexus.openlca.org/database/BAFU) with a free account), ecoinvent you bring yourself as
the ecoSpold2 files of your licence. The handbook at [prismlca.com](https://www.prismlca.com) walks through the first model.

**Windows will warn about the installer.** PrismLCA is not code-signed yet; signed releases will follow.
Compare the installer with `SHA256SUMS` below (`Get-FileHash` in PowerShell), then choose
*More info → Run anyway*.

**Linux.** The AppImage needs FUSE 2, which Ubuntu 22.04 and later do not install by default
(`sudo apt install libfuse2t64` on 24.04, `libfuse2` on 22.04); the deb needs nothing extra.

**Privacy.** No telemetry, no crash reports, no account. Nothing leaves your computer until you switch a
feature on or click a button that says it will contact a server — updates included: PrismLCA checks only
when you click *Check for updates*. Details in [PRIVACY.md](https://github.com/prismlca/prismlca/blob/main/PRIVACY.md).

**Security.** Electron 44.10.0 (Chromium 152, Node 24) and Python 3.12.16. The shipped dependencies are
checked against known advisories in the release pipeline. Chromium's automatic proxy discovery (WPAD) is off;
only the update check uses your system's proxy settings, and only while it runs. Report security problems
privately, as described in [SECURITY.md](https://github.com/prismlca/prismlca/blob/main/SECURITY.md).

**Beta.** Expect rough edges, and please report them in the issues. Each release comes with `SHA256SUMS`,
`build-info.txt`, a CycloneDX SBOM and build provenance attestations.

**Fixed since 0.9.2.** On Windows the update check now finds the installer: 0.9.2's update feed named the
installer differently from the file on GitHub, so an update *to* 0.9.2 failed. Updating *from* 0.9.2 to 0.9.3
works. Changes: https://github.com/prismlca/prismlca/compare/v0.9.2...v0.9.3

## 0.9.2 — 2026-10-30

First public beta.

PrismLCA is desktop software for life cycle assessment on Brightway 2.5, with an AI assistant and an MCP
server built in. This release runs on Windows 10 and 11 (64-bit) and on Linux (AppImage, deb).

**Getting started.** After installing, import a background database: BAFU:2026 is free (download it from
[openLCA Nexus](https://nexus.openlca.org/database/BAFU) with a free account), ecoinvent you bring yourself as
the ecoSpold2 files of your licence. The handbook at [prismlca.com](https://www.prismlca.com) walks through the first model.

**Windows will warn about the installer.** PrismLCA is not code-signed yet; signed releases will follow.
Compare the installer with `SHA256SUMS` below (`Get-FileHash` in PowerShell), then choose
*More info → Run anyway*.

**Linux.** The AppImage needs FUSE 2, which Ubuntu 22.04 and later do not install by default
(`sudo apt install libfuse2t64` on 24.04, `libfuse2` on 22.04); the deb needs nothing extra.

**Privacy.** No telemetry, no crash reports, no account. Nothing leaves your computer until you switch a
feature on or click a button that says it will contact a server — updates included: PrismLCA checks only
when you click *Check for updates*. Details in [PRIVACY.md](https://github.com/prismlca/prismlca/blob/main/PRIVACY.md).

**Security.** Electron 44.10.0 (Chromium 152, Node 24) and Python 3.12.16. The shipped dependencies are
checked against known advisories in the release pipeline. Chromium's automatic proxy discovery (WPAD) is off;
only the update check uses your system's proxy settings, and only while it runs. Report security problems
privately, as described in [SECURITY.md](https://github.com/prismlca/prismlca/blob/main/SECURITY.md).

**Beta.** Expect rough edges, and please report them in the issues. Each release comes with `SHA256SUMS`,
`build-info.txt`, a CycloneDX SBOM and build provenance attestations.

## 0.9.1 — 2026-10-30

Published by mistake without its files and withdrawn; the tag cannot be used again. 0.9.2 is the first public
release.

## 0.9.0 — 2026-10-30

Built and tagged, never published.
