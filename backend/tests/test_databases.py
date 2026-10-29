from __future__ import annotations

import uuid

import pytest

from prism_lca.engine import guardrails
from prism_lca.engine.bootstrap import get_bd
from prism_lca.errors import PrismError


def test_foreground_is_writable(client, token, project):
    dbname = "fg-" + uuid.uuid4().hex[:6]
    r = client.post("/api/v1/databases/foreground", json={"name": dbname}, headers=token)
    assert r.status_code == 200, r.text
    info = r.json()
    assert info["read_only"] is False
    assert info["kind"] == "foreground"

    listed = {d["name"]: d for d in client.get("/api/v1/databases", headers=token).json()}
    assert dbname in listed
    assert listed[dbname]["read_only"] is False


def test_readonly_guardrail_blocks_writes(client, token, project):
    # A background database in the active project is read-only and cannot be written.
    bd = get_bd()
    bgname = "bg-" + uuid.uuid4().hex[:6]
    bd.Database(bgname).register()
    guardrails.set_read_only(bgname, True)

    assert guardrails.is_read_only(bgname) is True
    with pytest.raises(PrismError):
        guardrails.assert_writable(bgname)

    listed = {d["name"]: d for d in client.get("/api/v1/databases", headers=token).json()}
    assert listed[bgname]["read_only"] is True
