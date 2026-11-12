"""Which processes consume a given dataset — the reverse read of a model.

The model is stored as "what does this process buy", so "where is this dataset used" has no Brightway
call of its own. Replacing a background dataset after a review — the commonest repair there is — starts
here, with the consumers and the uids of their exchanges.

Answered with one query on the exchange table, over bw2data's own index on the supplier side
(``exchangedataset_input``: input database + input code). Walking every process through the ORM and
resolving each input took 204 s over a whole background database (V484); this takes milliseconds there
and is no slower on a model.

A background database is searched only when asked for in so many words (``whole_database``): the usual
question is where the caller's OWN model uses a dataset, and a background holds tens of thousands of
processes. The search over it is still useful — it finds, say, the waste market that mixes a treatment —
so it is gated, not removed, and its list is capped.
"""
from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.model import _db_or_404
from prism_lca.errors import PrismError

#: Consumers listed from a whole background database; the rest are counted. A model lists them all.
WHOLE_DATABASE_SHOWN = 40


def find_consumers(database: str, input_database: str, input_code: str, *, whole_database: bool = False) -> dict:
    """Which activities of ``database`` consume ``(input_database, input_code)``, with their amounts."""
    from prism_lca.engine.backgrounds.common import is_background

    database = _db_or_404(get_bd(), database)
    background = is_background(database)
    if background and not whole_database:
        raise PrismError(
            f"This searches every process of '{database}', a background database.",
            code="consumers_whole_database",
            hint="Pass whole_database: true if that is what you want, or your own model as database to see "
            "where the model uses the dataset.",
        )
    out = [
        {
            "database": database,
            "code": code,
            "name": name or "",
            "uid": data.get("prism_uid"),
            "amount": data.get("amount"),
            "formula": data.get("formula"),
            "comment": data.get("comment") or None,
        }
        for code, data, name in _query(database, input_database, input_code)
    ]
    out.sort(key=lambda r: r["name"])
    answer = {"input": {"database": input_database, "code": input_code}, "count": len(out), "consumers": out}
    if background and len(out) > WHOLE_DATABASE_SHOWN:
        answer["consumers"] = out[:WHOLE_DATABASE_SHOWN]
        answer["more"] = f"{len(out) - WHOLE_DATABASE_SHOWN} more, not listed (the list is sorted by name)."
    return answer


def _query(database: str, input_database: str, input_code: str):
    """``(consumer code, exchange data, consumer name)`` per consuming exchange, the production row left
    out (it is the process itself). Filtered on the supplier first, so SQLite takes the input index."""
    from bw2data.backends.schema import ActivityDataset, ExchangeDataset
    from peewee import JOIN

    consumer = ActivityDataset
    return (
        ExchangeDataset.select(ExchangeDataset.output_code, ExchangeDataset.data, consumer.name)
        .join(consumer, join_type=JOIN.LEFT_OUTER, on=(
            (ExchangeDataset.output_database == consumer.database) & (ExchangeDataset.output_code == consumer.code)))
        .where((ExchangeDataset.input_database == input_database) & (ExchangeDataset.input_code == input_code)
               & (ExchangeDataset.output_database == database) & (ExchangeDataset.type != "production"))
        .tuples()
    )
