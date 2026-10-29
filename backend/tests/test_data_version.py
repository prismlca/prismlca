"""The data-format stamp (engine/data_version.py).

What it must hold: a directory without a stamp gets one; the same format opens; a NEWER format is
refused with a sentence naming its writer, and the refused directory is not touched; a damaged
stamp does not lock the user out.
"""
from __future__ import annotations

import json

from prism_lca.engine import data_version


def test_a_new_directory_is_stamped(tmp_path):
    target = tmp_path / "data"
    assert data_version.check_and_stamp(target, "0.9.0") is None
    stamp = json.loads((target / data_version.STAMP_FILE).read_text(encoding="utf-8"))
    assert stamp == {"schema": data_version.DATA_SCHEMA, "written_by": "0.9.0"}


def test_the_same_format_opens_and_keeps_its_writer(tmp_path):
    data_version.check_and_stamp(tmp_path, "0.9.0")
    assert data_version.check_and_stamp(tmp_path, "0.9.1") is None
    stamp = json.loads((tmp_path / data_version.STAMP_FILE).read_text(encoding="utf-8"))
    assert stamp["written_by"] == "0.9.0"


def test_a_newer_format_is_refused_and_left_alone(tmp_path):
    path = tmp_path / data_version.STAMP_FILE
    newer = json.dumps({"schema": data_version.DATA_SCHEMA + 1, "written_by": "1.4.0"})
    path.write_text(newer, encoding="utf-8")
    reason = data_version.check_and_stamp(tmp_path, "0.9.0")
    assert reason is not None
    assert "1.4.0" in reason and "0.9.0" in reason and "has not touched it" in reason
    assert path.read_text(encoding="utf-8") == newer


def test_a_damaged_stamp_does_not_lock_the_user_out(tmp_path):
    (tmp_path / data_version.STAMP_FILE).write_text("{not json", encoding="utf-8")
    assert data_version.check_and_stamp(tmp_path, "0.9.0") is None
    stamp = json.loads((tmp_path / data_version.STAMP_FILE).read_text(encoding="utf-8"))
    assert stamp["schema"] == data_version.DATA_SCHEMA


def test_a_brightway_dir_outside_the_data_dir_is_checked_too_and_nothing_is_stamped_on_refusal(tmp_path):
    data, bw = tmp_path / "data", tmp_path / "elsewhere"
    bw.mkdir()
    newer = json.dumps({"schema": data_version.DATA_SCHEMA + 1, "written_by": "1.4.0"})
    (bw / data_version.STAMP_FILE).write_text(newer, encoding="utf-8")
    assert "1.4.0" in data_version.check_and_stamp([data, bw], "0.9.0")
    # The refusal changed nothing anywhere: the data dir got no stamp either.
    assert not (data / data_version.STAMP_FILE).exists()
    assert (bw / data_version.STAMP_FILE).read_text(encoding="utf-8") == newer


def test_both_directories_are_stamped_when_new(tmp_path):
    data, bw = tmp_path / "data", tmp_path / "bw"
    assert data_version.check_and_stamp([data, bw], "0.9.0") is None
    assert (data / data_version.STAMP_FILE).exists() and (bw / data_version.STAMP_FILE).exists()
