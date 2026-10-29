"""The per-variant groups carried no `share`, so a folded variant's rest group summed
to 0 % beside a non-zero impact."""

from __future__ import annotations

from prism_lca.engine import report_data as rdt


def test_a_folded_variant_rest_group_keeps_its_share():
    entries = [
        {
            "label": "Half",
            "contribution": {
                "aggregation": {
                    "groups": [{"key": k, "impact": v, "share": v} for k, v in (("a", 0.5), ("b", 0.3), ("c", 0.2))]
                }
            },
        }
    ]
    out = rdt._contribution_subjects(entries, "en", keep={"a"})
    rest = next(g for g in out[0]["groups"] if g["key"] == rdt.OTHER_KEY)
    assert rest["share_percent"] == 50.0
    assert rest["share_text"].startswith("50")
