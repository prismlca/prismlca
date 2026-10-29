"""The spelled-out query variant: the workspace's abbreviation dictionary, the variant of one query, and
the fusion of the two rankings.

`abbrev.py` holds the rules (what counts as an abbreviation, how a query is split and read); this module
holds what the search service needs at run time — the dictionary derived from the workspace's own data, the
per-database facts the weights depend on, their caches and locks — so the service only asks and fuses.
"""

from __future__ import annotations

import re
import threading
from pathlib import Path

from prism_lca import _log
from prism_lca.engine.bootstrap import get_bd
from prism_lca.search import abbrev, vocabulary


class QueryVariants:
    """Derived artefacts of the search indexes, kept and dropped with them.

    ``service`` supplies the seams this needs (`_cache_key`, `_require_index`), so a subclass of the
    service that moves them (the eval harness) moves them here too.
    """

    def __init__(self, service) -> None:
        self._svc = service
        # What each background database contributes, the workspace's merged dictionary, and per searched
        # database its exact names and the abbreviations it uses AS material names — keyed like the
        # index caches (project/database).
        self._sources: dict[str, abbrev.Source] = {}
        self._dicts: dict[str, tuple[tuple, abbrev.Dictionary]] = {}
        self._dbinfo: dict[str, tuple] = {}
        self._lock = threading.Lock()

    # -- lifecycle --------------------------------------------------------------------------------
    def forget(self, key: str) -> None:
        """Drop what was derived from one database (and every merged dictionary, since any of them may
        contain it). Recomputed lazily on the next search."""
        with self._lock:
            self._sources.pop(key, None)
            self._dbinfo.pop(key, None)
            self._dicts.clear()

    def forget_all(self) -> None:
        with self._lock:
            self._sources.clear()
            self._dicts.clear()
            self._dbinfo.clear()

    def warm(self, names: list[str], started_in: str) -> None:
        """Precompute the dictionary and each warmed database's facts — seconds that would otherwise land
        on the first search."""
        dictionary = self.dictionary()
        for name in names:
            if name != "biosphere3" and get_bd().projects.current == started_in:
                self._database_facts(name, self._svc._require_index(name), dictionary)

    # -- the dictionary ---------------------------------------------------------------------------
    @staticmethod
    def rows(db_file: Path, db_name: str) -> list[abbrev.Row]:
        """Name, product, unit and synonyms of every activity, read from the workspace's SQLite file.

        Directly from the file, read-only, rather than through Brightway's activity table: that table is
        rebound on a workspace switch AFTER the new name is published, so a read in between took A's rows
        under B's name. The file is the one of the workspace captured under
        PROJECT_LOCK, so whatever switches meanwhile, these rows belong to the key they are cached under.
        The index metadata carries no synonyms, and an existing index must not need a rebuild for this."""
        import pickle
        import sqlite3

        con = sqlite3.connect(f"file:{db_file}?mode=ro", uri=True)
        try:
            rows = []
            for name, product, data in con.execute(
                "select name, product, data from activitydataset where database = ?", (db_name,)
            ):
                d = pickle.loads(data) if data else {}  # the user's own Brightway file, as Brightway reads it
                d = d if isinstance(d, dict) else {}
                rows.append(abbrev.Row(name=name or "", product=product or "", unit=str(d.get("unit") or ""),
                                       synonyms=[str(x) for x in (d.get("synonyms") or []) if x]))
            return rows
        finally:
            con.close()

    def dictionary(self) -> abbrev.Dictionary:
        """The workspace's abbreviations, from the synonyms of ALL its background databases.

        All of them, not only the ticked ones: a BAFU search gains from ecoinvent's synonyms (BAFU has
        none). Never the library (one import would change every search), never the
        biosphere, never a model.

        PROJECT_LOCK is held only to capture WHICH workspace, which databases and which file — the switch
        routes hold it for the whole switch, so that snapshot is consistent. The reading itself (about two
        seconds for ecoinvent, once) runs outside it: under the lock it stalled command routes and with
        them the API's event loop. No lock is held inside another here."""
        from prism_lca.engine.backgrounds.common import is_background
        from prism_lca.engine.commands import PROJECT_LOCK

        with PROJECT_LOCK:
            bd = get_bd()
            project = str(bd.projects.current)
            names = sorted(n for n in bd.databases if is_background(n))
            keys = tuple(self._svc._cache_key(n) for n in names)
            db_file = Path(bd.projects.dir) / "lci" / "databases.db"
        with self._lock:
            cached = self._dicts.get(project)
            if cached and cached[0] == keys:
                return cached[1]
            sources = []
            complete = True
            for name, key in zip(names, keys, strict=True):
                src = self._sources.get(key)
                if src is None:
                    try:
                        src = abbrev.derive(self.rows(db_file, name))
                        self._sources[key] = src
                    except Exception as exc:  # noqa: BLE001 — no dictionary is today's search, not an error
                        # Not cached: "database is locked" while the app writes is a moment, not a
                        # verdict — the next search reads again.
                        _log.swallowed(exc, "QueryVariants.dictionary")
                        src = abbrev.Source({})
                        complete = False
                sources.append(src)
            dictionary = abbrev.Dictionary.merge(sources)
            if complete:
                self._dicts[project] = (keys, dictionary)
            return dictionary

    def _database_facts(self, name: str, index, dictionary: abbrev.Dictionary) -> tuple:
        """Exact names/products of one searched database and the abbreviations it uses as material
        names — memoised on the index object, its size and the dictionary."""
        key = self._svc._cache_key(name)
        stamp = (id(index), len(index.meta), id(dictionary))
        with self._lock:
            cached = self._dbinfo.get(key)
            if cached and cached[0] == stamp:
                return cached[1], cached[2]
        exact = frozenset(abbrev.fold(m.get(f)) for m in index.meta for f in ("name", "product") if m.get(f))
        named = dictionary.names_material(m.get("name") or "" for m in index.meta)
        with self._lock:
            self._dbinfo[key] = (stamp, exact, named)
        return exact, named

    # -- one query ------------------------------------------------------------------------------------
    def for_query(self, query: str, entries) -> tuple[abbrev.Expansion | None, bool]:
        """The variant of the query the databases would write — abbreviations spelled out, then everyday words
        replaced (search/vocabulary.py) — and whether a searched database names one of its materials WITH the
        abbreviation (which decides the weights, see abbrev.RAW_WEIGHT).

        The word list does not depend on the dictionary: a workspace with BAFU alone has no synonyms to derive
        one from and still needs "truck" read as "lorry". A query that names a dataset exactly is left alone
        by both."""
        if any(name == "biosphere3" or name.startswith("biosphere") for name, _ in entries):
            return None, False  # elementary flows have their own synonyms; not measured, not touched
        dictionary = self.dictionary()
        exact: set[str] = set()
        named: set[str] = set()
        for name, index in entries:
            e, n = self._database_facts(name, index, dictionary)
            exact |= e
            named |= n
        folded = abbrev.fold(query)
        if folded in exact or abbrev.fold(re.sub(r"^market (group )?for ", "", folded)) in exact:
            return None, False
        expansion = abbrev.Expander(dictionary, frozenset(exact)).expand(query) if dictionary.table else None
        text, words = vocabulary.expand(expansion.text if expansion else query)
        if words:
            expansion = _with_words(expansion, text, words)
        if expansion is None:
            return None, False
        return expansion, any(k in named for k in expansion.keys)


def _with_words(expansion: abbrev.Expansion | None, text: str, words: dict[str, str]) -> abbrev.Expansion:
    """The expansion with the replaced words added: shown and reported beside the abbreviations, and counted
    by the honesty checks like them (a hit that says "lorry" carries the "truck" the query typed). They add no
    dictionary key, so the weights stay the abbreviation rule's; with no abbreviation in the query they are
    the plain RAW_WEIGHT / EXPANSION_WEIGHT."""
    # A hit carries a replaced word when it carries the reading's content words: "freight transport by lorry"
    # is matched by "transport, freight, lorry", which has no "by". Of a reading that names the thing in two
    # databases' words ("van, light commercial vehicle") the last counts, as a hit never says both.
    anchors = {w: " ".join(t for t in r.split(",")[-1].split() if t not in _FILLERS) for w, r in words.items()}
    if expansion is None:
        return abbrev.Expansion(text, dict(words), frozenset(), anchors)
    return abbrev.Expansion(text, {**expansion.aliases, **words}, expansion.keys,
                            {**expansion.anchors, **anchors}, dict(expansion.recyclates))


_FILLERS = frozenset({"by", "per", "for", "of", "the"})


def fuse(raw: list[dict], alt: list[dict], w_raw: float, w_exp: float) -> list[dict]:
    """Candidates of the query as typed and of its spelled-out form, fused by weighted RRF.

    Both variants are ranked over the SAME union of databases, so their RRF scores are comparable and
    simply add up (Benham et al., query-variation fusion). The alternative measured first — a different
    query text per database — put scores of two different queries into one ranking: the same BAFU hit
    scored 6.9 under one text and 18.0 under the other.

    ``dense`` keeps the better of the two cosines: it is what `weak` and the displayed score read, and the
    right PET market scores 0.36 against "pet" and 0.62 against its spelled-out form. In the dense-only path
    (``search_hybrid`` off) there is no RRF score and the better cosine alone decides.
    """
    merged: dict[tuple, dict] = {}
    for weight, cands in ((w_raw, raw), (w_exp, alt)):
        for c in cands:
            k = (c.get("database"), c.get("code"))
            cur = merged.get(k)
            if cur is None:
                cur = merged[k] = {**c}
                if "fused" in c:
                    cur["fused"] = 0.0
            else:
                cur["dense"] = max(cur.get("dense", 0.0), c.get("dense", 0.0))
                if "order" in c:  # the ranking's value (search/market_vectors.py) keeps its better one too
                    cur["order"] = max(cur.get("order", 0.0), c["order"])
            if "fused" in c:
                cur["fused"] = cur.get("fused", 0.0) + weight * c["fused"]
    return list(merged.values())
