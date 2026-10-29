"""Generate THIRD-PARTY-NOTICES.md — the licence notices that ship with PrismLCA.

Run from ``backend/``::

    uv run python scripts/third_party_notices.py          # write both copies
    uv run python scripts/third_party_notices.py --check  # exit 1 if stale or a licence fails

The file is written to the repository root and, identically, to
``frontend/resources/THIRD-PARTY-NOTICES.md`` (opened from inside the app, so it must be
self-contained and readable offline in a plain text viewer).

Sources:

* Python: the runtime closure from ``uv export --no-dev``; version, licence and every licence /
  notice file are read from the installed dist-info via ``importlib.metadata``.
* npm: ``npm ls --omit=dev --all --long --json``; licence from each ``package.json`` and the
  licence files from the package directory. We read ``node_modules`` and not the build output
  because Vite merges the renderer into one bundle, so per-package texts do not survive the build.
* Hand-maintained texts (icons, fonts, models, data): ``scripts/third_party_texts/`` (see its
  README for sources and fetch dates), plus notice files that live next to the bundled assets.

The output is deterministic: sorted, no timestamps. The only line that changes with every commit
is the one starting with ``HEADER_PREFIX``; ``--check`` ignores it.
"""

from __future__ import annotations

import argparse
import difflib
import importlib.metadata as metadata
import json
import re
import shutil
import subprocess
import sys
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
BACKEND = SCRIPTS.parent
REPO = BACKEND.parent
FRONTEND = REPO / "frontend"
TEXTS = SCRIPTS / "third_party_texts"
FONTS_DIR = BACKEND / "src" / "prism_lca" / "assets" / "fonts"
TRANSPORT_NOTICE = BACKEND / "src" / "prism_lca" / "assets" / "transport" / "NOTICE.md"
DICTIONARIES_NOTICE = FRONTEND / "resources" / "dictionaries" / "LICENSES.md"
OUTPUTS = (REPO / "THIRD-PARTY-NOTICES.md", FRONTEND / "resources" / "THIRD-PARTY-NOTICES.md")

HEADER_PREFIX = "Generated from git commit "

# ---------------------------------------------------------------------------------------------
# Policy
# ---------------------------------------------------------------------------------------------

# Permissive licences (SPDX ids). CNRI-Python is the CNRI part of the Python licence stack
# (regex declares "Apache-2.0 AND CNRI-Python"); it is as permissive as PSF-2.0 / Python-2.0.
# BSL-1.0 is the Boost licence, which torch lists among its bundled components.
ALLOWED = frozenset(
    {
        "MIT", "MIT-0", "MIT-CMU", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Apache-2.0",
        "PSF-2.0", "Python-2.0", "CNRI-Python", "MPL-2.0", "Unlicense", "CC0-1.0",
        "BlueOak-1.0.0", "Zlib", "HPND", "W3C", "BSL-1.0",
    }
)
# Tokens after WITH in an SPDX expression that do not restrict anything.
ALLOWED_EXCEPTIONS = frozenset({"LLVM-exception"})

_INTEL_SIMPLIFIED = (
    "Intel oneAPI runtime (MKL stack, needed by pypardiso). Intel Simplified Software License: "
    "redistribution in binary form, unmodified, is permitted. PrismLCA's LICENSE carries an "
    "AGPL-3.0 section 7 additional permission for combining PrismLCA with these libraries."
)
_INTEL_EULA = (
    "Intel oneAPI runtime (MKL stack, needed by pypardiso). Intel End User License Agreement for "
    "Developer Tools, which permits redistribution of these runtime components as part of a product, "
    "subject to a licence that prohibits reverse engineering, decompiling or disassembly of them (see "
    "the note at the top). Not in the installer: the bundle threads MKL through oneTBB "
    "(MKL_THREADING_LAYER=TBB, prism_backend.spec and __main__.py), so it is listed because it sits in "
    "the dependency closure. PrismLCA's LICENSE carries an AGPL-3.0 section 7 additional permission "
    "for combining PrismLCA with these libraries."
)
_INTEL_OPENMP = _INTEL_EULA.replace(
    "Not in the installer: the bundle threads MKL through oneTBB (MKL_THREADING_LAYER=TBB, "
    "prism_backend.spec and __main__.py), so it is listed because it sits in the dependency closure.",
    "PrismLCA threads MKL through oneTBB (MKL_THREADING_LAYER=TBB), but the Windows package contains "
    "the Intel OpenMP runtime all the same — torch/lib/libiomp5md.dll and libiompstubs5md.dll, shipped "
    "by PyTorch's Windows build, which needs them; the Linux packages contain none.",
)
# Packages outside the permissive list that ship anyway, with the reason.
EXCEPTIONS: dict[str, str] = {
    "mkl": _INTEL_SIMPLIFIED,
    "tbb": _INTEL_SIMPLIFIED,
    "tcmlib": _INTEL_SIMPLIFIED,
    "onemkl-license": _INTEL_SIMPLIFIED + " This package carries the licence text for the stack.",
    "intel-openmp": _INTEL_OPENMP,
    "intel-cmplr-lib-ur": _INTEL_EULA,
    "umf": (
        "Intel oneAPI runtime (MKL stack, needed by pypardiso). Apache-2.0 WITH LLVM-exception; "
        "the classifier says Other/Proprietary, the licence files say Apache."
    ),
}

# Build tools: never part of the runtime closure. If uv export lists them, --check fails.
BUILD_ONLY = ("pyinstaller", "pyinstaller-hooks-contrib")

# In the resolved closure, but kept out of the PyInstaller build (`excludes=` in
# backend/prism_backend.spec; policy_failures() checks that the spec still excludes them).
_EXIOBASE_PATH = (
    "Imported only by the EXIOBASE conversion modules of mrio-common-metadata, which PrismLCA never "
    "loads (it has no EXIOBASE import). Excluded from the PyInstaller build; it does not ship with "
    "PrismLCA. The licence text is reproduced here for completeness."
)
EXCLUDED_FROM_BUILD: dict[str, str] = {
    "pyxlsb": _EXIOBASE_PATH,
}
PYINSTALLER_SPEC = BACKEND / "prism_backend.spec"

# Where metadata is wrong or ambiguous, with the evidence.
LICENSE_OVERRIDES: dict[str, tuple[str, str]] = {
    # fastembed's classifier says "Other/Proprietary License", but its License field says
    # "Apache License" and the shipped LICENSE file is the Apache 2.0 text: trust the file.
    "fastembed": (
        "Apache-2.0",
        "The package classifier says Other/Proprietary; its License field and LICENSE file say "
        "Apache 2.0.",
    ),
    # cobble ships no licence file and only the generic "BSD License" classifier; the upstream
    # README (github.com/mwilliamson/python-cobble) states 2-Clause BSD.
    "cobble": ("BSD-2-Clause", "Upstream README states the 2-Clause BSD licence."),
    # pypdfium2 declares "BSD-3-Clause, Apache-2.0, dependency licenses"; it is dual-licensed and
    # bundles a PDFium build whose component licences it ships (all reproduced below).
    "pypdfium2": (
        "Apache-2.0 OR BSD-3-Clause",
        "Metadata says \"BSD-3-Clause, Apache-2.0, dependency licenses\"; the licences of the "
        "bundled PDFium build and its components are reproduced below.",
    ),
}

# Windows-only packages of the closure. They are not installed on the Linux machine that
# generates this file, so their metadata cannot be read; licence and holder are taken from the
# packages' PyPI metadata (checked 2026-09-30).
PLATFORM_ONLY: dict[str, tuple[str, str]] = {
    "colorama": ("BSD-3-Clause", "Jonathan Hartley"),
    "tzdata": ("Apache-2.0", "Python Software Foundation"),
    "win32-setctime": ("MIT", "Delgan"),
}

CLASSIFIER_MAP = {
    "MIT License": "MIT",
    "BSD License": "BSD",  # refined to 2- or 3-Clause from the licence text
    "Apache Software License": "Apache-2.0",
    "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
    "Python Software Foundation License": "PSF-2.0",
    "ISC License (ISCL)": "ISC",
    "W3C License": "W3C",
    "The Unlicense (Unlicense)": "Unlicense",
    "GNU Lesser General Public License v3 or later (LGPLv3+)": "LGPL-3.0-or-later",
}
FIELD_MAP = {
    "Apache License": "Apache-2.0",
    "Apache 2.0": "Apache-2.0",
    "Apache 2.0 License": "Apache-2.0",
    "Apache License 2.0": "Apache-2.0",
    "MIT License": "MIT",
    "3-Clause BSD License": "BSD-3-Clause",
    "LGPLv3+": "LGPL-3.0-or-later",
    "Apache-2.0 with LLVM exceptions": "Apache-2.0 WITH LLVM-exception",
}

SPDX_FALLBACK = {
    "MIT": "spdx-MIT.txt",
    "BSD-2-Clause": "spdx-BSD-2-Clause.txt",
    "BSD-3-Clause": "spdx-BSD-3-Clause.txt",
    "Apache-2.0": "spdx-Apache-2.0.txt",
}

_PY_LICENSE_FILE = re.compile(r"^(LICEN[CS]E|COPYING|NOTICE|AUTHORS)", re.IGNORECASE)
_NPM_LICENSE_FILE = re.compile(r"^(LICEN[CS]E|COPYING|NOTICE)", re.IGNORECASE)
_EXPR_SPLIT = re.compile(r"\s+(?:AND|OR)\s+|\s*,\s*|[()]")


# ---------------------------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------------------------


@dataclass
class Package:
    name: str
    version: str
    license: str
    texts: list[tuple[str, str]] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    marker: str = ""  # short note for the summary table

    @property
    def exception(self) -> str | None:
        return EXCEPTIONS.get(self.name)


# ---------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------


def normalize_text(raw: bytes | str) -> str:
    """Decode, unify line endings, strip trailing whitespace; content otherwise verbatim."""
    if isinstance(raw, bytes):
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("cp1252", errors="replace")
    else:
        text = raw
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.rstrip() for line in text.split("\n")).strip("\n")


def read_text(path: Path) -> str:
    return normalize_text(path.read_bytes())


def fenced(text: str) -> str:
    runs = [len(m) for m in re.findall(r"`+", text)]
    fence = "`" * max(3, max(runs, default=0) + 1)
    return f"{fence}text\n{text}\n{fence}"


def run(cmd: list[str], cwd: Path) -> str:
    return subprocess.run(
        cmd, cwd=cwd, check=True, capture_output=True, text=True, encoding="utf-8"
    ).stdout


def canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def license_tokens(expression: str) -> list[str]:
    tokens: list[str] = []
    for part in _EXPR_SPLIT.split(expression):
        part = part.strip()
        if not part:
            continue
        base, _, exception = part.partition(" WITH ")
        tokens.append(base.strip())
        if exception:
            tokens.append(exception.strip())
    return tokens


def detect_bsd(text: str) -> str | None:
    """2- or 3-Clause BSD, judged on the first BSD text in the file (files often bundle more)."""
    start = text.find("Redistribution and use in source and binary forms")
    if start < 0:
        return None
    clauses = text[start : start + 1500]
    three = re.search(r"Neither the name|endorse or promote", clauses, re.IGNORECASE)
    return "BSD-3-Clause" if three else "BSD-2-Clause"


def detect_license(text: str) -> str | None:
    """Recognise the common permissive licences from their wording."""
    if "Permission is hereby granted, free of charge" in text:
        return "MIT"
    bsd = detect_bsd(text)
    if bsd:
        return bsd
    if re.search(r"Apache License", text) and "Version 2.0" in text:
        return "Apache-2.0"
    if "Permission to use, copy, modify, and/or distribute" in text:
        return "ISC"
    return None


def spdx_fallback(license_id: str, holder: str) -> str:
    """Standard SPDX text with its placeholder copyright line replaced by the real holder."""
    body = read_text(TEXTS / SPDX_FALLBACK[license_id])
    lines = [ln for ln in body.split("\n") if not re.match(r"^Copyright \(c\) <", ln)]
    body = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip("\n")
    return f"Copyright: {holder}\n\n{body}"


def no_file_note(license_id: str) -> str:
    return (
        "This package ships no licence file. The standard SPDX text of its declared licence "
        f"({license_id}) is reproduced below, with the author from the package metadata."
    )


# ---------------------------------------------------------------------------------------------
# Python inventory
# ---------------------------------------------------------------------------------------------


def uv_closure() -> dict[str, str]:
    """Canonical name → version, from the locked runtime export (all platforms)."""
    out = run(
        ["uv", "export", "--no-dev", "--no-hashes", "--frozen", "--no-emit-project"], BACKEND
    )
    closure: dict[str, str] = {}
    for line in out.splitlines():
        match = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;]+)", line)
        if match:
            closure.setdefault(canonical(match.group(1)), match.group(2))
    return closure


def _python_license_files(dist: metadata.Distribution) -> list[tuple[str, str]]:
    found = []
    for item in dist.files or []:
        parts = item.parts
        in_licenses_dir = (
            len(parts) >= 3 and parts[0].endswith(".dist-info") and parts[1] == "licenses"
        )
        if not (in_licenses_dir or _PY_LICENSE_FILE.match(item.name)):
            continue
        if item.suffix in (".py", ".pyc", ".pyi"):
            continue
        path = Path(str(dist.locate_file(item)))
        if path.is_file():
            found.append((str(item), read_text(path)))
    return sorted(found)


def _python_license(dist: metadata.Distribution, texts: list[tuple[str, str]]) -> tuple[str, str]:
    """(licence, how it was determined): License-Expression → classifiers → License field."""
    meta = dist.metadata
    expression = (meta.get("License-Expression") or "").strip()
    if expression:
        return expression, ""
    detected = next((d for _, t in texts if (d := detect_license(t))), None)
    detected_bsd = next((d for _, t in texts if (d := detect_bsd(t))), None)
    classifiers = [
        c.split(" :: ")[-1] for c in meta.get_all("Classifier") or [] if c.startswith("License ::")
    ]
    mapped: list[str] = []
    for classifier in classifiers:
        if classifier == "Other/Proprietary License":
            continue  # fall through to the License field (Intel, fastembed)
        spdx = CLASSIFIER_MAP.get(classifier, classifier)
        if spdx == "BSD":
            spdx = detected_bsd or "BSD"
        if spdx not in mapped:
            mapped.append(spdx)
    if mapped:
        return ", ".join(mapped), ""
    license_field = (meta.get("License") or "").strip()
    if license_field and "\n" not in license_field and len(license_field) < 100:
        return FIELD_MAP.get(license_field, license_field), ""
    if detected:
        return detected, "licence detected from the licence text; the metadata declares none"
    return "UNKNOWN", ""


def _author(meta) -> str:
    parts: list[str] = []
    for key in ("Author", "Author-email"):
        value = (meta.get(key) or "").strip()
        if value and all(value not in p for p in parts):
            parts.append(value)
    if len(parts) == 2 and "<" not in parts[1] and "@" in parts[1]:
        return f"{parts[0]} <{parts[1]}>"
    return "; ".join(parts) or "the package authors"


def python_packages(closure: dict[str, str]) -> list[Package]:
    packages = []
    for name in sorted(closure):
        try:
            dist = metadata.distribution(name)
        except metadata.PackageNotFoundError:
            if name not in PLATFORM_ONLY:
                packages.append(Package(name, closure[name], "UNKNOWN", marker="not installed"))
                continue
            license_id, holder = PLATFORM_ONLY[name]
            packages.append(
                Package(
                    name,
                    closure[name],
                    license_id,
                    texts=[(f"SPDX {license_id}", spdx_fallback(license_id, holder))],
                    notes=[
                        "Windows-only dependency; it is not installed where this file was "
                        "generated, so the standard SPDX text of its licence is reproduced, "
                        "with the author from its PyPI metadata."
                    ],
                    marker="Windows only, SPDX text",
                )
            )
            continue
        texts = _python_license_files(dist)
        license_expr, how = _python_license(dist, texts)
        pkg = Package(name, dist.version, license_expr, texts=texts)
        if name in LICENSE_OVERRIDES:
            pkg.license, reason = LICENSE_OVERRIDES[name]
            pkg.notes.append(reason)
        if how:
            pkg.notes.append(how[0].upper() + how[1:] + ".")
            pkg.marker = "licence from text"
        if not texts:
            if pkg.license not in SPDX_FALLBACK:
                pkg.marker = "no licence file"
            else:
                pkg.texts = [
                    (f"SPDX {pkg.license}", spdx_fallback(pkg.license, _author(dist.metadata)))
                ]
                pkg.notes.append(no_file_note(pkg.license))
                pkg.marker = "no licence file, SPDX text"
        if pkg.exception:
            pkg.marker = "exception"
        if name in EXCLUDED_FROM_BUILD:
            pkg.marker = "excluded from build"
        packages.append(pkg)
    return packages


# ---------------------------------------------------------------------------------------------
# npm inventory
# ---------------------------------------------------------------------------------------------


def _npm_license(manifest: dict) -> str:
    value = manifest.get("license")
    if isinstance(value, dict):
        value = value.get("type")
    if not value and isinstance(manifest.get("licenses"), list):
        value = " OR ".join(str(x.get("type", x)) for x in manifest["licenses"])
    return str(value).strip() if value else "UNKNOWN"


def _npm_author(manifest: dict) -> str:
    author = manifest.get("author")
    if isinstance(author, dict):
        name, email = author.get("name", ""), author.get("email", "")
        author = f"{name} <{email}>" if email else name
    return str(author).strip() if author else "the package authors"


def _npm_license_files(pkg_dir: Path) -> list[tuple[str, str]]:
    found = []
    for entry in sorted(pkg_dir.iterdir(), key=lambda p: p.name):
        if not _NPM_LICENSE_FILE.match(entry.name):
            continue
        if entry.is_file():
            found.append((entry.name, read_text(entry)))
        elif entry.is_dir():  # e.g. echarts/licenses/ with the texts of code it includes
            for sub in sorted(p for p in entry.rglob("*") if p.is_file()):
                found.append((sub.relative_to(pkg_dir).as_posix(), read_text(sub)))
    return found


def npm_packages() -> list[Package]:
    npm = shutil.which("npm")
    if npm is None:
        raise SystemExit("npm not found on PATH; it is needed for the frontend inventory")
    proc = subprocess.run(
        [npm, "ls", "--omit=dev", "--all", "--long", "--json"],
        cwd=FRONTEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    tree = json.loads(proc.stdout)
    seen: dict[tuple[str, str], Path] = {}

    def walk(node: dict) -> None:
        for key, child in sorted((node.get("dependencies") or {}).items()):
            name, version, path = child.get("name", key), child.get("version"), child.get("path")
            if not version or not path:
                continue  # unresolved optional peer (e.g. immer)
            seen.setdefault((name, version), Path(path))
            # Descend into EVERY occurrence, not only the first. `npm ls` lists a package's children
            # once, at its canonical place in the tree, and shows it as a bare reference everywhere
            # else — so stopping at the first reference dropped the children of any package that is
            # also somebody's dependency: ajv is met under @modelcontextprotocol/sdk first, and its
            # four dependencies (fast-uri, fast-deep-equal, …) vanished from the notices (05.10.2026).
            walk(child)

    walk(tree)
    packages = []
    for (name, version), pkg_dir in sorted(seen.items()):
        manifest = json.loads((pkg_dir / "package.json").read_text(encoding="utf-8"))
        pkg = Package(name, version, _npm_license(manifest), texts=_npm_license_files(pkg_dir))
        if not pkg.texts and pkg.license in SPDX_FALLBACK:
            pkg.texts = [(f"SPDX {pkg.license}", spdx_fallback(pkg.license, _npm_author(manifest)))]
            pkg.notes.append(no_file_note(pkg.license))
            pkg.marker = "no licence file, SPDX text"
        elif not pkg.texts:
            pkg.marker = "no licence file"
        packages.append(pkg)
    return packages


# ---------------------------------------------------------------------------------------------
# Policy check
# ---------------------------------------------------------------------------------------------


def _spec_excludes() -> set[str]:
    """Package names in the PyInstaller spec's `excludes=[...]`, canonicalised."""
    try:
        spec = PYINSTALLER_SPEC.read_text(encoding="utf-8")
    except OSError:
        return set()
    names: set[str] = set()
    for block in re.findall(r"excludes\s*=\s*\[([^\]]*)\]", spec):
        names.update(canonical(n) for n in re.findall(r"[\"']([^\"']+)[\"']", block))
    return names


def policy_failures(python: list[Package], npm: list[Package]) -> list[str]:
    failures = []
    names = {p.name for p in python}
    for tool in BUILD_ONLY:
        if tool in names:
            failures.append(f"python {tool}: build-only tool is in the runtime closure")
    spec_excludes = _spec_excludes()
    for name in sorted(EXCLUDED_FROM_BUILD):
        if name in names and name not in spec_excludes:
            failures.append(
                f"python {name}: listed as excluded from the build, but "
                f"{PYINSTALLER_SPEC.name} does not exclude it"
            )
    for stack, packages in (("python", python), ("npm", npm)):
        for pkg in packages:
            if stack == "python" and (pkg.name in BUILD_ONLY or pkg.name in EXCLUDED_FROM_BUILD):
                continue
            if stack == "python" and pkg.exception:
                continue
            bad = [
                t for t in license_tokens(pkg.license) if t not in ALLOWED | ALLOWED_EXCEPTIONS
            ]
            if bad or not license_tokens(pkg.license):
                failures.append(
                    f"{stack} {pkg.name} {pkg.version}: licence {pkg.license!r} is not allowed"
                )
            if not pkg.texts:
                failures.append(f"{stack} {pkg.name} {pkg.version}: no licence text found")
    return failures


# ---------------------------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------------------------


def _git(*args: str) -> str:
    try:
        return run(["git", *args], REPO).strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def _summary_table(packages: list[Package]) -> list[str]:
    rows = ["| Package | Version | Licence | Note |", "|---|---|---|---|"]
    for p in packages:
        rows.append(f"| {p.name} | {p.version} | {p.license} | {p.marker} |")
    return rows


def _package_block(pkg: Package) -> list[str]:
    out = [f"### {pkg.name} {pkg.version} — {pkg.license}", ""]
    if pkg.exception:
        out += [f"Licence exception: {pkg.exception}", ""]
    for note in pkg.notes:
        out += [note, ""]
    for label, text in pkg.texts:
        out += [f"File: `{label}`", "", fenced(text), ""]
    return out


def _text_block(heading: str, intro: list[str], files: list[tuple[str, str]]) -> list[str]:
    out = [f"### {heading}", ""]
    for paragraph in intro:
        out += [paragraph, ""]
    for label, text in files:
        out += [f"File: `{label}`", "", fenced(text), ""]
    return out


def _hand_text(name: str) -> tuple[str, str]:
    return (f"backend/scripts/third_party_texts/{name}", read_text(TEXTS / name))


def _repo_text(path: Path) -> tuple[str, str]:
    return (path.relative_to(REPO).as_posix(), read_text(path))


def _mit_for(holder: str) -> str:
    return spdx_fallback("MIT", holder).replace("Copyright: ", "Copyright (c) ", 1)


def _fonts_section() -> list[str]:
    out = ["## Fonts", ""]
    out += [
        "The Typst compiler (`typst` Python wheel) embeds these fonts and makes them available to "
        "reports: Libertinus Serif (SIL Open Font License 1.1), New Computer Modern (GUST Font "
        "License; NewCM10-Regular: GPL-3.0-or-later with Font Exception and Distribution "
        "Exception, see its licence statement below) and DejaVu Sans Mono (Bitstream Vera Fonts "
        "Copyright / DejaVu licence). The typst-assets NOTICE at the end of this group covers "
        "every asset the compiler embeds.",
        "",
    ]
    out += _text_block("Libertinus Serif — OFL-1.1", [], [_hand_text("libertinus-OFL.txt")])
    out += _text_block(
        "New Computer Modern — GUST Font License",
        [],
        [_hand_text("newcm-GUST-FONT-LICENSE.txt"), _hand_text("newcm-License.txt")],
    )
    out += _text_block(
        "DejaVu Sans Mono — Bitstream Vera Fonts Copyright / DejaVu licence",
        [],
        [_hand_text("dejavu-LICENSE.txt")],
    )
    out += _text_block(
        "typst-assets 0.15.0 — NOTICE", [], [_hand_text("typst-assets-NOTICE.txt")]
    )
    out += _text_block(
        "Bundled report fonts — overview",
        ["Font files that ship with PrismLCA in `backend/src/prism_lca/assets/fonts/`."],
        [_repo_text(FONTS_DIR / "NOTICE.md")],
    )
    for family in sorted(p for p in FONTS_DIR.iterdir() if p.is_dir()):
        files = sorted(
            p for p in family.iterdir() if p.is_file() and p.name in ("OFL.txt", "LICENSE.md")
        )
        out += _text_block(f"{family.name} — OFL-1.1", [], [_repo_text(p) for p in files])
    return out


def _data_section() -> list[str]:
    out = ["## Data", ""]
    out += _text_block(
        "searoute shipping-lane network (Eurostat marnet, ORNL Global Shipping Lane Network) — "
        "EUPL-1.2",
        [
            "The `searoute` package itself is Apache-2.0 (its LICENCE.txt is under Python "
            "packages). The maritime network it ships is derived from Eurostat's marnet network, "
            "published under the European Union Public Licence 1.2, and from the Oak Ridge "
            "National Laboratory (ORNL) Global Shipping Lane Network. PrismLCA reads the network "
            "unmodified from the installed package.",
        ],
        [_hand_text("EUPL-1.2.txt")],
    )
    out += _text_block("Transport catalogue", [], [_repo_text(TRANSPORT_NOTICE)])
    return out


def _icons_section() -> list[str]:
    out = ["## Icons and logos", ""]
    out += _text_block(
        "Feather Icons — MIT",
        [
            "Most interface icons (`frontend/src/renderer/src/components/icons.tsx`) and the inline glyphs "
            "of the splash screen, the chat's composer menu and its model picker are drawn from Feather "
            "Icons, Copyright (c) 2013-2023 Cole Bemis. The source note of each icon in `icons.tsx` says "
            "whether it is Feather's, Lucide's or drawn for PrismLCA.",
        ],
        [_hand_text("feather-LICENSE.txt")],
    )
    out += _text_block(
        "Lucide — ISC",
        [
            "Some icons are taken or adapted from Lucide, Copyright (c) Lucide Icons and Contributors: "
            "calculator, bar chart, plane, route, mail, flask and the two-way arrows in `icons.tsx`, and "
            "the microphone in the chat composer and in the welcome tour's chat preview. Lucide's licence "
            "carries the MIT notice of the Feather icons it derives from.",
        ],
        [_hand_text("lucide-LICENSE.txt")],
    )
    out += _text_block(
        "Simple Icons — CC0-1.0",
        [
            "The logos in `frontend/src/renderer/src/assets/logos/` (anthropic = Claude, deepseek, github, "
            "google = Google Gemini, minimax, moonshotai, nvidia, openrouter, qwen, substack, xiaomi) are "
            "taken from Simple Icons, released under CC0 1.0; linkedin and openai come from earlier Simple "
            "Icons releases and have since been removed there. MiniMax's mark is in Simple Icons with its "
            "owner's permission and under its brand terms; GitHub's follows GitHub's logo guidelines. The "
            "logos label the respective provider or service only; all marks remain trademarks of their owners "
            "and imply no endorsement or partnership. Simple Icons' disclaimer follows its licence.",
        ],
        [_hand_text("simple-icons-LICENSE.md"), _hand_text("simple-icons-DISCLAIMER.md")],
    )
    out += _text_block(
        "LobeHub Icons — MIT",
        [
            "The Tencent logo (`frontend/src/renderer/src/assets/logos/tencent.svg`) is taken from LobeHub "
            "Icons, Copyright (c) 2023 LobeHub. The mark remains a trademark of Tencent and implies no "
            "endorsement or partnership.",
        ],
        [_hand_text("lobehub-icons-LICENSE.txt")],
    )
    out += [
        "### Logos of the geocoding services",
        "",
        "The logos of Mapbox (`mapbox.svg`: symbol and word mark together, black on the light theme and "
        "white on the dark one, as Mapbox's brand guidelines at https://www.mapbox.com/brand-guidelines "
        "ask) and of openrouteservice by HeiGIT (`openrouteservice.png`, the logo from "
        "https://openrouteservice.org) name the two geocoding services on the Transport settings page. "
        "They are trademarks of their owners and imply no endorsement or partnership.",
        "",
        "### Drawn for PrismLCA",
        "",
        "`zai.svg` (a plain letter Z standing for Z.ai) and `stealth.svg` in the same folder are drawn for "
        "PrismLCA and fall under its own licence.",
        "",
        "### Own artwork",
        "",
        "The app mark (`frontend/resources/icon.png`, also `backend/src/prism_lca/assets/images/"
        "prism-mark.png`), the backgrounds in `frontend/src/renderer/src/assets/` (`overview-bg`, "
        "`side-bg`, `welcome-bg`, `substack-banner`) and the default report cover "
        "(`backend/src/prism_lca/assets/images/cover-default.jpg`) were made for PrismLCA, with an AI image "
        "generator, and are distributed with it under the same terms as the rest of the repository. They "
        "contain no third-party photographs or marks.",
        "",
    ]
    return out


MODELS = (
    (
        "BAAI/bge-m3",
        "5617a9f61b028005a4858fdac845db406aefb181",
        "BAAI (Beijing Academy of Artificial Intelligence)",
        "the default search backend (sentence-transformers)",
    ),
    (
        "intfloat/multilingual-e5-large",
        "3d7cfbdacd47fdda877c5cd8a79fbcc4f2a574f3",
        "the multilingual-e5 authors (Liang Wang, Nan Yang, Xiaolong Huang, Linjun Yang, "
        "Rangan Majumder, Furu Wei)",
        "the fastembed search backend",
    ),
)


def _models_section() -> list[str]:
    out = ["## Models", ""]
    out += [
        "PrismLCA does not bundle model weights. The embedding models for semantic search are "
        "downloaded from Hugging Face at first use, pinned to the revisions below. Their model "
        "cards declare the MIT licence and carry no licence file, so the standard MIT text is "
        "reproduced with the model authors as copyright holders.",
        "",
    ]
    for repo_id, revision, holder, used_for in MODELS:
        out += _text_block(
            f"{repo_id} — MIT",
            [
                f"Used by {used_for}. Revision `{revision}`, "
                f"<https://huggingface.co/{repo_id}/tree/{revision}>.",
            ],
            [(f"MIT licence for {repo_id}", _mit_for(holder))],
        )
    return out


def _electron_section() -> list[str]:
    return [
        "## Electron and Chromium",
        "",
        "The desktop shell is Electron, which includes Chromium, Node.js and their "
        "dependencies. Their licence texts are not repeated here: electron-builder places "
        "`LICENSE.electron.txt` (Electron, MIT) and `LICENSES.chromium.html` (Chromium and every "
        "component it includes) next to the PrismLCA executable in the installation folder.",
        "",
    ]


def render(python: list[Package], npm: list[Package]) -> str:
    project = tomllib.loads((BACKEND / "pyproject.toml").read_text(encoding="utf-8"))
    version = project["project"]["version"]
    shipped = [p for p in python if p.name not in EXCLUDED_FROM_BUILD]
    excluded = [p for p in python if p.name in EXCLUDED_FROM_BUILD]
    commit = _git("rev-parse", "--short", "HEAD")

    out = [
        "# PrismLCA third-party notices",
        "",
        f"PrismLCA version {version}.",
        f"{HEADER_PREFIX}{commit} by `backend/scripts/third_party_notices.py`.",
        f"{len(shipped)} Python runtime packages, {len(npm)} npm packages.",
        "",
        "This file lists the third-party software, fonts, icons, data and models that ship "
        "with PrismLCA or that PrismLCA downloads, together with their licence and notice "
        "texts. PrismLCA itself is licensed under the GNU Affero General Public License, "
        "version 3 only (AGPL-3.0-only); see the LICENSE file. The file is generated; do not "
        "edit it by hand.",
        "",
        "All components are under permissive licences, except the Intel oneAPI runtime "
        "libraries marked \"exception\" below, which PrismLCA's LICENSE covers with an "
        "additional permission under AGPL-3.0 section 7. The Intel runtime libraries are licensed to "
        "you under Intel's terms reproduced below, not under the AGPL: reverse engineering, "
        "decompiling or disassembling them is not permitted.",
        "",
        "## Summary",
        "",
        f"### Python runtime packages ({len(shipped)})",
        "",
        *_summary_table(shipped),
        "",
    ]
    if excluded:
        out += [
            "### Present in the dependency closure but not shipped",
            "",
            *_summary_table(excluded),
            "",
        ]
    out += [f"### npm packages ({len(npm)})", "", *_summary_table(npm), ""]

    out += ["## Python packages", ""]
    for pkg in shipped:
        out += _package_block(pkg)
    if excluded:
        out += ["## Present in the dependency closure but excluded from the shipped build", ""]
        for pkg in excluded:
            out += [*_package_block(pkg)[:2], EXCLUDED_FROM_BUILD[pkg.name], ""]
            out += _package_block(pkg)[2:]
    out += ["## npm packages", ""]
    for pkg in npm:
        out += _package_block(pkg)
    out += _fonts_section()
    out += ["## Dictionaries", ""]
    out += _text_block("Spell-check dictionaries", [], [_repo_text(DICTIONARIES_NOTICE)])
    out += _data_section()
    out += _icons_section()
    out += _models_section()
    out += _electron_section()
    return "\n".join(out).rstrip("\n") + "\n"


def generate() -> tuple[str, list[str], list[Package], list[Package]]:
    python = python_packages(uv_closure())
    npm = npm_packages()
    return render(python, npm), policy_failures(python, npm), python, npm


# ---------------------------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------------------------


def comparable(text: str) -> list[str]:
    """The file's lines without the commit header, which changes with every commit."""
    return [ln for ln in text.split("\n") if not ln.startswith(HEADER_PREFIX)]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="do not write; exit 1 if a file is stale or a licence fails the policy",
    )
    args = parser.parse_args(argv)
    text, failures, python, npm = generate()
    status = 0
    if args.check:
        for path in OUTPUTS:
            current = path.read_text(encoding="utf-8") if path.exists() else ""
            diff = list(
                difflib.unified_diff(
                    comparable(current), comparable(text), str(path), "regenerated", lineterm="", n=1
                )
            )
            if diff:
                status = 1
                changed = sum(1 for d in diff if d[:1] in "+-" and d[:3] not in ("+++", "---"))
                print(f"STALE {path.relative_to(REPO)}: {changed} changed lines", file=sys.stderr)
                for line in diff[:40]:
                    print(f"  {line[:160]}", file=sys.stderr)
                if len(diff) > 40:
                    print(f"  ... {len(diff) - 40} more diff lines", file=sys.stderr)
        if status:
            print("Regenerate: cd backend && uv run python scripts/third_party_notices.py",
                  file=sys.stderr)
    else:
        for path in OUTPUTS:
            path.write_text(text, encoding="utf-8", newline="\n")
            print(f"wrote {path.relative_to(REPO)} ({len(text.encode('utf-8'))} bytes)")
    for failure in failures:
        print(f"POLICY {failure}", file=sys.stderr)
    if failures:
        status = 1
    shipped = sum(1 for p in python if p.name not in EXCLUDED_FROM_BUILD)
    print(f"{shipped} Python runtime packages, {len(npm)} npm packages, "
          f"{len(failures)} policy failures")
    return status


if __name__ == "__main__":
    sys.exit(main())
