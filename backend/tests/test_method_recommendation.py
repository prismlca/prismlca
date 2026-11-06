from prism_lca.engine.lca import _is_recommended


def test_standard_indicators_are_recommended():
    assert _is_recommended("IPCC 2021 · climate change: total (excl. biogenic CO2) · global warming potential (GWP100)")
    assert _is_recommended("EF v3.1 · acidification · accumulated exceedance (AE)")
    assert _is_recommended("EF v3.1 · climate change · global warming potential (GWP100)")
    assert _is_recommended("EF v3.1 · water use · user deprivation potential (deprivation-weighted water consumption)")
    # ReCiPe's endpoint INDICATORS are named "climate change: …" but belong to another category —
    # the sub-split rule tests the category segment only, so these must survive it.
    assert _is_recommended("ReCiPe 2016 v1.03, endpoint (H) · human health · climate change: human health")
    assert _is_recommended("ReCiPe 2016 v1.03, endpoint (H) · ecosystem quality · climate change: terrestrial ecosystems")


def test_specialist_variants_are_not_recommended():
    # The exact trap from the consultant simulation: a biogenic-only GWP (~20x off vs total).
    assert not _is_recommended("IPCC 2021 (incl. biogenic CO2) · climate change: biogenic (incl. CO2) · global warming potential (GWP100)")
    assert not _is_recommended("IPCC 2021 · climate change: total (excl. biogenic CO2) · global warming potential (GWP20)")
    assert not _is_recommended("IPCC 2021 · climate change: total (excl. biogenic CO2) · global warming potential (GWP500)")
    assert not _is_recommended("IPCC 2021 · climate change: total (excl. biogenic CO2) · global temperature change potential (GTP100)")
    assert not _is_recommended("EF v3.1 no LT · acidification no LT · accumulated exceedance (AE) no LT")
    assert not _is_recommended("EF v3.1 · climate change: fossil · global warming potential (GWP100)")
    assert not _is_recommended("EF v3.1 · climate change: land use and land use change · global warming potential (GWP100)")
    assert not _is_recommended("IPCC 2021 · climate change: including SLCFs · global warming potential (GWP100)")
    # ecoinvent 3.12's IPCC 2021 splits that no named marker caught — "aircraft emissions" sorts
    # first among the recommended ones and is ~7 orders of magnitude below the total, so an
    # assistant that took the first recommended hit computed nonsense.
    assert not _is_recommended("IPCC 2021 · climate change: aircraft emissions · global warming potential (GWP100)")
    assert not _is_recommended("IPCC 2021 · climate change: direct land use change · global warming potential (GWP100)")
    assert not _is_recommended("IPCC 2021 · climate change: emissions from direct land use change · global warming potential (GWP100)")
    assert not _is_recommended("IPCC 2021 · climate change: removals from direct land use change · global warming potential (GWP100)")


def test_the_ghg_protocol_family_is_not_a_second_recommended_total():
    """ecoinvent 3.13 adds 'IPCC 2021 (GHG Protocol mandatory)': the seven Kyoto gases split for GHG
    Protocol reporting. Its 'total mandatory GHGs' passes the shape rule (it starts with "total") but
    leaves out every other greenhouse gas, so it is not the carbon footprint the flag steers to — two
    recommended IPCC totals with different numbers is exactly the ambiguity the flag exists to remove."""
    ghg = "IPCC 2021 (GHG Protocol mandatory)"
    assert not _is_recommended(f"{ghg} · climate change: total mandatory GHGs (excl. biogenic CO2) · global warming potential (GWP100)")
    assert not _is_recommended(f"{ghg} · climate change: CH4 · global warming potential (GWP100)")
    assert not _is_recommended(f"{ghg} no LT · climate change: CO2, fossil no LT · global warming potential (GWP100) no LT")
    assert _is_recommended("IPCC 2021 · climate change: total (excl. biogenic CO2) · global warming potential (GWP100)")
