"""Under the chat's model fence, a copy brings in only what the chat may link: its model, the library, the background."""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient
from test_model_scope import _code, _fenced, _fg, _names, _refused

from prism_lca.engine import guardrails
from prism_lca.engine.library import LIBRARY_DB, ensure_library


def _link(client: TestClient, token, db: str, code: str, input_db: str, input_code: str) -> str:
    body = {"activity_database": db, "activity_code": code, "input_database": input_db, "input_code": input_code, "amount": 1}
    r = client.post("/api/v1/model/exchanges", json=body, headers=token)
    assert r.status_code == 200, r.text
    return r.json()["exchange"]["uid"]


def _copy(client: TestClient, headers, db: str, code: str, depth: int = 1, **extra):
    body = {"source_database": db, "source_code": code, "target_database": "A", "depth": depth, "source": "ai", **extra}
    return client.post("/api/v1/model/activities/copy", json=body, headers=headers)


def _world(client: TestClient, token) -> dict[str, str]:
    """Models A and B, a read-only background, and library datasets that do and do not draw on B."""
    _fg(client, token, "A")
    _fg(client, token, "B")
    bg = _fg(client, token, "bg-" + uuid.uuid4().hex[:6])
    ensure_library()
    c = {"bg": bg}
    c["steel"] = _code(client, token, bg, "steel")
    c["sheet"] = _code(client, token, bg, "sheet")
    _link(client, token, bg, c["sheet"], bg, c["steel"])
    guardrails.set_read_only(bg, True)
    c["sub"] = _code(client, token, "B", "B sub-part")
    c["part"] = _code(client, token, "B", "B part")
    _link(client, token, "B", c["part"], "B", c["sub"])
    # A library dataset that draws on B, and one that draws on B only through it.
    c["lib_on_b"] = _code(client, token, LIBRARY_DB, "lib on B")
    _link(client, token, LIBRARY_DB, c["lib_on_b"], "B", c["sub"])
    c["lib_top"] = _code(client, token, LIBRARY_DB, "lib top")
    _link(client, token, LIBRARY_DB, c["lib_top"], LIBRARY_DB, c["lib_on_b"])
    # A library chain that ends in the background.
    c["lib_clean"] = _code(client, token, LIBRARY_DB, "lib clean")
    _link(client, token, LIBRARY_DB, c["lib_clean"], bg, c["sheet"])
    c["lib_clean_top"] = _code(client, token, LIBRARY_DB, "lib clean top")
    _link(client, token, LIBRARY_DB, c["lib_clean_top"], LIBRARY_DB, c["lib_clean"])
    c["bottle"] = _code(client, token, "A", "bottle")
    return c


def test_a_copy_from_another_model_or_drawing_on_one_is_refused(client, token, project):
    c = _world(client, token)
    uid = _link(client, token, "A", c["bottle"], "B", c["part"])  # made by the user, unfenced
    chat = _fenced(token, "A")

    _refused(_copy(client, chat, "B", c["part"], relink_consumers=True, uids=[uid]))
    _refused(_copy(client, chat, "B", c["sub"]))  # draws on nothing, but its content is B's
    _refused(_copy(client, chat, "B", c["part"], depth=2))
    _refused(_copy(client, chat, LIBRARY_DB, c["lib_on_b"]))
    # Depth 2 copies the library supplier, which keeps its input from B.
    _refused(_copy(client, chat, LIBRARY_DB, c["lib_top"], depth=2))

    names = _names(client, token, "A")
    assert names == ["bottle"], names
    inputs = client.get(f"/api/v1/model/activities/A/{c['bottle']}", headers=token).json()
    assert [(e["input"]["database"], e["input"]["code"]) for e in inputs["exchanges"] if e["type"] == "technosphere"] == [
        ("B", c["part"])
    ]


def test_copies_from_the_library_and_the_background_stay_allowed(client, token, project):
    c = _world(client, token)
    chat = _fenced(token, "A")
    for db, code, depth in (
        (c["bg"], c["sheet"], 2),
        (LIBRARY_DB, c["lib_clean_top"], 2),
        (LIBRARY_DB, c["lib_top"], 1),  # its one input is a library dataset; the copy does not reach B
    ):
        r = _copy(client, chat, db, code, depth=depth)
        assert r.status_code == 200, r.text
    assert sorted(_names(client, token, "A")) == sorted(
        ["bottle", "sheet", "steel", "lib clean top", "lib clean", "lib top"]
    )


def test_an_unfenced_copy_from_another_model_still_works(client, token, project):
    c = _world(client, token)
    r = _copy(client, token, "B", c["part"], depth=2)
    assert r.status_code == 200, r.text
    assert {"B part", "B sub-part"} <= set(_names(client, token, "A"))


def test_a_localized_path_brings_in_nothing_from_another_model(client, token, project):
    c = _world(client, token)
    chat = _fenced(token, "A")

    def localize(path: list[list[str]]):
        return client.post("/api/v1/model/localize", json={"target_database": "A", "path": path}, headers=chat)

    _refused(localize([["B", c["part"]], ["B", c["sub"]]]))
    _refused(localize([[LIBRARY_DB, c["lib_top"]], [LIBRARY_DB, c["lib_on_b"]]]))
    assert _names(client, token, "A") == ["bottle"]
    r = localize([[c["bg"], c["sheet"]], [c["bg"], c["steel"]]])
    assert r.status_code == 200, r.text
