"""ecoinvent pedigree matrix → lognormal GSD.

Five data-quality indicators, each scored 1 (best) … 5 (worst); each score maps to a
geometric-standard-deviation factor. The combined GSD95 is
``exp(sqrt( Σ ln(f_i)² + ln(f_basic)² ))`` (Frischknecht et al. / ecoinvent guideline).
"""
from __future__ import annotations

import math

from prism_lca.errors import PrismError

ORDER = ["reliability", "completeness", "temporal", "geographical", "technological"]

# GSD factor per indicator per score (1..5) — pedigree matrix v1 (Frischknecht et al.;
# table as published in Mutel, "The new pedigree matrix numbers", LCA Orlando 2013).
# Geographical score 4 is 1.02 (same as score 3) — a previous 1.00 here was a typo that
# made the row non-monotonic.
FACTORS = {
    "reliability": [1.00, 1.05, 1.10, 1.20, 1.50],
    "completeness": [1.00, 1.02, 1.05, 1.10, 1.20],
    "temporal": [1.00, 1.03, 1.10, 1.20, 1.50],
    "geographical": [1.00, 1.01, 1.02, 1.02, 1.10],
    "technological": [1.00, 1.05, 1.20, 1.50, 2.00],
}


def gsd_from_pedigree(scores: list[int], basic_gsd: float = 1.0) -> float:
    if len(scores) != 5:
        raise PrismError(
            "Pedigree needs exactly 5 scores (reliability, completeness, temporal, "
            "geographical, technological).",
            code="invalid_pedigree",
            status_code=422,
        )
    variance = 0.0
    for indicator, score in zip(ORDER, scores, strict=True):  # both exactly 5 (checked above)
        s = int(score)
        if not 1 <= s <= 5:
            raise PrismError(
                f"Pedigree score for {indicator} must be 1..5, got {s}.",
                code="invalid_pedigree",
                status_code=422,
            )
        variance += math.log(FACTORS[indicator][s - 1]) ** 2
    if basic_gsd and basic_gsd > 1.0:
        variance += math.log(basic_gsd) ** 2
    return math.exp(math.sqrt(variance))
