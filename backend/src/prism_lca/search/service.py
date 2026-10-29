"""Search orchestration: build/load a per-database index and answer queries."""
from __future__ import annotations

import json
import logging
import threading
from pathlib import Path

import numpy as np

from prism_lca import _log
from prism_lca.config import Settings
from prism_lca.engine.bootstrap import get_bd
from prism_lca.errors import PrismError
from prism_lca.search import abbrev
from prism_lca.search.builds import IndexBuilds
from prism_lca.search.embeddings import EmbeddingProvider, get_embedding_provider
from prism_lca.search.fusion import RRF_K, reciprocal_rank_fusion
from prism_lca.search.identifiers import Identifiers
from prism_lca.search.index import VectorIndex
from prism_lca.search.indexer import activity_meta, embed_unique
from prism_lca.search.lexical import Bm25Index, union_stats
from prism_lca.search.market_vectors import MarketVectors
from prism_lca.search.ranking import (
    WEAK_TRIGGER,
    best_hit_coverage,
    finalize_hybrid,
    geo_rank,
    looks_like_a_research_question,
    query_signature,
    rank,
    unanchored_terms,
    unmatched_terms,
)
from prism_lca.search.transport_modes import adjust as adjust_transport_modes
from prism_lca.search.transport_modes import query_intent as transport_intent
from prism_lca.search.variants import QueryVariants, fuse

logger = logging.getLogger(__name__)

#: Hard ceiling on the hits one answer may carry, whatever the scaling below computes. Mirrors the
#: cap the API applies to the requested limit, so a scaled request cannot quietly exceed it.
MAX_HITS = 150



def _fold(s: object) -> str:
    """Case and whitespace folded, for exact-name comparisons."""
    return " ".join(str(s or "").lower().split())

#: How many geo-variants a collapsed hit carries when nothing narrowed the request. Enough to see
#: that a dataset is regionalised and to recognise the usual suspects (GLO, RoW, RER, a country or
#: two); far short of the 175 that ecoinvent's electricity markets would otherwise inline. Ask with
#: a `geographies` filter to get exactly the ones you want — that path is not capped (V235).
VARIANTS_SHOWN = 12

#: Which regions a capped variant list shows first when the caller named none. The order is the
#: proxy order a practitioner would try: GLO is a real global average, RER and its
#: without-Switzerland sibling are the European aggregates, and RoW is a RESIDUAL — whatever is
#: left after the modelled regions — so it is the weakest of the four and comes last.
#:
#: There used to be no order at all: the representative first, then whatever sequence the
#: index happened to hold. That is why "market for electricity, medium voltage" could show twelve
#: of its 175 regions without Germany among them (V347) — twelve arbitrary ones say much less than
#: three chosen ones.
DEFAULT_VARIANT_ORDER = ("GLO", "RER", "Europe without Switzerland", "RoW")


class SearchService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._provider: EmbeddingProvider | None = None
        self._cache: dict[str, VectorIndex] = {}
        self._bm25_cache: dict[str, Bm25Index] = {}
        self._lock = threading.Lock()
        #: The build slot and its queue (search/builds.py).
        self.builds = IndexBuilds(self)
        #: Whether a warm-up loop is walking the databases right now — see `warm_indexes`.
        self._warming = False
        self._warm_again = False  # a warm asked for while one ran — see `_warm_indexes`
        #: The spelled-out query variant (search/variants.py) — derived artefacts of the indexes, dropped
        #: wherever an index is dropped, rebuilt or replaced.
        self._variants = QueryVariants(self)
        #: Market vectors blended with their suppliers' — the ranking's view of a market (search/market_vectors.py).
        self._markets = MarketVectors(self)
        self._identifiers = Identifiers(self)  # a substance number in the query (search/identifiers.py)

    # -- provider (lazy so app start never blocks on the model) --------------
    def _provider_(self) -> EmbeddingProvider:
        if self._provider is None:
            with self._lock:  # double-checked: don't load the model twice if warm() races
                if self._provider is None:
                    try:
                        # A failure is NOT cached — fixing the key/model works without restart.
                        self._provider = get_embedding_provider(self._settings)
                    except Exception as exc:
                        raise PrismError(
                            f"Embedding backend '{self._settings.embedding_backend}' is "
                            f"unavailable: {exc}",
                            code="embedding_unavailable",
                            status_code=503,
                            hint="Fix the configured backend/model/API key — search deliberately "
                                 "does not degrade to a low-quality hashing index.",
                        ) from exc
        return self._provider

    def reset_provider(self) -> None:
        """Drop the built provider so the next embed re-reads the settings.

        Called when the API key changes at runtime (Settings → AI → General). A provider holds the key
        it was constructed with, so without this a newly entered key would only take effect at the
        next start. Cheap for the API backends; for a local model it costs one reload, which is why
        this is called on a key change and not on every search.
        """
        with self._lock:
            self._provider = None

    def warm(self) -> None:
        """Load the embedding model on a background thread at startup so the first
        user search doesn't pay the cold start (bge-m3 is ~1-2 min to load). The
        offline 'hashing' backend (tests) is instant, so skip the thread there."""
        if self._settings.embedding_backend == "hashing":
            return
        if self._settings.embedding_backend == "sentence-transformers":
            from prism_lca.search.model_store import is_cached

            if not is_cached(self._settings.embedding_model_st, self._settings.embedding_model_st_revision):
                # Loading is local_files_only, so warming now would only fail — and it must never
                # turn into a download: that waits for the user's consent (search.model_store).
                logger.info("search model not on disk yet; skipping warm-up until it is downloaded")
                return

        def _load() -> None:
            try:
                self._provider_().embed(["warmup"], is_query=True)  # force weights to load
                logger.info("embedding model warmed up")
            except Exception:  # pragma: no cover - never crash startup over a warmup
                logger.exception("embedding warmup failed; first search will load lazily")
            self._warm_indexes()

        threading.Thread(target=_load, name="prism-embed-warmup", daemon=True).start()

    def warm_indexes(self) -> None:
        """Warm the ACTIVE project's indexes on a background thread — without touching the model.

        Call it whenever the active project changes. The caches below are keyed by
        ``project/database`` (`_cache_key`), so a switch leaves every one of them a miss and the
        first search in the new project pays what a start used to pay: measured at 22 s for the
        index, the BM25 corpus and the geo-variant map together (V341). The model is process-wide
        and already loaded, so this is the cheaper half and there is nothing to skip per backend.

        Cheap when there is nothing to do: a populated cache makes the whole loop dict lookups, so
        the routes that call this without having switched anything pay a thread and no work.
        """
        threading.Thread(target=self._warm_indexes, name="prism-index-warmup", daemon=True).start()

    def _warm_indexes(self) -> None:
        """The loop itself — on the caller's thread. See `warm_indexes` for why."""
        with self._lock:
            if self._warming:
                # A second would load the same files twice — but the running one warms the workspace of its
                # START and stops on a switch: kept and run after it, or a switch left B cold.
                self._warm_again = True
                return
            self._warming = True
        try:
            while True:
                self._warm_once()
                with self._lock:
                    if not self._warm_again:
                        self._warming = False
                        return
                    self._warm_again = False
        except BaseException:
            with self._lock:
                self._warming = False
            raise

    def _warm_once(self) -> None:
        try:
            bd = get_bd()
            started_in = bd.projects.current
            warmed: list[str] = []
            for db_name in list(bd.databases):
                # A switch while this runs would cache the new project's index file under the old
                # project's key, and that index would then be served for the wrong project. Stopping
                # loses nothing: the switch asks for a warm of the project it lands on, run after this one.
                if bd.projects.current != started_in:
                    logger.info("index warmup stopped: the project changed")
                    return
                if not VectorIndex.exists(self._index_base(db_name)):
                    continue
                index = self._require_index(db_name)
                self._bm25_for(self._cache_key(db_name), index)
                self._variants_map(index, db_name)
                warmed.append(db_name)
            self._variants.warm(warmed, started_in)
            self._markets.warm(warmed, started_in)
            logger.info("search indexes warmed up")
        except Exception:  # pragma: no cover - a cold first search is the worst case, as before
            logger.exception("index warmup failed; the first search will load lazily")

    @staticmethod
    def _forget_variants(index: VectorIndex) -> None:
        """Drop the memoised geo-variant map after the index's rows changed.

        It is built once from the whole index and then kept on it. Without this, a dataset imported
        into the library is missing its region from every collapsed hit until a restart, and one
        that was deleted stays selectable in the variant list.
        """
        try:
            del index._prism_variants
        except AttributeError:
            pass

    def _bm25_for(self, key: str, index: VectorIndex) -> Bm25Index:
        if key not in self._bm25_cache:
            self._bm25_cache[key] = Bm25Index.from_meta(index.meta)
        return self._bm25_cache[key]

    # -- index location ------------------------------------------------------
    def _index_base(self, db_name: str) -> Path:
        bd = get_bd()
        return Path(bd.projects.dir) / "prism_search" / db_name

    def _cache_key(self, db_name: str) -> str:
        return f"{get_bd().projects.current}/{db_name}"

    def forget_loaded(self) -> None:
        """Drop every index held in memory; the files stay.

        For the case `drop_index` does not cover: the files were replaced under a project that is
        still the current one — a backup restored over it, or a project deleted and recreated under
        the same name. The cache keys are `project/database` and see nothing of that, so the next
        search would be served from the index of the data that no longer exists. The geo-variant
        map is memoised on the index object and goes with it.
        """
        with self._lock:
            self._cache.clear()
            self._bm25_cache.clear()
        self._variants.forget_all()

    def drop_index(self, db_name: str) -> bool:
        """Forget a database's index — the two files and both in-memory caches.

        Called when the database itself is deleted. Without it a search would still return hits
        whose activity ids no longer resolve, which reads as corruption rather than as a missing
        index.
        """
        key = self._cache_key(db_name)
        with self._lock:
            self._cache.pop(key, None)
            self._bm25_cache.pop(key, None)
        self._variants.forget(key)
        return VectorIndex.remove(self._index_base(db_name))

    def _install(self, index: VectorIndex, base: Path, key: str) -> None:
        """Make a freshly built index the one searches use: saved, cached, its derived artefacts dropped.

        Where to is the builder's to say (`_index_base`, `_cache_key`): it captured both for the
        workspace the build belongs to, which by now need not be the current one."""
        index.save(base)
        self._cache[key] = index
        self._bm25_cache.pop(key, None)  # rebuilt meta → stale BM25
        self._variants.forget(key)  # a re-import may bring other synonyms

    # -- index info (discovery: does this database need indexing?) -----------
    def index_info(self, db_name: str) -> dict:
        """Cheap 'do I need to press Index?' answer: whether an index exists for the database
        and whether its size still matches the database (a count mismatch = clearly stale;
        matching counts are no PROOF of freshness, but the honest cheap heuristic)."""
        bd = get_bd()
        if db_name not in bd.databases:
            raise PrismError(
                f"Database '{db_name}' not found in the active workspace.",
                code="database_not_found", status_code=404,
            )
        # Live SQL count — len(bd.Database(...)) reads the metadata "number", which lags behind
        # until the database is re-processed and would hide a stale index right after edits.
        try:
            from bw2data.backends import ActivityDataset

            activities = int(
                ActivityDataset.select().where(ActivityDataset.database == db_name).count()
            )
        except Exception as exc:  # noqa: BLE001 — non-SQLite backend: metadata count is all we have
            _log.swallowed(exc, "index_info")
            activities = len(bd.Database(db_name))
        # Asked BEFORE the index is looked at. A build installs its index before it reports done, so in
        # this order a build that ends in between is seen as running or as indexed — in the other it
        # could be neither, and the import hook then left the flows it had just added out of the index.
        building = self.builds.building(db_name)
        key = self._cache_key(db_name)
        indexed_count: int | None = None
        if key in self._cache:
            indexed_count = len(self._cache[key])
        else:
            base = self._index_base(db_name)
            if VectorIndex.exists(base):
                try:  # meta json only — never load the vector matrix just for a count
                    cfg = json.loads(VectorIndex._json(base).read_text(encoding="utf-8"))
                    indexed_count = len(cfg.get("meta", []))
                except Exception as exc:  # noqa: BLE001 — corrupt index file = treat as not indexed
                    _log.swallowed(exc, "index_info")
                    indexed_count = None
        return {
            "database": db_name,
            "indexed": indexed_count is not None,
            "indexed_count": indexed_count,
            "activities": activities,
            "stale": indexed_count is not None and indexed_count != activities,
            "building": building,
        }

    # -- query ---------------------------------------------------------------
    @staticmethod
    def _check_index(index: VectorIndex, provider, db_name: str) -> None:
        """Refuse an index that a different embedding setup produced.

        Both the backend NAME and the MODEL are checked, and the model matters more: the two local
        default backends are both 1024-dimensional, so a model swap inside one backend passes a
        name+dimension check and then returns silently meaningless similarities. Indices built
        before the model was recorded carry an empty `model` and keep the old, weaker check — they
        gain the stronger one at their next rebuild, and refusing them outright would invalidate
        every index in the field for a risk that only materialises when the setting changes.
        """
        if index.provider and index.provider != provider.name:
            raise PrismError(
                f"Search index for '{db_name}' was built with embedding backend "
                f"'{index.provider}', but '{provider.name}' is configured.",
                code="embedding_mismatch",
                status_code=409,
                hint="Switch the backend back, or rebuild the index (POST /api/v1/search/index).",
            )
        wanted = getattr(provider, "model", "") or ""
        if index.model and wanted and index.model != wanted:
            raise PrismError(
                f"Search index for '{db_name}' was built with embedding model '{index.model}', "
                f"but '{wanted}' is configured. Their vectors are not comparable.",
                code="embedding_mismatch",
                status_code=409,
                hint="Switch the model back, or rebuild the index (POST /api/v1/search/index).",
            )

    @staticmethod
    def _check_comparable(entries: list[tuple[str, VectorIndex]]) -> None:
        """Refuse to rank two databases together whose vectors come from different models.

        Searching several databases as one ranking space only means anything if a similarity of
        0.7 means the same thing in each of them. Same model, same query vector, L2-normalised —
        then it does. Two indices built with different models would produce a confidently ordered
        list out of two incomparable scales, and nothing in the answer would show it.
        """
        models = {ix.model for _, ix in entries if ix.model}
        if len(models) > 1:
            named = ", ".join(f"'{n}' ({ix.model})" for n, ix in entries if ix.model)
            raise PrismError(
                "The selected databases were indexed with different embedding models, so their "
                f"similarities cannot be compared: {named}.",
                code="embedding_mismatch",
                status_code=409,
                hint="Rebuild the indexes with one model (POST /api/v1/search/index), or search "
                     "the databases one at a time.",
            )

    def _require_index(self, db_name: str) -> VectorIndex:
        key = self._cache_key(db_name)
        if key not in self._cache:
            base = self._index_base(db_name)
            if not VectorIndex.exists(base):
                raise PrismError(
                    f"Database '{db_name}' is not indexed yet.",
                    code="not_indexed",
                    status_code=409,
                    hint="Build the search index first: POST /api/v1/search/index.",
                )
            self._cache[key] = VectorIndex.load(base)
        return self._cache[key]

    # -- keeping an index current without rebuilding it ----------------------

    def extend(self, db_name: str, codes: list[str]) -> dict:
        """Embed these activities and append them to the database's existing index.

        Written for the library, where datasets arrive a delivery at a time. A full rebuild would
        re-embed everything that was already there — minutes, for datasets nobody touched — and the
        alternative, leaving the index stale until somebody presses a button, means the datasets
        just imported are the ones the search cannot find.

        Silent no-op when the database has no index yet: there is nothing to extend, and building
        one from here would turn an import into a long job nobody asked for. The caller decides.
        """
        result = {"database": db_name, "added": 0, "indexed": False}
        base = self._index_base(db_name)
        key = self._cache_key(db_name)
        if key not in self._cache and not VectorIndex.exists(base):
            return result
        index = self._require_index(db_name)
        provider = self._provider_()
        try:
            # The same mismatch `search` refuses on: appending vectors from another backend or
            # model would not raise anything, it would quietly return nonsense similarities.
            self._check_index(index, provider, db_name)
        except PrismError as exc:
            _log.swallowed(exc, "extend")
            result["indexed"] = True
            return result

        known = {m.get("code") for m in index.meta}
        wanted = [c for c in dict.fromkeys(codes) if c not in known]
        result["indexed"] = True
        if not wanted:
            return result

        bd = get_bd()
        database = bd.Database(db_name)
        metas: list[dict] = []
        texts: list[str] = []
        for code in wanted:
            try:
                act = database.get(code)
            except Exception as exc:  # noqa: BLE001 — a code that vanished is not worth failing on
                _log.swallowed(exc, "extend")
                continue
            meta, text = activity_meta(act, db_name)
            metas.append(meta)
            texts.append(text)
        if not texts:
            return result

        with self._lock:
            index.add(embed_unique(provider, texts, index.dim), metas)
            index.save(base)
            self._cache[key] = index
            self._bm25_cache.pop(key, None)  # the corpus grew, so its IDF statistics are stale
            self._forget_variants(index)
        self._variants.forget(key)
        result["added"] = len(texts)
        return result

    def forget(self, db_name: str, codes: list[str]) -> dict:
        """Drop these activities from the index, keeping the rest.

        Used when an import is removed again. The blunt alternative — throwing the index away —
        costs the user every dataset that stayed, re-embedded from scratch, for someone else's
        deletion.
        """
        base = self._index_base(db_name)
        key = self._cache_key(db_name)
        if key not in self._cache and not VectorIndex.exists(base):
            return {"database": db_name, "removed": 0}
        index = self._require_index(db_name)
        with self._lock:
            gone = index.drop(set(codes))
            if gone:
                index.save(base)
                self._cache[key] = index
                self._bm25_cache.pop(key, None)
                self._forget_variants(index)
        if gone:
            self._variants.forget(key)
        return {"database": db_name, "removed": gone}


    def _respond(
        self, query: str, db_name: str, hits: list[dict], weak: bool, facets: dict,
        outside_filter: str | None = None, per_database: list[dict] | None = None,
        aliases: dict[str, str] | None = None, recyclates: dict[str, str] | None = None, honest: str | None = None,
    ) -> dict:
        """Turn a ranked list into the answer, honesty signals and all.

        Its own method because a search over several databases has to say the same things about the
        merged list that a single-database search says about its own — and "the same things" has to
        mean one implementation, or the multi-database path quietly loses a warning.

        ``aliases`` are the abbreviations the search also spelled out, as dictionary key → expansion: a
        hit named "polyethylene terephthalate, …" carries "PET" for these checks. Without that, every
        successful expansion would come back with "No result's name contains 'PET'" — a false alarm
        exactly when it worked. The recyclate prefix is handled by reading the query as "recycled …"
        (abbrev.honesty_query), so "rPET" needs "recycled" in the same hit like any other query word.
        """
        hit_texts = abbrev.with_aliases([
            abbrev.honesty_query(f"{h.get('name') or ''} {h.get('product') or ''} {h.get('geography') or ''}",
                                 recyclates)
            for h in hits
        ], aliases)
        # Three signals, three different failures — none of them able to cover for the others.
        # `weak_match`: nothing here looks like your query at all (gibberish).
        # `unmatched_terms`: your query named a SPECIFIER nothing matched (EURO 6 → a EURO 5 car).
        # `terms_not_in_results`: your query named a WORD no result carries — the material case, which
        # is pure letters and therefore invisible to the digit-based check above.
        # `best_match_words`: your query named SEVERAL things and no single result carries them all.
        # The three checks above all ask their question against the whole list, so a query for a
        # compound is answered "everything matched" as soon as its words are scattered over
        # different datasets — see best_hit_coverage for the case that cost a round.
        # The checks read "rPET" / "r-HDPE" as "recycled PET" / "recycled HDPE": the trade's prefix is a
        # qualifier, and a virgin hit must not count as matching it.
        checked = abbrev.honesty_query(query if honest is None else honest, recyclates)  # `honest`: without a substance number
        missing = unmatched_terms(checked, hit_texts)
        unanchored = unanchored_terms(checked, hit_texts)
        covered, n_terms = best_hit_coverage(checked, hit_texts)
        out = {
            "query": query,
            "database": db_name,
            "count": len(hits),
            "weak_match": weak,
            "unmatched_terms": missing,
            "terms_not_in_results": unanchored,
            # Not an honesty field: the words that identify this query, so a caller holding a
            # conversation can tell that it has asked this before. See query_signature.
            "content_terms": query_signature(abbrev.honesty_query(query, recyclates)),
            "facets": facets,
            "hits": hits,
        }
        # What each database contributed, and how well. Without it the merged answer can only speak
        # for the whole list, and "BAFU returned nothing that carries your word" — the thing the
        # reader has to know — has nowhere to be said.
        if per_database:
            out["databases_searched"] = per_database
            silent = [
                b["database"] for b in per_database
                if b.get("best_match_words", "").startswith("0 of") and b.get("hits")
            ]
            if silent and len(per_database) > 1 and any(
                not b.get("best_match_words", "1").startswith("0 of")
                for b in per_database if b.get("hits")
            ):
                out["no_word_match_in"] = (
                    "No result from " + ", ".join(silent) + " contains a word of your query. That "
                    "means no WORD matched — not that the dataset is absent: check the hits, they "
                    "may carry it under another name."
                )
        # A hard geography filter that hid the dataset the query NAMED. Three searches of the
        # one run asked for `treatment of wastewater, average, wastewater treatment` with
        # geographies RER/DE/GLO and got 25 industrial-wastewater neighbours each — the generic
        # dataset only exists as Europe without Switzerland, CH, RoW and CA-QC, and nothing said so
        # (V333). The filter stays; it now says what it left out.
        if outside_filter:
            out["outside_geography_filter"] = outside_filter
        # From ONE content word up. It used to start at two, and that is exactly the band where
        # the signal is most needed: a search for "grape" against a database that has no grapes
        # said nothing at all, because one word was not enough to report on.
        if n_terms >= 1:
            out["best_match_words"] = f"{covered} of {n_terms}"
        if n_terms >= 2:
            # Said in words only when it is worth saying. Half or less of a multi-word query in the
            # best single hit is the signature of a compound that is not in here; two of three is
            # what an ordinary good search looks like, and a warning there would train the model to
            # read past all of them.
            if covered * 2 <= n_terms:
                out["split_match_warning"] = (
                    f"No single result carries more than {covered} of the {n_terms} things your "
                    "query named — the words are spread over different datasets. Check whether the "
                    "combination exists at all before treating any of these as it."
                )
        # Said in words, because a bare list of tokens invites the wrong conclusion in both
        # directions: absent from the NAMES is not absent from the DATABASE (ecoinvent calls PVC
        # "polyvinyl chloride"), and a plausible-looking top hit is not evidence that the material
        # is there at all. Name the fact, then the two things worth doing about it.
        if unanchored:
            out["proxy_warning"] = (
                "No result's name or reference product contains: "
                + ", ".join(f"'{t}'" for t in unanchored)
                + ". Either this database names the material differently (a synonym or the full "
                "chemical name — check the hits before concluding anything), or it has no dataset "
                "for it and you need a documented proxy. Do not treat the closest hit as the "
                "material itself: say which it is in the exchange comment."
            )
        # A query aimed at the literature ("IPCC … default value") still returns the closest
        # activities, and they look like answers. Say what happened instead: the search cannot
        # produce a figure, and there is a tool that can.
        if looks_like_a_research_question(query):
            out["hint"] = (
                "This reads as a question about a FIGURE, not a dataset name. The database can only "
                "return activities, so these hits are the nearest names, not an answer — use "
                "research_web for emission factors, default values, rates and quotas."
            )
        return out

    def invalidate(self, db_name: str) -> None:
        """Forget a database's index (memory caches + on-disk files). Call when the database is
        deleted or renamed — otherwise a later same-named database would serve the stale index."""
        key = self._cache_key(db_name)
        self._cache.pop(key, None)
        self._bm25_cache.pop(key, None)
        self._variants.forget(key)
        base = self._index_base(db_name)
        for p in (VectorIndex._npz(base), VectorIndex._json(base)):
            try:
                p.unlink(missing_ok=True)
            except Exception as exc:  # noqa: BLE001 - best-effort cleanup
                _log.swallowed(exc, "invalidate")

    def _fused_candidates(self, query, qvec, variant, entries, types, geos, pool, floor: int = 0):
        """Candidates for the query as typed — and, when it carries an abbreviation, for its spelled-out
        form, ranked over the same union and fused (`variants.fuse`)."""
        if variant is None:
            return self._union_candidates(query, qvec, entries, types, geos, pool, floor=floor)
        text, vec, w_raw, w_exp = variant
        raw = self._union_candidates(query, qvec, entries, types, geos, pool, floor=floor, also=vec)
        alt = self._union_candidates(text, vec, entries, types, geos, pool, floor=floor, also=qvec)
        return fuse(raw, alt, w_raw, w_exp)

    def _union_candidates(self, query, qvec, entries, types, geos, pool, floor: int = 0, also=None):
        """Candidates from ALL selected databases in ONE ranking space.

        This replaces the per-database retrieval whose results were then merged. Merging was the
        bug: `reciprocal_rank_fusion` over `(database, code)` keys can never see the same document
        twice, because the corpora are disjoint — so every document scored `1/(60 + its own rank)`
        and the fusion degenerated into a strict round-robin. Position 1 went to the first
        database, position 2 to the second and position 3 to the third, whether or not they had
        anything to do with the query. Searching `grape` with three boxes ticked put two unrelated
        datasets directly under the right one.

        There is nothing to merge here. The dense scores are cosines from one model against one
        query vector, so they are comparable across databases; BM25 is given the statistics of the
        UNION (see `lexical.union_stats`), so a rare word is worth the same in a 26 533-row
        background as in a 50-dataset library. One RRF, one ranking, one order.
        """
        metas: list[dict] = []
        owners: list[str] = []
        dense_parts: list[np.ndarray] = []
        cos_parts: list[np.ndarray] = []
        bounds: list[tuple[str, VectorIndex, int, int]] = []
        for name, index in entries:
            n = len(index.meta)
            if n == 0 or index.matrix.shape[0] == 0:
                continue
            start = len(metas)
            metas.extend(index.meta)
            owners.extend([name] * n)
            cos = index.matrix @ np.asarray(qvec, dtype="float32")
            # Shown: the better of both query forms for EVERY row, not just rows both pools held.
            cos_parts.append(cos if also is None else np.maximum(cos, index.matrix @ np.asarray(also, "float32")))
            # Ordered with the markets' blended vectors; every candidate keeps its own cosine (`dense`).
            dense_parts.append(self._markets.order(name, index, cos, qvec) if self._settings.search_hybrid else cos)
            bounds.append((name, index, start, start + n))
        if not metas:
            return []
        dense = np.concatenate(dense_parts)
        cosine = np.concatenate(cos_parts)

        # Multi-select filters are applied to the WHOLE corpus before the pool is taken, so a
        # filtered region or type surfaces even when it would not rank in the unfiltered top-N.
        allowed: set | None = None
        if types or geos:
            allowed = {
                i for i, m in enumerate(metas)
                if (not types or m.get("atype") in types)
                and (not geos or (m.get("geo") or "") in geos)
            }
            if not allowed:
                return []

        def best(scores: np.ndarray, k: int, positive: bool = False) -> list[int]:
            if allowed is not None:
                ids = [i for i in allowed if not positive or scores[i] > 0]
                ids.sort(key=lambda i: -scores[i])
                return ids[:k]
            total = scores.shape[0]
            kk = max(1, min(k, total))
            idx = np.argpartition(-scores, kk - 1)[:kk]
            idx = idx[np.argsort(-scores[idx])]
            return [int(i) for i in idx if not positive or scores[i] > 0]

        dense_rank = best(dense, pool)
        # Each database's own best few, whether or not they made the global pool. Without this the
        # reserve cannot keep its promise: a background whose datasets all rank below 2 400 other
        # rows contributes no candidates at all, and "nothing came from BAFU" is again
        # indistinguishable from "BAFU has nothing" — the thing the reserve exists to tell apart.
        #
        # They are kept OUT of `dense_rank` and scored separately. Appending them to it would give
        # them a rank position taken from the order the databases happen to be in, and that is the
        # very disease this rewrite cured: two extras with nothing else to separate them would be
        # ordered by whose checkbox came first.
        extras: list[int] = []
        if floor:
            present = set(dense_rank)
            for _, _, lo, hi in bounds:
                local = dense[lo:hi]
                if local.shape[0] == 0:
                    continue
                k = min(max(floor * 4, floor), local.shape[0])
                idx = np.argpartition(-local, k - 1)[:k]
                added = 0
                for j in idx[np.argsort(-local[idx])]:
                    flat = lo + int(j)
                    if allowed is not None and flat not in allowed:
                        continue
                    if flat not in present:
                        present.add(flat)
                        extras.append(flat)
                    added += 1
                    if added >= floor:
                        break
            # Ordered by similarity across ALL of them, with the code as a database-neutral
            # tie-break, then given the RRF scores the dense list would have had if it had run on.
            extras.sort(key=lambda i: (-dense[i], str(metas[i].get("code") or "")))
        if not self._settings.search_hybrid:
            return [
                {**metas[i], "database": owners[i], "dense": float(dense[i])}
                for i in [*dense_rank, *extras]
            ]

        # BM25 over the union. Selecting first and scoring afterwards would be wrong: `top()` with
        # LOCAL statistics can drop a document that the union ranks highly, and no later rescoring
        # brings it back. So every document is scored with the union's statistics, and only then
        # does the pool get cut.
        indices = [self._bm25_for(self._cache_key(name), index) for name, index, _, _ in bounds]
        idf, avgdl = union_stats(indices)
        bm25 = np.zeros(len(metas), dtype="float32")
        for bm, (_, _, lo, hi) in zip(indices, bounds, strict=True):
            bm25[lo:hi] = bm.scores_with(query, idf, avgdl)
        # Widen the lexical fetch when filtering, so filtered matches are not lost outside the pool.
        bm25_rank = best(bm25, pool if allowed is None else max(pool, 4000), positive=True)[:pool]

        fused = reciprocal_rank_fusion([dense_rank, bm25_rank])
        for offset, i in enumerate(extras):
            fused.setdefault(i, 1.0 / (RRF_K + len(dense_rank) + 1 + offset))
        return [
            {**metas[i], "database": owners[i], "dense": float(cosine[i]), "order": float(dense[i]), "fused": score}
            for i, score in fused.items()
        ]

    @staticmethod
    def _scaled_limit(entries, limit: int, limit_cap: int | None) -> int:
        """How many hits one answer carries when several databases are searched.

        `limit` is the value for ONE background database; ticking a second one lengthens the list
        rather than making both share the old one. That was the point of the per-database limit
        the merge used to apply, and it survives the move to a common ranking — measured before:
        with one shared limit of 50, the pair returned 49 ecoinvent hits and a single library one,
        so a box that was meant to add something took a slot away instead.

        Two things it deliberately does NOT do. The user's own library never lengthens the list —
        it is always small, and its visibility is the reserve's job, not the limit's. And the
        growth is capped by the caller, because the model path pays for every row in context:
        the search panel scales to 150, a single model query to 40, a batched one to 16.
        """
        from prism_lca.engine.library import is_library

        # Everything but the user's own library counts. Deliberately not "everything registered as
        # a background": an import that was never flagged is still a big inventory competing for
        # the same slots, and treating it as weightless would silently shorten the list.
        scaling = sum(1 for name, _ in entries if not is_library(name) and name != "biosphere3")
        total = int(limit) * max(1, scaling)
        if limit_cap:
            total = min(total, int(limit_cap))
        return max(1, min(max(total, int(limit)), MAX_HITS))

    @staticmethod
    def _ensure_each_database(ranked, candidates, entries, reserve: int) -> list[dict]:
        """Give back what the cut to `rank_limit` took from a database that has too little.

        Feeding each database's best rows into the candidate pool is not enough on its own: the
        ranker still cuts the ordered list to `rank_limit` before anything is collapsed, and a
        library whose single hit ranks 501st is gone by then. Then the reserve has nothing left to
        reserve and the answer cannot distinguish "nothing came from my library" from "my library
        has nothing" — which is the whole reason the reserve exists.

        Appended at the END, ordered by similarity: this decides WHICH rows survive the cut, never
        where they sit. A row that earned no rank stays at the bottom, where it reads as what it is.
        """
        if reserve <= 0:
            return ranked
        have: dict[str, int] = {}
        seen: set[tuple[str, object]] = set()
        for h in ranked:
            name = str(h.get("database") or "")
            have[name] = have.get(name, 0) + 1
            seen.add((name, h.get("code")))
        tail: list[dict] = []
        for name, _ in entries:
            missing = reserve - have.get(name, 0)
            if missing <= 0:
                continue
            own = sorted(
                (c for c in candidates if str(c.get("database") or "") == name),
                key=lambda c: -float(c.get("order", c.get("dense", 0.0))),
            )
            for candidate in own:
                if missing <= 0:
                    break
                if (name, candidate.get("code")) in seen:
                    continue
                candidate.setdefault("score", float(candidate.get("dense", 0.0)))
                tail.append(candidate)
                seen.add((name, candidate.get("code")))
                missing -= 1
        return [*ranked, *tail]

    @staticmethod
    def _reserve_size(reserve: int, total: int, databases: int) -> int:
        """Slots guaranteed to each searched database — clamped so the reserves can never fill the
        whole answer. Zero for a single database, where there is nothing to reserve against."""
        if databases < 2:
            return 0
        return max(1, min(int(reserve), total // databases))

    @staticmethod
    def _apply_reserve(groups: list[dict], total: int, reserve: int) -> list[dict]:
        """Cut to `total`, but not before every database has had its reserved slots.

        Without this a common ranking answers "nothing from my library" and "my library has
        nothing" with the same empty result, and the user who ticked the box cannot tell which.
        Three rows are enough to tell them apart: three unrelated ones say the database has
        nothing, three near misses say look closer. One row would only ever be an outlier.

        The reserve decides WHICH hits are carried, never in which order — the list stays in the
        common ranking, so a reserved hit that earned no rank sits at the bottom, where it reads
        as what it is.
        """
        if reserve <= 0:
            return groups[:total]
        chosen: set[int] = set()
        per_db: dict[str, int] = {}
        for i, g in enumerate(groups):
            db = str(g.get("database") or "")
            if per_db.get(db, 0) < reserve:
                per_db[db] = per_db.get(db, 0) + 1
                chosen.add(i)
        for i in range(len(groups)):
            if len(chosen) >= total:
                break
            chosen.add(i)
        keep = sorted(chosen)[:total]
        # Which of them are here on the reserve's ticket rather than by rank. The caller needs to
        # know: for a person they are rows at the bottom, but the assistant's answer is cut to fit
        # a context budget from the END of the list, so these — the ones that exist precisely to be
        # seen — would be the first to go. Marked, they can be carried somewhere the cut cannot
        # reach (see `also_present` in the search tool).
        earned = set(range(min(total, len(groups))))
        for i in keep:
            if i not in earned:
                groups[i]["reserved"] = True
        return [groups[i] for i in keep]

    def geographies(self, db_name: str) -> list[str]:
        """Distinct locations in the index, for the region filter's autocomplete."""
        index = self._require_index(db_name)
        return sorted({(m.get("geo") or "") for m in index.meta} - {""})

    def _variants_map(self, index: VectorIndex, db_name: str) -> dict[tuple, list[dict]]:
        """Map (name, product, type) → ALL of that activity's geo-variants in the database.

        Built from the full index (not just the ranked pool), so a collapsed result lists every
        region the activity exists in — not only the handful that scored into the top results."""
        cached = getattr(index, "_prism_variants", None)
        if cached is not None:
            return cached
        m: dict[tuple, list[dict]] = {}
        for e in index.meta:
            key = (e.get("name"), e.get("product"), e.get("atype"))
            m.setdefault(key, []).append(
                {
                    "code": e.get("code"),
                    "geography": e.get("geo"),
                    "database": e.get("database", db_name),
                }
            )
        try:
            index._prism_variants = m  # memoise on the index (replaced on reindex)
        except Exception as exc:  # pragma: no cover - slotted index → recompute next time
            _log.swallowed(exc, "_variants_map")
        return m

    @staticmethod
    def _order_variants(variants: list[dict], rep_code, target_geo: str | None) -> list[dict]:
        """Representative first, then the regions most likely to be usable as a proxy.

        With a target region that is the ranking's own proxy chain (:func:`geo_rank`): the region
        itself, then the European aggregates for a European target, then GLO and RoW. Without one
        it is :data:`DEFAULT_VARIANT_ORDER`. Everything else follows alphabetically, so the same
        search twice gives the same list.
        """
        def key(v: dict) -> tuple:
            geo = v.get("geography") or ""
            if v.get("code") == rep_code:
                return (0, 0, "")
            if target_geo:
                return (1, geo_rank(geo, target_geo), geo)
            if geo in DEFAULT_VARIANT_ORDER:
                return (1, DEFAULT_VARIANT_ORDER.index(geo), geo)
            return (1, len(DEFAULT_VARIANT_ORDER), geo)

        return sorted(variants, key=key)

    def _collapse_geo(
        self, ranked: list[dict], indices: dict[str, VectorIndex], limit: int,
        geos: set | None = None, variants_cap: int | None = None,
        target_geo: str | None = None,
    ) -> list[dict]:
        """Collapse geo-variants of the same activity into one result carrying its geographies, so
        the list isn't flooded with one process repeated per region. The best-ranked variant is the
        representative; ``limit`` groups kept.

        The group key carries the DATABASE. Two databases can hold an activity of the same name and
        reference product — ecoinvent and BAFU both have electricity markets — and they are not the
        same dataset: collapsing them together would produce one hit whose listed regions came from
        two different inventories, and picking one of those regions would silently cross databases.

        The list is **capped**, and that cap is the point. ecoinvent's electricity markets exist in
        175 regions; unrolled inline, a single hit for "market for electricity, medium voltage"
        weighs 17,846 characters — more than an eight-query batch's whole budget, so the rest of the
        answer is truncated away before the second hit begins. That is what happened on a
        real run, and the assistant then mis-transcribed a 32-character code out of the wall
        of them (V235). A filtered request still gets every variant it asked for: the cap applies to
        what nobody narrowed. ``variants_total`` says what was left out, so a caller that needs the
        rest knows there is a rest to ask for.
        """
        # The cap protects the assistant's context (see above). The search panel is read by a person
        # who picks one region from a list, so it asks for the whole list (`variants_cap=0`): with the
        # cap, "market for electricity, medium voltage" offered 12 of its 175 regions and Germany was
        # not among them (V347).
        cap = VARIANTS_SHOWN if variants_cap is None else max(0, int(variants_cap))
        groups: dict[tuple, dict] = {}
        order: list[tuple] = []
        for h in ranked:
            db_name = str(h.get("database") or "")
            key = (db_name, h.get("name"), h.get("product"), h.get("atype"))
            if key in groups:
                continue
            index = indices.get(db_name)
            vmap = self._variants_map(index, db_name) if index is not None else {}
            variants = vmap.get((h.get("name"), h.get("product"), h.get("atype"))) or [
                {"code": h.get("code"), "geography": h.get("geo"), "database": db_name}
            ]
            if geos:  # a region filter narrows the offered variants to the chosen regions
                variants = [v for v in variants if v.get("geography") in geos]
            total = len(variants)
            if not geos:
                variants = self._order_variants(variants, h.get("code"), target_geo)
                if cap and total > cap:
                    variants = variants[:cap]
            groups[key] = {**h, "variants": variants, "variants_total": total}
            order.append(key)
        return [groups[k] for k in order[:limit]]

    def _open_indexes(self, wanted: list[str], provider) -> tuple[list[tuple[str, VectorIndex]], list[str]]:
        """The indexes of the selected databases a search can use, and the databases skipped for having
        none. A database that cannot answer is skipped rather than failing the search; none at all is an
        error, and indexes built by different models cannot share one ranking."""
        entries: list[tuple[str, VectorIndex]] = []
        skipped: list[str] = []
        for name in wanted:
            try:
                index = self._require_index(name)
            except PrismError as exc:
                if exc.code in ("not_indexed", "database_not_found"):
                    skipped.append(name)
                    continue
                raise
            self._check_index(index, provider, name)
            entries.append((name, index))
        if not entries:
            raise PrismError(
                "None of the selected databases has a search index yet.",
                code="not_indexed",
                status_code=409,
                hint="Build one in the search panel (Index).",
            )
        self._check_comparable(entries)
        return entries, skipped

    def search_many(
        self,
        query: str,
        db_names: list[str],
        *,
        activity_types: list[str] | None = None,
        geographies: list[str] | None = None,
        collapse_geo: bool = True,
        limit: int = 50,
        variants_cap: int | None = None,
        limit_cap: int | None = None,
        reserve: int = 3,
        literal: bool = False,
    ) -> dict:
        """One query, several databases, ONE ranked list.

        An abbreviation in the query ("PET", "rPET", "HDPE-Granulat") is also searched spelled out the
        way the background databases name the material, and the two variants are fused (see
        `_fused_candidates`); the answer then carries ``searched_as``. ``literal=True`` searches only the
        text as typed — the "Search only for …" link in the panel and ``literal`` in the assistant's tool.

        Which databases a search covers is a choice the user makes with checkboxes — their own
        library belongs beside ecoinvent when they are looking for something to put on a canvas.

        Each database used to be searched on its own and the lists were merged by rank.
        That merge is gone; see `_union_candidates` for why it could not work. The databases are now
        one ranking space: same model, same query vector, BM25 over the union's statistics. Nothing
        gets a top slot for being ticked — it gets one for matching.

        What survives from the old design is its intent, in two separate mechanisms:
        `_scaled_limit` keeps the list from getting shorter when a second background is ticked, and
        `_apply_reserve` keeps a small database visible. A database that cannot answer (no index
        yet) is skipped rather than failing the search: the point of ticking two boxes is to get
        what there is.
        """
        if not (query or "").strip():
            raise PrismError("Query must not be empty.", code="empty_query",
                             hint="Provide a search term.")
        wanted = [n for n in dict.fromkeys(db_names) if n]
        if not wanted:
            raise PrismError("No database selected.", code="no_database",
                             hint="Tick at least one database to search in.")

        provider = self._provider_()
        entries, skipped = self._open_indexes(wanted, provider)

        expansion, named = (None, False) if literal else self._variants.for_query(query, entries)
        intent = None if literal else transport_intent(query)  # "freight by truck": lorries up, ships down
        vecs = provider.embed([query, expansion.text] if expansion else [query], is_query=True)
        qvec = vecs[0]
        variant = None
        if expansion:
            w_raw, w_exp = ((abbrev.RAW_WEIGHT_NAMED, abbrev.EXPANSION_WEIGHT_NAMED) if named
                            else (abbrev.RAW_WEIGHT, abbrev.EXPANSION_WEIGHT))
            variant = (expansion.text, vecs[1], w_raw, w_exp)
        for name, index in entries:
            if qvec.shape[0] != index.dim:
                raise PrismError(
                    f"Search index for '{name}' was built with a different embedding backend.",
                    code="embedding_mismatch",
                    status_code=409,
                    hint="Rebuild the index (POST /api/v1/search/index) after changing the backend.",
                )

        types = set(activity_types) if activity_types else None
        # Geography semantics (matches the documented ranking behaviour): ONE selected region
        # is a ranking signal — exact matches first, then the proxy chain (RER/GLO/RoW) as
        # fallbacks. SEVERAL selected regions are an explicit multi-select hard filter.
        geos = set(geographies) if geographies and len(geographies) > 1 else None
        target_geo = geographies[0] if geographies and len(geographies) == 1 else None

        indices = {name: index for name, index in entries}
        total = self._scaled_limit(entries, limit, limit_cap)
        reserve_n = self._reserve_size(reserve, total, len(entries))

        # When collapsing geo-variants, rank a bigger pool so enough distinct activities remain —
        # and grow it until they do. A fixed pool was measured wrong on the real thing:
        # "electricity" against ecoinvent returned 6 activities out of 344, because the six electricity
        # markets alone are 6 x 175 regions = 1 050 rows and the pool held 400 ranked rows of them
        # before a single wind or nuclear dataset could appear. The pool quadruples until `total`
        # distinct activities are in it — and until every database has enough for its reserve — or
        # the whole corpus is. The growth runs over the UNION now, not per database: a pool per
        # database is what let ecoinvent's regionalised markets crowd out its own technologies.
        rank_limit = max(total * 8, 120) if collapse_geo else total
        pool = max(rank_limit * 3, 60)
        corpus = sum(len(index.meta) for _, index in entries)
        while True:
            candidates = self._fused_candidates(query, qvec, variant, entries, types, geos, pool,
                                                floor=reserve_n)
            if intent:
                adjust_transport_modes(intent, candidates)
            if self._settings.search_hybrid:
                ranked, _ = finalize_hybrid(candidates, target_geo=target_geo, types=types,
                                            geos=geos, limit=rank_limit)
                for h in ranked:
                    h["score"] = h.get("dense", 0.0)
            else:
                raw = [(c.get("dense", 0.0), c) for c in candidates]
                ranked, _ = rank(raw, target_geo=target_geo, types=types, geos=geos,
                                 limit=rank_limit)
            ensured = self._ensure_each_database(ranked, candidates, entries, reserve_n)
            # The reserve is appended BEHIND the cut list; the collapse below cuts to the same limit
            # again and took exactly those rows off when the front held enough distinct groups —
            # the small database vanished after being reserved for. The limit
            # grows by what was appended.
            reserved = len(ensured) - len(ranked)
            ranked = ensured
            groups = (
                self._collapse_geo(ranked, indices, rank_limit + reserved, geos, variants_cap, target_geo)
                if collapse_geo else ranked
            )
            seen = {str(g.get("database") or "") for g in groups}
            per_db_count: dict[str, int] = {}
            for g in groups:
                key = str(g.get("database") or "")
                per_db_count[key] = per_db_count.get(key, 0) + 1
            enough = len(groups) >= total and all(
                per_db_count.get(name, 0) >= reserve_n for name, _ in entries
                if name in seen or reserve_n == 0
            )
            # A pool covering the corpus does NOT mean every group has been seen: `rank_limit` can
            # still be far smaller, and one activity with 200 regions fills it on its own. The
            # honest exhaustion signal is the ranker returning less than it was asked for; the
            # corpus test only ends the growth once the ranked window could hold everything too.
            exhausted = len(ranked) < rank_limit or (pool >= corpus and rank_limit >= corpus)
            if enough or exhausted:
                break
            rank_limit *= 4
            pool = min(pool * 4, corpus)

        ranked = self._apply_reserve(groups, total, reserve_n)
        if found := self._identifiers.find(query, entries, types, geos):
            collapse = lambda rows: self._collapse_geo(rows, indices, len(rows), geos, variants_cap,  # noqa: E731
                                                       target_geo) if collapse_geo else rows
            ranked = found.pin(ranked, collapse, target_geo, reserve_n)

        facets = {"P": 0, "M": 0, "G": 0}
        for hit in ranked:
            facets[hit.get("atype", "P")] = facets.get(hit.get("atype", "P"), 0) + 1

        hits = [
            {
                "code": h.get("code"),
                "name": h.get("name"),
                "geography": h.get("geo"),
                "product": h.get("product"),
                "unit": h.get("unit"),
                "activity_type": h.get("atype"),
                "score": round(float(h.get("score", 0.0)), 4),
                # Per hit, against the same threshold `weak_match` uses for the whole list. Because
                # that flag is an ANY, one adjacent hit clearing the bar labels the entire result set
                # "strong": a search for "polyisobutylene" presented *straw production* (0.36) and
                # *grass production* (0.43) as unmarked rows under a strong-match header. Decided on
                # the UNROUNDED score — rounding is for display, and a hit at 0.42896 is weak.
                "weak": float(h.get("score", 0.0)) < WEAK_TRIGGER,
                "database": h.get("database"),
                # Only when true: a key that is false on nearly every row is pure payload.
                **({"reserved": True} if h.get("reserved") else {}),
                "variants": h.get("variants"),  # geo-variants of this activity (collapsed, capped)
                # How many there are in total. The list above is cut at VARIANTS_SHOWN when nothing
                # narrowed the request, and a caller cannot tell a short list from a cut one (V235).
                "variants_total": h.get("variants_total"),
            }
            for h in ranked
        ]

        # Said per database, because the merged list can no longer be asked these questions on
        # behalf of all of them: one good ecoinvent hit carrying the query's word silences the
        # word-level warnings for every other database's rows.
        anchors = expansion.anchors if expansion else None
        recyclates = expansion.recyclates if expansion else None
        checked = abbrev.honesty_query(found.rest if found else query, recyclates)
        per_database: list[dict] = []
        for name, _ in entries:
            own = [h for h in hits if h.get("database") == name]
            texts = abbrev.with_aliases([
                abbrev.honesty_query(f"{h.get('name') or ''} {h.get('product') or ''} {h.get('geography') or ''}",
                                     recyclates)
                for h in own
            ], anchors)
            covered, n_terms = best_hit_coverage(checked, texts)
            block = {
                "database": name,
                "hits": len(own),
                "weak_match": not any(not h.get("weak") for h in own),
            }
            if n_terms:
                block["best_match_words"] = f"{covered} of {n_terms}"
            per_database.append(block)
        for name in skipped:
            per_database.append({"database": name, "hits": 0, "not_indexed": True})

        outside = []
        # What the list shows, by (name, product): a collapsed hit stands for all its geo-variants,
        # listed or cut (variants_total says so), so a code comparison would misreport a cut variant.
        shown = {(_fold(h.get("name")), _fold(h.get("product"))) for h in hits}
        for name, index in entries:
            note = self._exact_name_outside(query, index, geos, name, shown)
            if note:
                outside.append(note)

        # Over the hits the caller can actually see — see ranking._weak. Read off the per-hit
        # flags, which were decided on the UNROUNDED score: taking `hits[*].score` instead would
        # let a 0.42896 round up to 0.429 and report a strong list whose only row says "weak".
        weak = all(bool(h["weak"]) for h in hits) if hits else True
        out = self._respond(query, ", ".join(name for name, _ in entries), hits, weak, facets,
                            outside_filter=" ".join(outside) or None,
                            per_database=per_database, aliases=anchors, recyclates=recyclates,
                            honest=found.rest if found else None)
        if found:  # the number is what tells two such searches apart; the signature keeps no digits
            out["content_terms"] = sorted({*out["content_terms"], *found.numbers})
        if expansion:
            # What was searched besides the text as typed — shown in the panel and to the assistant,
            # so a wrong reading ("pet food" → polyethylene terephthalate) is visible and can be undone
            # with literal=True.
            out["searched_as"] = {"query": expansion.text, "replaced": expansion.aliases}
        out["databases"] = [name for name, _ in entries]
        if skipped:
            out["databases_not_indexed"] = skipped
        return out

    def search(self, query: str, db_name: str, **kw) -> dict:
        """One database. The same path as :meth:`search_many` with a single member, so a single
        database and a set of them cannot drift apart in what they rank or what they admit."""
        return self.search_many(query, [db_name], **kw)

    @staticmethod
    def _exact_name_outside(
        query: str, index: VectorIndex, geos: set | None, db_name: str, shown: set | None = None,
    ) -> str | None:
        """Datasets the query NAMES exactly that the answer does not show.

        Two ways to miss one: a multi-select geography filter (`geos`) excludes its regions, or — with
        one region as a ranking signal, or none — the neighbours of the preferred region outrank it
        and the limit cuts it. Exact on the folded name or reference product (with or without the
        market prefix), deliberately not fuzzy: "tap water", "steel, chromium steel 18/8" and
        "wastewater, average" each named a market exactly and came back without it and without a
        word (an MCP session). Linear over the index metadata — 26 000 rows is a
        millisecond."""
        wanted = _fold(query)
        if not wanted:
            return None

        # The datasets a query NAMES: the activity called exactly that, or the market (group) for a
        # product called exactly that. Not every dataset that merely PRODUCES the product — forty
        # "tap water production, …" variants are neighbours, not the thing asked for, and a note
        # about them would fire on every product-word search.
        canonical = {wanted, f"market for {wanted}", f"market group for {wanted}"}
        elsewhere: dict[str, int] = {}
        for m in index.meta:
            name = _fold(m.get("name"))
            if name not in canonical:
                continue
            geo = m.get("geo") or ""
            if geos:
                if geo in geos:
                    continue
            elif shown is not None and (name, _fold(m.get("product"))) in shown:
                continue
            elsewhere[geo] = elsewhere.get(geo, 0) + 1
        if not elsewhere:
            return None
        n = sum(elsewhere.values())
        geo_names = sorted(g for g in elsewhere if g)
        where = ", ".join(geo_names[:8]) + (f" … ({len(geo_names)} regions)" if len(geo_names) > 8 else "")
        if not geos:
            return (
                f"{n} dataset{'s' if n != 1 else ''} named exactly '{query.strip()}' (or its market) "
                f"exist{'s' if n == 1 else ''} in {db_name} ({where}) but {'is' if n == 1 else 'are'} not in this "
                "list — outranked by the region preference or cut by the limit. If that is the dataset you meant, "
                "search its exact name with activity_types=\"M\" or a larger limit, or pass its region in geographies."
            )
        return (
            f"{n} dataset{'s' if n != 1 else ''} named exactly '{query.strip()}' exist{'s' if n == 1 else ''} in "
            f"{db_name} outside the requested geographies ({', '.join(sorted(geos))}): {where}. The filter "
            "hid them. If that is the dataset you meant, search again with one of those locations or "
            "without geographies, and record the geography proxy in the exchange comment."
        )
