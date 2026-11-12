"""Wall-clock time per step of a long write, logged as one INFO line when it is done.

A model rename rewrites the whole database under the new name and then every store that keys data by
it; on a large model that takes long enough to notice, and which step it is cannot be told from the
outside. :class:`StepTimer` records each step as it finishes and logs them together, so the next slow
operation says where its time went without a separate measurement. Only step names and seconds go into
the line — no model names, no content.
"""
from __future__ import annotations

import logging
import time


class StepTimer:
    """Seconds per named step, in order, from one start."""

    def __init__(self, operation: str) -> None:
        self.operation = operation
        self.steps: list[tuple[str, float]] = []
        self._start = self._mark = time.perf_counter()

    def done(self, step: str) -> None:
        """Close the step that has been running since the previous mark."""
        now = time.perf_counter()
        self.steps.append((step, now - self._mark))
        self._mark = now

    @property
    def total(self) -> float:
        return self._mark - self._start

    def line(self) -> str:
        parts = ", ".join(f"{name} {secs:.2f} s" for name, secs in self.steps)
        return f"{self.operation}: {self.total:.2f} s — {parts}"

    def log(self, logger: logging.Logger) -> None:
        logger.info("%s", self.line())
