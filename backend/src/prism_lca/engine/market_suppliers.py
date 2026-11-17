"""A market and the producers behind it.

A market sells a product it does not make: it mixes the datasets that do, and adds transport and losses.
What the product is — which technology, built for which application — is said one level down, on those
producers; the market's own comment is the same boilerplate on every market of the database. Everything
that has to look through a market reads the link here:

- the detail of a market quotes the producer it mostly buys from (:func:`market_main_supplier_comment`),
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

#: How a market's name says it is one — the same rule the search indexer uses (search/indexer.py).
MARKET_PREFIXES = ("market group for ", "market for ")

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
    if not is_market(act):
        return None
    best, best_amount = None, 0.0
    for supplier, amount in same_product_inputs(act, "market_main_supplier_comment"):
        if amount > best_amount:
            best, best_amount = supplier, amount
    comment = (best.get("comment") or "").strip() if best is not None else ""
    if not comment:
        return None
    return {
        "name": best.get("name"),
        "location": best.get("location"),
        "share": round(best_amount, 4),
        "comment": comment,
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
