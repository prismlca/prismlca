# Changelog

Every PrismLCA release, newest first. Sections are drafted by `npm run release` (in `frontend/`) from the
What's-new entries since the previous release and finished by hand before the release is tagged.

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
