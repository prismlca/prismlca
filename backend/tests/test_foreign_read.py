"""Copying another program's files only as they stood at one moment, and never in its way (foreign_read)."""
from __future__ import annotations

import os
import sqlite3

import pytest

from prism_lca.engine import foreign_read
from prism_lca.engine.foreign_read import Changing, Linked, copy_stable


def _tree(root):
    (root / "lci").mkdir(parents=True)
    con = sqlite3.connect(root / "lci" / "databases.db")
    con.execute("CREATE TABLE t (x)")
    con.execute("INSERT INTO t VALUES (1)")
    con.commit()
    con.close()
    (root / "prism_meta").mkdir()
    (root / "prism_meta" / "audit.jsonl").write_text("{}\n", encoding="utf-8")
    return root


def _files(root):
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()}


def test_a_quiet_tree_is_copied_whole(tmp_path):
    src = _tree(tmp_path / "src")
    copy_stable(src, tmp_path / "dst")
    assert _files(tmp_path / "dst") == _files(src)


def test_a_change_while_copying_means_copying_again(tmp_path, monkeypatch):
    src = _tree(tmp_path / "src")
    writes = iter([True])  # the other program commits once, during the first try

    def commit_once(_n):
        if next(writes, False):
            con = sqlite3.connect(src / "lci" / "databases.db")
            con.execute("INSERT INTO t VALUES (2)")
            con.commit()
            con.close()

    copy_stable(src, tmp_path / "dst", commit_once, pause=0)
    rows = sqlite3.connect(tmp_path / "dst" / "lci" / "databases.db").execute("SELECT x FROM t").fetchall()
    assert rows == [(1,), (2,)]  # the state after the commit, never a mix


def test_a_tree_that_never_holds_still_is_given_up_and_nothing_is_left(tmp_path):
    src = _tree(tmp_path / "src")
    counter = iter(range(10**6))

    def keep_writing(_n):
        (src / "prism_meta" / "audit.jsonl").write_text(f"{next(counter)}\n", encoding="utf-8")

    with pytest.raises(Changing):
        copy_stable(src, tmp_path / "dst", keep_writing, attempts=3, pause=0)
    assert not (tmp_path / "dst").exists()


def test_a_transaction_in_flight_is_not_copied(tmp_path):
    src = _tree(tmp_path / "src")
    (src / "lci" / "databases.db-journal").write_bytes(b"x" * 512)  # a write is under way
    with pytest.raises(Changing):
        copy_stable(src, tmp_path / "dst", pause=0)
    assert not (tmp_path / "dst").exists()
    single = tmp_path / "projects.db"
    _db(single)
    (tmp_path / "projects.db-journal").write_bytes(b"x" * 512)
    with pytest.raises(Changing):
        copy_stable(single, tmp_path / "copy.db", pause=0)


def _db(path, wal=False):
    con = sqlite3.connect(path)
    if wal:
        con.execute("PRAGMA journal_mode=WAL")
    con.execute("CREATE TABLE t (x)")
    con.execute("INSERT INTO t VALUES (1)")
    con.commit()
    return con


def test_a_wal_database_somebody_has_open_is_not_copied(tmp_path):
    con = _db(tmp_path / "x.db", wal=True)  # held open: -wal and -shm exist
    try:
        with pytest.raises(Changing):
            copy_stable(tmp_path / "x.db", tmp_path / "copy.db", pause=0)
    finally:
        con.close()
    assert not (tmp_path / "copy.db").exists()
    # Closed, SQLite folds the WAL in and removes it: now there is one consistent file.
    copy_stable(tmp_path / "x.db", tmp_path / "copy.db")
    assert sqlite3.connect(tmp_path / "copy.db").execute("SELECT x FROM t").fetchall() == [(1,)]


def test_a_commit_under_way_at_the_first_look_is_waited_for(tmp_path, monkeypatch):
    src = _tree(tmp_path / "src")
    journal = src / "lci" / "databases.db-journal"
    journal.write_bytes(b"x" * 512)
    monkeypatch.setattr(foreign_read.time, "sleep", lambda _s: journal.unlink())  # the commit ends
    copy_stable(src, tmp_path / "dst")
    assert (tmp_path / "dst" / "lci" / "databases.db").is_file()


def test_an_empty_journal_is_no_transaction(tmp_path):
    src = _tree(tmp_path / "src")
    (src / "lci" / "databases.db-journal").write_bytes(b"")
    copy_stable(src, tmp_path / "dst")
    assert not (tmp_path / "dst" / "lci" / "databases.db-journal").exists()


@pytest.mark.skipif(os.name == "nt", reason="symlinks need privileges on Windows")
def test_a_linked_folder_is_refused_not_skipped(tmp_path):
    src = _tree(tmp_path / "src")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (src / "processed").symlink_to(elsewhere, target_is_directory=True)
    with pytest.raises(Linked):
        copy_stable(src, tmp_path / "dst")
    assert not (tmp_path / "dst").exists()


def test_a_single_file_is_copied_as_it_stood(tmp_path):
    single = tmp_path / "projects.db"
    con = sqlite3.connect(single)
    con.execute("CREATE TABLE projectdataset (name)")
    con.commit()
    con.close()
    copy_stable(single, tmp_path / "copy.db")
    assert (tmp_path / "copy.db").read_bytes() == single.read_bytes()


def test_the_sqlite_change_counter_is_part_of_the_fingerprint(tmp_path):
    db = tmp_path / "x.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE t (x)")
    con.commit()
    before = foreign_read._fingerprint(db)
    con.execute("INSERT INTO t VALUES (1)")
    con.commit()
    con.close()
    assert foreign_read._fingerprint(db)[2] != before[2]


def test_a_commit_that_starts_during_the_copy_is_waited_for_too(tmp_path, monkeypatch):
    src = _tree(tmp_path / "src")
    journal = src / "lci" / "databases.db-journal"
    started = iter([True])

    def begin_once(_n):
        if next(started, False):
            journal.write_bytes(b"x" * 512)  # the other program begins a write mid-copy

    monkeypatch.setattr(foreign_read.time, "sleep", lambda _s: journal.unlink(missing_ok=True))
    copy_stable(src, tmp_path / "dst", begin_once)
    assert (tmp_path / "dst" / "lci" / "databases.db").is_file()
    assert not (tmp_path / "dst" / "lci" / "databases.db-journal").exists()
