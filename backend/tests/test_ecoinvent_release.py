"""Which release an ecoinvent folder holds — version and system model — and the name it is imported under."""

from __future__ import annotations

import pytest
from test_setup import FLOWS, write_flow_list

from prism_lca.engine.backgrounds import ecoinvent_release
from prism_lca.errors import PrismError

NS = "http://www.EcoInvent.org/EcoSpold02"


def _release(root, model="Allocation, cut-off by classification"):
    datasets = root / "datasets"
    datasets.mkdir(parents=True)
    (root / "MasterData").mkdir()
    write_flow_list(root / "MasterData" / "ElementaryExchanges.xml", FLOWS)
    (datasets / "a_b.spold").write_text(
        f'<ecoSpold xmlns="{NS}"><childActivityDataset><modellingAndValidation><representativeness '
        f'systemModelId="x"><systemModelName xml:lang="en">{model}</systemModelName>'
        "</representativeness></modellingAndValidation></childActivityDataset></ecoSpold>",
        encoding="utf-8",
    )
    return datasets


def _workbook(path, version="3.13, November 2026"):
    from openpyxl import Workbook

    wb = Workbook()
    readme = wb.active
    readme.title = "Read me"
    readme.append([None])
    readme.append(["Database Version", version])
    wb.create_sheet("CFs")
    wb.save(path)
    return path


def test_the_folder_name_the_archive_extracts_to_names_the_release(tmp_path):
    datasets = _release(tmp_path / "ecoinvent 3.13_cutoff_ecoSpold02")
    release = ecoinvent_release.identify(datasets, None)
    assert (release.version, release.system_model) == ("3.13", "cutoff")
    assert release.database_name() == "ecoinvent-3.13-cutoff"


def test_the_workbook_read_me_names_the_release_whatever_the_folders_are_called(tmp_path):
    datasets = _release(tmp_path / "eco", model="Allocation at the point of substitution")
    workbook = _workbook(tmp_path / "methods.xlsx")
    assert ecoinvent_release.identify(datasets, workbook).database_name() == "ecoinvent-3.13-apos"


def test_a_workbook_from_another_release_is_refused_before_anything_is_read(tmp_path):
    datasets = _release(tmp_path / "ecoinvent 3.12_cutoff_ecoSpold02")
    with pytest.raises(PrismError) as excinfo:
        ecoinvent_release.identify(datasets, _workbook(tmp_path / "LCIA Implementation 3.13.xlsx"))
    assert excinfo.value.code == "release_mismatch"


def test_a_requested_name_with_another_version_is_refused(tmp_path):
    release = ecoinvent_release.identify(_release(tmp_path / "ecoinvent 3.13_cutoff_ecoSpold02"), None)
    with pytest.raises(PrismError) as excinfo:
        release.database_name("ecoinvent-3.12-cutoff")
    assert excinfo.value.code == "release_mismatch"
    assert release.database_name("my-ecoinvent") == "my-ecoinvent"  # no version in it: the caller's call


def test_an_unnamed_release_says_how_to_name_it(tmp_path):
    release = ecoinvent_release.identify(_release(tmp_path / "eco"), None)
    with pytest.raises(PrismError) as excinfo:
        release.database_name()
    assert excinfo.value.code == "release_unknown"
    assert "Read me" in excinfo.value.hint


def test_the_wizard_import_is_named_after_the_release(client, token, project, tmp_path):
    """The frontend sends no database name; before, every release was imported as 3.12."""
    from prism_lca.engine import ecoinvent

    root = tmp_path / "ecoinvent 3.13_cutoff_ecoSpold02"
    _release(root)
    st = ecoinvent.start_import(str(root), run_in_thread=False)
    assert st.database == "ecoinvent-3.13-cutoff"
    assert st.project == project


def test_every_system_model_ecoinvent_ships_reads_back_from_the_name():
    from prism_lca.engine.backgrounds.common import infer_from_name

    labels = {slug: infer_from_name(f"ecoinvent-3.13-{slug}").system_model
              for slug in ecoinvent_release.SYSTEM_MODELS.values()}
    assert labels == {"cutoff": "cut-off", "apos": "APOS", "consequential": "consequential",
                      "en15804": "cut-off, EN15804"}


def test_a_typed_version_fills_in_only_where_the_files_name_none(tmp_path):
    unnamed = ecoinvent_release.identify(_release(tmp_path / "eco"), None)
    assert unnamed.with_version("3.13").database_name() == "ecoinvent-3.13-cutoff"
    assert unnamed.with_version(" v3.13 ").version == "3.13"
    with pytest.raises(PrismError) as excinfo:
        unnamed.with_version("thirteen")
    assert excinfo.value.code == "release_version_invalid"

    named = ecoinvent_release.identify(_release(tmp_path / "ecoinvent 3.13_cutoff_ecoSpold02"), None)
    assert named.with_version("3.13").database_name() == "ecoinvent-3.13-cutoff"
    with pytest.raises(PrismError) as excinfo:
        named.with_version("3.12")
    assert excinfo.value.code == "release_mismatch"


def test_the_wizard_sees_the_release_before_importing(client, token, tmp_path):
    root = tmp_path / "ecoinvent 3.13_cutoff_ecoSpold02"
    _release(root)
    r = client.get("/api/v1/setup/ecoinvent-release", params={"path": str(root)}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json() == {"release": True, "version": "3.13", "system_model": "cutoff",
                        "database": "ecoinvent-3.13-cutoff", "source": "folder"}

    unnamed = tmp_path / "eco"
    _release(unnamed)
    workbook = _workbook(tmp_path / "methods.xlsx")
    r = client.get("/api/v1/setup/ecoinvent-release", params={"path": str(unnamed)}, headers=token)
    assert r.json()["version"] is None and r.json()["release"] is True
    r = client.get("/api/v1/setup/ecoinvent-release",
                   params={"path": str(unnamed), "lcia_xlsx": str(workbook)}, headers=token)
    assert (r.json()["version"], r.json()["source"]) == ("3.13", "workbook")

    r = client.get("/api/v1/setup/ecoinvent-release", params={"path": str(tmp_path / "nothing")}, headers=token)
    assert r.json()["release"] is False


def test_the_typed_version_reaches_the_import(client, token, project, tmp_path):
    from prism_lca.engine import ecoinvent

    root = tmp_path / "eco"
    _release(root)
    st = ecoinvent.start_import(str(root), run_in_thread=False, version="3.13")
    assert st.database == "ecoinvent-3.13-cutoff"
