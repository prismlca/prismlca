"""Geography names come from the workspace's own ecoinvent release, never from the repository."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from prism_lca.engine import background_reset, geography_names
from prism_lca.engine.backgrounds import common as backgrounds

# Invented codes and names in the ecoSpold2 layout: shortname and name per language, a KML outline.
_XML = """<?xml version="1.0" encoding="utf-8"?>
<validGeographies xmlns="http://www.EcoInvent.org/EcoSpold02" majorRelease="3">
  <geography id="00000000-0000-0000-0000-000000000001" uNCode="999">
    <name xml:lang="en">Testland</name>
    <name xml:lang="de">Testland (de)</name>
    <shortname xml:lang="en">TL</shortname>
    <kml><![CDATA[<Polygon/>]]></kml>
  </geography>
  <geography id="00000000-0000-0000-0000-000000000002">
    <name xml:lang="en">Testland without its north</name>
    <shortname xml:lang="en">TL w/o N</shortname>
  </geography>
  <geography id="00000000-0000-0000-0000-000000000003">
    <name xml:lang="en">No code given</name>
  </geography>
</validGeographies>
"""


def _release(tmp_path: Path) -> Path:
    """An extracted release with only what this test needs; returns its ``datasets`` folder."""
    (tmp_path / "datasets").mkdir()
    (tmp_path / "MasterData").mkdir()
    (tmp_path / "MasterData" / "Geographies.xml").write_text(_XML, encoding="utf-8")
    return tmp_path / "datasets"


def test_parse_takes_english_shortname_and_name(tmp_path: Path) -> None:
    names = geography_names.parse(_release(tmp_path).parent / "MasterData" / "Geographies.xml")
    assert names == {"TL": "Testland", "TL w/o N": "Testland without its north"}


def test_stored_names_are_served(client: TestClient, token: dict[str, str], project: str, tmp_path: Path) -> None:
    assert geography_names.store_from_release(_release(tmp_path)) == 2
    r = client.get("/api/v1/search/geography-names", headers=token)
    assert r.status_code == 200, r.text
    assert r.json() == {"names": {"TL": "Testland", "TL w/o N": "Testland without its north"}}


def test_a_release_without_geographies_stores_nothing(project: str, tmp_path: Path) -> None:
    (tmp_path / "datasets").mkdir()
    assert geography_names.store_from_release(tmp_path / "datasets") == 0
    assert geography_names.load() == {}


def test_an_older_workspace_reads_the_recorded_release_once(project: str, tmp_path: Path, monkeypatch) -> None:
    datasets = _release(tmp_path)
    info = backgrounds.BackgroundInfo(provider=backgrounds.PROVIDER_ECOINVENT, label="ei", version="3.12")
    info.source_path = str(datasets)
    monkeypatch.setattr(backgrounds, "database_of", lambda provider: "ei")
    monkeypatch.setattr(backgrounds, "registry", lambda name: info)
    assert geography_names.load()["TL"] == "Testland"
    # Stored now: the release folder may go away and the names stay.
    (datasets.parent / "MasterData" / "Geographies.xml").unlink()
    assert geography_names.load()["TL"] == "Testland"


def test_without_ecoinvent_there_are_no_names(project: str) -> None:
    assert geography_names.load() == {}


def test_starting_over_drops_the_names(project: str, tmp_path: Path) -> None:
    geography_names.store_from_release(_release(tmp_path))
    background_reset.reset_background(background_reset.issue_reset_code()["code"])
    assert geography_names.load() == {}


def test_a_lazy_read_writes_where_it_started(project: str, tmp_path: Path) -> None:
    """The lazy path resolves its file first and hands it down — a workspace switch during the read
    must not move the names into the workspace that is active by the time they are written."""
    destination = tmp_path / "elsewhere" / "geographies.json"
    assert geography_names.store_from_release(_release(tmp_path), destination) == 2
    assert destination.is_file()
    assert geography_names.load() == {}  # the active workspace got nothing
