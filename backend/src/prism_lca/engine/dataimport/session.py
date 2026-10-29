"""One import at a time: read, match, review, write.

Kept as a single session rather than a job queue, for the same reason the ecoinvent import is:
two imports at once would race for the same background database and the same biosphere, and the
answer to "can I start another one" should be "finish the first" rather than a merge conflict two
minutes later.

**Nothing is written before :func:`commit`.** Everything up to then lives here, in memory, and can
be thrown away by closing the wizard — which is the whole point of a review step. Commit writes into
the project's library, ``My processes`` (see :mod:`prism_lca.engine.library`), never into ecoinvent
and never into a database of its own. It links to the same ``biosphere3``, which is what keeps every
installed LCIA method working on it: a method characterises biosphere flows and does not know
database names at all.

Written with ``new_activity().save()`` rather than ``Database.write()``, and that is not a style
choice — ``write()`` empties the database and re-inserts, so every activity id changes. The library
is permanent and other models' processed datapackages hold those ids; rewriting it would leave them
pointing at rows that no longer exist, silently.
"""

from __future__ import annotations

import copy
import dataclasses
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

from prism_lca import _log
from prism_lca.engine import model as _model
from prism_lca.engine import params as _params
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.dataimport import readers, units
from prism_lca.engine.dataimport.detect import FORMAT_LABELS, SourceFormat
from prism_lca.engine.dataimport.matching import (
    BIOSPHERE_DB,
    PACKAGE_DB,
    BiosphereIndex,
    Candidate,
    Confidence,
    Match,
    PackageIndex,
    match_biosphere,
    match_in_package,
    match_technosphere,
    normalise_name,
    property_bridge,
    searched_why,
)
from prism_lca.engine.dataimport.model import ForeignDataset, ForeignExchange
from prism_lca.engine.library import (
    LIBRARY_DB,
    ensure_library,
    new_batch,
    stamp,
)
from prism_lca.errors import PrismError

#: Where parked flows are kept. Not a Database: a process with no exchanges
#: computes as zero, and a flow with no characterisation factor contributes zero to every method.
#: Both would turn a visible gap into a silent one, so the parking lot is metadata, not inventory.
UNMATCHED_KEY = "prism_unmatched"

#: Where a dataset keeps the co-products its import did not book. Metadata for the same
#: reason as the parking lot: a co-product booked as nothing is invisible, and one booked as a
#: consumption buys what the process sells. Kept apart from UNMATCHED_KEY because nothing about it is
#: unmatched — it is a modelling decision (allocation or system expansion) still to be taken.
COPRODUCTS_KEY = "prism_coproducts"

#: What identifies a library dataset as "the same one again" on a re-import of its source — see
#: ForeignDataset.identity. Not the code: a code can carry a suffix, and a name can be normalised.
IDENTITY_KEY = "prism_import_identity"


class Unmatched(StrEnum):
    """What to do with what could not be matched. Both choices are recorded in the import report."""

    park = "park"
    drop = "drop"


@dataclass
class Row:
    """One reviewable line: a foreign exchange, what it was matched to, and why.

    ``dataset`` is the name the table shows; ``dataset_key`` is what identifies the dataset. Two
    processes of one name — the same activity in two regions is the ordinary case — used to pool
    their rows under the name, and each came out of the commit with the other's inventory as well.
    """

    dataset: str
    index: int
    match: Match
    dataset_key: str = ""

    def as_json(self, sign_of: Callable[[str, str], float] | None = None) -> dict[str, Any]:
        """``sign_of`` is the commit's own sign lookup (see :class:`_Plan`) — passed for a waste
        whose target the same import replaces, so the row shows the sign the commit writes."""
        exchange, match = self.match.exchange, self.match
        treatment = match.target.treatment if match.target is not None else None
        if sign_of is not None and exchange.waste and match.target is not None:
            treatment = sign_of(match.target.database, match.target.code) < 0
        return {
            "dataset": self.dataset,
            "dataset_key": self.dataset_key or self.dataset,
            "index": self.index,
            "kind": exchange.kind,
            "name": exchange.name,
            "amount": exchange.amount,
            "unit": exchange.unit,
            "compartment": list(exchange.compartment),
            "direction": exchange.direction,
            # A product the process gives off besides its reference — booked as nothing unless the
            # session says substitution (see Session.coproducts_as_substitution).
            "coproduct": exchange.coproduct,
            # A waste the process gives off: booked as a link to its TREATMENT, with the sign of the
            # treatment's own reference production — never a co-product, never a substitution.
            "waste": exchange.waste,
            # A negative input the source does not call a waste: booked as written, but the
            # reviewer has to say whether it is waste to treatment or a deliberate credit.
            "sign_review": exchange.sign_review,
            # What the unit measures, and what the source states about the flow beyond the amount.
            # Both exist so that a quantity mismatch can be SAID — in the table and to the matching
            # model — instead of hiding inside two unit strings a reader has to know by heart.
            "quantity": units.dimension(exchange.unit),
            "properties": [
                {"name": p.name, "amount": p.amount, "unit": p.unit} for p in exchange.properties
            ],
            "confidence": match.confidence.value,
            "evidence": match.evidence,
            "factor": match.factor,
            "scale": match.scale_note,
            # The chosen target measures another quantity and neither arithmetic nor a property the
            # source states bridges the two: only a substance property the reviewer supplies (a
            # density, a calorific value) can. The wizard offers that input exactly here.
            "needs_assumption": _needs_assumption(exchange, match),
            "needs_model": match.needs_model,
            "region_open": match.region_open,
            # What the reviewer is agreeing to, spelled out rather than implied. A characterisation
            # factor is per compartment, and a conversion factor changes the number itself — both
            # have to be readable in the row, not inferred from a label.
            "scaled_amount": _booked_amount(exchange, match, treatment),
            "target": None
            if match.target is None
            else {
                "database": match.target.database,
                "code": match.target.code,
                "label": match.target.label,
                "name": match.target.name,
                "unit": match.target.unit,
                # For a flow the compartment, for a process the region: the same question — into
                # which medium, in which place — and neither is visible in a name.
                "categories": list(match.target.categories),
                "location": match.target.location,
                # A dataset of this very package rather than of any database — the wizard says so.
                "package": match.target.database == PACKAGE_DB,
                "treatment": treatment,
            },
            "candidates": [
                {
                    "database": c.database,
                    "code": c.code,
                    "label": c.label,
                    "unit": c.unit,
                    "location": c.location,
                    "categories": list(c.categories),
                    # Name apart from the label, because the matching model is shown the activity
                    # without its region: it judges whether this is the same thing, and the region
                    # is a decision for the person reviewing (see matching._regions_first).
                    "name": c.name,
                    "why": c.why,
                    "quantity": units.dimension(c.unit),
                    "package": c.database == PACKAGE_DB,
                    # Makes the product only as a co-product: not choosable until it is allocated.
                    "allocation_required": c.allocation_required,
                    # Negative reference production: what a waste row wants (None = not looked at).
                    "treatment": c.treatment,
                }
                for c in match.candidates
            ],
        }


def _booked_amount(exchange: ForeignExchange, match: Match, treatment: bool | None) -> float:
    """The amount the review table says will land — for a waste, signed by its treatment target.

    The commit re-reads the target's sign (:func:`_production_sign`); this is the same rule on what
    the row already knows, so the number the reviewer agrees to is the number written."""
    amount = exchange.amount * match.factor
    if exchange.waste and match.target is not None:
        return abs(amount) * (-1.0 if treatment else 1.0)
    return amount


@dataclass
class Session:
    source: Path
    format: SourceFormat
    datasets: list[ForeignDataset]
    rows: list[Row] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    #: The project the source was read and matched in. Its match targets are that project's
    #: databases; a commit after a project switch wrote them into whichever project was active.
    #: Empty only for sessions built by hand.
    project: str = ""
    #: Book co-products as ``substitution`` (avoided burden, system expansion) instead of leaving
    #: them unbooked. Off by default: substitution changes results, and choosing it is a modelling
    #: decision — the reviewer's, set in the wizard and read at commit.
    coproducts_as_substitution: bool = False
    #: Set while :func:`commit` writes. Options and decisions are refused meanwhile: the commit works
    #: on a snapshot, and a switch flipped halfway used to split one import between two bookings.
    committing: bool = False

    def books(self, row: Row) -> bool:
        """Whether commit turns this row into an exchange at all. A co-product only on request."""
        return not row.match.exchange.coproduct or self.coproducts_as_substitution

    def summary(self) -> dict[str, Any]:
        bands: dict[str, int] = {}
        for row in self.rows:
            key = row.match.confidence.value
            bands[key] = bands.get(key, 0) + 1
        return {
            "source": str(self.source),
            "format": self.format.value,
            "format_label": FORMAT_LABELS[self.format],
            "datasets": len(self.datasets),
            "rows": len(self.rows),
            "bands": bands,
            "needs_model": sum(1 for r in self.rows if r.match.needs_model),
            # Matched processes whose region nobody has chosen yet — commit refuses while > 0. A
            # co-product that is not booked has no region worth asking about.
            "region_open": sum(1 for r in self.rows if r.match.region_open and self.books(r)),
            "coproducts": sum(1 for r in self.rows if r.match.exchange.coproduct),
            "coproducts_as_substitution": self.coproducts_as_substitution,
            # Wastes given off, booked as treatment (never counted as co-products).
            "waste": sum(1 for r in self.rows if r.match.exchange.waste),
            "sign_review": sum(1 for r in self.rows if r.match.exchange.sign_review),
            # Inputs bound to a supplier delivered in the same package.
            "from_package": sum(
                1 for r in self.rows if r.match.target is not None and r.match.target.database == PACKAGE_DB
            ),
            "notes": list(self.notes),
        }


_lock = threading.Lock()
_current: Session | None = None


def _biosphere_index() -> BiosphereIndex:
    bd = get_bd()
    if BIOSPHERE_DB not in bd.databases:
        raise PrismError(
            "There is no biosphere yet, so imported flows would have nothing to point at.",
            code="import_no_biosphere",
            hint="Import ecoinvent first — it brings the elementary flow list with it.",
        )
    return BiosphereIndex.build(dict(flow) for flow in bd.Database(BIOSPHERE_DB))


#: What the running deterministic pass is doing right now, for the wizard's progress bar. Written
#: WITHOUT the session lock: a reader polling progress must never queue behind the very work it is
#: watching. One writer (the /start request), many readers, plain dict swaps — atomic enough.
_reading: dict[str, Any] | None = None

#: Set by :func:`stop_reading` while a pass should give up. Lock-free for the same reason: the
#: request that stops the work must not queue behind the work.
_stop_reading = False


class ImportStopped(Exception):
    """The reader was asked to stop. Not a failure — nothing was read and nothing was written."""


def reading_progress() -> dict[str, Any] | None:
    """Where the deterministic pass stands, or ``None`` when none is running."""
    return _reading


def committing() -> bool:
    """Whether a commit is writing into the database right now — the phase in which a stopped
    process would leave half-replaced activities behind (system.py's busy check)."""
    return _current is not None and _current.committing


def stop_reading() -> None:
    """Ask a running pass to give up at its next row.

    Cooperative rather than a killed thread, and the checkpoints are chosen accordingly: between
    two rows of the matching loop, and once when the file has been read. A stop pressed while the
    package is still being parsed therefore lands when the parse is done — bw2io and the XML
    readers have no place to ask. That is why the button says *Stopping…* once it is pressed:
    the wizard promises that it was heard, not that it happened this instant.
    """
    global _stop_reading
    _stop_reading = True


def start(target: Path, *, search=None, background: str = "") -> dict[str, Any]:
    """Read the source and run the deterministic pass. Writes nothing.

    Raises :class:`ImportStopped` when the wizard asked to stop — the session is left untouched,
    so a stopped read is indistinguishable from one never started.
    """
    global _current, _reading, _stop_reading
    _stop_reading = False
    _reading = {"phase": "reading", "done": 0, "total": 0}
    try:
        fmt, result = readers.read(target)
        if _stop_reading:
            raise ImportStopped
        index = _biosphere_index()
        # A reference amount of 0 has no "per unit": every amount would be divided by nothing, and
        # the commit wrote it as a production of +1. Such datasets are not imported,
        # and not offered as package suppliers either — said in the notes, by name.
        zero = [
            d for d in result.importable
            if any(e.kind == "production" and e.amount == 0 for e in d.exchanges)
            and not any(e.kind == "production" and e.amount for e in d.exchanges)
        ]
        dropped = {id(d) for d in zero}
        importable = [d for d in result.importable if id(d) not in dropped]
        if zero:
            shown = ", ".join(f"“{d.name}”" for d in zero[:3]) + (f" and {len(zero) - 3} more" if len(zero) > 3 else "")
            result.notes.append(
                f"{len(zero)} dataset{'s state' if len(zero) != 1 else ' states'} a reference amount of "
                f"0 ({shown}) — nothing can be written per unit of it, so {'they are' if len(zero) != 1 else 'it is'} "
                "not imported. Correct the reference amount in the source and export again."
            )
        package = PackageIndex.build(importable)

        total = sum(
            1
            for dataset in importable
            for exchange in dataset.exchanges
            if exchange.kind != "production"
        )
        rows: list[Row] = []
        for dataset in importable:
            for position, exchange in enumerate(dataset.exchanges):
                if exchange.kind == "production":
                    continue
                if _stop_reading:
                    raise ImportStopped
                internal = match_in_package(exchange, package, own_key=dataset.key)
                if exchange.kind == "biosphere":
                    # The same semantic index the process search uses, over `biosphere3`. It has
                    # been built behind every background index all along and was queried by nobody.
                    match = match_biosphere(exchange, index, search=search)
                elif internal is not None and internal.matched:
                    # Delivered in the same package: that is the answer, and the background search
                    # would only offer proxies for it. The reviewer can still pick one by hand.
                    match = internal
                elif search is not None and background:
                    match = match_technosphere(
                        exchange,
                        search=search,
                        background=background,
                        prefer_location=dataset.location or "",
                    )
                else:
                    match = Match(
                        exchange=exchange,
                        evidence=(
                            "no background database is indexed, so there is nothing to link against"
                        ),
                    )
                if internal is not None and not internal.matched:
                    # A package supplier whose unit does not convert: offered first, bound by nobody.
                    match.candidates = [*internal.candidates, *match.candidates]
                    match.evidence = f"{internal.evidence}; {match.evidence}" if match.evidence else internal.evidence
                if exchange.waste:
                    _flag_treatments(match, importable)
                rows.append(Row(dataset=dataset.name, index=position, match=match, dataset_key=dataset.key))
                _reading = {"phase": "matching", "done": len(rows), "total": total}

        with _lock:
            _current = Session(
                source=target,
                format=fmt,
                datasets=importable,
                rows=rows,
                notes=list(result.notes),
                project=str(get_bd().projects.current),
            )
            return _current.summary()
    finally:
        _reading = None
        _stop_reading = False


def _refuse_while_committing(session: Session) -> None:
    if session.committing:
        raise PrismError(
            "This import is being written right now — the change would reach only part of it.",
            code="import_committing",
            status_code=409,
            hint="Wait for the import to finish.",
        )


def set_options(*, coproducts_as_substitution: bool | None = None) -> dict[str, Any]:
    """Change how the current import will be written. Applies at once — there is no save step."""
    with _lock:
        if _current is None:
            raise PrismError("There is no import to change.", code="import_no_session")
        _refuse_while_committing(_current)
        if coproducts_as_substitution is not None:
            _current.coproducts_as_substitution = bool(coproducts_as_substitution)
        return {"active": True, **_current.summary()}


def _package_candidate(session: Session, key: str) -> Candidate | None:
    """A dataset of the package under review, as a match target."""
    dataset = next((d for d in session.datasets if d.key == key), None)
    if dataset is None:
        return None
    return Candidate(
        database=PACKAGE_DB,
        code=dataset.key,
        name=dataset.name,
        unit=dataset.unit,
        location=dataset.location,
        reference_product=dataset.reference_product,
        why="this package",
    )


def state() -> dict[str, Any]:
    with _lock:
        if _current is None:
            return {"active": False}
        return {"active": True, **_current.summary()}


def rows(*, confidence: str | None = None, only_open: bool = False) -> list[dict[str, Any]]:
    """The review table, filterable — the filter is the whole point of the band."""
    with _lock:
        if _current is None:
            return []
        # A waste bound to a library dataset this very import replaces takes the REPLACEMENT's sign
        # at commit; the row has to show that number, not the one the library holds today.
        plan = (
            _replacements(_current)
            if any(
                r.match.exchange.waste and r.match.target is not None and r.match.target.database == LIBRARY_DB
                for r in _current.rows
            )
            else None
        )
        out = []
        for row in _current.rows:
            if only_open and row.match.matched:
                continue
            if confidence and row.match.confidence.value != confidence:
                continue
            bound = plan is not None and row.match.target is not None and row.match.target.database == LIBRARY_DB
            out.append(row.as_json(plan.sign_of if bound and plan is not None else None))
        return out


def candidates(query: str, kind: str, *, search=None, background: str = "", limit: int = 40) -> list[dict]:
    """Look something up by hand — every flow, or every process in the searchable databases.

    The shortlist a row carries is what the RULES found; it is not the vocabulary. A reviewer who
    disagrees with all of it had no way to say what they actually meant, which turns "none of these"
    from a judgement into a dead end.
    """
    query = (query or "").strip()
    if not query:
        return []
    if kind == "biosphere":
        found = _biosphere_index().search(query, limit=limit)
    else:
        hits = (search(query, background, limit) if search and background else []) or []
        found = [
            Candidate(
                database=hit.get("database", background),
                code=hit.get("code", ""),
                name=hit.get("name", ""),
                unit=hit.get("unit", ""),
                location=hit.get("geography") or hit.get("location") or "",
                reference_product=hit.get("product") or "",
                why=searched_why("search", hit),
            )
            for hit in hits
        ]
    return [
        {
            "database": c.database,
            "code": c.code,
            "label": c.label,
            "name": c.name,
            "unit": c.unit,
            "categories": list(c.categories),
            "location": c.location,
            # What put it on the list — with a hand search, also what an abbreviation was read as.
            "why": c.why,
            # A searched process says whether it is a treatment — what a waste row is looking for.
            **({} if kind == "biosphere" else {"treatment": _reference_sign(c.database, c.code, []) < 0}),
        }
        for c in found
    ]


def _resolve_target(database: str, code: str) -> Candidate | None:
    """A target the reviewer picked, which may be nowhere near the row's shortlist."""
    if database == BIOSPHERE_DB:
        return _biosphere_index().by_code.get(code)
    try:
        node = get_bd().get_node(database=database, code=code)
    except Exception as exc:  # noqa: BLE001 — a code that does not resolve is a rejected decision
        _log.swallowed(exc, "resolve_target")
        return None
    return Candidate(
        database=database,
        code=code,
        name=str(node.get("name") or ""),
        unit=str(node.get("unit") or ""),
        location=str(node.get("location") or ""),
        reference_product=str(node.get("reference product") or ""),
    )


def decide(decisions: list[dict[str, Any]], *, refused: list[dict[str, Any]] | None = None) -> int:
    """Apply decisions from the review table or from the matching model.

    A decision with no ``code`` clears the match — saying "not this" has to be as easy as saying
    "this one", or a reviewer will leave a wrong match standing rather than fight the interface.

    A candidate that makes the product only as a co-product (``allocation_required``) is refused
    unless the decision says ``allocation_confirmed``. Refused decisions are listed in ``refused``;
    a request in which nothing could be applied BECAUSE of such a refusal raises
    ``import_allocation_required``, so a single pick in the wizard gets its reason back.
    """
    applied = 0
    refusals: list[dict[str, Any]] = [] if refused is None else refused
    with _lock:
        if _current is None:
            return 0
        _refuse_while_committing(_current)
        by_key = {(r.dataset_key or r.dataset, r.index): r for r in _current.rows}
        by_name: dict[tuple[str, int], list[Row]] = {}
        for r in _current.rows:
            by_name.setdefault((r.dataset, r.index), []).append(r)
        # A decision by NAME where two datasets share it names two rows. It was resolved onto the
        # last one, so "match the first, clear the second" matched nothing and cleared the second.
        # Refused before anything is applied: half a batch is worse than none.
        for decision in decisions:
            if decision.get("dataset_key"):
                continue
            named = by_name.get((decision.get("dataset"), int(decision.get("index", -1))), [])
            if len(named) > 1:
                raise PrismError(
                    f"Two datasets are called “{decision.get('dataset')}” — a decision naming one "
                    "of them by name cannot say which.",
                    code="import_dataset_ambiguous",
                    status_code=422,
                    hint="Send the row's dataset_key with the decision (the review rows carry it).",
                )
        dataset_locations = {d.name: (d.location or "") for d in _current.datasets}
        for decision in decisions:
            index = int(decision.get("index", -1))
            row = by_key.get((decision.get("dataset_key"), index)) if decision.get("dataset_key") else None
            if row is None:
                named = by_name.get((decision.get("dataset"), index), [])
                row = named[0] if len(named) == 1 else None
            if row is None:
                continue
            code = decision.get("code")
            if not code:
                row.match.target = None
                row.match.confidence = Confidence.open
                row.match.evidence = str(decision.get("evidence") or "cleared by the reviewer")
                # No match, no region to choose for it — the flag counted a cleared row as an open
                # decision and blocked the whole commit on it.
                row.match.region_open = False
                applied += 1
                continue
            wanted_db = str(decision.get("database") or "")
            # The database decides first where it was sent: a package key and a background code are
            # two namespaces, and a code alone could pick the wrong one.
            if wanted_db:
                # Sent with a database, a decision is resolved in THAT database only — a code-only
                # fallback picked the package's `same` when the reviewer had chosen `bg/same`.
                chosen = next(
                    (c for c in row.match.candidates if c.code == code and c.database == wanted_db), None
                )
            else:  # an older client, which never sent one
                chosen = next((c for c in row.match.candidates if c.code == code), None)
            if chosen is None:
                # Not on the shortlist — the reviewer searched for it. Resolve it properly and
                # re-derive the conversion, because a target picked by hand needs the same unit
                # arithmetic as one the rules found.
                if wanted_db == PACKAGE_DB:
                    chosen = _package_candidate(_current, code)
                else:
                    chosen = _resolve_target(wanted_db or BIOSPHERE_DB, code)
                if chosen is None:
                    continue
                row.match.candidates = [*row.match.candidates, chosen]
            if chosen.allocation_required and not decision.get("allocation_confirmed"):
                refusals.append(
                    {
                        "dataset": row.dataset,
                        "dataset_key": row.dataset_key,
                        "index": row.index,
                        "code": "import_allocation_required",
                    }
                )
                continue
            if row.match.exchange.waste and chosen.treatment is None:
                chosen = dataclasses.replace(
                    chosen, treatment=_reference_sign(chosen.database, chosen.code, _current.datasets) < 0
                )
            rescale = units.rescale(row.match.exchange.unit, chosen.unit)
            from_the_source = False
            if not rescale.ok:
                # First the file itself: a property the source states (a density, a calorific
                # value) is data, not an assumption of ours — see matching.property_bridge.
                bridged = property_bridge(row.match.exchange, chosen.unit)
                if bridged is not None:
                    rescale, from_the_source = bridged, True
            if not rescale.ok:
                # Mass against volume, mass against energy: no arithmetic bridges those, only a
                # property of the substance does — a density, a calorific value. The decider may
                # supply one, and then it is written into the note rather than applied silently.
                # This is the one place a number enters the inventory that came from neither the
                # source nor our data, so it never earns more than the lowest band.
                bridge = decision.get("assumption") or {}
                try:
                    quantity = float(bridge.get("quantity") or 0)
                except (TypeError, ValueError):
                    quantity = 0.0
                what = str(bridge.get("what") or "").strip()
                if quantity > 0 and what:
                    rescale = units.with_assumption(
                        row.match.exchange.unit, chosen.unit, quantity=quantity, what=what
                    )
            row.match.factor = rescale.factor if rescale.ok else 1.0
            row.match.scale_note = rescale.note if rescale.factor != 1.0 or not rescale.ok else ""
            row.match.target = chosen
            row.match.confidence = Confidence(str(decision.get("confidence") or Confidence.medium))
            if not rescale.ok or (rescale.kind is units.ASSUMED and not from_the_source):
                # A match whose units cannot convert is not a medium-confidence match, whoever made
                # it. The amount would go in unchanged and mean something else — the band has to
                # carry that, because the band is what the reviewer filters by.
                # An assumed conversion lands here too: it converts, but on a number somebody
                # supplied rather than a definition.
                row.match.confidence = Confidence.low
            row.match.evidence = str(decision.get("evidence") or "chosen in review")
            row.match.needs_model = False
            row.match.region_open = _region_still_open(row, chosen, decision, dataset_locations)
            applied += 1
    if refusals and not applied:
        raise PrismError(
            "That supplier makes this product only as a co-product. Linking to it would buy its "
            "whole process, reference product and all.",
            code="import_allocation_required",
            status_code=409,
            hint="Allocate the supplier first, or pick another process.",
        )
    return applied


def _needs_assumption(exchange: ForeignExchange, match: Any) -> bool:
    """Whether the match's units meet only through an assumption — see ``decide``'s bridge."""
    if match.target is None:
        return False
    if units.rescale(exchange.unit, match.target.unit).ok:
        return False
    return property_bridge(exchange, match.target.unit) is None


def _region_still_open(
    row: Row, chosen: Candidate, decision: dict[str, Any], dataset_locations: dict[str, str]
) -> bool:
    """Whether this process match still needs a person to pick the region.

    The dataset exists in several regions and the source named none — then whichever region the
    match carries is an artefact of search order, and it decides electricity mixes and transport
    distances. Nobody may guess it, the model least of all (it is never asked about countries, by
    design): the reviewer picks, and ``region_chosen`` on the decision records that they did.
    """
    if row.match.exchange.kind != "technosphere" or decision.get("region_chosen"):
        return False
    if chosen.database == PACKAGE_DB:
        return False  # one dataset of the package, in the one region the package gives it
    same_activity = [
        c
        for c in row.match.candidates
        if normalise_name(c.name or c.label) == normalise_name(chosen.name or chosen.label)
        and c.unit == chosen.unit
        and c.database == chosen.database
    ]
    regions = {c.location for c in same_activity if c.location}
    if len(regions) < 2:
        return False
    wanted = (
        row.match.exchange.location or dataset_locations.get(row.dataset) or ""
    ).strip().casefold()
    return not (wanted and (chosen.location or "").strip().casefold() == wanted)


def commit(label: str = "", *, unmatched: Unmatched = Unmatched.park) -> dict[str, Any]:
    """Write the source into the project's library. The only step that touches the project.

    ``label`` names the *import*, not a database — it is what the user sees in the list of imports
    and what they remove again. Everything lands in ``My processes`` either way.
    """
    global _current
    with _lock:
        session = _current
        if session is None:
            raise PrismError("There is no import to write.", code="import_no_session")
        _refuse_while_committing(session)
        # Everything the commit decides on, frozen here: the option and every row's match. The
        # validation and the writing both read this snapshot, never the live session. Built BEFORE
        # the flag goes up: a copy that fails (memory) must not leave the session refusing every
        # change with 409 for good.
        frozen = _Frozen(
            substitution=session.coproducts_as_substitution,
            rows=[Row(r.dataset, r.index, copy.copy(r.match), r.dataset_key) for r in session.rows],
        )
        session.committing = True
    try:
        return _commit(session, frozen, label, unmatched)
    finally:
        with _lock:
            session.committing = False


@dataclass
class _Frozen:
    substitution: bool
    rows: list[Row]

    def books(self, row: Row) -> bool:
        return not row.match.exchange.coproduct or self.substitution


def _production_sign(session: Session, database: str, code: str) -> float:
    """+1 when the target PRODUCES its reference, −1 when it is a treatment (production < 0).

    A substitution credits the target by running it backwards. Against a treatment — whose
    reference production is negative — the same positive amount runs it FORWARDS and adds its burden:
    1 kg of co-product on a treatment of −1 kg booked one more treatment. The amount
    therefore carries the sign of the target's own production.

    A waste output uses the same sign the other way round: it runs its treatment FORWARDS, so 2 kg
    of waste on a treatment of −1 kg is booked −2 (two treatments), and on a +1 dataset +2.
    """
    return _reference_sign(database, code, session.datasets)


def _reference_sign(database: str, code: str, datasets: list[ForeignDataset]) -> float:
    """:func:`_production_sign` for a target in ``database`` — ``datasets`` are the package's."""
    if database == PACKAGE_DB:
        dataset = next((d for d in datasets if d.key == code), None)
        reference = next((e for e in dataset.exchanges if e.kind == "production"), None) if dataset else None
        if reference is not None and reference.amount == 0:
            return 0.0
        return -1.0 if reference is not None and reference.amount < 0 else 1.0
    try:
        node = get_bd().get_node(database=database, code=code)
        # The REFERENCE production only — the exchange whose input is the target itself. Summing
        # every production exchange let a second one (−1 against the self-reference +1) cancel it
        # and read a producing supplier as "reference of 0".
        own = [e for e in node.production() if e.input.key == node.key]
        chosen = own or list(node.production())[:1]
        total = float(chosen[0].get("amount") or 0.0) if chosen else 0.0
    except Exception as exc:  # noqa: BLE001 — an unresolvable target keeps the plain reading
        _log.swallowed(exc, "import_production_sign")
        return 1.0
    return 0.0 if total == 0 else (-1.0 if total < 0 else 1.0)


def _flag_treatments(match: Match, datasets: list[ForeignDataset]) -> None:
    """Mark a waste row's candidates as treatment or not, and put the treatments first.

    A waste going out is booked against the dataset that TREATS it; the search finds that by name
    alongside everything else called "scrap" or "sludge". The flag is the dataset's own reference
    sign — the one fact that tells a treatment from a producer — and the order is stable, so the
    search's ranking still holds within each group.
    """
    seen: dict[tuple[str, str], bool] = {}

    def flagged(candidate: Candidate) -> Candidate:
        key = (candidate.database, candidate.code)
        if key not in seen:
            seen[key] = _reference_sign(candidate.database, candidate.code, datasets) < 0
        return dataclasses.replace(candidate, treatment=seen[key])

    match.candidates = sorted((flagged(c) for c in match.candidates), key=lambda c: not c.treatment)
    if match.target is not None:
        match.target = flagged(match.target)


def _lines_of(
    frozen: _Frozen,
    rows: list[Row],
    per_unit: float,
    unmatched: Unmatched,
    sign_of: Callable[[str, str], float],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[tuple[tuple[str, str], dict[str, Any]]], int, int]:
    """One dataset's rows, sorted into what is parked, what is kept as an unbooked co-product, and
    the edges to write — plus how many of those edges are substitutions, and how many are wastes
    sent to treatment.

    ``sign_of`` is the reference sign of a target AS THIS IMPORT LEAVES IT (see :func:`_commit`).
    A waste that matched nothing is always parked, ``unmatched="drop"`` or not: the drop option is
    for flows no method would characterise anyway, and a waste dropped is a treatment burden gone
    without a trace."""
    substituted = 0
    treated = 0
    parked: list[dict[str, Any]] = []
    coproducts: list[dict[str, Any]] = []
    links: list[tuple[tuple[str, str], dict[str, Any]]] = []
    for row in rows:
        exchange, match = row.match.exchange, row.match
        if not frozen.books(row):
            # A co-product, and the reviewer did not ask for substitution: not booked, but kept
            # with the dataset — its burden is still all on the reference product, and whoever
            # opens it has to be able to see that an allocation is owed.
            coproducts.append(
                {
                    "name": exchange.name,
                    "amount": exchange.amount / per_unit,
                    "unit": exchange.unit,
                    "matched_to": None if match.target is None else match.target.label,
                    "reason": "co-product — not booked; allocate, or book it as substitution",
                }
            )
            continue
        if match.target is None:
            if unmatched is Unmatched.park or exchange.waste:
                parked.append(
                    {
                        "name": exchange.name,
                        "amount": exchange.amount / per_unit,
                        "unit": exchange.unit,
                        "compartment": list(exchange.compartment),
                        "kind": exchange.kind,
                        "reason": f"waste output — no treatment matched: {match.evidence}"
                        if exchange.waste
                        else match.evidence,
                        **({"waste": True} if exchange.waste else {}),
                    }
                )
            continue
        if exchange.waste:
            # A waste going out buys its treatment: a technosphere link, never a substitution and
            # never a co-product. The magnitude is the source's, the sign the treatment's own — a
            # cut-off treatment of −1 kg takes −2 for 2 kg, and runs twice; a +1 dataset takes +2.
            sign = sign_of(match.target.database, match.target.code)
            if sign == 0:
                # No "one unit" of it to run. Parked whatever the unmatched choice: it is matched,
                # and dropping it would lose a burden with no trace.
                parked.append(
                    {
                        "name": exchange.name,
                        "amount": exchange.amount / per_unit,
                        "unit": exchange.unit,
                        "compartment": list(exchange.compartment),
                        "kind": exchange.kind,
                        "reason": "waste output — not booked: its treatment target has a reference "
                        "production of 0",
                        "waste": True,
                    }
                )
                continue
            treated += 1
            links.append(
                (
                    (match.target.database, match.target.code),
                    {
                        "amount": abs(exchange.amount * match.factor / per_unit) * sign,
                        "type": "technosphere",
                        "unit": match.target.unit,
                        "name": match.target.name,
                        "comment": match.evidence,
                    },
                )
            )
            continue
        # A co-product booked on request is an avoided burden: Brightway's `substitution`, whose
        # positive amount CREDITS the supplier's burden (system expansion). Everything else keeps
        # the kind the source gave it.
        kind = "substitution" if exchange.coproduct else exchange.kind
        substituted += 1 if exchange.coproduct else 0
        amount = exchange.amount * match.factor / per_unit
        if exchange.coproduct:
            sign = sign_of(match.target.database, match.target.code)
            if sign == 0:
                # A target that produces nothing cannot be run backwards — there is no "one unit"
                # of it to avoid. Kept with the dataset instead of booked with a guessed sign.
                substituted -= 1
                coproducts.append(
                    {
                        "name": exchange.name,
                        "amount": exchange.amount / per_unit,
                        "unit": exchange.unit,
                        "matched_to": match.target.label,
                        "reason": "co-product — not booked: its target has a reference production of 0",
                    }
                )
                continue
            amount = abs(amount) * sign
        elif kind == "technosphere" and sign_of(match.target.database, match.target.code) == 0:
            # A supplier that produces nothing cannot deliver anything — not the positive input,
            # not a negative one flagged for review (−0.4 on such a target was
            # written, where it used to be parked as a waste). Parked whatever the unmatched choice:
            # it is matched, and dropping it would lose it without a trace.
            parked.append(
                {
                    "name": exchange.name,
                    "amount": exchange.amount / per_unit,
                    "unit": exchange.unit,
                    "compartment": list(exchange.compartment),
                    "kind": exchange.kind,
                    "reason": "not booked: its target has a reference production of 0",
                    **({"sign_review": True} if exchange.sign_review else {}),
                }
            )
            continue
        links.append(
            (
                (match.target.database, match.target.code),
                {
                    "amount": amount,
                    "type": kind,
                    "unit": match.target.unit,
                    "name": match.target.name,
                    # The conversion travels with the reason: a factor the reviewer supplied (a
                    # density) or one the source stated changes the number itself, and after the
                    # commit the comment is the only place it can still be read.
                    "comment": " · ".join(x for x in (match.evidence, match.scale_note) if x),
                },
            )
        )
    return parked, coproducts, links, substituted, treated


def _previous(
    dataset: ForeignDataset,
    *,
    by_identity: dict[str, list[Any]],
    existing: dict[tuple[str, str], Any],
    incoming: dict[str, int],
    consumed: set[str],
    ambiguous: list[str],
) -> Any:
    """The library dataset a re-import of ``dataset`` replaces, or None — see the lookup order in
    :func:`_commit`. An identity naming more than one dataset is recorded in ``ambiguous``."""
    if dataset.identity and (
        incoming.get(dataset.identity, 0) > 1 or len(by_identity.get(dataset.identity, [])) > 1
    ):
        ambiguous.append(dataset.name)
        return None
    known = by_identity.get(dataset.identity) if dataset.identity else None
    # The two-part identity an import of 25f99373 wrote ("<id>|<product>", without the process
    # name) — and the code its key deduplication gave ("<id>:<product>"). Without both, the same
    # process re-imported alone matched nothing and came in twice.
    parts = dataset.identity.split("|") if dataset.identity else []
    two_part = f"{parts[0]}|{parts[-1]}" if len(parts) >= 3 else ""
    older = by_identity.get(two_part, []) if two_part else []
    if len(older) > 1 and not known:
        ambiguous.append(dataset.name)
        return None
    for found in (
        known[0] if known else None,
        older[0] if older else None,
        existing.get((dataset.key, dataset.name)),
        existing.get((dataset.legacy_key, dataset.legacy_name))
        if dataset.legacy_key and dataset.legacy_name
        else None,
        existing.get((f"{dataset.legacy_key}:{dataset.reference_product}", dataset.name))
        if dataset.legacy_key and dataset.reference_product
        else None,
    ):
        if found is not None and found["code"] not in consumed:
            return found
    return None


@dataclass
class _Plan:
    """What each dataset of an import replaces (in order), decided before anything is written."""

    session: Session
    olds: list[Any]
    ambiguous: list[str]
    #: Every code the library holds now.
    taken: set[str]
    #: Library code → the incoming dataset that replaces it.
    replaced_by: dict[str, ForeignDataset]

    def sign_of(self, database: str, code: str) -> float:
        """The reference sign of a target as the import will LEAVE it: a library dataset being
        replaced answers with its replacement's — the order of writing decided it."""
        incoming = self.replaced_by.get(code) if database == LIBRARY_DB else None
        if incoming is not None:
            return _reference_sign(PACKAGE_DB, incoming.key, [incoming])
        return _production_sign(self.session, database, code)


def _replacements(session: Session) -> _Plan:
    """Which library dataset each incoming one replaces — for the commit, and for the review table,
    which has to show the sign the commit will write.

    Re-importing an updated file must not double the library. Same code AND same name is the same
    dataset and gets replaced; the same code under a different name is a different thing that
    happens to share an id (SimaPro and EcoSpold 1 have no UUIDs at all), so it gets a free code.

    Found by the dataset's IDENTITY first (source id + product as the source spelled it, stored on
    the activity): the normalisation now splits SimaPro's "Rice/IN U" into "Rice" and an allocated
    process's key grows the product, and a (code, name) lookup missed every one of them — the
    re-import doubled the dataset and the model stayed on the old one. The two
    (code, name) lookups stay as the fallback for imports written before the identity existed.

    An identity that names more than one dataset — in the library or in this import — identifies
    none of them. Replacing on it overwrote one process with another (coal electricity by gas
    electricity, both "1|electricity"); such a dataset is written as new and reported instead. The
    same holds when two incoming datasets would each replace ONE library dataset through a fallback
    (``1|coal|scrap`` and ``1|gas|scrap`` both reaching an old ``1|scrap``): the first used to take
    it, the second came in new, and which was which was the order of the files.
    """
    bd = get_bd()
    existing: dict[tuple[str, str], Any] = {}
    by_identity: dict[str, list[Any]] = {}
    taken: set[str] = set()
    if LIBRARY_DB in bd.databases:
        for activity in bd.Database(LIBRARY_DB):
            existing[(activity["code"], activity["name"])] = activity
            if activity.get(IDENTITY_KEY):
                by_identity.setdefault(activity[IDENTITY_KEY], []).append(activity)
            taken.add(activity["code"])
    incoming: dict[str, int] = {}
    for dataset in session.datasets:
        if dataset.identity:
            incoming[dataset.identity] = incoming.get(dataset.identity, 0) + 1

    def previous(dataset: ForeignDataset, consumed: set[str], ambiguous: list[str]) -> Any:
        return _previous(
            dataset, by_identity=by_identity, existing=existing, incoming=incoming,
            consumed=consumed, ambiguous=ambiguous,
        )

    # What each would claim on its own — a library dataset two of them reach is claimed by neither.
    claims: dict[str, int] = {}
    for dataset in session.datasets:
        alone = previous(dataset, set(), [])
        if alone is not None:
            claims[alone["code"]] = claims.get(alone["code"], 0) + 1
    contested = {code for code, n in claims.items() if n > 1}

    olds: list[Any] = []
    ambiguous: list[str] = []
    consumed: set[str] = set()
    for dataset in session.datasets:
        old = previous(dataset, consumed, ambiguous)
        if old is not None and old["code"] in contested:
            ambiguous.append(dataset.name)
            old = None
        if old is not None:
            consumed.add(old["code"])
        olds.append(old)
    replaced_by = {
        old["code"]: dataset for dataset, old in zip(session.datasets, olds, strict=True) if old is not None
    }
    return _Plan(session=session, olds=olds, ambiguous=ambiguous, taken=taken, replaced_by=replaced_by)


def _commit(session: Session, frozen: _Frozen, label: str, unmatched: Unmatched) -> dict[str, Any]:
    global _current

    bd = get_bd()
    if session.project and str(bd.projects.current) != session.project:
        raise PrismError(
            f"This import was read in project '{session.project}', but '{bd.projects.current}' is "
            "active now — its matches belong to the other workspace's databases.",
            code="import_project_changed",
            status_code=409,
            hint="Switch back to that workspace to write it, or start the import again here.",
        )

    still_open = sum(1 for r in frozen.rows if r.match.region_open and frozen.books(r))
    if still_open:
        raise PrismError(
            f"{still_open} matched process{'es still need' if still_open != 1 else ' still needs'} "
            "a region — "
            "the source names none, so it is the reviewer's call.",
            code="import_region_open",
            hint="Pick a region in each row showing “Select region…”, then commit again.",
        )

    ensure_library()
    db = bd.Database(LIBRARY_DB)
    batch = new_batch()
    provenance = stamp(str(session.source), session.format.value, batch, label.strip() or session.source.name)

    by_dataset: dict[str, list[Row]] = {}
    for row in frozen.rows:
        by_dataset.setdefault(row.dataset_key or row.dataset, []).append(row)

    plan = _replacements(session)
    olds, ambiguous, taken, sign_of = plan.olds, plan.ambiguous, plan.taken, plan.sign_of
    consumed: set[str] = set()

    written = 0
    replaced = 0
    parked_total = 0
    coproducts_total = 0
    substituted = 0
    wastes_treated = 0
    codes: list[str] = []
    #: Package key → the code it was written under. Filled by the first pass, read by the second:
    #: an input bound to another dataset of the package can only be written once that dataset
    #: exists, under a code that may have grown a suffix on the way.
    final_code: dict[str, str] = {}
    pending: list[tuple[Any, list[tuple[tuple[str, str], dict[str, Any]]]]] = []

    # First pass: every dataset, with its production and its parked lines — no inputs yet.
    for dataset, old in zip(session.datasets, olds, strict=True):
        old_code = old["code"] if old is not None else None
        consumers: list[tuple[Any, dict[str, Any]]] = []
        if old is not None:
            # bw2data's delete() cascades into the exchanges of every process that CONSUMES this
            # dataset — the model links into the library. Recorded here and re-attached to the
            # replacement below; a re-import of an updated file used to empty those inputs out of
            # existing models.
            for ex in old.upstream():
                consumer = ex.output
                if consumer.key == old.key:
                    continue  # its own production exchange, recreated below
                consumers.append(
                    (
                        consumer,
                        {
                            "amount": ex.get("amount"),
                            "type": ex.get("type") or "technosphere",
                            "uid": ex.get("prism_uid"),
                            "extra": _model.exchange_extra_fields(ex),
                        },
                    )
                )
            consumed.add(old_code)
            old.delete()
            taken.discard(old_code)
            replaced += 1
        # A replacement keeps the code it replaces: models, the search index and bundles name it.
        code = old_code or dataset.key
        if code in taken:
            n = 2
            while f"{code}-{n}" in taken:
                n += 1
            code = f"{code}-{n}"
        taken.add(code)
        final_code[dataset.key] = code

        # Everything the dataset books is written PER ONE UNIT of its reference product. A source
        # that produces 10 kg with 20 kg of CO2 used to land as 20 kg per 1 kg — the production was
        # written as 1 and nothing else was divided. The sign of the reference
        # (negative = a treatment) is kept on the production exchange.
        reference = next((e for e in dataset.exchanges if e.kind == "production"), None)
        reference_amount = float(reference.amount) if reference is not None and reference.amount else 1.0
        per_unit = abs(reference_amount) or 1.0
        parked, coproducts, links, subs, treated = _lines_of(
            frozen, by_dataset.get(dataset.key, []), per_unit, unmatched, sign_of
        )
        substituted += subs
        wastes_treated += treated
        parked_total += len(parked)
        coproducts_total += len(coproducts)

        activity = db.new_activity(
            code=code,
            name=dataset.name,
            unit=dataset.unit,
            location=dataset.location,
            type="process",
            comment=dataset.comment,
            **{"reference product": dataset.reference_product},
            **provenance,
            # Parked, not dropped, and counted where the health check can see it.
            **{UNMATCHED_KEY: parked},
            **({COPRODUCTS_KEY: coproducts} if coproducts else {}),
            **{IDENTITY_KEY: dataset.identity or dataset.key},
        )
        activity.save()
        activity.new_edge(
            input=activity,
            amount=1.0 if reference_amount >= 0 else -1.0,
            type="production",
            unit=dataset.unit,
            name=dataset.reference_product or dataset.name,
        ).save()
        for consumer, fields in consumers:
            edge = consumer.new_edge(input=activity, amount=fields["amount"], type=fields["type"])
            for k, v in (fields.get("extra") or {}).items():
                edge[k] = v
            # The re-pointed model exchange keeps its uid; one that never had any gets one now.
            edge["prism_uid"] = fields.get("uid") or _model.new_uid()
            edge.save()
            if (fields.get("extra") or {}).get("formula"):
                _params.register_activity_group(consumer)
        pending.append((activity, links))
        written += 1
        codes.append(code)

    # Second pass: the inputs. A target inside the package now has its final code.
    for activity, links in pending:
        for (database, target_code), fields in links:
            if database == PACKAGE_DB:
                database, target_code = LIBRARY_DB, final_code.get(target_code, target_code)
            activity.new_edge(input=(database, target_code), **fields).save()
    # The new datasets' exchanges are editable only with a uid.
    _model.ensure_exchange_uids(LIBRARY_DB, codes=codes)

    with _lock:
        _current = None
    return {
        "database": LIBRARY_DB,
        "batch": batch,
        "label": provenance["prism_import_label"],
        "datasets": written,
        "replaced": replaced,
        "unmatched": parked_total,
        "unmatched_handling": unmatched.value,
        # Co-products left unbooked, and co-products booked as substitution.
        "coproducts": coproducts_total,
        "substituted": substituted,
        # Wastes given off, booked as a link to their treatment (never as substitution).
        "waste_treated": wastes_treated,
        # Written as new because what identifies them named more than one dataset — see `previous`.
        "ambiguous": ambiguous,
        "codes": codes,
    }


def cancel() -> None:
    global _current
    with _lock:
        _current = None
