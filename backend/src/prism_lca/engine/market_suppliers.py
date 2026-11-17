"""A market and the producers behind it.

A market sells a product it does not make: it mixes the datasets that do, and adds transport and losses.
What the product is — which technology, built for which application — is said one level down, on those
producers; the market's own comment is the same boilerplate on every market of the database. Everything
that has to look through a market reads the link here:

- the detail of a market quotes the producer it mostly buys from (:func:`market_main_supplier_comment`),
  and for a market billed per square metre or metre lists what that producer consumes for one unit
  (:func:`market_main_supplier_inputs`),
- a "processing only" note is inherited from that producer (``engine/model.py``, ``service_only_note``),
- the assistant's record of the datasets it has opened counts a market as read once a producer behind it
  was read, and asks :func:`suppliers_of` which those are.

A supplier is an input that sells the market's own reference product. Transport and the other inputs of a
market have other products and are not what it sells.
"""
from __future__ import annotations

from collections.abc import Iterator

from prism_lca import _log
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.input_summary import biggest_inputs

#: How a market's name says it is one — the same rule the search indexer uses (search/indexer.py).
MARKET_PREFIXES = ("market group for ", "market for ")

#: Units whose quantity names no material: a square metre of WHICH surface, a metre of WHICH seam. A market
#: billed in them sells a coating, a weld, a pane or a cable, and what one unit holds shows only in what its
#: producer consumes for it. Over ecoinvent 3.12 cut-off these are 103 markets in square metres and 34 in
#: metres, every coating, plating and weld among them. Pieces are left out on purpose: the 660 markets per
#: "unit" are plants, vehicles and appliances, where one piece is one piece and the inputs settle nothing.
MEASURED_UNITS = frozenset({"square meter", "meter"})

#: Datasets one :func:`suppliers_of` call answers for. A caller asks about the inputs one edit linked or
#: the biggest contributors of one result; a longer list is a mistake and is cut, not served.
MAX_DATASETS = 200


def is_market(act) -> bool:
    return (act.get("name") or "").lower().startswith(MARKET_PREFIXES)


def same_product_inputs(act, caller: str) -> Iterator[tuple[object, float]]:
    """Every technosphere input of ``act`` that sells ``act``'s own reference product, with its amount.

    The amount is passed on as stored: a waste market draws on its treatments with negative amounts, and
    whether those count is the caller's question. An input whose dataset cannot be resolved is skipped —
    a broken link must never fail a read (``caller`` names the reader in the log)."""
    product = act.get("reference product")
    if not product:
        return
    for e in act.technosphere():
        try:
            supplier = e.input
        except Exception as exc:  # noqa: BLE001 - a broken link must never fail a read
            _log.swallowed(exc, caller)
            continue
        if supplier.get("reference product") != product or supplier.key == act.key:
            continue
        yield supplier, e.get("amount") or 0


def market_main_supplier_comment(act) -> dict | None:
    """For a market: the comment of the supplier it mostly consists of, with name and share.

    A market's own comment is boilerplate ("Each market represents the consumption mix…") and the
    sentence that decides a dataset choice sits one level down, on the producer. Measured on a
    solar-lamp run: ``market for battery, NiMH, rechargeable`` carried 41 % of the result,
    and the producer behind it says "This dataset represents the production of 1 kg of a NiMH battery
    for laptop applications … as used in a Fujitsu-Siemens laptop, model: C4135". Reading that
    sentence took a second lookup nobody made. This puts it in the market's own detail answer, so the
    one lookup a model does make (or the review dossier makes for it) carries the calibration
    sentence — the same market inheritance ``service_only_note`` already does for the narrower
    "processing only" case, generalised to the whole producer comment without judging its text.

    Markets only (by the indexer's own name rule): on a production dataset the comment IS the
    activity's comment, and inheriting a supplier's story onto a producer would attribute words to
    the wrong dataset. The largest same-product supplier, because that is what the market mostly is;
    transport and losses inside the market have different products and never qualify.
    """
    found = main_supplier(act, "market_main_supplier_comment")
    if found is None:
        return None
    best, share = found
    comment = (best.get("comment") or "").strip()
    if not comment:
        return None
    return {
        "name": best.get("name"),
        "location": best.get("location"),
        "share": round(share, 4),
        "comment": comment,
    }


def main_supplier(act, caller: str) -> tuple[object, float] | None:
    """For a market: the same-product supplier with the largest positive amount, and that amount.

    ``None`` for anything that is not a market, and for a market that buys from nobody with a positive
    amount (a waste market draws on its treatments with negative ones)."""
    if not is_market(act):
        return None
    best, best_amount = None, 0.0
    for supplier, amount in same_product_inputs(act, caller):
        if amount > best_amount:
            best, best_amount = supplier, amount
    return (best, best_amount) if best is not None else None


def market_main_supplier_inputs(act) -> dict | None:
    """For a market billed per square metre or metre: what its main supplier consumes for ONE unit.

    A market's own inputs are its suppliers, so the summary of a coating market reads "zinc coating,
    coils [RoW] 0.67 m², [RER] 0.33 m²" and says nothing about what the square metre is. Its words
    contradict each other: "an input of 1 m2 of steel sheet", and data per tonne divided by "64 m2/t
    (corresponding to ca. 4.2 mm thickness)", which fits only when both faces are counted. The producer
    settles it in numbers: 0.679 kg of zinc per m² is 47.5 µm a side on a square metre of sheet and 95 µm
    on a square metre of one face, and only the first fits the "20 to 45 um" the comment states. A model
    that had opened only the market built a scenario on the wrong reading and counted the zinc twice;
    the full view of a market would not have helped, it holds the same two lines.

    The supplier is the one :func:`market_main_supplier_comment` quotes. Its inputs are listed by the rule
    every short view of a dataset follows (:func:`~prism_lca.engine.input_summary.biggest_inputs`: one input
    bought in several regions is one row, summed), per one unit of its reference product and to four
    significant digits. ``None`` outside :data:`MEASURED_UNITS`, for a production dataset, when the supplier
    has no inputs that can be read, and when the supplier is a market itself (a market group buys from
    markets, whose inputs are producers again and say nothing about one unit).
    """
    if act.get("unit") not in MEASURED_UNITS:
        return None
    found = main_supplier(act, "market_main_supplier_inputs")
    if found is None:
        return None
    supplier, share = found
    if is_market(supplier):
        return None
    produced = next((e.get("amount") for e in supplier.production() if e.get("amount")), 1.0)
    rows = biggest_inputs(supplier, "market_main_supplier_inputs", per=produced)
    if not rows:
        return None
    return {
        "name": supplier.get("name"),
        "location": supplier.get("location"),
        "share": round(share, 4),
        "per": f"1 {supplier.get('unit') or act.get('unit')}",
        "biggest_inputs": rows,
    }


def suppliers_of(datasets: list[tuple[str, str]]) -> list[dict]:
    """For each MARKET among ``datasets`` (database, code): the datasets it buys its own product from.

    Asked by the assistant's tools before they say a linked dataset was never opened: a model that read
    the steel producers and then linked the steel market has read what the market is made of, and a
    reminder to open the market — or a review told it was never looked at — states something untrue.

    Every supplier the market draws on is listed, whatever its share and sign: the question is whether
    one of them was read, not what the market mostly is. An exchange with an amount of zero supplies
    nothing — reading that dataset says nothing about what the market is made of, so it is left out. One
    level only — the members of a market group are markets, and their producers are not listed for the
    group. A dataset that is not a market, or that does not exist, has no entry: for those "opened" means
    the dataset itself.
    """
    bd = get_bd()
    out: list[dict] = []
    for database, code in dict.fromkeys(datasets[:MAX_DATASETS]):
        try:
            act = bd.get_node(database=database, code=code)
        except Exception as exc:  # noqa: BLE001 - an unknown dataset simply has no suppliers to name
            _log.swallowed(exc, "suppliers_of")
            continue
        if not is_market(act):
            continue
        keys = dict.fromkeys(tuple(s.key) for s, amount in same_product_inputs(act, "suppliers_of") if amount)
        if keys:
            out.append({
                "database": database,
                "code": code,
                "suppliers": [{"database": d, "code": c} for d, c in keys],
            })
    return out
