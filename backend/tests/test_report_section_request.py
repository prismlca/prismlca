"""Every section option the store accepts has to be declared on the HTTP schema, or pydantic drops
it before the patch is built and the request answers 200 for nothing."""

from __future__ import annotations

from prism_lca.api.v1.report import SectionRequest


def test_the_section_schema_carries_every_store_option():
    sent = {
        "hotspots": False, "aggregate_by": "tag:stage", "background_tier": False,
        "per_process": 6, "colour_by": "stage", "edge_amounts": True,
    }
    patch = SectionRequest(**sent).model_dump(exclude_unset=True)
    assert patch == sent
