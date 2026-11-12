"""A model rename logs its seconds per step, as one INFO line that names steps and nothing else (V469)."""
from __future__ import annotations

import logging
import re
import uuid

from prism_lca.engine.step_timing import StepTimer


def test_a_timer_reports_each_step_in_order_and_their_sum():
    timer = StepTimer("model rename")
    timer.done("parameters saved")
    timer.done("database rewritten")
    names = [name for name, _ in timer.steps]
    assert names == ["parameters saved", "database rewritten"]
    assert timer.total == sum(secs for _, secs in timer.steps)
    assert re.fullmatch(
        r"model rename: \d+\.\d\d s — parameters saved \d+\.\d\d s, database rewritten \d+\.\d\d s", timer.line()
    )


def test_a_rename_logs_every_step_and_no_model_name(client, token, project, caplog):
    del project
    db = "secret-study-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    with caplog.at_level(logging.INFO, logger="prism_lca.engine.brightway_repository"):
        r = client.post(
            "/api/v1/databases/foreground/rename", json={"database": db, "name": db + "-renamed"}, headers=token
        )
    assert r.status_code == 200, r.text
    lines = [rec.getMessage() for rec in caplog.records if rec.getMessage().startswith("model rename")]
    assert len(lines) == 1, caplog.text
    line = lines[0]
    assert caplog.records[-1].levelno == logging.INFO
    for step in (
        "inventory rows renamed",
        "parameters renamed",
        "registry updated",
        "arrays processed",
        "store chats",
        "store reports",
        "calculation caches cleared",
    ):
        assert f"{step} " in line, line
    # The model's names stay out of the log: a name can say whose study it is.
    assert "secret-study" not in line


def test_the_backend_shows_its_own_info_lines_once(monkeypatch):
    from prism_lca import server

    logger = logging.getLogger("prism_lca")
    root = logging.getLogger()
    monkeypatch.setattr(logger, "handlers", [])
    monkeypatch.setattr(logger, "level", logging.NOTSET)
    root_before = (list(root.handlers), root.level)
    server._show_own_log_lines()
    server._show_own_log_lines()
    assert len(logger.handlers) == 1
    assert logging.getLogger("prism_lca.engine.brightway_repository").isEnabledFor(logging.INFO)
    # Libraries keep their own level: the handler sits on our package, the root is left as it was.
    assert (list(root.handlers), root.level) == root_before
