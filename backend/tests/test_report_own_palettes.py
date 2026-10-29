"""Colour sets of your own: a name and three colours, kept for the whole installation.

The shipped sets are fixed per version; these are added from the report's Appearance panel and offered to
every report on the computer from then on. What has to hold: they reach the document like a shipped set,
they are checked on the way in rather than at compile time, and losing one never costs a report its render.
"""
from __future__ import annotations

import pytest

from prism_lca.config import get_settings
from prism_lca.engine import report_palettes


@pytest.fixture(autouse=True)
def _no_own_sets():
    """Every test starts and ends without sets of its own — the file lives in the worker's data directory,
    which every other test in the process shares, and the catalogue tests count the shipped sets."""
    path = report_palettes._user_path()
    path.unlink(missing_ok=True)
    yield
    path.unlink(missing_ok=True)


def _add(client, token, **over):
    body = {"label": "House style", "accent": "#e4572e", "deep": "#17324d", "paper": "#fbf8f2", **over}
    return client.post("/api/v1/report/palettes", json=body, headers=token)


def test_a_set_of_your_own_joins_the_catalogue_after_the_shipped_ones(client, token):
    r = _add(client, token)
    assert r.status_code == 200, r.text
    own = r.json()["palette"]
    assert own["id"].startswith("own-")
    assert own["label"] == "House style"
    assert own["swatches"] == ["#e4572e", "#17324d", "#fbf8f2"]
    assert own["builtin"] is False

    listed = client.get("/api/v1/report/palettes", headers=token).json()["palettes"]
    shipped = [p["id"] for p in report_palettes.PALETTES]
    # The shipped sets keep their places — the default first — and the own one follows them.
    assert [p["id"] for p in listed] == [*shipped, own["id"]]
    assert all(p["builtin"] for p in listed[: len(shipped)])


def test_it_belongs_to_the_installation_not_to_a_workspace(client, token):
    """Stored under the data directory, beside nothing a workspace owns: a house style is chosen once."""
    _add(client, token)
    path = report_palettes._user_path()
    assert path.exists()
    assert path.parent == get_settings().data_dir / "prism_meta"


def test_a_report_typeset_in_it_gets_its_three_colours_over_the_default_neutrals(client, token):
    own = _add(client, token).json()["palette"]
    typ = report_palettes.palette_typst(own["id"])
    assert '#let prism-green = rgb("#e4572e")' in typ
    assert '#let prism-navy = rgb("#17324d")' in typ
    assert '#let paper = rgb("#fbf8f2")' in typ
    # The greys and the mark are the default set's, as they are under a report's own three colours.
    default = report_palettes.resolve(report_palettes.DEFAULT_PALETTE)["colors"]
    for key in ("prism-accent2", "prism-ink", "prism-text", "prism-gray", "prism-line", "prism-muted"):
        assert f'#let {key} = rgb("{default[key]}")' in typ
    assert "House style" in typ  # the header names the set it was written from


def test_it_typesets_in_every_shipped_theme(client, token):
    from prism_lca.engine import typst_render

    own = _add(client, token).json()["palette"]
    for theme in typst_render.BUILTIN_TEMPLATES:
        typst_render.validate_template(typst_render.builtin_template_source(theme), palette=own["id"])


def test_a_short_hex_is_stored_in_six_digits(client, token):
    """The colour well beside the field only takes `#rrggbb`; one spelling per colour on disk."""
    own = _add(client, token, accent="#E52", deep="#123", paper="#fff").json()["palette"]
    assert own["swatches"] == ["#ee5522", "#112233", "#ffffff"]


@pytest.mark.parametrize(
    ("over", "code"),
    [
        ({"label": "   "}, "palette_name_missing"),
        ({"label": "x" * 41}, "palette_name_too_long"),
        ({"label": "prismlca"}, "palette_name_taken"),  # a shipped set's name, in any case
        ({"accent": "green"}, "report_color_invalid"),
        ({"paper": ""}, "palette_color_missing"),
    ],
)
def test_what_is_refused_on_the_way_in(client, token, over, code):
    r = _add(client, token, **over)
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == code
    assert not report_palettes.user_palettes()


def test_two_own_sets_cannot_share_a_name(client, token):
    assert _add(client, token).status_code == 200
    r = _add(client, token, label="  house   STYLE ")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "palette_name_taken"


def test_deleting_one_sends_its_reports_back_to_the_default(client, token):
    own = _add(client, token).json()["palette"]
    r = client.post(f"/api/v1/report/palettes/{own['id']}/delete", headers=token)
    assert r.status_code == 200, r.text
    assert own["id"] not in [p["id"] for p in client.get("/api/v1/report/palettes", headers=token).json()["palettes"]]
    # A report still naming it renders — in the default set, as for any set that is gone.
    assert report_palettes.resolve(own["id"])["id"] == report_palettes.DEFAULT_PALETTE


def test_the_shipped_sets_cannot_be_deleted_and_an_unknown_one_is_a_404(client, token):
    r = client.post("/api/v1/report/palettes/prism/delete", headers=token)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "palette_builtin"
    r = client.post("/api/v1/report/palettes/own-nope/delete", headers=token)
    assert r.status_code == 404
