"""Reading a workspace backup: only regular files and folders, inside the target folder, within set limits."""
from __future__ import annotations

import io
import json
import tarfile
from pathlib import Path

import pytest

from prism_lca.engine import backup_archive
from prism_lca.errors import PrismError


def _dir(name: str) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.type = tarfile.DIRTYPE
    info.mode = 0o755
    return info


def _file(name: str, data: bytes = b"x") -> tuple[tarfile.TarInfo, bytes]:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    return info, data


def _link(name: str, target: str, kind: bytes) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.type = kind
    info.linkname = target
    return info


def _archive(path: Path, *members, fmt: int = tarfile.PAX_FORMAT) -> Path:
    """A .tar.gz of ``members``: TarInfo for folders and links, (TarInfo, bytes) for files."""
    with tarfile.open(path, "w:gz", format=fmt) as tar:
        for member in members:
            if isinstance(member, tuple):
                tar.addfile(member[0], io.BytesIO(member[1]))
            else:
                tar.addfile(member)
    return path


def _workspace(*extra) -> tuple:
    return (_dir("ws"), _file("ws/.project-name.json", json.dumps({"name": "ws"}).encode()), *extra)


def _unpack(tmp_path: Path, *members, fmt: int = tarfile.PAX_FORMAT):
    into = tmp_path / "into"
    into.mkdir()
    return backup_archive.unpack(_archive(tmp_path / "b.tar.gz", *members, fmt=fmt), into)


def test_a_backup_of_files_and_folders_unpacks_with_its_size(tmp_path):
    out = _unpack(tmp_path, *_workspace(_dir("ws/lci"), _file("ws/lci/databases.db", b"12345")))
    assert out.folder == tmp_path / "into" / "ws"
    assert (out.folder / "lci" / "databases.db").read_bytes() == b"12345"
    assert out.size == len(json.dumps({"name": "ws"})) + 5


@pytest.mark.parametrize("kind", [tarfile.SYMTYPE, tarfile.LNKTYPE])
def test_only_regular_files_and_folders_are_unpacked(tmp_path, kind):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "kept.txt").write_text("unchanged")
    target = str(elsewhere) if kind == tarfile.SYMTYPE else "ws/.project-name.json"
    with pytest.raises(PrismError) as exc:
        _unpack(tmp_path, *_workspace(_link("ws/l", target, kind), _file("ws/l/new.txt")))
    assert exc.value.code == "backup_unreadable"
    assert sorted(p.name for p in elsewhere.iterdir()) == ["kept.txt"]
    assert not (tmp_path / "into" / "ws" / "l").exists()


@pytest.mark.parametrize("kind", [tarfile.FIFOTYPE, tarfile.CHRTYPE])
def test_special_members_are_refused(tmp_path, kind):
    info = tarfile.TarInfo("ws/special")
    info.type = kind
    with pytest.raises(PrismError) as exc:
        _unpack(tmp_path, *_workspace(info))
    assert exc.value.code == "backup_unreadable"


def test_sparse_members_are_refused(tmp_path):
    info, data = _file("ws/data.bin", b"")
    info.type = tarfile.GNUTYPE_SPARSE
    with pytest.raises(PrismError) as exc:
        _unpack(tmp_path, *_workspace((info, data)), fmt=tarfile.GNU_FORMAT)
    assert exc.value.code == "backup_unreadable"


@pytest.mark.parametrize("name", ["../outside.txt", "ws/../../outside.txt"])
def test_member_names_stay_inside_the_target_folder(tmp_path, name):
    with pytest.raises(PrismError) as exc:
        _unpack(tmp_path, *_workspace(_file(name)))
    assert exc.value.code == "backup_unreadable"
    assert not (tmp_path / "outside.txt").exists()


def test_an_absolute_member_name_lands_inside_the_target_folder(tmp_path):
    absolute = tmp_path / "absolute.txt"
    try:
        _unpack(tmp_path, *_workspace(_file(str(absolute))))
    except PrismError:
        pass
    assert not absolute.exists()


def test_the_member_count_is_capped(tmp_path, monkeypatch):
    monkeypatch.setattr(backup_archive, "MAX_MEMBERS", 3)
    with pytest.raises(PrismError) as exc:
        _unpack(tmp_path, *_workspace(_file("ws/a"), _file("ws/b")))
    assert exc.value.code == "backup_unreadable"
    with pytest.raises(PrismError):
        backup_archive.read_name(_archive(tmp_path / "late.tar.gz", _dir("ws"), _file("ws/a"), _file("ws/b"),
                                          _file("ws/.project-name.json", b'{"name": "late"}')))


def test_the_bytes_written_are_capped_by_the_free_space(tmp_path, monkeypatch):
    monkeypatch.setattr(backup_archive, "room_on", lambda where: 1000)
    with pytest.raises(PrismError) as exc:
        _unpack(tmp_path, *_workspace(_file("ws/a", bytes(600)), _file("ws/b", bytes(600))))
    assert exc.value.code == "backup_no_room"
    assert not (tmp_path / "into" / "ws" / "b").exists()


def test_room_keeps_the_reserve_free(tmp_path, monkeypatch):
    monkeypatch.setattr(backup_archive, "RESERVE", 0)
    free = backup_archive.room_on(tmp_path)
    backup_archive.assert_room(free, tmp_path)
    with pytest.raises(PrismError) as exc:
        backup_archive.assert_room(free + 10**9, tmp_path)
    assert exc.value.code == "backup_no_room"


def test_the_name_is_read_from_a_small_regular_file_only(tmp_path):
    assert backup_archive.read_name(_archive(tmp_path / "a.tar.gz", *_workspace())) == "ws"
    big = json.dumps({"name": "x" * backup_archive.MAX_NAME_FILE}).encode()
    with pytest.raises(PrismError) as exc:
        backup_archive.read_name(_archive(tmp_path / "b.tar.gz", _dir("ws"), _file("ws/.project-name.json", big)))
    assert exc.value.code == "backup_unreadable"
    for body in (b"[1]", b"{}", b"not json"):
        with pytest.raises(PrismError):
            backup_archive.read_name(_archive(tmp_path / "c.tar.gz", _dir("ws"),
                                              _file("ws/.project-name.json", body)))


def test_more_than_one_top_folder_is_not_a_backup(tmp_path):
    with pytest.raises(PrismError) as exc:
        _unpack(tmp_path, *_workspace(_dir("other")))
    assert exc.value.code == "backup_unreadable"


# Through the route: nothing is written outside the new workspace, and no workspace is registered.


def _restore(client, token, path: Path, **body):
    return client.post("/api/v1/projects/restore", json={"path": str(path), **body}, headers=token)


def test_a_refused_backup_registers_no_workspace_and_leaves_no_folder(client, token, project, tmp_path):
    from bw2data.project import ProjectDataset

    from prism_lca.engine.bootstrap import get_bd

    del project
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    path = _archive(tmp_path / "b.tar.gz", *_workspace(
        _link("ws/l", str(elsewhere), tarfile.SYMTYPE), _file("ws/l/new.txt"),
    ))
    r = _restore(client, token, path, project_name="refused-ws")
    assert r.status_code == 400 and r.json()["error"]["code"] == "backup_unreadable", r.text
    assert list(elsewhere.iterdir()) == []
    projects = get_bd().projects
    assert "refused-ws" not in projects
    assert not projects._project_dir(ProjectDataset(name="refused-ws", full_hash=False)).exists()


def test_the_overwrite_is_checked_like_a_new_workspace(client, token, project, tmp_path):
    from prism_lca.engine.bootstrap import get_bd

    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    path = _archive(tmp_path / "b.tar.gz", *_workspace(
        _link("ws/l", str(elsewhere), tarfile.SYMTYPE), _file("ws/l/new.txt"),
    ))
    r = _restore(client, token, path, project_name=project, overwrite=True)
    assert r.status_code == 400 and r.json()["error"]["code"] == "backup_unreadable", r.text
    assert list(elsewhere.iterdir()) == []
    assert get_bd().projects.current == project


def test_a_name_clash_is_refused_before_the_archive_is_unpacked(client, token, project, tmp_path, monkeypatch):
    """The app's first round asks without a name; the clash must come back at once, not after the unpacking."""
    def never(*a, **k):
        raise AssertionError("unpacked although the name was taken")

    monkeypatch.setattr(backup_archive, "unpack", never)
    path = _archive(tmp_path / "b.tar.gz", _dir("ws"),
                    _file("ws/.project-name.json", json.dumps({"name": project}).encode()))
    r = _restore(client, token, path)
    assert r.status_code == 409 and r.json()["error"]["code"] == "workspace_exists", r.text


def test_the_locks_are_free_while_the_archive_is_unpacked(client, token, project, tmp_path, monkeypatch):
    from prism_lca.engine import commands, lca

    del project
    seen: list[bool] = []
    real = backup_archive.unpack

    def watching(fp, into):
        for lock in (lca._LCA_LOCK, commands.PROJECT_LOCK):
            took = lock.acquire(blocking=False)
            seen.append(took)
            if took:
                lock.release()
        return real(fp, into)

    monkeypatch.setattr(backup_archive, "unpack", watching)
    path = client.post("/api/v1/system/backup", json={"directory": str(tmp_path)}, headers=token).json()["path"]
    r = _restore(client, token, Path(path), project_name="unlocked-copy")
    assert r.status_code == 200, r.text
    assert seen == [True, True]


def test_a_backup_larger_than_the_free_space_is_refused(client, token, project, tmp_path, monkeypatch):
    from prism_lca.engine.bootstrap import get_bd

    del project
    path = client.post("/api/v1/system/backup", json={"directory": str(tmp_path)}, headers=token).json()["path"]
    monkeypatch.setattr(backup_archive, "room_on", lambda where: 100)
    r = _restore(client, token, Path(path), project_name="no-room-copy")
    assert r.status_code == 507 and r.json()["error"]["code"] == "backup_no_room", r.text
    assert "no-room-copy" not in get_bd().projects


def test_an_overwrite_puts_the_backup_over_the_workspace(client, token, project, tmp_path):
    from prism_lca.engine.bootstrap import get_bd

    def add(db: str) -> None:
        assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200

    add("Kept")
    path = client.post("/api/v1/system/backup", json={"directory": str(tmp_path)}, headers=token).json()["path"]
    add("Added later")
    r = _restore(client, token, Path(path), project_name=project, overwrite=True)
    assert r.status_code == 200, r.text
    bd = get_bd()
    assert bd.projects.current == project
    assert "Kept" in bd.databases and "Added later" not in bd.databases
    assert not (Path(bd.projects.dir) / "project-metadata.json").exists()


@pytest.mark.parametrize("fmt", [tarfile.PAX_FORMAT, tarfile.GNU_FORMAT])
def test_extension_headers_are_capped_before_they_are_read(tmp_path, fmt):
    info, data = _file("ws/" + "n" * (backup_archive.MAX_EXTENSION_HEADER + 1))
    path = _archive(tmp_path / "b.tar.gz", *_workspace((info, data)), fmt=fmt)
    into = tmp_path / "into"
    into.mkdir()
    with pytest.raises(PrismError) as exc:
        backup_archive.unpack(path, into)
    assert exc.value.code == "backup_unreadable"
    late = _archive(tmp_path / "late.tar.gz", _dir("ws"), (info, data),
                    _file("ws/.project-name.json", b'{"name": "late"}'), fmt=fmt)
    with pytest.raises(PrismError):
        backup_archive.read_name(late)


def test_sparse_maps_in_extension_headers_are_refused(tmp_path):
    info, data = _file("ws/data.bin", b"")
    info.pax_headers = {"GNU.sparse.major": "1", "GNU.sparse.minor": "0", "GNU.sparse.name": "ws/data.bin",
                        "GNU.sparse.realsize": "1048576"}
    with pytest.raises(PrismError) as exc:
        _unpack(tmp_path, *_workspace((info, data)))
    assert exc.value.code == "backup_unreadable"


def test_reading_the_name_stops_once_the_backup_outgrows_the_room(tmp_path, monkeypatch):
    path = _archive(tmp_path / "b.tar.gz", _dir("ws"), _file("ws/a", bytes(2000)),
                    _file("ws/.project-name.json", b'{"name": "late"}'))
    assert backup_archive.read_name(path) == "late"
    monkeypatch.setattr(backup_archive, "room_on", lambda where: 1000)
    with pytest.raises(PrismError) as exc:
        backup_archive.read_name(path)
    assert exc.value.code == "backup_no_room"


def test_global_extension_headers_are_refused(tmp_path):
    path = tmp_path / "b.tar.gz"
    with tarfile.open(path, "w:gz", format=tarfile.PAX_FORMAT, pax_headers={"comment": "global"}) as tar:
        top, (name_file, name_data) = _workspace()
        tar.addfile(top)
        tar.addfile(name_file, io.BytesIO(name_data))
    into = tmp_path / "into"
    into.mkdir()
    with pytest.raises(PrismError) as exc:
        backup_archive.unpack(path, into)
    assert exc.value.code == "backup_unreadable"
    with pytest.raises(PrismError):
        backup_archive.read_name(path)


def test_extension_headers_are_capped_in_total(tmp_path, monkeypatch):
    long_names = [_file("ws/" + f"{i:03d}" + "n" * 200) for i in range(20)]
    (tmp_path / "fits").mkdir()
    _unpack(tmp_path / "fits", *_workspace(*long_names))
    monkeypatch.setattr(backup_archive, "MAX_EXTENSION_TOTAL", 2000)
    (tmp_path / "too-much").mkdir()
    with pytest.raises(PrismError) as exc:
        _unpack(tmp_path / "too-much", *_workspace(*long_names))
    assert exc.value.code == "backup_unreadable"
