"""The few inputs that say what a dataset is.

A short view of a dataset lists its biggest technosphere inputs, and they answer the question its name and unit
leave open: is this a material, a product made from one, or a service applied to one. Two readers ask for them —
the assistant's summary of any dataset (``summary=true`` on the detail endpoint) and the block that shows what
the main producer of a market per square metre or metre consumes for one unit (``market_suppliers.py``) — and
both list them by the rule here.

The rule is about one input bought in several regions. A RoW or GLO producer in ecoinvent buys its electricity
from the market groups of RAS, RNA, RLA and RAF and from the markets of a few countries, and every region is an
exchange of its own. Ranked one exchange per row, those fragments took the places of the materials (a powder
coating listed its powder sixth, behind three electricity and heat fragments) and showed every amount as a part
(an LDPE film read as 0.495 kg of polyethylene per kilogram, which is 1.02 kg bought in four regions). Over
ecoinvent 3.12 cut-off, two thirds of the RoW producers lost at least one input that way.

So inputs are summed when they are the same input: the same name, product, unit and database, where "market
group for X" counts as "market for X" — both sell X, only from regions of different size. What stays apart:

- inputs that sell the dataset's OWN reference product. On a market they are its suppliers, and on a mix
  ("electricity, high voltage, production mix") its technologies; which region or technology supplies how much
  is the dataset's content, not a fragment of something else;
- the same product from differently named datasets — recycling and disposal of one waste, air and kiln drying
  of one board — because one row named after the larger would state something untrue about the other;
- one name selling different products (the outputs of one multi-output process), which then carry ``product``;
- what a dataset buys and what it sends back of the same input (a purchase and a credit): summed only within
  one direction, so neither hides in a net amount.
"""
from __future__ import annotations

from collections import defaultdict
from typing import NamedTuple

from prism_lca import _log

#: Rows a short view shows — enough to tell a material from a product made of it, few enough to stay short.
SHOWN = 6

_GROUP_PREFIX = "market group for "
_MARKET_PREFIX = "market for "


class _Part(NamedTuple):
    """One exchange of an input: its size, and what the dataset it comes from is called and sells where."""

    size: float
    name: str | None
    location: str | None
    product: str | None
    unit: str | None


def biggest_inputs(act, caller: str, per: float = 1.0, digits: int = 4) -> list[dict]:
    """The :data:`SHOWN` biggest technosphere inputs of ``act``, one row per input, largest first by size.

    Each row has ``amount`` (the sum divided by ``per``, to ``digits`` significant digits), ``name`` (of the
    largest part), ``unit`` and ``location`` — the region bought most, and how many others add to it ("RAS and
    6 more"). Zero amounts supply nothing and are left out. Signs are kept: a waste a dataset sends to
    treatment is a negative input, and ranks by its size. An input whose dataset cannot be resolved is skipped —
    a broken link must never fail a read (``caller`` names the reader in the log)."""
    own = act.get("reference product")
    totals: dict[tuple, float] = defaultdict(float)
    parts: dict[tuple, list[_Part]] = defaultdict(list)
    for e in act.technosphere():
        amount = e.get("amount")
        if not amount:
            continue
        try:
            source = e.input
        except Exception as exc:  # noqa: BLE001 - a broken link must never fail a read
            _log.swallowed(exc, caller)
            continue
        product = source.get("reference product")
        # The direction is part of the key: a process that buys a kilogram of steel and books a credit of
        # 0.8 kg through the same market shows both, not a net 0.2 kg that hides what it does.
        bought = amount > 0
        if own and product == own:
            key: tuple = ("own", *source.key, bought)
        else:
            key = (source.key[0], _same_supply(source.get("name")), product, source.get("unit"), bought)
        totals[key] += amount
        parts[key].append(_Part(abs(amount), source.get("name"), source.get("location"), product, source.get("unit")))
    biggest = sorted(totals, key=lambda k: abs(totals[k]), reverse=True)[:SHOWN]
    largest = {key: max(parts[key], key=lambda p: p.size) for key in biggest}
    products: dict[str | None, set] = defaultdict(set)
    for part in largest.values():
        products[part.name].add(part.product)
    rows = []
    for key in biggest:
        part = largest[key]
        row = {
            "amount": float(f"{totals[key] / per:.{digits}g}"),
            "name": part.name,
            "unit": part.unit,
            "location": _regions(parts[key]),
        }
        if len(products[part.name]) > 1:
            row["product"] = part.product
        rows.append(row)
    return rows



def _same_supply(name: str | None) -> str | None:
    """A market group and a market of one product are the same input from regions of different size."""
    if name and name.lower().startswith(_GROUP_PREFIX):
        return _MARKET_PREFIX + name[len(_GROUP_PREFIX):]
    return name


def _regions(parts: list[_Part]) -> str | None:
    """The region an input is mostly bought in, and how many other regions add to it. Two exchanges of one
    region (a process that books the same dataset twice) are one region."""
    by_region: dict[str | None, float] = defaultdict(float)
    for part in parts:
        by_region[part.location] += part.size
    ordered = sorted(by_region, key=lambda loc: by_region[loc], reverse=True)
    first = ordered[0]
    return first if len(ordered) == 1 else f"{first or '?'} and {len(ordered) - 1} more"
