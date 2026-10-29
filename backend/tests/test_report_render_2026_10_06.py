"""V426, V427, V428 — the contribution chapter's foreground
sentence, quotation marks in a deterministic chapter's written comment, and the cover's date."""
from __future__ import annotations

import io
import time
from zoneinfo import ZoneInfo

import pytest

from prism_lca.engine import report_render as rr
from prism_lca.engine import report_typst as rt
from prism_lca.engine import typst_render


def _view(label: str, direct_percent: float | None, total: float = 1.48) -> dict:
    return {
        "method_label": label,
        "dimension": "tag:Bauteil",
        "unit": "kg CO2-Eq",
        "dropped": 0,
        "total": total,
        "direct_percent": direct_percent,
        "direct_text": f"{direct_percent or 0.0:.1f} %",
        "upstream_text": f"{100.0 - (direct_percent or 0.0):.1f} %",
        "groups": [
            {"key": "Silikonpolymer und -öl", "impact": 0.6, "share": 0.411, "share_percent": 41.1,
             "share_text": "41.1 %"},
            {"key": "Entsorgung Dichtstoff", "impact": 0.25, "share": 0.166, "share_percent": 16.6,
             "share_text": "16.6 %"},
        ],
        "subjects": [],
    }


def _contribution(data: dict, lang: str = "en", section: dict | None = None) -> tuple[list[dict], dict]:
    report = {"lang": lang, "sections": [{"id": "c", "kind": "contribution", **(section or {})}]}
    values: dict[str, str] = {}
    blocks = rr.blocks_for(report, {}, {}, None, data, {}, [], values)[0]
    return blocks, values


def _prose(blocks: list[dict]) -> list[str]:
    return [str(b.get("text") or "") for b in blocks if b.get("type") == "prose"]


# ---- V426 -------------------------------------------------------------------------------------------


def test_a_zero_foreground_share_is_said_once_per_chapter_not_under_every_table():
    data = {"contributions": [_view(f"EF v3.1 / indicator {i} / x", 0.0) for i in range(4)]}
    prose = _prose(_contribution(data)[0])
    note = "The foreground processes have no elementary flows of their own"
    assert sum(note in p for p in prose) == 1
    assert not any("directly in the foreground processes" in p for p in prose)
    # At the top of the chapter, right under its heading.
    blocks = _contribution(data)[0]
    assert blocks[0]["type"] == "heading" and note in blocks[1]["text"]


def test_a_mixed_chapter_keeps_the_sentence_where_the_share_is_real():
    data = {"contributions": [
        _view("EF v3.1 / climate change / GWP100", 0.0),
        _view("EF v3.1 / photochemical oxidant formation / NMVOC", 36.5),
        _view("EF v3.1 / water use / deprivation", 0.0),
    ]}
    prose = _prose(_contribution(data)[0])
    # The "no elementary flows at all" note would be false next to NMVOC's 36.5 %.
    assert not any("no elementary flows of their own" in p for p in prose)
    assert sum("Unless a sentence under a table states a direct share" in p for p in prose) == 1
    direct = [p for p in prose if "directly in the foreground processes" in p]
    assert len(direct) == 1 and "36.5 %" in direct[0]


def test_a_snapshot_without_the_percentage_keeps_its_sentence():
    """None is "not recorded", not zero — an old snapshot must not suddenly claim a zero foreground."""
    data = {"contributions": [_view("t / gwp", None)]}
    prose = _prose(_contribution(data)[0])
    assert any("directly in the foreground processes" in p for p in prose)
    assert not any("no elementary flows" in p or "Unless a sentence" in p for p in prose)


def test_the_note_exists_in_every_report_language():
    data = {"contributions": [_view("t / gwp", 0.0)]}
    expected = {
        "de": "Die Vordergrundprozesse haben keine eigenen Elementarflüsse",
        "fr": "Les processus de premier plan n’ont pas de flux élémentaires propres",
        "es": "Los procesos de primer plano no tienen flujos elementales propios",
        "pt": "Os processos de primeiro plano não têm fluxos elementares próprios",
    }
    for lang, text in expected.items():
        assert any(text in p for p in _prose(_contribution(data, lang)[0])), lang


# ---- V427 -------------------------------------------------------------------------------------------


def _pdf_text(pdf: bytes) -> str:
    from pdfminer.high_level import extract_text

    return extract_text(io.BytesIO(pdf))


def test_quotes_in_a_contribution_comment_print_as_the_languages_pair():
    """The comment under a deterministic chapter's tables was resolved without straightening its quotes,
    so a German opener with a straight closer printed „…„ — while the summary, a prose chapter, was fine.
    Three variants: straight pair, mixed pair, mixed pair around resolved placeholders."""
    data = {"contributions": [_view("t / gwp", 0.0)]}
    data["contribution"] = data["contributions"][0]
    text = "\n\n".join([
        'Eins: Die Gruppe "Silikonpolymer und -öl" führt.',
        'Zwei: Die Last der Gruppe „Entsorgung Dichtstoff" hängt am Proxy.',
        'Drei: Die Gruppe „{{contribution.groups.0.key}}" mit {{contribution.groups.0.share_text}} dominiert.',
    ])
    blocks, values = _contribution(data, "de", {"text": text})
    sources = rt.wrap_document(blocks, title="t", study={}, lang="de", values=values)
    pdf = " ".join(_pdf_text(typst_render.compile_pdf(sources)).split())
    assert "Die Gruppe „Silikonpolymer und -öl“ führt." in pdf
    assert "Die Last der Gruppe „Entsorgung Dichtstoff“ hängt" in pdf
    assert "Die Gruppe „Silikonpolymer und -öl“ mit 41.1 % dominiert." in pdf
    assert "„Silikonpolymer und -öl„" not in pdf and "„Entsorgung Dichtstoff„" not in pdf


# ---- V428 -------------------------------------------------------------------------------------------


def test_the_cover_date_is_the_local_day_not_the_utc_day():
    berlin = ZoneInfo("Europe/Berlin")
    # 23:51 UTC on the 5th is 01:51 on the 6th in Berlin — the run that printed the 5th.
    assert rr._local_day("2026-10-05 23:51 UTC", berlin) == "2026-10-06"
    # The preview's stamp: the report's `updated` (UTC isoformat) cut to minutes, no zone left.
    assert rr._local_day("2026-10-05 23:51", berlin) == "2026-10-06"
    assert rr._local_day("2026-10-05T23:51:07.123456+00:00", berlin) == "2026-10-06"
    # Westwards the same instant stays on the 5th.
    assert rr._local_day("2026-10-05 23:51 UTC", ZoneInfo("America/New_York")) == "2026-10-05"
    # A bare day is a day; something unparseable keeps the old behaviour.
    assert rr._local_day("2026-10-05", berlin) == "2026-10-05"
    assert rr._local_day("soon", berlin) == "soon"
    assert rr._local_day("", berlin) == "" and rr._local_day(None, berlin) == ""


@pytest.mark.skipif(not hasattr(time, "tzset"), reason="time.tzset() is Unix-only; Windows runs the injected-timezone test above")
def test_the_cover_reads_this_computers_clock(monkeypatch):
    monkeypatch.setenv("TZ", "Europe/Berlin")
    time.tzset()
    try:
        study = rr._cover_study({}, None, "2026-10-05 23:51 UTC")
        assert study["date"] == "2026-10-06"
        # A date the study states itself is never touched.
        assert rr._cover_study({"date": "October 2026"}, None, "2026-10-05 23:51 UTC")["date"] == "October 2026"
    finally:
        monkeypatch.undo()
        time.tzset()
