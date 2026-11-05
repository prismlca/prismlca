"""A workspace folder from a backup holds plain values wherever bw2data unpickles, or it is not restored."""
from __future__ import annotations

import collections
import datetime
import pickle
import sqlite3
import tarfile
from pathlib import Path

import pytest

from prism_lca.engine import workspace_pickles
from prism_lca.errors import PrismError

PLAIN = {"name": "steel", "amount": 1.5, "uncertainty type": 2, "loc": 0.4, "tags": ("a", "b"),
         "ids": {1, 2}, "frozen": frozenset({3}), "blob": b"\x00", "none": None, "flag": True,
         "classifications": [("CPC", "41")], "big": 10**30}
NOT_PLAIN = (datetime.date(2020, 1, 1), collections.OrderedDict(a=1), complex(1, 2))


def _db(path: Path, table: str, column: str, values: list) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.execute(f'CREATE TABLE "{table}" (id INTEGER PRIMARY KEY, "{column}" BLOB)')
    con.executemany(f'INSERT INTO "{table}" ("{column}") VALUES (?)', [(v,) for v in values])
    con.commit()
    con.close()
    return path


def _refused(folder: Path) -> PrismError:
    with pytest.raises(PrismError) as exc:
        workspace_pickles.assert_plain(folder)
    assert exc.value.code == "backup_unreadable"
    return exc.value


def test_plain_values_pass_in_every_store(tmp_path):
    data = pickle.dumps(PLAIN, protocol=4)
    for rel, columns in workspace_pickles.PICKLE_COLUMNS.items():
        for table, column in columns:
            _db(tmp_path / rel, table, column, [data, None])
    (tmp_path / "preferences.pickle").write_bytes(pickle.dumps({"use_cache": True}, protocol=4))
    (tmp_path / "intermediate").mkdir()
    (tmp_path / "intermediate" / "method.pickle").write_bytes(pickle.dumps([(("bio", "co2"), 1.0)], protocol=4))
    workspace_pickles.assert_plain(tmp_path)


@pytest.mark.parametrize("value", NOT_PLAIN)
@pytest.mark.parametrize(("rel", "table", "column"), [
    (rel, table, column)
    for rel, columns in workspace_pickles.PICKLE_COLUMNS.items() for table, column in columns
])
def test_a_column_value_naming_a_global_is_refused(tmp_path, rel, table, column, value):
    _db(tmp_path / rel, table, column, [pickle.dumps(PLAIN, protocol=4), pickle.dumps(value, protocol=4)])
    assert rel in _refused(tmp_path).message


@pytest.mark.parametrize("rel", ["preferences.pickle", "geomapping.pickle", "setups.pickle",
                                 "dynamicsetups.pickle", "intermediate/m.pickle", "processed/old.pickle"])
def test_a_pickle_file_naming_a_global_is_refused(tmp_path, rel):
    (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
    (tmp_path / rel).write_bytes(pickle.dumps(NOT_PLAIN[0], protocol=2))
    _refused(tmp_path)


def test_paths_and_tables_match_regardless_of_case(tmp_path):
    _db(tmp_path / "LCI" / "Databases.DB", "ActivityDataset", "DATA", [pickle.dumps(NOT_PLAIN[1])])
    _refused(tmp_path)
    other = tmp_path / "other"
    (other).mkdir()
    (other / "Preferences.PICKLE").write_bytes(pickle.dumps(NOT_PLAIN[0]))
    _refused(other)


def test_only_ordinary_tables_are_accepted(tmp_path):
    path = tmp_path / "lci" / "databases.db"
    path.parent.mkdir()
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE source (data BLOB)")
    con.execute("INSERT INTO source VALUES (?)", (pickle.dumps(PLAIN),))
    con.execute("CREATE VIEW activitydataset AS SELECT data FROM source")
    con.commit()
    con.close()
    _refused(tmp_path)


@pytest.mark.parametrize("value", [12, 1.5, "text"])
def test_a_column_value_that_is_not_a_blob_is_refused(tmp_path, value):
    _db(tmp_path / "lci" / "databases.db", "exchangedataset", "data", [value])
    _refused(tmp_path)


def test_large_pickles_are_read_opcode_by_opcode(tmp_path, monkeypatch):
    monkeypatch.setattr(workspace_pickles, "LOAD_LIMIT", 16)
    (tmp_path / "intermediate").mkdir()
    big = tmp_path / "intermediate" / "big.pickle"
    big.write_bytes(pickle.dumps([PLAIN] * 50, protocol=4))
    workspace_pickles.assert_plain(tmp_path)
    big.write_bytes(pickle.dumps([PLAIN, NOT_PLAIN[0]], protocol=4))
    _refused(tmp_path)


def test_pickles_above_the_size_cap_are_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(workspace_pickles, "MAX_PICKLE", 32)
    data = pickle.dumps(PLAIN, protocol=4)
    assert len(data) > 32
    (tmp_path / "geomapping.pickle").write_bytes(data)
    _refused(tmp_path)
    blob = tmp_path / "blob"
    blob.mkdir()
    _db(blob / "lci" / "databases.db", "activitydataset", "data", [data])
    _refused(blob)


# Through the route, with a backup PrismLCA wrote and one value changed in it.


def _rewrite(backup: Path, out: Path, change) -> Path:
    """Unpack our own backup, apply ``change`` to its workspace folder, pack it again."""
    work = out.parent / (out.name + ".d")
    with tarfile.open(backup, "r:gz") as tar:
        tar.extractall(work, filter="data")
    (folder,) = [p for p in work.iterdir() if p.is_dir()]
    change(folder)
    with tarfile.open(out, "w:gz") as tar:
        tar.add(folder, arcname=folder.name)
    return out


def _set_first(db: Path, table: str, column: str, value: bytes) -> None:
    con = sqlite3.connect(db)
    assert con.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0] > 0, table
    con.execute(f'UPDATE "{table}" SET "{column}" = ? WHERE rowid = (SELECT min(rowid) FROM "{table}")', (value,))
    con.commit()
    con.close()


@pytest.mark.parametrize("store", ["activity", "exchange", "parameter", "preferences"])
def test_a_backup_with_a_value_naming_a_global_is_not_restored(client, token, project, tmp_path, store):
    from bw2data.project import ProjectDataset

    from prism_lca.engine.bootstrap import get_bd

    del project
    db = "PlainModel"
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    for name in ("A", "B"):
        client.post("/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"}, headers=token)
    assert client.post("/api/v1/params", json={"database": db, "name": "mass", "amount": 2.0},
                       headers=token).status_code == 200
    backup = Path(client.post("/api/v1/system/backup", json={"directory": str(tmp_path)},
                              headers=token).json()["path"])
    value = pickle.dumps(NOT_PLAIN[0], protocol=4)

    def change(folder: Path) -> None:
        if store == "activity":
            _set_first(folder / "lci" / "databases.db", "activitydataset", "data", value)
        elif store == "exchange":
            _set_first(folder / "lci" / "databases.db", "exchangedataset", "data", value)
        elif store == "parameter":
            _set_first(folder / "parameters.db", "databaseparameter", "data", value)
        else:
            assert (folder / "preferences.pickle").is_file()
            (folder / "preferences.pickle").write_bytes(value)

    changed = _rewrite(backup, tmp_path / "changed.tar.gz", change)
    r = client.post("/api/v1/projects/restore", json={"path": str(changed), "project_name": "changed-copy"},
                    headers=token)
    assert r.status_code == 400 and r.json()["error"]["code"] == "backup_unreadable", r.text
    projects = get_bd().projects
    assert "changed-copy" not in projects
    assert not projects._project_dir(ProjectDataset(name="changed-copy", full_hash=False)).exists()
