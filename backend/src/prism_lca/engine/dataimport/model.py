"""The one shape every source format is read into.

Five formats, five readers, **one intermediate** — because everything downstream (matching,
unit conversion, the compartment rule, the review table, the report) has to work the same way for
a SimaPro export and an ILCD package. If the shape leaked the format, every one of those steps
would grow five branches.

Deliberately thin: this is what a matcher needs to decide, not a faithful rendering of any source
format. Whatever else the source said is kept verbatim in ``raw`` so the review table can show the
user the line as it stood in their file — the one thing no normalisation may take away.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class SourceKind(StrEnum):
    """What a dataset carries — which decides whether matching is possible at all.

    The line that matters is **inventory or not**, and it does not run where the ILCD type names
    suggest. An *EPD* carries characterised results per module and no elementary flows: nothing to
    map onto our biosphere. An *LCI result* is called aggregated too, and is — no supply chain to
    look into — but it carries a full list of elementary flows and is exactly what the matcher is
    for. The EU's own EF reference data is 93 of those, and we refused all of them while telling
    the user they had "no elementary flows".
    """

    #: An inventory with its supply chain: what it consumed, what it emitted.
    unit_process = "unit_process"
    #: An aggregated inventory — elementary flows for the whole system, no supply chain. Importable.
    lci_result = "lci_result"
    #: Results only (an EPD). Nothing to match, so nothing to import.
    aggregated = "aggregated"


@dataclass(frozen=True)
class FlowProperty:
    """One property the source states about a flow — a density, a calorific value, a dry mass.

    ``amount`` is per one reference unit of the exchange, in ``unit``. This is what bridges two
    quantities without anybody guessing: a flow given in m³ whose source also states its mass per m³
    has told us its density, and using that number is reading the file, not assuming.
    """

    name: str
    amount: float
    unit: str


@dataclass
class ForeignExchange:
    """One line of a foreign dataset's inventory, before anything has been matched."""

    #: ``production`` | ``technosphere`` | ``biosphere`` | ``unknown``
    kind: str
    name: str
    amount: float
    unit: str
    #: Compartment path as the source wrote it, outermost first. Empty when the source said nothing.
    compartment: tuple[str, ...] = ()
    #: The source's own identifier, where it has one. EcoSpold 2, ILCD and JSON-LD do; EcoSpold 1
    #: and SimaPro CSV do not, which is precisely why those two need the matcher most.
    uuid: str | None = None
    location: str | None = None
    #: ``input`` | ``output`` — an emission and an uptake of the same substance are two flows.
    direction: str = "input"
    #: What the source states about the flow itself, beyond the amount — see :class:`FlowProperty`.
    #: EcoSpold 2 carries these per exchange, ILCD per flow dataset; EcoSpold 1 and SimaPro have
    #: none, which is fine: an empty tuple means "the source said nothing", never "assume".
    properties: tuple[FlowProperty, ...] = ()
    #: A product the process gives off BESIDES its reference product (2 kWh of electricity from a
    #: process that makes cement). Not a consumption, whatever its kind says: booked as one, it
    #: would buy what the process sells. The import parks it unless the reviewer
    #: asks for substitution — allocation or system expansion is the modeller's decision.
    coproduct: bool = False
    #: A waste the process gives OFF — scrap, sludge, municipal waste going out to be treated. Not a
    #: co-product and never a substitution: the process buys the SERVICE of having it treated, so it
    #: is booked as a technosphere link to a treatment dataset, with the sign of that dataset's own
    #: reference production (ecoinvent's treatments produce −1 kg: 2 kg of waste books −2, and the
    #: matrix runs the treatment twice). The magnitude is the source's; its sign is the target's.
    #: Read from the source where it says so — ILCD ``Waste flow`` / JSON-LD ``WASTE_FLOW`` going
    #: out, SimaPro "Waste to treatment", EcoSpold 1 output group 3, EcoSpold 2 a negative input or
    #: a by-product classified as waste. A waste going IN (a treatment's own input) is not this.
    waste: bool = False
    #: A negative input the source does not say is a waste (EcoSpold 2): booked with its sign as
    #: written — a credit on a producer, a treatment on a treatment — and flagged, because only the
    #: reviewer can tell a waste to treatment from a deliberate negative correction.
    sign_review: bool = False
    #: The supplier the source itself names for this input, when that supplier is a dataset of the
    #: same package — ``"<activity id>:<product flow id>"`` against :attr:`ForeignDataset.provides`.
    #: EcoSpold 2 writes it as ``activityLinkId``, JSON-LD as ``defaultProvider``.
    provider: str | None = None
    #: The line as the source wrote it. Shown in the review table; never normalised away.
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class ForeignDataset:
    key: str
    name: str
    unit: str
    location: str
    reference_product: str
    comment: str
    kind: SourceKind
    exchanges: list[ForeignExchange] = field(default_factory=list)
    #: The names under which another dataset of the same package can point at this one as its
    #: supplier — see :attr:`ForeignExchange.provider`. Empty for formats without such links.
    provides: tuple[str, ...] = ()
    #: What identifies this dataset across re-imports of the same source, independent of anything
    #: a normalisation step renames: the source's own id plus the product as the source spelled it.
    #: Written onto the library activity; a re-import finds what it replaces by it. Empty = use key.
    identity: str = ""
    #: The (code, name) an import before the identity field existed would have written — the key
    #: and name as the source gave them, before allocation suffixes and name/region splitting. Only
    #: for finding those older imports again.
    legacy_key: str = ""
    legacy_name: str = ""

    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for exc in self.exchanges:
            out[exc.kind] = out.get(exc.kind, 0) + 1
        return out


@dataclass
class ReadResult:
    datasets: list[ForeignDataset] = field(default_factory=list)
    #: What the reader wants to tell the user before anything is imported — a partial package, a
    #: pile of EPDs where an inventory was expected. Shown in step 1 of the wizard, in these words.
    notes: list[str] = field(default_factory=list)

    @property
    def importable(self) -> list[ForeignDataset]:
        """Everything that carries an inventory — a supply chain is not the criterion, flows are."""
        return [
            d for d in self.datasets if d.kind in (SourceKind.unit_process, SourceKind.lci_result)
        ]

    def summary(self) -> dict[str, Any]:
        importable = self.importable
        return {
            "datasets": len(self.datasets),
            "importable": len(importable),
            "aggregated": len(self.datasets) - len(importable),
            "exchanges": sum(len(d.exchanges) for d in importable),
            "biosphere": sum(1 for d in importable for e in d.exchanges if e.kind == "biosphere"),
            "technosphere": sum(1 for d in importable for e in d.exchanges if e.kind == "technosphere"),
            "notes": list(self.notes),
        }
