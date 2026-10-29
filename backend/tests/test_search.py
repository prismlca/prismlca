from __future__ import annotations

import time
import uuid

from prism_lca.engine.bootstrap import get_bd
from prism_lca.search.service import SearchService


def _seed(bd, name: str) -> None:
    def act(code, nm, prod, loc, unit):
        return {
            "name": nm,
            "reference product": prod,
            "location": loc,
            "unit": unit,
            "exchanges": [{"input": (name, code), "amount": 1.0, "type": "production"}],
        }

    bd.Database(name).write(
        {
            (name, "elec_de"): act("elec_de", "electricity, low voltage",
                                   "electricity, low voltage", "DE", "kWh"),
            (name, "elec_market"): act("elec_market", "market for electricity, low voltage",
                                       "electricity, low voltage", "GLO", "kWh"),
            (name, "elec_group"): act("elec_group", "market group for electricity, low voltage",
                                      "electricity, low voltage", "RER", "kWh"),
            (name, "pet"): act("pet", "polyethylene terephthalate production",
                               "polyethylene terephthalate, granulate", "RER", "kg"),
        }
    )


def test_index_and_search(client, token, project):
    bd = get_bd()
    db = "syn-" + uuid.uuid4().hex[:6]
    _seed(bd, db)

    r = client.post("/api/v1/search/index", json={"database": db}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "done"
    assert r.json()["count"] == 4

    r = client.post(
        "/api/v1/search/activities",
        json={"query": "electricity", "database": db, "limit": 10},
        headers=token,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["count"] >= 3
    names = [h["name"].lower() for h in data["hits"]]
    # electricity activities rank at the top; the unrelated PET activity never outranks them
    # (with strong matches present the adaptive cutoff may drop PET entirely).
    assert "electricity" in names[0]
    assert not any("polyethylene" in n for n in names[:3])
    if any("polyethylene" in n for n in names):
        assert "polyethylene" in names[-1]
    # facet counts present
    assert set(data["facets"]) == {"P", "M", "G"}


def test_a_market_hit_carries_what_it_mixes(client, token, project):
    """A GLO market is an average, not a global dataset — and which technologies and regions it
    averages is what decides whether it fits a regional study. That decision is made while READING
    search results, so the composition belongs here rather than behind a per-candidate detail call:
    a real run took four GLO markets without ever looking, and checked only the one a reviewer
    pointed at."""
    bd = get_bd()
    db = "mix-" + uuid.uuid4().hex[:6]
    bd.Database(db).write(
        {
            (db, "syn"): {"name": "glycerine production, synthetic", "reference product": "glycerine",
                          "location": "RER", "unit": "kg",
                          "exchanges": [{"input": (db, "syn"), "amount": 1.0, "type": "production"}]},
            (db, "veg"): {"name": "esterification of rape oil", "reference product": "glycerine",
                          "location": "RER", "unit": "kg",
                          "exchanges": [{"input": (db, "veg"), "amount": 1.0, "type": "production"}]},
            (db, "lorry"): {"name": "market for transport, lorry", "reference product": "transport, lorry",
                            "location": "RER", "unit": "ton kilometer",
                            "exchanges": [{"input": (db, "lorry"), "amount": 1.0, "type": "production"}]},
            (db, "market"): {"name": "market for glycerine", "reference product": "glycerine",
                             "location": "RER", "unit": "kg",
                             "exchanges": [
                                 {"input": (db, "market"), "amount": 1.0, "type": "production"},
                                 {"input": (db, "veg"), "amount": 0.67, "type": "technosphere"},
                                 {"input": (db, "syn"), "amount": 0.33, "type": "technosphere"},
                                 # By share this beats the smaller feedstocks — and it is not a
                                 # supplier of glycerine at all. Only inputs of the market's own
                                 # product count as suppliers, so it stays out.
                                 {"input": (db, "lorry"), "amount": 0.17, "type": "technosphere"},
                             ]},
        }
    )
    client.post("/api/v1/search/index", json={"database": db}, headers=token)
    r = client.post(
        "/api/v1/search/activities",
        json={"query": "market for glycerine", "database": db, "limit": 10, "collapse_geo": False},
        headers=token,
    )
    assert r.status_code == 200, r.text
    market = next(h for h in r.json()["hits"] if h["code"] == "market")
    names = [s["name"] for s in market["suppliers"]]
    assert names == ["esterification of rape oil", "glycerine production, synthetic"]
    assert abs(market["suppliers"][0]["share"] - 0.67) < 1e-9
    assert not any("transport" in n for n in names)  # a different product, however large its share

    # A production dataset has no composition to show, so it carries none.
    assert "suppliers" not in next(h for h in r.json()["hits"] if h["code"] == "syn")


def test_index_info(client, token, project):
    bd = get_bd()
    db = "syn-" + uuid.uuid4().hex[:6]
    _seed(bd, db)

    # before indexing: exists check says no
    info = client.get(f"/api/v1/search/index-info?database={db}", headers=token).json()
    assert info == {"database": db, "indexed": False, "indexed_count": None,
                    "activities": 4, "stale": False, "building": False}

    client.post("/api/v1/search/index", json={"database": db}, headers=token)
    info = client.get(f"/api/v1/search/index-info?database={db}", headers=token).json()
    assert info["indexed"] is True and info["indexed_count"] == 4 and info["stale"] is False

    # adding an activity makes the index stale (count mismatch)
    node = bd.Database(db).new_node(code="steel", name="steel production", unit="kg")
    node.save()
    info = client.get(f"/api/v1/search/index-info?database={db}", headers=token).json()
    assert info["activities"] == 5 and info["stale"] is True

    # unknown database → 404
    assert client.get("/api/v1/search/index-info?database=nope", headers=token).status_code == 404


def test_search_type_filter(client, token, project):
    bd = get_bd()
    db = "syn-" + uuid.uuid4().hex[:6]
    _seed(bd, db)
    client.post("/api/v1/search/index", json={"database": db}, headers=token)

    r = client.post(
        "/api/v1/search/activities",
        json={"query": "electricity", "database": db, "activity_types": ["M"]},
        headers=token,
    )
    assert r.status_code == 200
    hits = r.json()["hits"]
    assert hits
    assert all(h["activity_type"] == "M" for h in hits)


def test_search_requires_index(client, token, project):
    r = client.post(
        "/api/v1/search/activities",
        json={"query": "steel", "database": "never-indexed"},
        headers=token,
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "not_indexed"


def test_invalid_activity_type_rejected(client, token, project):
    r = client.post(
        "/api/v1/search/activities",
        json={"query": "steel", "database": "x", "activity_types": ["Z"]},
        headers=token,
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "invalid_activity_type"


def test_single_geo_is_ranking_signal_not_hard_filter(client, token, project):
    """One selected region ranks exact matches first but KEEPS proxy fallbacks (GLO/RoW/RER)
    — it must not hard-filter them away (P19). Multiple regions stay a hard filter."""
    bd = get_bd()
    db = "syn-" + uuid.uuid4().hex[:6]
    _seed(bd, db)
    client.post("/api/v1/search/index", json={"database": db}, headers=token)

    # Single region DE: the DE dataset ranks first, but GLO/RER variants still appear.
    r = client.post(
        "/api/v1/search/activities",
        json={"query": "electricity", "database": db, "geographies": ["DE"],
              "collapse_geo": False, "limit": 10},
        headers=token,
    )
    hits = r.json()["hits"]
    geos = [h["geography"] for h in hits if "electricity" in h["name"].lower()]
    assert geos[0] == "DE"
    assert any(g in ("GLO", "RER") for g in geos[1:])  # proxies survive

    # Two regions: explicit multi-select = hard filter.
    r = client.post(
        "/api/v1/search/activities",
        json={"query": "electricity", "database": db, "geographies": ["DE", "GLO"],
              "collapse_geo": False, "limit": 10},
        headers=token,
    )
    assert {h["geography"] for h in r.json()["hits"]} <= {"DE", "GLO"}


def test_provider_mismatch_rejected(client, token, project):
    """An index built with another embedding backend must 409 even when dims match (P17)."""
    bd = get_bd()
    db = "syn-" + uuid.uuid4().hex[:6]
    _seed(bd, db)
    client.post("/api/v1/search/index", json={"database": db}, headers=token)

    svc = client.app.state.search
    index = svc._require_index(db)
    index.provider = "sentence-transformers"  # simulate a backend switch, same dim
    r = client.post(
        "/api/v1/search/activities",
        json={"query": "electricity", "database": db},
        headers=token,
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "embedding_mismatch"


def test_geo_chain_not_eurocentric():
    from prism_lca.search.ranking import geo_chain

    assert geo_chain("DE") == ["DE", "RER", "Europe without Switzerland", "GLO", "RoW"]
    assert geo_chain("CN") == ["CN", "GLO", "RoW"]  # no European proxies for non-European targets


# --- V235: the geo-variant list is capped when nothing narrowed the request ---------------------


def test_a_wide_geo_variant_list_is_capped_and_says_how_many_there_are(client, token, project):
    """ecoinvent's electricity markets exist in 175 regions. Unrolled inline, one hit outweighed a
    whole eight-query batch's budget and the rest of the answer was truncated away."""
    from prism_lca.search.service import VARIANTS_SHOWN

    bd = get_bd()
    db = "syn-" + uuid.uuid4().hex[:6]
    regions = [f"R{i:03d}" for i in range(40)]
    bd.Database(db).write(
        {
            (db, f"elec_{geo}"): {
                "name": "market for electricity, medium voltage",
                "reference product": "electricity, medium voltage",
                "location": geo,
                "unit": "kWh",
                "exchanges": [{"input": (db, f"elec_{geo}"), "amount": 1.0, "type": "production"}],
            }
            for geo in regions
        }
    )
    client.post("/api/v1/search/index", json={"database": db}, headers=token)

    wide = client.post(
        "/api/v1/search/activities",
        json={"query": "electricity medium voltage", "database": db, "limit": 3},
        headers=token,
    ).json()["hits"]
    assert wide, "the seeded market should be found"
    hit = wide[0]
    assert hit["variants_total"] == len(regions)
    assert len(hit["variants"]) == VARIANTS_SHOWN
    # The ranked hit itself has to survive the cut — it is the one the caller is looking at.
    assert hit["code"] in {v["code"] for v in hit["variants"]}

    # A narrowed request is not capped: it already asked for exactly what it wants.
    narrow = client.post(
        "/api/v1/search/activities",
        json={"query": "electricity medium voltage", "database": db,
              "geographies": regions[:20], "limit": 3},
        headers=token,
    ).json()["hits"]
    assert len(narrow[0]["variants"]) == 20
    assert narrow[0]["variants_total"] == 20

    # The search panel asks for the whole list: a person picks one region from it, and with the cap
    # the list said "12 regions" for a market that exists in 175 — Germany not among them (V347).
    whole = client.post(
        "/api/v1/search/activities",
        json={"query": "electricity medium voltage", "database": db, "limit": 3, "variants_cap": 0},
        headers=token,
    ).json()["hits"]
    assert len(whole[0]["variants"]) == len(regions)
    some = client.post(
        "/api/v1/search/activities",
        json={"query": "electricity medium voltage", "database": db, "limit": 3, "variants_cap": 5},
        headers=token,
    ).json()["hits"]
    assert len(some[0]["variants"]) == 5


def test_an_index_grows_and_shrinks_without_being_rebuilt(client, token, project):
    """The library gets datasets a delivery at a time, and loses them an import at a time.

    Both used to mean "throw the index away": a full rebuild re-embeds everything that never
    changed, and until somebody presses the button the datasets just imported are exactly the ones
    the search cannot find. `extend` and `forget` are what make the index keep up on its own.
    """
    bd = get_bd()
    db = "syn-" + uuid.uuid4().hex[:6]
    _seed(bd, db)
    search = client.app.state.search
    client.post("/api/v1/search/index", json={"database": db}, headers=token)

    database = bd.Database(db)
    added = database.new_activity(
        code="steam", name="steam production, in chemical industry",
        **{"reference product": "steam"}, location="RER", unit="kg", type="process",
    )
    added.save()

    assert search.extend(db, ["steam"])["added"] == 1
    hits = client.post(
        "/api/v1/search/activities", json={"query": "steam", "database": db, "limit": 5}, headers=token
    ).json()["hits"]
    assert any(h["code"] == "steam" for h in hits)
    # …and the four that were already there were not re-embedded, they are simply still in.
    assert search.index_info(db)["indexed_count"] == 5

    # Asking twice is not asking twice: an activity already in the index is skipped, or a re-import
    # would double every dataset it touches.
    assert search.extend(db, ["steam"])["added"] == 0

    assert search.forget(db, ["steam"])["removed"] == 1
    assert search.index_info(db)["indexed_count"] == 4
    after = client.post(
        "/api/v1/search/activities", json={"query": "steam", "database": db, "limit": 5}, headers=token
    ).json()["hits"]
    assert not any(h["code"] == "steam" for h in after)


def test_extending_an_unindexed_database_does_nothing(client, token, project):
    """Building the first index from inside an import would turn a delivery into a long job nobody
    asked for. Nothing to extend means nothing happens, and the search panel offers the build."""
    bd = get_bd()
    db = "syn-" + uuid.uuid4().hex[:6]
    _seed(bd, db)
    result = client.app.state.search.extend(db, ["pet"])
    assert result == {"database": db, "added": 0, "indexed": False}


def _one(bd, name: str, code: str, nm: str, prod: str, loc: str = "GLO", unit: str = "kg") -> None:
    bd.Database(name).write(
        {
            (name, code): {
                "name": nm, "reference product": prod, "location": loc, "unit": unit,
                "exchanges": [{"input": (name, code), "amount": 1.0, "type": "production"}],
            }
        }
    )


def test_searching_two_databases_at_once(client, token, project):
    """Your own library belongs beside ecoinvent when you are looking for something to put on a
    canvas — and the two are ranked as ONE list, not woven together by turns."""
    bd = get_bd()
    background = "syn-" + uuid.uuid4().hex[:6]
    library = "My processes"
    _seed(bd, background)
    _one(bd, library, "own_elec", "electricity from our own roof",
         "electricity, low voltage", "DE", "kWh")
    for db in (background, library):
        client.post("/api/v1/search/index", json={"database": db}, headers=token)

    both = client.post(
        "/api/v1/search/activities",
        json={"query": "electricity", "databases": [background, library], "limit": 10},
        headers=token,
    ).json()

    assert both["databases"] == [background, library]
    assert any(h["database"] == library for h in both["hits"])
    # Every database says for itself how well it did — the merged list can no longer answer that
    # on behalf of all of them.
    assert {b["database"] for b in both["databases_searched"]} == {background, library}


def test_a_second_database_does_not_own_the_second_slot(client, token, project):
    """The bug this whole path was rewritten for.

    Merging by RRF over `(database, code)` could never see a document twice — the corpora are
    disjoint — so every hit scored 1/(60 + its own rank) and the merge became a strict round-robin:
    position 1 to the first database, position 2 to the second, whatever it held. Searching
    `grape` with three boxes ticked put two unrelated datasets directly under the right one.
    """
    bd = get_bd()
    background = "syn-" + uuid.uuid4().hex[:6]
    library = "My processes"
    bd.Database(background).write(
        {
            (background, "grape"): {
                "name": "grape production", "reference product": "grape", "location": "IT",
                "unit": "kg",
                "exchanges": [{"input": (background, "grape"), "amount": 1.0, "type": "production"}],
            },
            (background, "grape_market"): {
                "name": "market for grape", "reference product": "grape", "location": "GLO",
                "unit": "kg",
                "exchanges": [
                    {"input": (background, "grape_market"), "amount": 1.0, "type": "production"}
                ],
            },
            (background, "grape_ch"): {
                "name": "grape production, organic", "reference product": "grape",
                "location": "CH", "unit": "kg",
                "exchanges": [
                    {"input": (background, "grape_ch"), "amount": 1.0, "type": "production"}
                ],
            },
        }
    )
    _one(bd, library, "steel_part", "steel bracket, welded", "steel bracket")
    for db in (background, library):
        client.post("/api/v1/search/index", json={"database": db}, headers=token)

    hits = client.post(
        "/api/v1/search/activities",
        json={"query": "grape", "databases": [background, library], "limit": 10},
        headers=token,
    ).json()["hits"]

    assert [h["database"] for h in hits[:3]] == [background] * 3
    # Present, but at the bottom where its rank puts it — visible, not promoted.
    assert hits[-1]["database"] == library


def test_a_second_background_lengthens_the_list_but_the_library_does_not(client, token, project):
    """Two mechanisms, two questions.

    Scaling is about DEPTH: a second background competes for the same slots, so the list grows
    rather than making both share the old one — measured before, a shared limit of 50 returned 49
    ecoinvent hits and one library hit, so a box meant to add something took a slot away.
    The library never scales: it is always small, and its visibility is the reserve's job.
    """
    bd = get_bd()
    first = "syn-" + uuid.uuid4().hex[:6]
    second = "syn-" + uuid.uuid4().hex[:6]
    library = "My processes"
    _seed(bd, first)
    _seed(bd, second)
    _one(bd, library, "own_elec", "electricity from our own roof",
         "electricity, low voltage", "DE", "kWh")
    for db in (first, second, library):
        client.post("/api/v1/search/index", json={"database": db}, headers=token)

    def hits(payload):
        payload.setdefault("query", "electricity")
        payload.setdefault("limit", 2)
        return client.post("/api/v1/search/activities", json=payload, headers=token).json()["hits"]

    assert len(hits({"database": first})) == 2
    assert len(hits({"databases": [first, second]})) == 4          # two backgrounds -> twice as deep
    assert len(hits({"databases": [first, library]})) == 2         # the library does not lengthen it
    # …but it is still in there: that is the reserve, and it is what makes "nothing came from my
    # library" distinguishable from "my library has nothing".
    assert any(h["database"] == library for h in hits({"databases": [first, library]}))


def test_the_limit_never_grows_past_its_cap(client, token, project):
    """The model pays for every row in context, so the caller sets the ceiling: a batched query
    scales to 16, not to 8 x however many databases happen to be ticked."""
    bd = get_bd()
    first = "syn-" + uuid.uuid4().hex[:6]
    second = "syn-" + uuid.uuid4().hex[:6]
    _seed(bd, first)
    _seed(bd, second)
    for db in (first, second):
        client.post("/api/v1/search/index", json={"database": db}, headers=token)

    hits = client.post(
        "/api/v1/search/activities",
        json={"query": "electricity", "databases": [first, second], "limit": 3, "limit_cap": 4},
        headers=token,
    ).json()["hits"]
    assert len(hits) == 4  # 3 x 2 backgrounds = 6, capped at 4


def test_collapse_does_not_merge_the_same_name_across_databases(client, token, project):
    """Two inventories can hold an activity of the same name and product; they are not the same
    dataset. Collapsing them together would offer regions from two databases as one hit's
    variants, and picking one would silently cross inventories."""
    bd = get_bd()
    first = "syn-" + uuid.uuid4().hex[:6]
    second = "syn-" + uuid.uuid4().hex[:6]
    for db in (first, second):
        _one(bd, db, "elec", "market for electricity, low voltage",
             "electricity, low voltage", "GLO", "kWh")
        client.post("/api/v1/search/index", json={"database": db}, headers=token)

    hits = client.post(
        "/api/v1/search/activities",
        json={"query": "electricity", "databases": [first, second], "limit": 10},
        headers=token,
    ).json()["hits"]
    assert sorted(h["database"] for h in hits) == sorted([first, second])


def test_databases_indexed_with_different_models_are_refused(client, token, project):
    """A common ranking only means something if a similarity of 0.7 means the same in each
    database. Two models, two scales — and a confidently ordered list that shows none of it."""
    bd = get_bd()
    first = "syn-" + uuid.uuid4().hex[:6]
    second = "syn-" + uuid.uuid4().hex[:6]
    _seed(bd, first)
    _seed(bd, second)
    for db in (first, second):
        client.post("/api/v1/search/index", json={"database": db}, headers=token)

    search = client.app.state.search
    search._require_index(second).model = "some-other-model"
    r = client.post(
        "/api/v1/search/activities",
        json={"query": "electricity", "databases": [first, second], "limit": 5},
        headers=token,
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "embedding_mismatch"


def test_a_database_without_an_index_is_skipped_not_fatal(client, token, project):
    """Ticking two boxes is a request for what there is. Failing the whole search because one of
    them was never indexed would punish the user for the box they cannot see into."""
    bd = get_bd()
    background = "syn-" + uuid.uuid4().hex[:6]
    empty = "lib-" + uuid.uuid4().hex[:6]
    _seed(bd, background)
    bd.Database(empty).register()
    client.post("/api/v1/search/index", json={"database": background}, headers=token)

    r = client.post(
        "/api/v1/search/activities",
        json={"query": "electricity", "databases": [background, empty], "limit": 10},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert r.json()["count"] >= 1


def test_listing_a_database_needs_no_query_and_no_index(client, token, project):
    """"What have I actually got in there" has no search term, and a library whose contents can
    only be reached by inventing one stays unused. It also answers before the first index exists —
    it reads Brightway, not the index."""
    bd = get_bd()
    db = "syn-" + uuid.uuid4().hex[:6]
    _seed(bd, db)

    r = client.get(f"/api/v1/search/list?database={db}", headers=token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 4 and body["count"] == 4
    # Sorted by name, and in the shape a search result has, so the same list renders it.
    assert [h["name"] for h in body["hits"]] == sorted(h["name"] for h in body["hits"])
    first = body["hits"][0]
    assert {"code", "name", "geography", "product", "unit", "activity_type", "database"} <= set(first)

    # A cut list says so, rather than looking complete.
    short = client.get(f"/api/v1/search/list?database={db}&limit=2", headers=token).json()
    assert short["count"] == 2 and short["total"] == 4


def test_listing_an_unknown_database_says_so(client, token, project):
    r = client.get("/api/v1/search/list?database=nope", headers=token)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "database_not_found"


def test_a_hard_geography_filter_says_which_exact_name_matches_it_hid(client, token, project):
    """V333: three searches in a run named the generic wastewater dataset exactly and got
    industrial neighbours, because the dataset only exists in regions the multi-select filter excluded.
    The filter stays; the answer now names what it left out."""
    bd = get_bd()
    db = "syn-" + uuid.uuid4().hex[:6]
    _seed(bd, db)
    client.post("/api/v1/search/index", json={"database": db}, headers=token)

    def search(query: str, geographies: list[str]) -> dict:
        r = client.post(
            "/api/v1/search/activities",
            json={"query": query, "database": db, "geographies": geographies,
                  "collapse_geo": False, "limit": 10},
            headers=token,
        )
        assert r.status_code == 200, r.text
        return r.json()

    # The market exists in GLO only; DE + RER is a hard filter that drops it.
    body = search("market for electricity, low voltage", ["DE", "RER"])
    assert {h["geography"] for h in body["hits"]} <= {"DE", "RER"}
    note = body["outside_geography_filter"]
    assert "named exactly 'market for electricity, low voltage'" in note
    assert "GLO" in note and "DE, RER" in note

    # The reference PRODUCT names the dataset too — "tap water" is how a modeller asks for
    # "market for tap water" (four hidden markets, no note, because only the activity
    # name counted).
    note = search("electricity, low voltage", ["DE", "RER"])["outside_geography_filter"]
    assert "GLO" in note

    # No dataset carries this exact name anywhere — nothing to report, whatever the filter.
    assert "outside_geography_filter" not in search("electricity production", ["DE", "RER"])
    # One region is a ranking signal, not a filter — the GLO market is still in the list, so no note.
    assert "outside_geography_filter" not in search("market for electricity, low voltage", ["DE"])

    # …but a one-region preference plus a small limit can push the exact match OUT of the list, and
    # then the answer says so ("tap water" with DE came back as decarbonised water).
    r = client.post(
        "/api/v1/search/activities",
        json={"query": "market for electricity, low voltage", "database": db, "geographies": ["DE"],
              "collapse_geo": False, "limit": 1},
        headers=token,
    )
    body = r.json()
    if all(h["name"] != "market for electricity, low voltage" for h in body["hits"]):
        assert "not in this list" in body["outside_geography_filter"]
    else:  # the market itself made the one slot — nothing hidden, nothing said
        assert "outside_geography_filter" not in body


# --- the candidate pool grows until enough distinct activities are in it ---------------------------


def test_many_regions_of_one_activity_do_not_hide_the_other_activities(client, token, project):
    """Measured: "electricity" against ecoinvent returned 6 activities out of 344. The
    six electricity markets alone are 1 050 region rows, and the fixed candidate pool was full of
    them before a single wind or nuclear dataset could appear. Beside BAFU, whose electricity
    datasets are mostly single-region, that read as "50 BAFU hits, 6 ecoinvent" in the merged list.
    """
    bd = get_bd()
    db = "syn-" + uuid.uuid4().hex[:6]
    regions = [f"R{i:03d}" for i in range(150)]
    markets = ["low", "medium", "high"]
    singles = [
        "electricity production, wind, 1-3MW turbine, onshore",
        "electricity production, nuclear, pressure water reactor",
        "electricity production, hydro, run-of-river",
        "electricity production, photovoltaic, 570kWp open ground installation, multi-Si",
        "electricity production, hard coal",
        "electricity production, natural gas, combined cycle power plant",
    ]

    def act(code, name, product, geo):
        return {
            "name": name,
            "reference product": product,
            "location": geo,
            "unit": "kWh",
            "exchanges": [{"input": (db, code), "amount": 1.0, "type": "production"}],
        }

    data = {}
    for level in markets:
        for geo in regions:
            code = f"m_{level}_{geo}"
            data[(db, code)] = act(code, f"market for electricity, {level} voltage",
                                   f"electricity, {level} voltage", geo)
    for i, name in enumerate(singles):
        data[(db, f"s{i}")] = act(f"s{i}", name, "electricity, high voltage", "CH")
    bd.Database(db).write(data)
    client.post("/api/v1/search/index", json={"database": db}, headers=token)

    # 456 rows, 9 distinct activities. Asking for 9 must give 9 — the 450 market rows are three of
    # them, however many regions they come in.
    hits = client.post(
        "/api/v1/search/activities",
        json={"query": "electricity", "database": db, "limit": 9},
        headers=token,
    ).json()["hits"]
    names = {h["name"] for h in hits}
    assert len(hits) == 9, sorted(names)
    assert set(singles) <= names
    # Each market is one row carrying its regions, not 150 rows.
    market_rows = [h for h in hits if h["name"].startswith("market for")]
    assert len(market_rows) == 3
    assert all(h["variants_total"] == len(regions) for h in market_rows)

    # Without collapsing, `limit` counts rows — the pool does not grow and the order is untouched.
    flat = client.post(
        "/api/v1/search/activities",
        json={"query": "electricity", "database": db, "limit": 9, "collapse_geo": False},
        headers=token,
    ).json()["hits"]
    assert len(flat) == 9


def test_every_database_reaches_the_candidate_pool(client, token, project):
    """The reserve can only keep a database visible if that database has candidates at all.

    A tiny library beside a 26 533-row background can fall entirely below the global pool: its
    datasets simply do not rank. Then it contributes nothing, the reserve has nothing to reserve,
    and "nothing came from my library" is once again indistinguishable from "my library has
    nothing" — the one thing the reserve exists to tell apart. So each database's own best few are
    added to the pool whatever the global ranking says, at the bottom, where they belong.
    """
    bd = get_bd()
    background = "syn-" + uuid.uuid4().hex[:6]
    library = "My processes"
    _seed(bd, background)
    _one(bd, library, "steel_part", "steel bracket, welded", "steel bracket")
    for db in (background, library):
        client.post("/api/v1/search/index", json={"database": db}, headers=token)

    search = client.app.state.search
    entries = [(name, search._require_index(name)) for name in (background, library)]
    qvec = search._provider_().embed(["electricity"], is_query=True)[0]

    # A pool of one: without the floor, only the single best hit of the whole union survives.
    tight = search._union_candidates("electricity", qvec, entries, None, None, 1, floor=0)
    assert {c["database"] for c in tight} == {background}

    floored = search._union_candidates("electricity", qvec, entries, None, None, 1, floor=1)
    assert {c["database"] for c in floored} == {background, library}


def test_the_order_does_not_depend_on_which_box_was_ticked_first(client, token, project):
    """The disease this rewrite cured, in its subtlest form.

    The old merge ordered ties by the order the databases arrived in. Anything that reintroduces a
    per-database rank — an extra candidate appended in database order, for instance — brings it
    back for exactly the rows nothing else separates. The merged list must read the same whichever
    checkbox was clicked first.
    """
    bd = get_bd()
    background = "syn-" + uuid.uuid4().hex[:6]
    library = "My processes"
    _seed(bd, background)
    _one(bd, library, "own_elec", "electricity from our own roof",
         "electricity, low voltage", "DE", "kWh")
    for db in (background, library):
        client.post("/api/v1/search/index", json={"database": db}, headers=token)

    def order(dbs):
        hits = client.post(
            "/api/v1/search/activities",
            json={"query": "electricity", "databases": dbs, "limit": 10},
            headers=token,
        ).json()["hits"]
        return [(h["database"], h["code"]) for h in hits]

    assert order([background, library]) == order([library, background])


def test_a_database_cut_away_by_the_ranker_still_gets_its_reserve(client, token, project):
    """Feeding a database's best rows into the candidate pool is not enough on its own.

    The ranker cuts the ordered list before anything is collapsed, and a library whose only hit
    ranks five hundredth is gone by then — the reserve would have nothing left to reserve.
    """
    ranked = [{"database": "eco", "code": f"e{i}", "dense": 0.9} for i in range(5)]
    candidates = [*ranked, {"database": "lib", "code": "own", "dense": 0.1}]
    entries = [("eco", None), ("lib", None)]

    kept = SearchService._ensure_each_database(ranked, candidates, entries, reserve=2)
    assert [h["code"] for h in kept] == ["e0", "e1", "e2", "e3", "e4", "own"]
    assert kept[-1]["score"] == 0.1  # carries a score, like every other hit

    untouched = SearchService._ensure_each_database(ranked, candidates, entries, reserve=0)
    assert untouched is ranked  # a single database has nothing to reserve against


def test_variants_are_chosen_not_taken_in_index_order():
    """Three deliberate regions say more than twelve arbitrary ones.

    A capped variant list was the representative plus whatever order the index
    happened to hold — which is why "market for electricity, medium voltage" could show twelve of
    its 175 regions without Germany among them (V347). The order is now the proxy order a
    practitioner would try.
    """
    variants = [
        {"code": "c-pl", "geography": "PL"},
        {"code": "c-row", "geography": "RoW"},
        {"code": "c-de", "geography": "DE"},
        {"code": "c-glo", "geography": "GLO"},
        {"code": "c-at", "geography": "AT"},
        {"code": "c-rer", "geography": "RER"},
        {"code": "c-ewoch", "geography": "Europe without Switzerland"},
    ]
    # No region asked for: the global average first, then the European aggregates, the residual
    # last, and everything else alphabetically so the same search twice reads the same.
    order = SearchService._order_variants(variants, "c-de", None)
    assert [v["geography"] for v in order][:5] == [
        "DE", "GLO", "RER", "Europe without Switzerland", "RoW",
    ]
    assert [v["geography"] for v in order][5:] == ["AT", "PL"]

    # A region asked for: the ranking's own proxy chain decides.
    order = SearchService._order_variants(variants, "c-glo", "AT")
    assert [v["geography"] for v in order][:4] == ["GLO", "AT", "RER", "Europe without Switzerland"]


def test_a_hit_that_is_only_there_on_the_reserve_says_so(client, token, project):
    """The assistant's answer is cut from the END to fit its context budget, and the reserved rows
    live at the end. Marked, they can be carried somewhere the cut cannot reach."""
    bd = get_bd()
    background = "syn-" + uuid.uuid4().hex[:6]
    library = "My processes"
    _seed(bd, background)
    _one(bd, library, "steel_part", "steel bracket, welded", "steel bracket")
    for db in (background, library):
        client.post("/api/v1/search/index", json={"database": db}, headers=token)

    hits = client.post(
        "/api/v1/search/activities",
        json={"query": "electricity", "databases": [background, library], "limit": 2},
        headers=token,
    ).json()["hits"]

    own = [h for h in hits if h["database"] == library]
    assert own and all(h.get("reserved") for h in own)
    # The ones that earned their place carry no such flag — it is not a label for "from a small
    # database", it is a statement about how this row got here.
    assert not any(h.get("reserved") for h in hits if h["database"] == background)


def test_a_project_switch_warms_the_new_project_indexes(client, token, project):
    """A switch leaves every search cache a miss, because they are keyed `project/database`.

    `warm()` used to run once at app start and never again, so the first search after a
    switch paid what a cold start pays — the index, the BM25 corpus and the variant map (V341).
    """
    bd = get_bd()
    db = "syn-" + uuid.uuid4().hex[:6]
    _seed(bd, db)
    client.post("/api/v1/search/index", json={"database": db}, headers=token)
    svc = client.app.state.search

    # What a switch leaves behind, without leaving the project: building the index filled the
    # caches, and every one of them is keyed by the project this test is standing in.
    svc._cache.clear()
    svc._bm25_cache.clear()
    assert svc._cache_key(db) not in svc._cache

    client.post(f"/api/v1/projects/{project}/activate", headers=token)
    # The route warms on a thread; what matters is that it happens without a search being made.
    for _ in range(100):
        if svc._cache_key(db) in svc._cache:
            break
        time.sleep(0.05)
    key = svc._cache_key(db)
    assert key in svc._cache, "the switch left the index cold"
    assert key in svc._bm25_cache, "the switch left the BM25 corpus cold"
    assert hasattr(svc._cache[key], "_prism_variants"), "the switch left the variant map cold"


def test_two_warms_at_once_do_not_both_walk_the_databases(client, token, project):
    """The guard exists so a burst of switches cannot load the same files several times over."""
    svc = client.app.state.search
    svc._warming = True
    try:
        svc._warm_indexes()  # returns at once, does nothing — but remembers that a warm was asked for
        assert svc._warm_again
    finally:
        svc._warming = svc._warm_again = False


def test_a_warm_asked_for_while_one_runs_is_run_after_it(client, token, project, monkeypatch):
    """A warms, the user switches to B — B's warm returned at once because A ran, and A
    stopped on the switch. B stayed cold. Now B's request is kept and run when A ends."""
    import threading

    svc = client.app.state.search
    inside, release = threading.Event(), threading.Event()
    runs = []

    def once():
        runs.append(1)
        if len(runs) == 1:
            inside.set()
            release.wait(5)

    monkeypatch.setattr(svc, "_warm_once", once)
    first = threading.Thread(target=svc._warm_indexes)
    first.start()
    assert inside.wait(5)
    svc._warm_indexes()  # the switch's request, while the first still runs: returns at once…
    release.set()
    first.join(5)
    assert len(runs) == 2  # …and runs after it
    assert not svc._warming and not svc._warm_again
