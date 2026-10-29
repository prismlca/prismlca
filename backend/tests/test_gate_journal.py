"""The gate journal — the only place a REFUSED chapter attempt is written down.

On 2026-08-29 a run finished with three chapters at two attempts each and every one of them stored.
By the next morning nothing could say what any of the three had been refused for: the report keeps
only the accepted text with its advisory findings, the audit log keeps successful stores, and the
app's console log is truncated at every start.
"""
import json

import pytest

from prism_lca.engine import gate_journal

ADVISORY = frozenset({"unverifiable_claim", "value_judgement"})


@pytest.fixture()
def journal(tmp_path, monkeypatch):
    path = tmp_path / "report_gate.jsonl"
    monkeypatch.setattr(gate_journal, "_path", lambda: path)
    return path


def _rows(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _note(**over):
    args = dict(
        database="m", report_id="rep-1", section_id="sec-1", kind="lcia", store=False, ok=False,
        findings=[], advisory_kinds=ADVISORY, text_chars=100, lookups=0, model="x", run="wr-1",
        attempt=1,
    )
    args.update(over)
    gate_journal.note(**args)


def test_a_refused_attempt_is_written_down_with_what_was_wrong(journal):
    """The whole point: the objection that triggered a revision, in a form that can be read back."""
    _note(
        ok=False,
        findings=[
            {"kind": "literal_number", "detail": "The number 250 is the current value of …",
             "sentence": "…in the 250 ml tinplate can."},
            {"kind": "unverifiable_claim", "detail": "The chapter explains causes."},
        ],
    )
    (row,) = _rows(journal)
    assert row["ok"] is False and row["attempt"] == 1 and row["run"] == "wr-1"
    # Blocking findings keep their explanation AND the sentence — without it you know that
    # literal_number fired but not on what.
    assert [f["kind"] for f in row["blocking"]] == ["literal_number"]
    assert "250 ml tinplate can" in row["blocking"][0]["sentence"]
    # Advisory ones are counted, not quoted: they survive on the stored chapter anyway.
    assert row["advisory"] == ["unverifiable_claim"]


def test_the_chapter_text_never_enters_the_file(journal):
    """It rotates and it is diagnostics. The length is enough to see a revision shorten a chapter."""
    _note(text_chars=5741)
    (row,) = _rows(journal)
    assert row["chars"] == 5741
    assert "text" not in row
    assert "5741" not in json.dumps(row["blocking"])


def test_one_run_is_traceable_across_lanes(journal):
    """Eleven lanes interleave in one file; without the run id nothing says which is which."""
    for section, attempt in (("sec-a", 1), ("sec-b", 1), ("sec-a", 2)):
        _note(section_id=section, attempt=attempt)
    _note(section_id="sec-a", attempt=1, run="wr-2")
    rows = _rows(journal)
    first = [r for r in rows if r["run"] == "wr-1"]
    assert len(first) == 3
    assert [r["attempt"] for r in first if r["section"] == "sec-a"] == [1, 2]


def test_it_rotates_instead_of_growing_forever(journal, monkeypatch):
    monkeypatch.setattr(gate_journal, "MAX_BYTES", 4000)
    for i in range(400):
        _note(section_id=f"sec-{i}")
    assert journal.stat().st_size <= 4000
    rows = _rows(journal)
    # The OLD lines are the ones that go: the most recent run is the one being analysed.
    assert rows[-1]["section"] == "sec-399"
    assert len(rows) < 400


def test_a_broken_journal_never_costs_a_chapter(monkeypatch, tmp_path):
    """A gate that fails because its diagnostics failed would be worse than no diagnostics."""
    monkeypatch.setattr(gate_journal, "_path", lambda: tmp_path / "no" / "such" / "dir" / "x.jsonl")
    monkeypatch.setattr(gate_journal.Path, "mkdir", lambda *a, **k: (_ for _ in ()).throw(OSError("nope")))
    _note()  # must not raise


def test_the_findings_of_a_stored_chapter_are_recorded_too(journal):
    """The accepted attempt is a line as well — otherwise "attempt 2 passed" has no counterpart."""
    _note(store=True, ok=True, attempt=2, findings=[{"kind": "unverifiable_claim", "detail": "…"}])
    (row,) = _rows(journal)
    assert row["store"] is True and row["ok"] is True and row["blocking"] == []
