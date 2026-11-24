"""A model name holds one line and no slash: typed names are checked, names from a file are cleaned, existing
names work."""

from __future__ import annotations

import io
import json
import zipfile
from urllib.parse import quote

import pytest
from test_bundle import _b64, _export, fill_source

from prism_lca.engine import guardrails, model_names
from prism_lca.engine.bootstrap import get_bd

BROKEN = ["A\nB", "A\r\nB", "A\tB", "A\x1bB", "A\x00B", "A\x85B", "A\u2028B", "A\u2029B"]
#: A slash splits the name's path segment, even sent as %2F (model_names).
SLASHED = ["A/B → C", "/lead", "trail/", "PET/glass/can"]
#: Odd but fine: other scripts, quotes, a backslash, arrows, an emoji with a zero-width joiner, a direction mark,
#: and the characters a URL gives a meaning to (they travel percent-encoded), dot segments included.
FINE = ["Müller-研究", "Bottle 'PET' \"0.5 l\"", "A\\B → C", "Family \U0001F468\u200d\U0001F469\u200d\U0001F467",
        "\u200fעברית", "50% #1 ?a=b&c+d;e", "..", "."]
TWO_LINES = "Bottle PET\n\n0.5 l"


def _names(client, token) -> set[str]:
    return {d["name"] for d in client.get("/api/v1/databases", headers=token).json()}


def _refused(r, why: str = "line breaks") -> None:
    assert r.status_code == 400, r.text
    error = r.json()["error"]
    assert error["code"] == "invalid_name"
    assert why in error["message"]


def test_clean_puts_a_name_on_one_line_and_leaves_a_clean_name_alone():
    assert model_names.clean(TWO_LINES) == "Bottle PET 0.5 l"
    assert model_names.clean("A \r\n B\t\tC") == "A B C"
    assert model_names.clean("\n\n") == ""
    assert model_names.clean("PET/glass") == "PET-glass"
    assert model_names.clean("A/\nB") == "A- B"
    for name in [*FINE, "  padded  ", "two  spaces", ""]:
        assert model_names.clean(name) == name


@pytest.mark.parametrize("name", BROKEN)
def test_a_typed_name_with_a_control_character_is_refused(client, token, project, name):
    _refused(client.post("/api/v1/databases/foreground", json={"name": name}, headers=token))
    assert not any(c in n for n in _names(client, token) for c in "\n\t\x1b\x00\u2028")


@pytest.mark.parametrize("name", SLASHED)
def test_a_typed_name_with_a_slash_is_refused_with_a_name_that_would_do(client, token, project, name):
    r = client.post("/api/v1/databases/foreground", json={"name": name}, headers=token)
    _refused(r, "slash")
    assert f"‘{name.strip().replace('/', '-')}’" in r.json()["error"]["hint"]
    assert not any("/" in n for n in _names(client, token))


def test_odd_names_without_control_characters_or_slashes_stay_allowed(client, token, project):
    for name in FINE:
        r = client.post("/api/v1/databases/foreground", json={"name": name}, headers=token)
        assert r.status_code == 200, r.text
    # A stray line break at an end was trimmed before and still is.
    r = client.post("/api/v1/databases/foreground", json={"name": "Trailing\n"}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Trailing"


def test_copy_and_rename_refuse_such_a_name_too(client, token, project):
    assert client.post("/api/v1/databases/foreground", json={"name": "Source"}, headers=token).status_code == 200
    _refused(client.post("/api/v1/databases/foreground/duplicate", json={"source": "Source", "name": TWO_LINES}, headers=token))
    _refused(client.post("/api/v1/databases/foreground/rename", json={"database": "Source", "name": TWO_LINES}, headers=token))
    _refused(client.post("/api/v1/databases/foreground/duplicate", json={"source": "Source", "name": "A/B"}, headers=token),
             "slash")
    _refused(client.post("/api/v1/databases/foreground/rename", json={"database": "Source", "name": "A/B"}, headers=token),
             "slash")
    assert "Source" in _names(client, token)
    assert not any("\n" in n or "/" in n for n in _names(client, token))


def test_an_odd_name_reaches_the_routes_that_carry_it_in_the_path(client, token, project):
    """What the pages ask for a model, with the name percent-encoded as the app sends it. Not "." and "..":
    httpx resolves them as dot segments, Node's http (the app's transport) sends them as they are, and the
    end-to-end walk takes them through the pages."""
    for name in [n for n in FINE if n.strip(".")]:
        assert client.post("/api/v1/databases/foreground", json={"name": name}, headers=token).status_code == 200
        r = client.post("/api/v1/model/activities", json={"database": name, "name": "P", "unit": "kg"}, headers=token)
        assert r.status_code == 200, r.text
        seg = quote(name, safe="")
        for path in (f"/model/activities/{seg}", f"/model/graph/{seg}", f"/model/reference/{seg}",
                     f"/model/health/{seg}", f"/views/{seg}", f"/ai/chats/{seg}", f"/report/list/{seg}"):
            r = client.get(f"/api/v1{path}", headers=token)
            assert r.status_code == 200, (name, path, r.text)
        assert [a["name"] for a in client.get(f"/api/v1/model/activities/{seg}", headers=token).json()] == ["P"]


def test_a_model_that_already_carries_such_a_name_keeps_working(client, token, project):
    """It opens, takes a process, keeps its name on a rename to itself, and can be renamed to one line."""
    bd = get_bd()
    bd.Database(TWO_LINES).register(searchable=False)
    guardrails.set_read_only(TWO_LINES, False)
    r = client.post("/api/v1/model/activities", json={"database": TWO_LINES, "name": "P", "unit": "kg"}, headers=token)
    assert r.status_code == 200, r.text
    same = client.post("/api/v1/databases/foreground/rename", json={"database": TWO_LINES, "name": TWO_LINES}, headers=token)
    assert same.status_code == 200, same.text
    renamed = client.post("/api/v1/databases/foreground/rename", json={"database": TWO_LINES, "name": "Bottle"}, headers=token)
    assert renamed.status_code == 200, renamed.text
    assert [a["name"] for a in client.get("/api/v1/model/activities/Bottle", headers=token).json()] == ["P"]


def test_a_model_that_already_carries_a_slash_can_be_copied_and_renamed_out_of_it(client, token, project):
    """Its pages answer "Not Found", but copy and rename take the name in the body: that is the repair."""
    bd = get_bd()
    bd.Database("PET/glass").register(searchable=False)
    guardrails.set_read_only("PET/glass", False)
    r = client.post("/api/v1/model/activities", json={"database": "PET/glass", "name": "P", "unit": "kg"}, headers=token)
    assert r.status_code == 200, r.text
    same = client.post("/api/v1/databases/foreground/rename", json={"database": "PET/glass", "name": "PET/glass"},
                       headers=token)
    assert same.status_code == 200, same.text
    copy = client.post("/api/v1/databases/foreground/duplicate", json={"source": "PET/glass", "name": "PET-glass copy"},
                       headers=token)
    assert copy.status_code == 200, copy.text
    renamed = client.post("/api/v1/databases/foreground/rename", json={"database": "PET/glass", "name": "PET-glass"},
                          headers=token)
    assert renamed.status_code == 200, renamed.text
    for name in ("PET-glass", "PET-glass copy"):
        assert [a["name"] for a in client.get(f"/api/v1/model/activities/{name}", headers=token).json()] == ["P"]


def _named(data: bytes, name: str) -> bytes:
    """The bundle with another model name in its manifest."""
    buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as src, zipfile.ZipFile(buf, "w") as dst:
        for member in src.namelist():
            raw = src.read(member)
            if member == "manifest.json":
                manifest = json.loads(raw)
                manifest["model"]["name"] = name
                raw = json.dumps(manifest).encode()
            dst.writestr(member, raw)
    return buf.getvalue()


def test_a_bundle_name_is_cleaned_on_import_and_in_the_dry_run(client, token, project):
    data = _named(_export(client, token, fill_source(client, token)), TWO_LINES)
    one_line = model_names.clean(TWO_LINES)

    look = client.post("/api/v1/bundle/inspect", json={"content": _b64(data)}, headers=token).json()["model"]
    assert (look["name"], look["suggested_name"], look["name_taken"]) == (one_line, one_line, False)

    # Without a name the manifest's is used; with the dry run's suggestion the same one, numbered.
    r = client.post("/api/v1/bundle/import", json={"content": _b64(data)}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["database"] == one_line
    r = client.post("/api/v1/bundle/import", json={"content": _b64(data), "name": TWO_LINES}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["database"] == f"{one_line} (2)"
    assert not any("\n" in n for n in _names(client, token))


def test_a_bundle_name_loses_its_slash_on_import(client, token, project):
    data = _named(_export(client, token, fill_source(client, token)), "PET/glass")
    look = client.post("/api/v1/bundle/inspect", json={"content": _b64(data)}, headers=token).json()["model"]
    assert (look["name"], look["suggested_name"]) == ("PET-glass", "PET-glass")
    r = client.post("/api/v1/bundle/import", json={"content": _b64(data)}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["database"] == "PET-glass"
    r = client.post("/api/v1/bundle/import", json={"content": _b64(data), "name": "Can/glass"}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["database"] == "Can-glass"
