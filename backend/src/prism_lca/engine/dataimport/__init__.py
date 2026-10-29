"""Bringing foreign LCI data into PrismLCA — SimaPro, openLCA, GaBi, EcoSpold, ILCD.

The design in short:

* Brightway reads EcoSpold 1/2, SimaPro CSV and openLCA JSON-LD already; **ILCD is the one big
  format it has no importer for**, and the one EU EPD work runs on. That reader is ours.
* Every source becomes its **own read-only database** beside ecoinvent, never a write into it.
  LCIA keeps working because methods characterise biosphere flows, not databases — which is
  exactly why the flows have to be matched onto *our* biosphere.
* A flow that cannot be matched is **parked and counted**, never silently dropped: a dropped
  emission makes a dataset look better than it is, and nothing on screen would say so.
"""

from prism_lca.engine.dataimport.detect import (
    FORMAT_LABELS,
    Detection,
    SourceFormat,
    detect,
    detect_file,
)

__all__ = ["FORMAT_LABELS", "Detection", "SourceFormat", "detect", "detect_file"]
