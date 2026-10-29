"""Where a bundle's background references land in *this* installation.

A model bundle carries the foreground graph and points at background datasets rather than copying
them — the licence forbids the copy, and the recipient has the data anyway. So an import has to answer
one question per reference: which activity here is the one that bundle meant?

Kept as a **pure function** on purpose. It takes what the bundle claims and what is installed, and
returns a verdict per reference; it touches no database and writes nothing. That is what makes the dry
run possible: the report the user sees before importing *is* this function's output, so the preview
cannot drift from what the import then does.

The ladder, in order:

1. ``(database, code)`` — exact. The normal case when both sides have the same ecoinvent.
2. the code in *another* installed database — same data, different name
   (``ecoinvent-3.12-cutoff`` vs ``ecoinvent 3.12 cutoff``), which in practice is the frequent case.
3. the **fingerprint** (name, reference product, location, unit) exactly, in a database of the same
   ecoinvent version — the code changed, the dataset did not.
4. the fingerprint loosely — candidates, for the user to choose.
5. nothing — reported, and the import refuses to write.

**Across ecoinvent versions this stops at step 1**: the later stages are built and
tested but only applied within the same version. A 3.11 dataset is not the same number as its 3.12
successor, so matching one to the other by name would produce results that look calculated as
modelled when they are not. Turning it on later is a release decision, not a rewrite — which is why
the stages exist rather than being left for later.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


def fingerprint_of(name: str, reference_product: str, location: str, unit: str) -> tuple[str, str, str, str]:
    """What counts as "the same dataset described the same way".

    One function for both sides on purpose: normalising the reference and not the installed data (or
    the reverse) makes every comparison fail on a capital letter, and the failure looks like "not
    found" rather than like a bug.
    """
    return (
        (name or "").strip().casefold(),
        (reference_product or "").strip().casefold(),
        (location or "").strip().casefold(),
        (unit or "").strip().casefold(),
    )


class Verdict(StrEnum):
    exact = "exact"           # (database, code) found as named
    relinked = "relinked"     # same code, another database — only the name differed
    matched = "matched"       # same fingerprint, different code, same version
    ambiguous = "ambiguous"   # several plausible candidates; the user decides
    missing = "missing"       # nothing that could honestly be called the same dataset
    version = "version"       # found, but in another ecoinvent version — refused for now


@dataclass
class Reference:
    """One background dataset a bundle needs, as the bundle described it."""

    database: str
    code: str
    name: str = ""
    reference_product: str = ""
    location: str = ""
    unit: str = ""
    #: ecoinvent version of the database it came from, when the exporter knew it ("3.12").
    version: str = ""

    def fingerprint(self) -> tuple[str, str, str, str]:
        return fingerprint_of(self.name, self.reference_product, self.location, self.unit)


@dataclass
class Installed:
    """A background database as it exists here, flattened to what matching needs."""

    name: str
    version: str = ""
    #: code -> fingerprint
    by_code: dict[str, tuple[str, str, str, str]] = field(default_factory=dict)

    def by_fingerprint(self) -> dict[tuple[str, str, str, str], list[str]]:
        """Normalised on the way in, so a caller may fill `by_code` straight from the database."""
        out: dict[tuple[str, str, str, str], list[str]] = {}
        for code, fp in self.by_code.items():
            out.setdefault(fingerprint_of(*fp), []).append(code)
        return out


@dataclass
class Resolution:
    reference: Reference
    verdict: Verdict
    #: Where it will actually be linked, when that is decided.
    database: str = ""
    code: str = ""
    #: For `ambiguous`: what the user may choose from, as `[{"database", "code", "name", …}]`.
    candidates: list[dict] = field(default_factory=list)
    #: One sentence for the dry-run report — the reason, not the mechanism.
    detail: str = ""

    @property
    def resolved(self) -> bool:
        return self.verdict in (Verdict.exact, Verdict.relinked, Verdict.matched)


def _same_version(a: str, b: str) -> bool:
    """Unknown on either side counts as "do not know", and the caller decides what that permits."""
    return bool(a) and bool(b) and a.strip() == b.strip()


def resolve(
    references: list[Reference],
    installed: list[Installed],
    *,
    allow_cross_version: bool = False,
) -> list[Resolution]:
    """One verdict per reference. Pure: no database access, no writes, no ordering surprises."""
    by_name = {db.name: db for db in installed}
    fingerprints = {db.name: db.by_fingerprint() for db in installed}
    out: list[Resolution] = []

    for ref in references:
        # 1. exactly where the bundle said — but only if it is the same ecoinvent.
        home = by_name.get(ref.database)
        if home is not None and ref.code in home.by_code:
            mismatched = ref.version and home.version and not _same_version(ref.version, home.version)
            if not mismatched or allow_cross_version:
                out.append(Resolution(ref, Verdict.exact, ref.database, ref.code,
                                      detail="found where the bundle said it was"))
                continue
            # A database of the same NAME holding another ecoinvent version is the quietest way to
            # get wrong numbers: everything lines up except the data. Refused, loudly.
            out.append(Resolution(
                ref, Verdict.version,
                detail=(f"'{ref.database}' here is ecoinvent {home.version}, the bundle was written "
                        f"against {ref.version} — same name, different data, so it is refused"),
            ))
            continue

        # 2. the same code somewhere else — a differently named copy of the same database.
        elsewhere = [db for db in installed if ref.code in db.by_code]
        cross = [db for db in elsewhere if ref.version and db.version and not _same_version(ref.version, db.version)]
        same_version = [db for db in elsewhere if not cross or db not in cross]
        if same_version:
            db = same_version[0]
            out.append(Resolution(ref, Verdict.relinked, db.name, ref.code,
                                  detail=f"same dataset in '{db.name}' — only the database name differed"))
            continue

        # 3./4. the fingerprint, within the same version unless explicitly allowed.
        fp = ref.fingerprint()
        hits: list[tuple[str, str]] = []
        other_version: list[tuple[str, str]] = []
        for db in installed:
            for code in fingerprints[db.name].get(fp, ()):
                if ref.version and db.version and not _same_version(ref.version, db.version):
                    other_version.append((db.name, code))
                else:
                    hits.append((db.name, code))

        if len(hits) == 1:
            db_name, code = hits[0]
            out.append(Resolution(ref, Verdict.matched, db_name, code,
                                  detail="same name, product, location and unit — the code changed"))
            continue
        if len(hits) > 1:
            out.append(Resolution(
                ref, Verdict.ambiguous,
                candidates=[{"database": d, "code": c, "name": ref.name} for d, c in hits],
                detail=f"{len(hits)} datasets match equally well, so the link is not chosen silently",
            ))
            continue

        if (other_version or cross) and not allow_cross_version:
            found = (other_version or [(db.name, ref.code) for db in cross])[0]
            out.append(Resolution(
                ref, Verdict.version,
                detail=(f"only found in '{found[0]}', which is a different ecoinvent version than the "
                        f"bundle's ({ref.version or 'unknown'}) — relinking across versions changes the "
                        f"numbers, so it is refused"),
            ))
            continue
        if other_version and allow_cross_version:
            db_name, code = other_version[0]
            out.append(Resolution(ref, Verdict.matched, db_name, code,
                                  detail="matched across ecoinvent versions — the numbers may differ"))
            continue

        out.append(Resolution(ref, Verdict.missing,
                              detail="no dataset here carries this code or this description"))
    return out


def summary(resolutions: list[Resolution]) -> dict:
    """Counts for the dry-run panel — and `can_import`, the one thing the UI has to branch on."""
    counts: dict[str, int] = {v.value: 0 for v in Verdict}
    for r in resolutions:
        counts[r.verdict.value] += 1
    blocking = counts[Verdict.missing.value] + counts[Verdict.ambiguous.value] + counts[Verdict.version.value]
    return {
        "counts": counts,
        "total": len(resolutions),
        "resolved": sum(1 for r in resolutions if r.resolved),
        "can_import": blocking == 0,
    }
