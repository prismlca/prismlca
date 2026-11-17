from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd

METHOD = ["t", "gwp"]
H = None  # set per test via `token` fixture header


def _hdr(token):
    return token


# ---- tag groups CRUD ------------------------------------------------------
def test_tag_group_crud_and_cascade(client, token, project):
    fg = _fg(client, token)
    # create group + values
    assert client.post(
        "/api/v1/model/tag-groups", json={"database": fg, "name": "Component"}, headers=token
    ).status_code == 200
    for v in ("Production", "Distribution"):
        client.post(
            "/api/v1/model/tag-groups/values", json={"database": fg, "group": "Component", "value": v}, headers=token
        )
    groups = client.get(f"/api/v1/model/tag-groups?database={fg}", headers=token).json()["groups"]
    component = next(g for g in groups if g["name"] == "Component")
    assert component["values"] == ["Production", "Distribution"]
    assert component["color"]  # auto-assigned

    # assign a value to an activity, then removing that value cascades (untags it)
    a = _create(client, token, fg, "A")
    client.post(
        "/api/v1/model/tags/set",
        json={"keys": [{"database": fg, "code": a}], "group": "Component", "value": "Production"},
        headers=token,
    )
    assert client.get(f"/api/v1/model/tags/{fg}/{a}", headers=token).json() == [
        {"dimension": "Component", "value": "Production"}
    ]
    client.post(
        "/api/v1/model/tag-groups/values/remove",
        json={"database": fg, "group": "Component", "value": "Production"},
        headers=token,
    )
    assert client.get(f"/api/v1/model/tags/{fg}/{a}", headers=token).json() == []

    # deleting the group cascades too
    client.post(
        "/api/v1/model/tags/set",
        json={"keys": [{"database": fg, "code": a}], "group": "Component", "value": "Distribution"},
        headers=token,
    )
    client.post("/api/v1/model/tag-groups/delete", json={"database": fg, "name": "Component"}, headers=token)
    assert client.get(f"/api/v1/model/tags/{fg}/{a}", headers=token).json() == []


def _group(client, token, fg, name) -> dict:
    groups = client.get(f"/api/v1/model/tag-groups?database={fg}", headers=token).json()["groups"]
    return next(g for g in groups if g["name"] == name)


def test_tag_taxonomy_delete_is_undoable(client, token, project):
    """Deleting a value or a whole group cascades — and undo restores the taxonomy (colour,
    value order) AND every tag assignment. Audit marks notes vs. undoable commands."""
    fg = _fg(client, token)
    client.post("/api/v1/model/tag-groups", json={"database": fg, "name": "Component"}, headers=token)
    for v in ("Production", "Distribution", "End-of-life"):
        client.post(
            "/api/v1/model/tag-groups/values", json={"database": fg, "group": "Component", "value": v}, headers=token
        )
    a = _create(client, token, fg, "A")
    client.post(
        "/api/v1/model/tags/set",
        json={"keys": [{"database": fg, "code": a}], "group": "Component", "value": "Distribution"},
        headers=token,
    )

    # remove a value in the middle → cascade untags; undo restores position + assignment
    r = client.post(
        "/api/v1/model/tag-groups/values/remove",
        json={"database": fg, "group": "Component", "value": "Distribution"},
        headers=token,
    )
    assert r.status_code == 200 and r.json()["untagged"] == 1
    assert client.get(f"/api/v1/model/tags/{fg}/{a}", headers=token).json() == []
    client.post("/api/v1/model/undo", headers=token)
    component = _group(client, token, fg, "Component")
    assert component["values"] == ["Production", "Distribution", "End-of-life"]  # original order kept
    assert client.get(f"/api/v1/model/tags/{fg}/{a}", headers=token).json() == [
        {"dimension": "Component", "value": "Distribution"}
    ]

    # delete the whole group → cascade; undo restores group (colour + values) + assignment
    color = component["color"]
    r = client.post("/api/v1/model/tag-groups/delete", json={"database": fg, "name": "Component"}, headers=token)
    assert r.status_code == 200 and r.json()["untagged"] == 1
    assert client.get(f"/api/v1/model/tags/{fg}/{a}", headers=token).json() == []
    client.post("/api/v1/model/undo", headers=token)
    component = _group(client, token, fg, "Component")
    assert component["values"] == ["Production", "Distribution", "End-of-life"]
    assert component["color"] == color
    assert client.get(f"/api/v1/model/tags/{fg}/{a}", headers=token).json() == [
        {"dimension": "Component", "value": "Distribution"}
    ]

    # audit flags: taxonomy deletions are undoable commands; database lifecycle stays a note
    audit = client.get("/api/v1/model/audit", headers=token).json()
    by_action = {e["action"]: e for e in audit}
    assert by_action["delete_tag_group"]["undoable"] is True
    assert by_action["remove_tag_value"]["undoable"] is True
    assert by_action["create_model"]["undoable"] is False


def test_one_value_per_group(client, token, project):
    fg = _fg(client, token)
    a = _create(client, token, fg, "A")
    for v in ("Production", "Distribution"):
        client.post(
            "/api/v1/model/tags/set",
            json={"keys": [{"database": fg, "code": a}], "group": "Component", "value": v},
            headers=token,
        )
    tags = client.get(f"/api/v1/model/tags/{fg}/{a}", headers=token).json()
    assert tags == [{"dimension": "Component", "value": "Distribution"}]  # replaced, not appended

    # empty value clears the group + undo restores
    client.post(
        "/api/v1/model/tags/set",
        json={"keys": [{"database": fg, "code": a}], "group": "Component", "value": None},
        headers=token,
    )
    assert client.get(f"/api/v1/model/tags/{fg}/{a}", headers=token).json() == []
    client.post("/api/v1/model/undo", headers=token)
    assert client.get(f"/api/v1/model/tags/{fg}/{a}", headers=token).json() == [
        {"dimension": "Component", "value": "Distribution"}
    ]


# ---- path-based aggregation ----------------------------------------------
def _shared_seed(bd) -> None:
    """R → {A, B}; both A and B consume the SAME background S (each emits nothing itself);
    S emits 1 kg CO2. A tagged Production, B tagged Distribution, S untagged."""
    bd.Database("bio").write(
        {("bio", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("fg").write(
        {
            ("fg", "S"): {
                "name": "shared supply", "unit": "kg",
                "exchanges": [
                    {"input": ("fg", "S"), "amount": 1, "type": "production"},
                    {"input": ("bio", "co2"), "amount": 1.0, "type": "biosphere"},
                ],
            },
            ("fg", "A"): {
                "name": "A", "unit": "unit",
                "exchanges": [
                    {"input": ("fg", "A"), "amount": 1, "type": "production"},
                    {"input": ("fg", "S"), "amount": 1, "type": "technosphere"},
                ],
            },
            ("fg", "B"): {
                "name": "B", "unit": "unit",
                "exchanges": [
                    {"input": ("fg", "B"), "amount": 1, "type": "production"},
                    {"input": ("fg", "S"), "amount": 1, "type": "technosphere"},
                ],
            },
            ("fg", "R"): {
                "name": "R", "unit": "unit",
                "exchanges": [
                    {"input": ("fg", "R"), "amount": 1, "type": "production"},
                    {"input": ("fg", "A"), "amount": 1, "type": "technosphere"},
                    {"input": ("fg", "B"), "amount": 1, "type": "technosphere"},
                ],
            },
        }
    )
    bd.Method(("t", "gwp")).write([(("bio", "co2"), 1.0)])


def test_shared_node_path_based_attribution(client, token, project):
    """The shared background S must count as Production under A and Distribution under B —
    NOT collapse to a single tag (the whole point of path-based aggregation)."""
    _shared_seed(get_bd())
    for code, val in (("A", "Production"), ("B", "Distribution")):
        client.post(
            "/api/v1/model/tags/set",
            json={"keys": [{"database": "fg", "code": code}], "group": "Component", "value": val},
            headers=token,
        )
    r = client.post(
        "/api/v1/calc/contribution",
        json={"database": "fg", "code": "R", "method": METHOD, "aggregate_by": "tag:Component"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    groups = {g["key"]: g["impact"] for g in r.json()["aggregation"]["groups"]}
    assert abs(groups.get("Production", 0) - 1.0) < 1e-6
    assert abs(groups.get("Distribution", 0) - 1.0) < 1e-6


def test_untagged_child_inherits(client, token, project):
    """An untagged input inherits the nearest tagged ancestor's value."""
    _shared_seed(get_bd())
    # Tag only R; A, B, S untagged → everything inherits R's value.
    client.post(
        "/api/v1/model/tags/set",
        json={"keys": [{"database": "fg", "code": "R"}], "group": "Component", "value": "Whole"},
        headers=token,
    )
    r = client.post(
        "/api/v1/calc/contribution",
        json={"database": "fg", "code": "R", "method": METHOD, "aggregate_by": "tag:Component"},
        headers=token,
    )
    groups = {g["key"]: g["impact"] for g in r.json()["aggregation"]["groups"]}
    assert abs(groups.get("Whole", 0) - 2.0) < 1e-6
    assert "(untagged)" not in groups or abs(groups["(untagged)"]) < 1e-9


def test_compare_stacked_by_tag(client, token, project):
    """compare-stacked returns, per (subject, method), the impact broken down by the dimension."""
    _shared_seed(get_bd())
    for code, val in (("A", "Production"), ("B", "Distribution")):
        client.post(
            "/api/v1/model/tags/set",
            json={"keys": [{"database": "fg", "code": code}], "group": "Component", "value": val},
            headers=token,
        )
    r = client.post(
        "/api/v1/calc/compare-stacked",
        json={
            "subjects": [{"database": "fg", "code": "R"}],
            "methods": [METHOD],
            "dimensions": ["tag:Component", "isic"],  # multiple dims in one pass
        },
        headers=token,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body["keys"]["tag:Component"]) >= {"Production", "Distribution"}
    subj = body["subjects"][0]
    dims = subj["methods"][" · ".join(METHOD)]["dims"]
    groups = {g["key"]: g["impact"] for g in dims["tag:Component"]}
    assert abs(groups.get("Production", 0) - 1.0) < 1e-6
    assert abs(groups.get("Distribution", 0) - 1.0) < 1e-6
    assert "isic" in dims  # computed in the same pass


def test_below_cutoff_children_keep_their_tag(client, token, project):
    """A tagged child below the cutoff must still be attributed to ITS tag group (not the
    parent's / untagged) in both compare-stacked and the contribution aggregation."""
    _shared_seed(get_bd())
    for code, val in (("A", "Production"), ("B", "Distribution")):
        client.post(
            "/api/v1/model/tags/set",
            json={"keys": [{"database": "fg", "code": code}], "group": "Component", "value": val},
            headers=token,
        )
    # Each child is 50% of the total; cutoff 0.6 skips BOTH at the root.
    r = client.post(
        "/api/v1/calc/compare-stacked",
        json={"subjects": [{"database": "fg", "code": "R"}], "methods": [METHOD],
              "dimensions": ["tag:Component"], "cutoff": 0.6},
        headers=token,
    )
    dims = r.json()["subjects"][0]["methods"][" · ".join(METHOD)]["dims"]["tag:Component"]
    groups = {g["key"]: g["impact"] for g in dims}
    assert abs(groups.get("Production", 0) - 1.0) < 1e-6
    assert abs(groups.get("Distribution", 0) - 1.0) < 1e-6
    assert abs(groups.get("(untagged)", 0)) < 1e-9

    r = client.post(
        "/api/v1/calc/contribution",
        json={"database": "fg", "code": "R", "method": METHOD,
              "aggregate_by": "tag:Component", "cutoff": 0.6},
        headers=token,
    )
    groups = {g["key"]: g["impact"] for g in r.json()["aggregation"]["groups"]}
    assert abs(groups.get("Production", 0) - 1.0) < 1e-6
    assert abs(groups.get("Distribution", 0) - 1.0) < 1e-6


def test_foreground_classification_in_stacked(client, token, project):
    """Setting ISIC/CPC on a foreground activity classifies it in the ISIC/CPC stacked breakdown,
    and the label carries the section name. Undo clears it."""
    from prism_lca.engine.guardrails import set_read_only

    _shared_seed(get_bd())
    set_read_only("fg", False)  # seed writes "fg" directly; mark it writable like a real foreground db
    r = client.post(
        "/api/v1/model/activities/classification",
        json={"database": "fg", "code": "A", "isic": "C", "cpc": "34240", "cpc_name": "Widgets"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    info = client.get("/api/v1/model/activities/fg/A", headers=token).json()["activity"]
    assert info["isic"] == "C" and info["cpc"] == "34240"

    body = client.post(
        "/api/v1/calc/compare-stacked",
        json={"subjects": [{"database": "fg", "code": "A"}], "methods": [METHOD], "dimensions": ["isic"]},
        headers=token,
    ).json()
    assert "C" in body["keys"]["isic"]
    assert body["labels"]["isic"]["C"].startswith("C — ")

    client.post("/api/v1/model/undo", headers=token)
    info = client.get("/api/v1/model/activities/fg/A", headers=token).json()["activity"]
    assert info["isic"] is None and info["cpc"] is None


# ---- helpers --------------------------------------------------------------
def _fg(client, token) -> str:
    import uuid

    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _create(client, token, db, name) -> str:
    return client.post(
        "/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"}, headers=token
    ).json()["activity"]["code"]


def test_a_dimension_says_which_models_it_is_actually_used_in(client, token, project):
    """What lets a *split by* offer only families that would produce groups.

    A group exists in its model from the moment it is created, so a picker that offered every group would
    offer ones nobody has tagged — and splitting a contribution by such a dimension draws one bar called
    "untagged", which reads as a broken chart rather than as an empty answer. So the list says per group
    whether the model uses it, and `in-use` names the models (of those asked for) that carry it.
    """
    m1, m2 = _fg(client, token), _fg(client, token)
    a = _create(client, token, m1, "A")
    _create(client, token, m2, "B")

    for db in (m1, m2):
        for name in ("Component", "Supplier"):
            assert client.post(
                "/api/v1/model/tag-groups", json={"database": db, "name": name}, headers=token
            ).status_code == 200
        for group, value in (("Component", "Production"), ("Supplier", "Acme")):
            assert client.post(
                "/api/v1/model/tag-groups/values", json={"database": db, "group": group, "value": value}, headers=token
            ).status_code == 200

    # Only m1 gets a Component tag; Supplier is tagged nowhere.
    r = client.post(
        "/api/v1/model/tags/set",
        json={"keys": [{"database": m1, "code": a}], "group": "Component", "value": "Production"},
        headers=token,
    )
    assert r.status_code == 200, r.text

    used = {g["name"]: g["used"] for g in client.get(f"/api/v1/model/tag-groups?database={m1}", headers=token).json()["groups"]}
    assert used == {"Component": True, "Supplier": False}
    in_use = client.get(f"/api/v1/model/tag-groups/in-use?database={m1}&database={m2}", headers=token).json()
    # Not "every model" and not "the ones it could apply to" — the ones it is on.
    assert in_use["groups"] == [{"name": "Component", "databases": [m1]}]


def test_the_audit_credits_whoever_made_the_tag_group(client, token, project):
    """Creating a group and adding a value hard-coded "user" as the source, so the assistant's own
    tag groups appeared under the user's name — beside the tag assignments it *was* credited with,
    which reads as the user having done half the work."""
    fg = _fg(client, token)
    client.post(
        "/api/v1/model/tag-groups", json={"database": fg, "name": "Life-cycle phase", "source": "ai"}, headers=token
    )
    client.post(
        "/api/v1/model/tag-groups/values",
        json={"database": fg, "group": "Life-cycle phase", "value": "Use", "source": "ai"},
        headers=token,
    )
    client.post("/api/v1/model/tag-groups", json={"database": fg, "name": "Owner"}, headers=token)  # default stays "user"

    by_summary = {e["summary"]: e for e in client.get("/api/v1/model/audit", headers=token).json()}
    assert by_summary["Create tag group 'Life-cycle phase'"]["source"] == "ai"
    assert by_summary["Add value 'Use' to tag group 'Life-cycle phase'"]["source"] == "ai"
    assert by_summary["Create tag group 'Owner'"]["source"] == "user"


# ---- partitioning a model by one tag group (the canvas's "Group on canvas") -----------------
def test_partition_by_tag_group_follows_the_declared_tag_order(client, token, project):
    """One box per tag, in the order the tags were arranged in — not in whatever order the activities
    happen to iterate, because the boxes are what the user then reads."""
    fg = _fg(client, token)
    client.post("/api/v1/model/tag-groups", json={"database": fg, "name": "Component"}, headers=token)
    for v in ("Production", "Distribution", "End-of-life"):
        client.post(
            "/api/v1/model/tag-groups/values", json={"database": fg, "group": "Component", "value": v}, headers=token
        )
    codes = {name: _create(client, token, fg, name) for name in ("A", "B", "C", "D", "untagged")}
    for name, value in (("A", "End-of-life"), ("B", "Production"), ("C", "Production"), ("D", "Distribution")):
        client.post(
            "/api/v1/model/tags/set",
            json={"keys": [{"database": fg, "code": codes[name]}], "group": "Component", "value": value},
            headers=token,
        )

    r = client.post("/api/v1/model/tag-groups/partition", json={"database": fg, "group": "Component"}, headers=token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["conflicts"] == []
    assert [p["value"] for p in body["partition"]] == ["Production", "Distribution", "End-of-life"]
    by_value = {p["value"]: sorted(p["members"]) for p in body["partition"]}
    assert by_value["Production"] == sorted([f"{fg}/{codes['B']}", f"{fg}/{codes['C']}"])
    assert by_value["End-of-life"] == [f"{fg}/{codes['A']}"]
    # A process carrying no tag of the group is in no box, and says so rather than being dropped.
    assert body["untagged"] == [f"{fg}/{codes['untagged']}"]


def test_partition_refuses_and_NAMES_the_processes_carrying_two_tags_of_the_group(client, token, project):
    """The refusal has to be actionable. "It would not work" leaves the user with nothing to do; the
    names of the processes that broke it are the whole message.

    Reachable because ``tags/bulk`` *adds* rather than sets (and an imported bundle carries whatever it
    carries), while ``tags/set`` has always kept it to one value per group.
    """
    fg = _fg(client, token)
    client.post("/api/v1/model/tag-groups", json={"database": fg, "name": "Component"}, headers=token)
    for v in ("Production", "Distribution"):
        client.post(
            "/api/v1/model/tag-groups/values", json={"database": fg, "group": "Component", "value": v}, headers=token
        )
    double = _create(client, token, fg, "Wears two hats")
    clean = _create(client, token, fg, "Behaves")
    for v in ("Production", "Distribution"):
        assert client.post(
            "/api/v1/model/tags/bulk",
            json={"keys": [{"database": fg, "code": double}], "dimension": "Component", "value": v},
            headers=token,
        ).status_code == 200
    client.post(
        "/api/v1/model/tags/set",
        json={"keys": [{"database": fg, "code": clean}], "group": "Component", "value": "Production"},
        headers=token,
    )

    body = client.post(
        "/api/v1/model/tag-groups/partition", json={"database": fg, "group": "Component"}, headers=token
    ).json()
    assert len(body["conflicts"]) == 1
    conflict = body["conflicts"][0]
    assert conflict["name"] == "Wears two hats"  # named, not counted
    assert conflict["id"] == f"{fg}/{double}"
    assert conflict["values"] == ["Distribution", "Production"]
    # The offender is in no partition entry either — it has no single box to be in.
    assert all(conflict["id"] not in p["members"] for p in body["partition"])
    assert conflict["id"] not in body["untagged"]


def test_partition_refuses_a_tag_group_that_does_not_exist(client, token, project):
    fg = _fg(client, token)
    r = client.post("/api/v1/model/tag-groups/partition", json={"database": fg, "group": "Nope"}, headers=token)
    assert r.status_code == 404


def test_a_tag_written_under_an_alias_joins_the_canonical_group(client, token, project):
    """`find_or_create` resolved the alias to the existing group, and the very next
    call looked the alias up by exact name and answered group_not_found."""
    fg = _fg(client, token)
    assert client.post(
        "/api/v1/model/tag-groups", json={"database": fg, "name": "Life-cycle phase"}, headers=token
    ).status_code == 200
    a = _create(client, token, fg, "A")
    r = client.post(
        "/api/v1/model/tags/set",
        json={"keys": [{"database": fg, "code": a}], "group": "Lebenswegphase", "value": "Use"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert client.get(f"/api/v1/model/tags/{fg}/{a}", headers=token).json() == [
        {"dimension": "Life-cycle phase", "value": "Use"}
    ]
    groups = client.get(f"/api/v1/model/tag-groups?database={fg}", headers=token).json()["groups"]
    assert [g["name"] for g in groups if "phase" in g["name"].casefold()] == ["Life-cycle phase"]


def test_deleting_and_undoing_an_activity_keeps_its_classification(client, token, project):
    """The delete snapshot did not carry the ISIC/CPC fields."""
    fg = _fg(client, token)
    a = _create(client, token, fg, "A")
    assert client.post(
        "/api/v1/model/activities/classification",
        json={"database": fg, "code": a, "isic": "C", "cpc": "34240", "cpc_name": "Widgets"},
        headers=token,
    ).status_code == 200
    assert client.post(
        "/api/v1/model/activities/delete", json={"database": fg, "code": a, "force": True}, headers=token
    ).status_code == 200
    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    info = client.get(f"/api/v1/model/activities/{fg}/{a}", headers=token).json()["activity"]
    assert info["isic"] == "C" and info["cpc"] == "34240"


def test_merging_a_tag_value_retags_and_is_undoable(client, token, project):
    """Four spellings of one phase accumulate across runs ("Use", "Use Phase", "Usage Phase");
    deleting one untags its processes, merging keeps them (V385)."""
    fg = _fg(client, token)
    assert client.post("/api/v1/model/tag-groups", json={"database": fg, "name": "PhaseV"}, headers=token).status_code == 200
    for v in ("Use", "Usage Phase"):
        client.post("/api/v1/model/tag-groups/values", json={"database": fg, "group": "PhaseV", "value": v}, headers=token)
    a = _create(client, token, fg, "A")
    b = _create(client, token, fg, "B")
    client.post("/api/v1/model/tags/set", json={"keys": [{"database": fg, "code": a}], "group": "PhaseV", "value": "Usage Phase"}, headers=token)
    client.post("/api/v1/model/tags/set", json={"keys": [{"database": fg, "code": b}], "group": "PhaseV", "value": "Use"}, headers=token)

    r = client.post("/api/v1/model/tag-groups/values/merge", json={"database": fg, "group": "PhaseV", "value": "Usage Phase", "into": "Use"}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["retagged"] == 1
    assert client.get(f"/api/v1/model/tags/{fg}/{a}", headers=token).json() == [{"dimension": "PhaseV", "value": "Use"}]
    phase = next(g for g in client.get(f"/api/v1/model/tag-groups?database={fg}", headers=token).json()["groups"] if g["name"] == "PhaseV")
    assert phase["values"] == ["Use"]
    # unknown target is refused by name
    bad = client.post("/api/v1/model/tag-groups/values/merge", json={"database": fg, "group": "PhaseV", "value": "Use", "into": "Nope"}, headers=token)
    assert bad.status_code == 404 and bad.json()["error"]["code"] == "value_not_found"

    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    assert client.get(f"/api/v1/model/tags/{fg}/{a}", headers=token).json() == [{"dimension": "PhaseV", "value": "Usage Phase"}]
    phase = next(g for g in client.get(f"/api/v1/model/tag-groups?database={fg}", headers=token).json()["groups"] if g["name"] == "PhaseV")
    assert phase["values"] == ["Use", "Usage Phase"]


def test_merging_a_tag_group_moves_values_and_tags_and_is_undoable(client, token, project):
    """Parallel vocabularies ("PhaseG" beside "LCP-G") merge into one; a process already
    tagged in the target keeps the target's value only after undo."""
    fg = _fg(client, token)
    for name in ("PhaseG", "LCP-G"):
        assert client.post("/api/v1/model/tag-groups", json={"database": fg, "name": name}, headers=token).status_code == 200
    client.post("/api/v1/model/tag-groups/values", json={"database": fg, "group": "PhaseG", "value": "Production"}, headers=token)
    client.post("/api/v1/model/tag-groups/values", json={"database": fg, "group": "PhaseG", "value": "Use"}, headers=token)
    client.post("/api/v1/model/tag-groups/values", json={"database": fg, "group": "LCP-G", "value": "Use"}, headers=token)
    a = _create(client, token, fg, "A")
    b = _create(client, token, fg, "B")
    client.post("/api/v1/model/tags/set", json={"keys": [{"database": fg, "code": a}], "group": "PhaseG", "value": "Production"}, headers=token)
    client.post("/api/v1/model/tags/set", json={"keys": [{"database": fg, "code": b}], "group": "PhaseG", "value": "Use"}, headers=token)
    client.post("/api/v1/model/tags/set", json={"keys": [{"database": fg, "code": b}], "group": "LCP-G", "value": "Use"}, headers=token)

    r = client.post("/api/v1/model/tag-groups/merge", json={"database": fg, "name": "PhaseG", "into": "LCP-G"}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["retagged"] == 2 and r.json()["values_added"] == ["Production"]
    groups = {g["name"]: g for g in client.get(f"/api/v1/model/tag-groups?database={fg}", headers=token).json()["groups"]}
    assert "PhaseG" not in groups
    assert groups["LCP-G"]["values"] == ["Use", "Production"]
    assert client.get(f"/api/v1/model/tags/{fg}/{a}", headers=token).json() == [{"dimension": "LCP-G", "value": "Production"}]
    assert client.get(f"/api/v1/model/tags/{fg}/{b}", headers=token).json() == [{"dimension": "LCP-G", "value": "Use"}]

    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    groups = {g["name"]: g for g in client.get(f"/api/v1/model/tag-groups?database={fg}", headers=token).json()["groups"]}
    assert groups["PhaseG"]["values"] == ["Production", "Use"]
    assert groups["LCP-G"]["values"] == ["Use"]
    tags_a = client.get(f"/api/v1/model/tags/{fg}/{a}", headers=token).json()
    assert tags_a == [{"dimension": "PhaseG", "value": "Production"}]
    tags_b = {t["dimension"]: t["value"] for t in client.get(f"/api/v1/model/tags/{fg}/{b}", headers=token).json()}
    assert tags_b == {"PhaseG": "Use", "LCP-G": "Use"}


def test_merge_undo_restores_multi_value_tags_exactly_and_redo_rebuilds_its_bookkeeping(client, token, project):
    """The plain /tags route lets an activity carry two values of one dimension;
    an undo that replays set_tag lost one of them and the target's own value. Undo now restores each
    affected tag list as a snapshot. And redo runs the same command instance: bookkeeping is rebuilt
    per execution, so a value the user added between undo and redo is not deleted by the next undo."""
    fg = _fg(client, token)
    for name in ("PhaseM", "LCP-M"):
        assert client.post("/api/v1/model/tag-groups", json={"database": fg, "name": name}, headers=token).status_code == 200
    for v in ("a", "b"):
        client.post("/api/v1/model/tag-groups/values", json={"database": fg, "group": "PhaseM", "value": v}, headers=token)
    client.post("/api/v1/model/tag-groups/values", json={"database": fg, "group": "LCP-M", "value": "x"}, headers=token)
    p = _create(client, token, fg, "P")
    # two values of one dimension via the plain route, plus the target's own value
    for group, value in (("PhaseM", "a"), ("PhaseM", "b"), ("LCP-M", "x")):
        assert client.post("/api/v1/model/tags", json={"database": fg, "code": p, "dimension": group, "value": value}, headers=token).status_code == 200
    before = client.get(f"/api/v1/model/tags/{fg}/{p}", headers=token).json()
    assert len(before) == 3

    r = client.post("/api/v1/model/tag-groups/merge", json={"database": fg, "name": "PhaseM", "into": "LCP-M"}, headers=token)
    assert r.status_code == 200, r.text
    merged = client.get(f"/api/v1/model/tags/{fg}/{p}", headers=token).json()
    assert {(t["dimension"], t["value"]) for t in merged} == {("LCP-M", "x"), ("LCP-M", "a"), ("LCP-M", "b")}
    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    assert client.get(f"/api/v1/model/tags/{fg}/{p}", headers=token).json() == before
    groups = {g["name"]: g for g in client.get(f"/api/v1/model/tag-groups?database={fg}", headers=token).json()["groups"]}
    assert groups["LCP-M"]["values"] == ["x"]

    # between undo and redo the user adds "a" to the target by hand — redo must not claim it
    client.post("/api/v1/model/tag-groups/values", json={"database": fg, "group": "LCP-M", "value": "a"}, headers=token)
    assert client.post("/api/v1/model/redo", headers=token).status_code == 200
    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    groups = {g["name"]: g for g in client.get(f"/api/v1/model/tag-groups?database={fg}", headers=token).json()["groups"]}
    assert groups["LCP-M"]["values"] == ["x", "a"]
    assert client.get(f"/api/v1/model/tags/{fg}/{p}", headers=token).json() == before

    # the value merge keeps sibling values too
    client.post("/api/v1/model/tag-groups/values", json={"database": fg, "group": "PhaseM", "value": "c"}, headers=token)
    r = client.post("/api/v1/model/tag-groups/values/merge", json={"database": fg, "group": "PhaseM", "value": "a", "into": "c"}, headers=token)
    assert r.status_code == 200, r.text
    assert {(t["dimension"], t["value"]) for t in client.get(f"/api/v1/model/tags/{fg}/{p}", headers=token).json()} == {("PhaseM", "c"), ("PhaseM", "b"), ("LCP-M", "x")}
    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    assert client.get(f"/api/v1/model/tags/{fg}/{p}", headers=token).json() == before


def test_tagging_an_unknown_code_is_refused(client, token, project):
    """A mistyped activity code must not leave a phantom tag (V425): the assistant
    spliced two hex codes into one, `tags/set` answered ``set: 1`` and the phase aggregation
    carried the value under "(untagged)". Both tag routes now refuse like the exchange routes do."""
    fg = _fg(client, token)
    a = _create(client, token, fg, "A")
    ghost = "76adf6d0be1c4d3cb652f1ce7986a4b4"
    r = client.post(
        "/api/v1/model/tags/set",
        json={"keys": [{"database": fg, "code": a}, {"database": fg, "code": ghost}], "group": "Phase", "value": "Production"},
        headers=token,
    )
    assert r.status_code == 404
    assert "not found" in r.text
    # Nothing was written for the real activity either — the batch is refused as a whole.
    assert client.get(f"/api/v1/model/tags/{fg}/{a}", headers=token).json() == []
    assert client.get(f"/api/v1/model/tags/{fg}/{ghost}", headers=token).json() == []
    r = client.post(
        "/api/v1/model/tags/bulk",
        json={"keys": [{"database": fg, "code": ghost}], "dimension": "Phase", "value": "Production"},
        headers=token,
    )
    assert r.status_code == 404


def test_adding_a_value_that_exists_leaves_no_audit_line(client, token, project):
    """The assistant's assign adds its value before every assignment; that no-op must not read as an event."""
    fg = _fg(client, token)
    client.post("/api/v1/model/tag-groups", json={"database": fg, "name": "Component"}, headers=_hdr(token))

    def added() -> int:
        entries = client.get("/api/v1/model/audit", headers=_hdr(token)).json()
        return sum(e["action"] == "add_tag_value" and "'Use'" in e["summary"] for e in entries)

    for _ in range(3):
        r = client.post("/api/v1/model/tag-groups/values", json={"database": fg, "group": "Component", "value": "Use"},
                        headers=_hdr(token))
        assert r.status_code == 200 and r.json()["values"] == ["Use"]
    assert added() == 1



def _seed_with_root_emission(bd, emission: float) -> None:
    """The shared seed, with the root R emitting ``emission`` kg CO2 itself — an untagged part of that size."""
    _shared_seed(bd)
    data = bd.Database("fg").load()
    data[("fg", "R")]["exchanges"].append({"input": ("bio", "co2"), "amount": emission, "type": "biosphere"})
    bd.Database("fg").write(data)


def _tag_groups(client, token) -> tuple[dict, dict]:
    for code, val in (("A", "Production"), ("B", "Distribution")):
        client.post("/api/v1/model/tags/set",
                    json={"keys": [{"database": "fg", "code": code}], "group": "Component", "value": val}, headers=token)
    det = client.post("/api/v1/calc/contribution",
                      json={"database": "fg", "code": "R", "method": METHOD, "aggregate_by": "tag:Component"},
                      headers=token).json()["aggregation"]["groups"]
    st = client.post("/api/v1/calc/compare-stacked",
                     json={"subjects": [{"database": "fg", "code": "R"}], "methods": [METHOD],
                           "dimensions": ["tag:Component"]}, headers=token).json()
    return {g["key"]: g["impact"] for g in det}, st


def test_a_group_below_one_part_in_a_million_is_not_drawn(client, token, project):
    """The own part of a process is its cumulative impact minus its inputs'; for a functional-unit node that
    emits nothing, that difference is solver noise of about 1e-8 of the score — and drawn, it showed a grey
    "(untagged)" group in a fully tagged model. Below one part in a million a group is not drawn; above, it is."""
    _seed_with_root_emission(get_bd(), 2e-7)  # 1e-7 of the 2 kg score
    det, st = _tag_groups(client, token)
    assert "(untagged)" not in det
    assert "(untagged)" not in st["keys"]["tag:Component"]

    _seed_with_root_emission(get_bd(), 2e-5)  # 1e-5 of the score: a real, if small, group
    det, st = _tag_groups(client, token)
    assert abs(det["(untagged)"] - 2e-5) < 1e-9
    assert "(untagged)" in st["keys"]["tag:Component"]


# ---- a model's tags and a neighbour whose name extends it with a slash ------------------------
def _model_with_tag(name: str, code: str) -> None:
    from prism_lca.engine.brightway_repository import BrightwayRepository
    from prism_lca.engine.tags import TagStore

    BrightwayRepository().create_foreground_database(name)
    get_bd().Database(name).new_activity(code=code, name=code, unit="kilogram", type="process").save()
    TagStore().add(name, code, "phase", f"tag of {name}")


def _tag(name: str, code: str) -> list:
    from prism_lca.engine.tags import TagStore

    return TagStore().list_for(name, code)


def test_deleting_a_model_leaves_the_tags_of_a_model_named_after_it_alone(project):
    from prism_lca.engine.brightway_repository import BrightwayRepository

    del project
    _model_with_tag("A", "p1")
    _model_with_tag("A/B", "x")
    _model_with_tag("C", "B/y")  # the other way round: "C/B/y" is C's own code, not a model "C/B"
    _model_with_tag("C/B", "z")
    repo = BrightwayRepository()

    repo.delete_foreground_database("A")
    assert _tag("A", "p1") == []
    assert _tag("A/B", "x"), "the neighbour's tag went with the deleted model"

    repo.delete_foreground_database("C/B")
    assert _tag("C/B", "z") == []
    assert _tag("C", "B/y"), "a code with a slash was read as the deleted model's"


def test_renaming_a_model_leaves_the_tags_of_a_model_named_after_it_alone(project):
    from prism_lca.engine.brightway_repository import BrightwayRepository

    del project
    _model_with_tag("A", "p1")
    _model_with_tag("A/B", "x")

    BrightwayRepository().rename_foreground_database("A", "D")
    assert _tag("D", "p1") and _tag("A", "p1") == []
    assert _tag("A/B", "x"), "the neighbour's tag moved with the renamed model"
    assert _tag("D/B", "x") == []


def test_an_ordinary_delete_and_rename_take_every_tag_under_the_name(project):
    """No neighbour: every key under the name goes along, a tag of a process no longer there included."""
    from prism_lca.engine.brightway_repository import BrightwayRepository
    from prism_lca.engine.tags import TagStore

    del project
    _model_with_tag("Bottle", "p1")
    TagStore().add("Bottle", "gone", "phase", "stale")
    repo = BrightwayRepository()

    repo.rename_foreground_database("Bottle", "Flask")
    assert _tag("Flask", "p1") and _tag("Flask", "gone")
    assert _tag("Bottle", "p1") == [] and _tag("Bottle", "gone") == []
    repo.delete_foreground_database("Flask")
    assert TagStore().load_map() == {}
