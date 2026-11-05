"""A model name holds one line: typed names are checked, names from a bundle are cleaned, existing names work."""

from __future__ import annotations

import io
import json
import zipfile

import pytest
from test_bundle import _b64, _export, fill_source

from prism_lca.engine import guardrails, model_names
from prism_lca.engine.bootstrap import get_bd

BROKEN = ["A\nB", "A\r\nB", "A\tB", "A\x1bB", "A\x00B", "A\x85B", "A\u2028B", "A\u2029B"]
#: Odd but fine: other scripts, quotes, slashes, arrows, an emoji with a zero-width joiner, a direction mark.
FINE = ["Müller-研究", "Bottle 'PET' \"0.5 l\"", "A/B → C", "Family \U0001F468\u200d\U0001F469\u200d\U0001F467", "\u200fעברית"]
TWO_LINES = "Bottle PET\n\n0.5 l"


def _names(client, token) -> set[str]:
    return {d["name"] for d in client.get("/api/v1/databases", headers=token).json()}


def _refused(r) -> None:
    assert r.status_code == 400, r.text
    error = r.json()["error"]
    assert error["code"] == "invalid_name"
    assert "line breaks" in error["message"]


def test_clean_puts_a_name_on_one_line_and_leaves_a_clean_name_alone():
    assert model_names.clean(TWO_LINES) == "Bottle PET 0.5 l"
    assert model_names.clean("A \r\n B\t\tC") == "A B C"
    assert model_names.clean("\n\n") == ""
    for name in [*FINE, "  padded  ", "two  spaces", ""]:
        assert model_names.clean(name) == name


@pytest.mark.parametrize("name", BROKEN)
def test_a_typed_name_with_a_control_character_is_refused(client, token, project, name):
    _refused(client.post("/api/v1/databases/foreground", json={"name": name}, headers=token))
    assert not any(c in n for n in _names(client, token) for c in "\n\t\x1b\x00\u2028")


def test_odd_names_without_control_characters_stay_allowed(client, token, project):
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
    assert "Source" in _names(client, token)
    assert not any("\n" in n for n in _names(client, token))


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
