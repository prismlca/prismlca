# Changelog

Every PrismLCA release, newest first. Sections are drafted by `npm run release` (in `frontend/`) from the
What's-new entries since the previous release and finished by hand before the release is tagged.

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
