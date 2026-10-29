"""A substance identifier in a query: the datasets whose reference product carries it, ahead of the ranking.

Databases record a substance number of the form 1310-73-2 on their reference products. It names one substance
exactly, and the ranking cannot read it — the digits find whatever shares them. So the number is looked up in the
searched databases themselves (the field on each reference product, read from the workspace's own file) and the
datasets carrying it lead the list; the ranked list follows unchanged. A number no searched database carries
changes nothing.

A number is a substance, not a dataset, and three things follow from that:

- **Waste and treatment rows carry it too.** Polyethylene's number sits on 40 product rows and 64 rows of
  "waste polyethylene"; whoever pastes it from a data sheet wants the material. A row whose reference product
  is negative (a treatment) is left out unless the query asks for waste. Recycled material is material.
- **One number can stand for hundreds of rows.** Natural gas has 696 — seven products in many regions. The block
  is collapsed by geography like any hit list, markets first, and kept short.
- **The honesty checks read the query without the number.** The digits appear in no dataset name, so a correct
  hit would otherwise be reported as "1310" and "73" not found. The number stays in the search's signature.
"""

from __future__ import annotations

import pickle
import re
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from prism_lca import _log
from prism_lca.engine.bootstrap import get_bd
from prism_lca.search.abbrev import _WASTE_INTENT
from prism_lca.search.ranking import geo_rank

#: How many collapsed rows the block may take; the ranked list fills the rest of the limit.
PINNED = 10
#: Markets before market groups before production datasets — what an input usually links to first.
_TYPE_ORDER = {"M": 0, "G": 1, "P": 2}
#: Which region stands for a collapsed row when the caller chose none: the broadest first (with a chosen
#: region, the ranking's own proxy chain decides).
_REGION_ORDER = ("GLO", "RoW", "RER")
#: How long a failed read is kept before the next search tries again ("database is locked" is a moment).
RETRY_AFTER = 60.0

#: A number of that form, leading zeros allowed (ecoinvent pads the first block to six digits), and the label a
#: data sheet writes beside it.
_NUMBER = re.compile(r"(?<![\w-])0*(\d{2,7})-(\d{2})-(\d)(?![\w-])")
_LABEL = re.compile(r"(?<![\w-])CAS(?:[\s-]*(?:RN|No|Nr)\b\.?)?(?![\w-])\s*[#:]?", re.IGNORECASE)


def normalise(number: str) -> str:
    """``007732-18-5`` and ``7732-18-5`` are one number; anything else is not a number ("")."""
    m = re.fullmatch(r"\s*0*(\d{2,7})-(\d{2})-(\d)\s*", str(number or ""))
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m and _valid(m) else ""


def _valid(m: re.Match) -> bool:
    """The check digit: the other digits from the right, weighted 1, 2, 3 …, summed modulo 10."""
    digits = (m.group(1) + m.group(2))[::-1]
    return sum((i + 1) * int(d) for i, d in enumerate(digits)) % 10 == int(m.group(3))


@dataclass
class Found:
    """A number the searched databases carry: the rows carrying it, and how the query wrote it."""

    number: str
    rows: list[dict]
    #: The query without the number and its label — what the honesty checks read.
    rest: str = ""
    #: Every valid number the query names: what tells two such searches apart.
    numbers: tuple[str, ...] = ()

    def pin(self, ranked: list[dict], collapse, target_geo: str | None = None, keep: int = 0) -> list[dict]:
        """The carrying rows first, markets before groups before production datasets (within a type, those the
        ranking found in its order, then the others, each shown in the chosen region or else the broadest), and
        the ranked list behind them — all within the list's length, every database keeping ``keep`` rows (the
        pinned ones count) as the reserve promised."""
        def key(h):
            return h.get("database"), h.get("name"), h.get("product"), h.get("atype")

        def region(geo):
            if target_geo:
                return geo_rank(geo, target_geo)
            return _REGION_ORDER.index(geo) if geo in _REGION_ORDER else len(_REGION_ORDER)

        carrying = {key(r) for r in self.rows}
        found = [(i, h) for i, h in enumerate(ranked) if key(h) in carrying]
        seen = {key(h) for _, h in found}
        injected = collapse(sorted((r for r in self.rows if key(r) not in seen),
                                   key=lambda r: (r.get("name") or "", region(r.get("geo")), r.get("geo") or "")))
        candidates = [h for _, h in sorted(found + [(len(ranked) + i, h) for i, h in enumerate(injected)],
                                           key=lambda p: (_TYPE_ORDER.get(p[1].get("atype"), 3), p[0]))]
        total = len(ranked) or PINNED
        others = [h for h in ranked if key(h) not in carrying]
        size = min(PINNED, total, len(candidates))
        for _ in range(2):  # the guarantee depends on what the block holds, the block on the guarantee
            held = {}
            for h in candidates[:size]:
                held[h.get("database")] = held.get(h.get("database"), 0) + 1
            kept, owed = [], {}
            for h in others:
                db = h.get("database")
                if owed.setdefault(db, max(0, keep - held.get(db, 0))) > 0:
                    owed[db] -= 1
                    kept.append(h)
            size = max(1, min(PINNED, total - len(kept), len(candidates)))
        block = [{k: v for k, v in h.items() if k != "reserved"} | {"score": 1.0} for h in candidates[:size]]
        room = total - len(block) - len(kept)
        owed_rows = {id(h) for h in kept}
        tail = []
        for h in others:
            if id(h) in owed_rows:
                tail.append(h)
            elif room > 0:
                tail.append(h)
                room -= 1
        return block + tail


class Identifiers:
    """Number → carrying rows per searched index, kept on the index object like the market blend: a rebuilt
    or extended index has a new generation, and the table built for the old one is never used again."""

    def __init__(self, service) -> None:
        self._svc = service
        self._build = threading.Lock()

    def source(self, name: str) -> Path | None:
        """The workspace file holding ``name``, or None for the elementary flows (searched with their own
        tools). Determined under PROJECT_LOCK — the switch routes hold it for the whole switch — and read
        outside it. The eval harness replaces this method: it has no Brightway projects, only the file."""
        from prism_lca.engine.commands import PROJECT_LOCK

        if name.startswith("biosphere"):
            return None
        with PROJECT_LOCK:
            return Path(get_bd().projects.dir) / "lci" / "databases.db"

    def find(self, query: str, entries, types: set | None = None, geos: set | None = None) -> Found | None:
        """The first valid number in ``query`` that a searched database carries, with its rows — filtered like
        the ranking (activity types, a multi-region filter) and without treatment rows unless the query asks
        for waste. None when there is no such number."""
        waste = bool(_WASTE_INTENT.search(query or ""))
        valid = [m for m in _NUMBER.finditer(query or "") if _valid(m)]
        numbers = tuple(f"{m.group(1)}-{m.group(2)}-{m.group(3)}" for m in valid)
        for m, number in zip(valid, numbers, strict=True):
            rows: list[dict] = []
            for name, index in entries:
                table = self._table(name, index)
                meta = index.meta
                for i, code, treatment in (table or {}).get(number, ()):
                    row = meta[i] if i < len(meta) else {}
                    if row.get("code") != code or (treatment and not waste) or (
                            types and row.get("atype") not in types) or (geos and row.get("geo") not in geos):
                        continue  # (a row moved since the table was read: skipped, not mistaken)
                    rows.append({**row, "database": name})
            if rows:
                rest = _LABEL.sub(" ", query[:m.start()] + " " + query[m.end():])
                return Found(number, rows, " ".join(rest.split()), numbers)
        return None

    def _table(self, name: str, index) -> dict[str, list[tuple[int, str, bool]]] | None:
        """Number → (row of ``index``, its code, is a treatment) for every reference product that carries one.
        An empty table is kept only briefly: the database may simply carry none (BAFU), or the file read was
        another workspace's, the index loaded before a switch."""
        stamp = (index.generation, len(index.meta))
        cached = getattr(index, "_prism_identifiers", None)
        if cached and cached[0] == stamp and (cached[2] is None or time.monotonic() < cached[2]):
            return cached[1]
        try:
            db_file = self.source(name)
        except Exception as exc:  # noqa: BLE001 — no table is today's search, not an error
            _log.swallowed(exc, "Identifiers.source")
            db_file = None
        with self._build:
            cached = getattr(index, "_prism_identifiers", None)
            if cached and cached[0] == stamp and cached[2] is None:
                return cached[1]  # built while this one waited
            if db_file is None:
                index._prism_identifiers = (stamp, None, None)
                return None
            try:
                table = _read(db_file, name, {m.get("code"): i for i, m in enumerate(index.meta)})
            except Exception as exc:  # noqa: BLE001 — as above; kept briefly, the next search reads again
                _log.swallowed(exc, "Identifiers")
                index._prism_identifiers = (stamp, None, time.monotonic() + RETRY_AFTER)
                return None
            if (index.generation, len(index.meta)) != stamp:
                return None  # rows changed while reading: the table describes old rows — not this search
            index._prism_identifiers = (stamp, table, None if table else time.monotonic() + RETRY_AFTER)
            return table


def _read(db_file: Path, name: str, rows: dict[str, int]) -> dict[str, list[tuple[int, str, bool]]]:
    """The substance number of every production exchange of ``name``, read-only from the workspace's file — the
    search index stores no exchanges, and an existing index must not need a rebuild for this."""
    con = sqlite3.connect(f"file:{db_file}?mode=ro", uri=True)
    try:
        table: dict[str, list[tuple[int, str, bool]]] = {}
        for code, data in con.execute(
            "select output_code, data from exchangedataset where output_database = ? and type = 'production'",
            (name,),
        ):
            row = rows.get(code)
            if row is None or not data:
                continue
            d = pickle.loads(data)  # the user's own Brightway file, as Brightway reads it
            number = normalise(d.get("CAS number") if isinstance(d, dict) else "")
            if number:
                table.setdefault(number, []).append((row, code, float(d.get("amount") or 0.0) < 0))
        return table
    finally:
        con.close()
