"""index.html offers pre-shrunk copies of its large screenshots, and they must exist.

Tripwire for ``Website2/tools/shot_variants.py``: a new screenshot size, a changed SIZES entry or a missing copy
fails here. Offline; skips without Website2/.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

_TOOL = Path(__file__).resolve().parent.parent.parent / "Website2" / "tools" / "shot_variants.py"


def test_shot_variants_are_current():
    if not _TOOL.exists():
        pytest.skip("no Website2/ in this checkout")
    r = subprocess.run([sys.executable, str(_TOOL), "--check"], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr or r.stdout
