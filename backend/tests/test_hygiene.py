"""What a project must not accumulate on a user's machine — the residue found in a development
project, each with the change that stops it from arising and the sweep for what an
older version already left."""
from __future__ import annotations

import base64
import uuid
from pathlib import Path

from prism_lca.engine import attachments, hygiene
from prism_lca.engine.attachments import SourceIndex
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.chat_store import ChatStore


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _attach(client, token, name: str, data: bytes) -> str:
    r = client.post(
        "/api/v1/files/attachments",
        json={"name": name, "data_b64": base64.b64encode(data).decode("ascii")},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


# --- bw2data's full-text index ---------------------------------------------------------------------

def test_a_new_model_never_grows_a_bw2data_search_index(client, token, project):
    """bw2data reads a missing `searchable` flag as True and maintains an FTS file per save. PrismLCA has
    its own index, so every database is registered with the flag off — and nothing under `search/`."""
    del project
    bd = get_bd()
    db = _fg(client, token)
    assert bd.databases[db].get("searchable") is False
    # A save is what used to create the index file; with the flag off bw2data never touches it.
    act = bd.Database(db).new_activity(code="a1", name="a process", unit="kg", type="process")
    act.save()
    index_dir = Path(bd.projects.dir) / "search"
    assert not index_dir.exists() or not any(p.name.startswith(bd.Database(db).filename) for p in index_dir.iterdir())


def test_the_library_and_a_duplicate_carry_the_flag_too(client, token, project):
    del project
    from prism_lca.engine.library import ensure_library

    bd = get_bd()
    lib = ensure_library()
    assert bd.databases[lib].get("searchable") is False
    src = _fg(client, token)
    r = client.post("/api/v1/databases/foreground/duplicate", json={"source": src, "name": src + "-copy"}, headers=token)
    assert r.status_code == 200, r.text
    assert bd.databases[src + "-copy"].get("searchable") is False


def test_the_sweep_retires_an_index_an_older_version_left(client, token, project):
    """A project from before the flag: databases say nothing (= searchable) and `search/` holds
    their index files. One sweep turns the flag off everywhere and removes the directory."""
    del project
    bd = get_bd()
    db = _fg(client, token)
    del bd.databases[db]["searchable"]
    bd.databases.flush()
    index_dir = Path(bd.projects.dir) / "search"
    index_dir.mkdir(exist_ok=True)
    (index_dir / bd.Database(db).filename).write_bytes(b"sqlite-ish")

    assert hygiene.retire_search_indices() >= 1
    assert bd.databases[db].get("searchable") is False
    assert not index_dir.exists()
    # idempotent: a second sweep has nothing to do
    assert hygiene.retire_search_indices() == 0


# --- attachments live as long as a message names them ------------------------------------------------

def test_an_attachment_lives_exactly_as_long_as_the_last_message_naming_it(client, token, project, monkeypatch):
    del project
    monkeypatch.setattr(attachments, "GRACE_SECONDS", 0)
    db = _fg(client, token)
    cited = _attach(client, token, "spec.txt", b"the specification")
    orphan = _attach(client, token, "notes.txt", b"never sent")
    chat = client.post(f"/api/v1/ai/chats/{db}", json={"title": "t"}, headers=token).json()
    r = client.post(
        f"/api/v1/ai/chats/{db}/{chat['id']}/messages",
        json={"messages": [{"role": "user", "content": "see file", "attachments": [{"id": cited, "name": "spec.txt"}]}]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert ChatStore().attachment_ids() == {cited}

    removed = attachments.prune_unreferenced()
    assert removed == [orphan]
    assert SourceIndex().get(orphan) is None
    assert not attachments.path_of(orphan).exists()
    assert SourceIndex().get(cited) is not None and attachments.path_of(cited).exists()

    # Deleting the chat is what ends the cited one — the route prunes on its own.
    assert client.post(f"/api/v1/ai/chats/{db}/{chat['id']}/delete", headers=token).status_code == 200
    assert SourceIndex().get(cited) is None
    assert not attachments.path_of(cited).exists()


def test_deleting_a_model_frees_what_only_its_chats_cited(client, token, project, monkeypatch):
    del project
    monkeypatch.setattr(attachments, "GRACE_SECONDS", 0)
    db_a, db_b = _fg(client, token), _fg(client, token)
    shared = _attach(client, token, "shared.txt", b"cited from both models")
    only_a = _attach(client, token, "only-a.txt", b"cited from a alone")
    for db, ids in ((db_a, [shared, only_a]), (db_b, [shared])):
        chat = client.post(f"/api/v1/ai/chats/{db}", json={"title": "t"}, headers=token).json()
        client.post(
            f"/api/v1/ai/chats/{db}/{chat['id']}/messages",
            json={"messages": [{"role": "user", "content": "x", "attachments": [{"id": i, "name": i} for i in ids]}]},
            headers=token,
        )
    assert client.post("/api/v1/databases/foreground/delete", json={"database": db_a}, headers=token).status_code == 200
    assert SourceIndex().get(only_a) is None and not attachments.path_of(only_a).exists()
    assert SourceIndex().get(shared) is not None and attachments.path_of(shared).exists()


def test_a_fresh_upload_survives_a_prune_it_did_not_cause(client, token, project):
    """Attached a moment ago, message still being typed: deleting some other chat must not take it."""
    del project
    fresh = _attach(client, token, "fresh.txt", b"about to be sent")
    assert attachments.prune_unreferenced() == []  # default grace keeps it
    assert SourceIndex().get(fresh) is not None


# --- the migration marker ------------------------------------------------------------------------------

def test_a_project_with_nothing_to_migrate_gets_no_marker_file(client, token, project):
    del project
    from prism_lca.engine import params as _p

    _fg(client, token)  # creating a model is what triggers the (guarded) migration
    assert _p.migrate_project_to_models() is False
    assert not (Path(get_bd().projects.dir) / "prism_meta" / "param_scope_migrated.json").exists()


# --- the files bw2data keeps beside SQLite and never removes -------------------------------------------

def _processed_zip(name: str) -> Path:
    db = get_bd().Database(name)
    return Path(db.dirpath_processed()) / db.filename_processed()


def test_deleting_a_model_takes_its_processed_arrays_along(client, token, project):
    """bw2data's `Database.delete()` removes rows and index and leaves the zip bw2calc loaded — one
    per deleted model, for ever. Sixty of them were found in one development project."""
    del project
    db = _fg(client, token)
    zip_path = _processed_zip(db)
    assert zip_path.exists(), "register() writes an empty database, and that is processed at once"
    assert client.post("/api/v1/databases/foreground/delete", json={"database": db}, headers=token).status_code == 200
    assert not zip_path.exists()


def test_renaming_a_model_leaves_no_zip_under_the_old_name(client, token, project):
    del project
    db = _fg(client, token)
    old_zip = _processed_zip(db)
    assert old_zip.exists()
    r = client.post("/api/v1/databases/foreground/rename", json={"database": db, "name": db + "-new"}, headers=token)
    assert r.status_code == 200, r.text
    assert not old_zip.exists()
    assert _processed_zip(db + "-new").exists()


def test_deleting_a_custom_method_takes_its_zip_and_pickle_along(client, token, project):
    """`Method.deregister()` says it in its docstring: 'Does not delete any files.' Four such pairs sat
    in one development project for a family deleted weeks earlier."""
    del project
    bd = get_bd()
    r = client.post("/api/v1/lcia/method", json={"family": "hygiene fam", "name": "m1", "unit": "kg"}, headers=token)
    assert r.status_code == 200, r.text
    key = ("hygiene fam", "m1")
    stem = bd.Method(key).filename
    root = Path(bd.projects.dir)
    files = [root / "processed" / f"{stem}.zip", root / "intermediate" / f"{stem}.pickle"]
    assert all(f.exists() for f in files), [str(f) for f in files]
    assert client.post("/api/v1/lcia/delete", json={"method": list(key)}, headers=token).status_code == 200
    assert not any(f.exists() for f in files)
    assert key not in bd.methods

    # …and deleting a whole family walks the same path for every method in it
    for name in ("a", "b"):
        assert client.post("/api/v1/lcia/method", json={"family": "hygiene fam2", "name": name, "unit": "kg"}, headers=token).status_code == 200
    stems = [bd.Method(("hygiene fam2", n)).filename for n in ("a", "b")]
    assert client.post("/api/v1/lcia/family/delete", json={"family": "hygiene fam2"}, headers=token).status_code == 200
    for stem in stems:
        assert not (root / "processed" / f"{stem}.zip").exists()
        assert not (root / "intermediate" / f"{stem}.pickle").exists()



def test_exchanges_an_older_importer_left_without_a_uid_get_one_once(client, token, project):
    """Models imported by older versions have uid-less exchanges and cannot be edited. The
    sweep heals a writable database once and flags it; backgrounds are left alone."""
    from prism_lca.engine.model import UIDS_KEY

    bd = get_bd()
    db = _fg(client, token)
    act = bd.Database(db).new_activity(code="p", name="p", unit="kg", type="process")
    act.save()
    act.new_edge(input=act, amount=1.0, type="production").save()  # no prism_uid, like the old import
    bd.Database("bg-old").write({("bg-old", "x"): {"name": "x", "unit": "kg", "exchanges": []}})

    assert hygiene.backfill_exchange_uids() >= 1
    assert all(ex.get("prism_uid") for ex in bd.Database(db).get("p").exchanges())
    assert bd.databases[db].get(UIDS_KEY) is True
    assert not bd.databases["bg-old"].get(UIDS_KEY)  # read-only background: never touched
    assert hygiene.backfill_exchange_uids() == 0  # flagged: the next start costs a metadata read


def test_the_uid_sweep_holds_the_workspace_lock_while_it_writes(client, token, project, monkeypatch):
    """A switch rebinds bw2data under any exchange still held, so a save after it lands in the other
    workspace. The sweep runs after activation released the lock; it must take it itself, so that a
    concurrent switch waits."""
    import threading

    from prism_lca.engine import model as model_module
    from prism_lca.engine.commands import PROJECT_LOCK

    _fg(client, token)
    blocked: list[bool] = []

    def probe(name: str, codes=None) -> int:  # noqa: ANN001 - test double
        got: list[bool] = []

        def switch() -> None:  # what activate_project does first
            if PROJECT_LOCK.acquire(timeout=0.2):
                got.append(True)
                PROJECT_LOCK.release()  # an RLock is released by the thread that holds it
            else:
                got.append(False)

        t = threading.Thread(target=switch)
        t.start()
        t.join()
        blocked.append(not got[0])
        return 0

    monkeypatch.setattr(model_module, "ensure_exchange_uids", probe)
    hygiene.backfill_exchange_uids()
    assert blocked and all(blocked)  # a switch could not get in while any database was swept
