"""Low-level Brightway model helpers used by the command layer.

Exchanges are tagged with a stable ``prism_uid`` so the UI can reference edges and commands
can undo precisely.
"""
from __future__ import annotations

import json
import math
import re
import threading
import uuid

import stats_arrays as sa

from prism_lca import _log
from prism_lca.config import get_settings
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.guardrails import assert_writable, is_read_only
from prism_lca.engine.library import LIBRARY_DB
from prism_lca.engine.pedigree import gsd_from_pedigree
from prism_lca.errors import PrismError

# Exchange keys touched by uncertainty (for snapshot/restore and clearing).
_UNC_KEYS = ("uncertainty type", "loc", "scale", "shape", "minimum", "maximum", "amount", "pedigree")

# Editable activity fields (standard bw fields + PrismLCA ISO-doc dict).
_ACT_FIELDS = ("name", "location", "unit", "reference product", "comment")
_DOC_KEY = "prism_doc"
_DISTS = {
    "none": sa.UndefinedUncertainty.id,
    "lognormal": sa.LognormalUncertainty.id,
    "normal": sa.NormalUncertainty.id,
    "triangular": sa.TriangularUncertainty.id,
    "uniform": sa.UniformUncertainty.id,
}


def _fold_db(name: str) -> str:
    """A database name reduced to its letters and digits, for matching what someone meant to type.

    `ecoinvent-3.12-cutoff`, `ecoinvent 3.12 cutoff` and `Ecoinvent3.12Cutoff` all fold to the same
    thing. Hyphens versus spaces is not a distinction anyone should have to remember, and an assistant
    lost a round to exactly that in an earlier modelling session.
    """
    return "".join(c for c in name.lower() if c.isalnum())


def resolve_db_name(database: str) -> str:
    """The database a name reaches (as `_db_or_404` resolves it), or the name unchanged when it reaches
    none — for the reads that answer an unknown model with an empty list rather than a 404."""
    try:
        return _db_or_404(get_bd(), database) if database else database
    except PrismError:
        return database


def _db_or_404(bd, database: str) -> str:
    """The canonical name of an existing database. Exact match first, then a UNIQUE folded match.

    Returns the resolved name rather than nothing, so callers use what exists instead of what they were
    handed. Ambiguity is refused rather than guessed: two databases that differ only in punctuation are
    a situation to be told about, not to have chosen for you.
    """
    if database in bd.databases:
        return database
    names = list(bd.databases)
    wanted = _fold_db(database or "")
    hits = [n for n in names if _fold_db(n) == wanted] if wanted else []
    if len(hits) == 1:
        return hits[0]
    raise PrismError(
        f"Database '{database}' not found in the active workspace."
        + (f" Did you mean one of: {', '.join(hits)}?" if hits else ""),
        code="database_not_found",
        status_code=404,
        hint=(
            f"Databases in this workspace: {', '.join(names)}."
            if names
            else "Create or import the database first (see /api/v1/databases)."
        ),
    )


def get_activity(database: str, code: str):
    bd = get_bd()
    database = _db_or_404(bd, database)
    db = bd.Database(database)
    try:
        act = db.get(code)
        if act is not None:
            return act
    except Exception as exc:
        _log.swallowed(exc, "get_activity")
    try:
        return bd.get_node(database=database, code=code)
    except Exception as exc:
        _log.swallowed(exc, "get_activity")
    for a in db:
        if a.get("code") == code:
            return a
    raise PrismError(
        f"Activity '{code}' not found in '{database}'.",
        code="activity_not_found",
        status_code=404,
        hint=_not_found_hint(code),
    )


#: How many codes of a mis-sent batch the hint repeats back. Enough to recognise it as one's own
#: list, short enough that a forty-code slip does not become a wall of hex.
_HINT_CODES = 3


def _not_found_hint(code: str) -> str:
    """The hint, and where the value says what went wrong, the hint says it.

    A model sent ``code`` a JSON array as a STRING — the whole batch under the singular field — and
    got back "Activity '[\"0d6068eb…\", …]' not found. Check the activity code and database". The
    value was right there in the message; nothing read it. Two dead calls, and in one session's tooling
    critique it became the accusation that the batch parameter is broken. It is not: `codes` works,
    it was simply not the field that was used (V277).

    Same shape as the report gate's repair (V267): where the refusing party already knows the
    remedy, the refusal says so.
    """
    text = (code or "").strip()
    if not (text.startswith("[") and text.endswith("]")):
        return "Check the activity code and database."
    try:
        items = json.loads(text)
    except ValueError:
        return "Check the activity code and database."
    if not isinstance(items, list) or not all(isinstance(i, str) for i in items) or not items:
        return "Check the activity code and database."
    shown = ", ".join(items[:_HINT_CODES])
    more = f" (+{len(items) - _HINT_CODES} more)" if len(items) > _HINT_CODES else ""
    return (
        f"That is a list of {len(items)} codes in the single-code field. Pass them as "
        f'"codes": [{shown}]{more} — one call, one result per code.'
    )


def find_exchange(act, uid: str):
    for ex in act.exchanges():
        if ex.get("prism_uid") == uid:
            return ex
    raise PrismError(
        f"Exchange '{uid}' not found.",
        code="exchange_not_found",
        status_code=404,
        hint="The exchange may have been removed; reload the activity.",
    )


def new_uid() -> str:
    return uuid.uuid4().hex


#: Database metadata flag: every exchange here carries a ``prism_uid`` (see ``ensure_exchange_uids``).
UIDS_KEY = "prism_uids_complete"


def ensure_exchange_uids(database: str, *, codes: list[str] | None = None) -> int:
    """Give every exchange of ``database`` (or of just its activities ``codes``) a ``prism_uid``.

    The UI addresses an exchange by its uid — amount, formula, comment, uncertainty, delete — so an
    exchange without one is shown but cannot be edited ("uid: Input should be a valid string").
    The canvas commands always set one; the import paths did not: a ``.prism`` bundle carries no
    uids (they are per model, a copy gets fresh ones) and the wizard's library datasets were
    written uid-less too. Every writer of foreign exchanges calls
    this afterwards, and :func:`prism_lca.engine.hygiene.backfill_exchange_uids` heals what earlier
    versions left. Returns how many exchanges got one.
    """
    from bw2data.backends import sqlite3_lci_db

    bd = get_bd()
    if database not in bd.databases:
        return 0
    db = bd.Database(database)
    acts = [db.get(c) for c in codes] if codes is not None else list(db)
    given = 0
    with sqlite3_lci_db.atomic():
        for act in acts:
            for ex in act.exchanges():
                if not ex.get("prism_uid"):
                    ex["prism_uid"] = new_uid()
                    ex.save()
                    given += 1
    return given


def activity_info(act) -> dict:
    db_name = act.key[0]
    from prism_lca.engine.lca import _classify_activity  # lazy: lca imports model

    isic, cpc, cpc_name = _classify_activity(act)
    return {
        "database": db_name,
        "code": act.key[1],
        "name": act.get("name"),
        "product": act.get("reference product"),
        "location": act.get("location"),
        "unit": act.get("unit"),
        "read_only": is_read_only(db_name),
        "isic": isic or None,
        "cpc": cpc or None,
        "cpc_name": cpc_name or None,
    }


def _exchange_direction(ex, inp) -> str:
    """Input vs output, from the LCA meaning of the exchange.

    Products the activity makes (production) leave it → output. Biosphere flows
    split on their category: natural-resource extractions are drawn *from* the
    environment (input), everything else (air/water/soil …) is emitted *to* it
    (output). For technosphere/substitution the sign decides — a negative amount
    is a flow leaving the process (waste sent on, avoided product) → output.
    """
    t = ex.get("type")
    if t == "production":
        return "output"
    if t == "biosphere":
        cats = inp.get("categories") or ()
        return "input" if (cats and cats[0] == "natural resource") else "output"
    return "output" if (ex.get("amount") or 0) < 0 else "input"


#: Said out loud on every negative technosphere exchange, because the encoding alone is misleading:
#: `direction` flips to "output" and nothing else marks the amount as deliberate. The search results
#: already explain the convention when you PICK such a dataset (`sign_hint` in api/v1/search.py);
#: this is the same sentence for reading one back. Without it an assistant re-creating a waste flow
#: cannot tell a correct negative amount from a mistake, and spends a round replacing it with itself.
_SIGN_NOTE = (
    "Negative on purpose: this supplies a dataset whose reference product is negative (a treatment "
    "service), so the amount must be negative. direction is reported as 'output' for the same reason."
)


def exchange_info(ex, tag_map: dict | None = None) -> dict:
    """One exchange as the API shows it. ``tag_map`` (TagStore.load_map) saves a file read per exchange
    when a whole process is listed; the input's own tags come from it."""
    inp = ex.input
    amount = ex.get("amount")
    info = {
        "uid": ex.get("prism_uid"),
        "type": ex.get("type"),
        "direction": _exchange_direction(ex, inp),
        "amount": amount,
        "formula": ex.get("formula"),
        "comment": ex.get("comment") or None,
        "input": {
            "database": inp.key[0],
            "code": inp.key[1],
            "name": inp.get("name"),
            "unit": inp.get("unit"),
            "location": inp.get("location"),
            "categories": list(inp.get("categories") or ()),
        },
    }
    if ex.get("type") == "technosphere" and isinstance(amount, (int, float)) and amount < 0:
        info["sign_note"] = _SIGN_NOTE
    if ex.get("type") in ("technosphere", "substitution") and ex.get("prism_uid"):
        from prism_lca.engine.tags import TagStore

        out = ex.output
        tags = (TagStore().load_map() if tag_map is None else tag_map).get(
            f"{out.key[0]}/{TagStore.exchange_code(out.key[1], ex['prism_uid'])}"
        )
        if tags:
            info["tags"] = [dict(t) for t in tags]
    return info


#: stats_arrays distribution ids, as the words a reviewer reads them by.
_UNCERTAINTY_NAMES = {
    0: "undefined", 1: "none", 2: "lognormal", 3: "normal", 4: "uniform", 5: "triangular",
    6: "bernoulli", 7: "discrete uniform", 8: "weibull", 9: "gamma", 10: "beta",
    11: "generalized extreme value", 12: "student's t", 13: "beta PERT",
}

#: Dataset fields a critical review asks for beyond the exchanges, and the names they travel under.
#: NOT here on purpose: ``authors`` — personal data of the people who entered the dataset.
_REVIEW_FIELDS = (
    ("activity type", "activity_type"),
    ("included_activities_start", "included_activities_start"),
    ("included_activities_end", "included_activities_end"),
    ("product_information", "product_information"),
    ("synonyms", "synonyms"),
    ("start_date", "valid_from"),
    ("end_date", "valid_until"),
    ("filename", "source_file"),
)


def _review_fields(act) -> dict:
    """What ecoinvent documents about a dataset besides its comment: system boundary (included
    activities), product information, synonyms, validity period, source file."""
    out: dict = {}
    for key, name in _REVIEW_FIELDS:
        v = act.get(key)
        if v not in (None, "", [], {}):
            out[name] = v
    return out


def _review_exchange(ex) -> dict:
    """Per exchange: production volume and the uncertainty distribution, when the dataset carries them."""
    out: dict = {}
    pv = ex.get("production volume")
    if isinstance(pv, (int, float)) and pv:
        out["production_volume"] = pv
    ut = ex.get("uncertainty type")
    if ut not in (None, "", 0, 1):
        try:
            unc: dict = {"type": _UNCERTAINTY_NAMES.get(int(ut), str(ut))}
        except (TypeError, ValueError):
            unc = {"type": str(ut)}
        for k in ("loc", "scale", "shape", "minimum", "maximum"):
            if ex.get(k) not in (None, ""):
                unc[k] = ex.get(k)
        if ex.get("pedigree"):
            unc["pedigree"] = ex.get("pedigree")
        out["uncertainty"] = unc
    return out


def activity_detail(act, review: bool = False) -> dict:
    """``review=True`` adds what a critical review reads and the editor does not need: the dataset's
    system boundary, product information, synonyms and validity period, and per exchange the production
    volume and uncertainty distribution. Off by default — it is more payload on every inspector open."""
    # The description travels with the detail, not with `activity_info`: the latter is also used for
    # graph nodes and search hits, where an ecoinvent comment of several hundred characters per node
    # would be paid for on every canvas load and read by nobody.
    from prism_lca.engine.tags import TagStore

    raw = list(act.exchanges())
    tag_map = TagStore().load_map()
    exchanges = [exchange_info(e, tag_map) for e in raw]
    if review:
        for info, ex in zip(exchanges, raw, strict=True):
            info.update(_review_exchange(ex))
    # The reference-product amount decides the sign of every exchange that supplies this activity, so
    # it is stated once at the top instead of leaving callers to find the production row themselves and
    # work it out. Negative = treatment/waste activity, which must be supplied with a negative amount.
    ref = next((e for e in exchanges if e["type"] == "production" and e["amount"]), None)
    ref_amount = ref["amount"] if ref else None
    activity = {
        **activity_info(act),
        "comment": act.get("comment") or "",
        "reference_amount": ref_amount,
        "treatment": None if ref_amount is None else ref_amount < 0,
    }
    # An imported dataset carries what its import could NOT link as a parked list (see
    # dataimport.session.UNMATCHED_KEY). The count travels with the detail so the editor and the
    # details window can say "7 flows from the import are not linked" — the dataset looks finished
    # otherwise, and carries less burden than its file said.
    parked = act.get("prism_unmatched")
    if parked:
        activity["unmatched_from_import"] = len(parked)
    note = service_only_note(act)
    if note:
        activity["service_note"] = note
    supplier = market_main_supplier_comment(act)
    if supplier:
        activity["main_supplier_comment"] = supplier
    if review:
        activity["review"] = _review_fields(act)
    return {"activity": activity, "exchanges": exchanges}


#: How ecoinvent says, in its own words, that a dataset covers the PROCESSING and not the material.
#: Verbatim phrases, not a classifier — measured against the whole of ecoinvent 3.12 cut-off, they
#: occur in 191 of 26,533 activities (0.7 %), across 86 distinct names, all of them genuine treatment
#: services: extrusion, rolling, drawing, deep drawing, anodising, dyeing, enamelling, laser machining.
_SERVICE_PHRASES = (
    "is not included as input",
    "does not include the material",
    "not include the material being",
    "not include the material beeing",  # ecoinvent's own spelling, and it is the aluminium one
)

#: The same statement in ecoinvent's OTHER wordings, which the four phrases above miss entirely.
#: Found by a wall-paint run: `injection moulding` — the plastics equivalent of the
#: aluminium case that started all this, and the one actually in that model — says "The converted
#: amount of plastics is NOT included into the dataset", and got no note.
#:
#: Measured over ecoinvent 3.12 cut-off: the four verbatim phrases catch 191 activities, these catch
#: **179 more across 70 names** — the whole plastics-converting family (injection/blow/stretch-blow
#: moulding, blown film extrusion in seven variants, thermoforming, plastic pipes, plastic bag making,
#: pultrusion, filament winding, hand lay-up), the composite processes, `section bar rolling, steel`,
#: `sheet rolling, steel`, brass and bronze casting, and forestry work where the wood is the material
#: (harvesting, forwarding, skidding, chipping). Together 370 of 26,533 activities = 1.39 %.
#:
#: These are SUBJECTS, not whole statements, so they only count in a sentence that also says
#: "not included" — "the converted amount of" alone would match a sentence saying the opposite.
#: Measured: no such sentence exists today, but a literal phrase list is only safe while it stays
#: literal. The guard also keeps out the four false-alarm classes that a bare "not included" would
#: drag in: "Losses and relevant exchanges … are not included" (54 names), "Electricity input is NOT
#: included", "Planting material is not included", "Packaging material is not included" — none of
#: those is the material being worked on.
_SERVICE_SUBJECTS = (
    "converted amount of",
    "processed amount of",
    "main input components that comprise",
    "the metal input",
    "wood is not included in the dataset",
    "harvested wood is not included",
)
#: What a :data:`_SERVICE_SUBJECTS` sentence must also say before it counts.
_NOT_INCLUDED = "not included"


def _service_sentences(comment: str) -> list[str]:
    """The sentences of a comment that declare the material is not included."""
    if not comment:
        return []
    out = []
    for raw in re.split(r"(?<=[.!?])\s+|\n", comment):
        s = raw.strip()
        if not s:
            continue
        low = s.lower()
        if any(p in low for p in _SERVICE_PHRASES) or (
            _NOT_INCLUDED in low and any(p in low for p in _SERVICE_SUBJECTS)
        ):
            out.append(s)
    return out


def service_only_note(act) -> str:
    """Quote ecoinvent where it says this dataset supplies a PROCESS, not the material it processes.

    One session modelled an aluminium picture frame with 0.95 kg of
    ``market for section bar extrusion, aluminium`` and no aluminium: that dataset draws 0.013 kg of
    wrought alloy per kilogram — the scrap lost in extrusion — because in ecoinvent a profile is TWO
    exchanges, the metal and the forming. 12.24 kg CO2e went missing from a 10.56 kg result, and
    nothing in the tools distinguished the two datasets: same unit, same ISIC, the same CPC 88602 whose
    name reads "…manufacturing services", ``treatment`` false on both, no weak flag, no unmatched term.

    A mass-signature heuristic was measured first and discarded: "consumes far less than its own
    reference mass" fires on 21.8 % of the database (land transformation, sewage treatment, cut-off
    scrap flows, chemistry with gaseous inputs) and still misses half the real services, some of which
    have ratios of 8 or 190 because they count strokes or include the fish. So this quotes ecoinvent
    instead of judging: no threshold, no false positives of our own making, and the sentence the model
    reads is the database's own.

    The market matters as much as the process. A market comment is boilerplate ("Each market represents
    the consumption mix…") and says nothing, yet the market is what search returns and what a model
    links. So a market inherits the note from the supplier it mostly consists of — 85 of 8,214 markets,
    including the one that caused all this.
    """
    own = _service_sentences(act.get("comment") or "")
    if own:
        return " ".join(own)
    # A market: find the supplier of the same product it mostly draws on, and ask that one.
    product = act.get("reference product")
    if not product:
        return ""
    best_amount, best_sentences = 0.0, []
    for e in act.technosphere():
        try:
            supplier = e.input
        except Exception as exc:  # noqa: BLE001 - a broken link must never fail a read
            _log.swallowed(exc, "service_only_note")
            continue
        if supplier.get("reference product") != product or supplier.key == act.key:
            continue
        amount = e.get("amount") or 0
        if amount <= best_amount:
            continue
        sentences = _service_sentences(supplier.get("comment") or "")
        if sentences:
            best_amount = amount
            best_sentences = [
                f"{supplier.get('name')} [{supplier.get('location')}], which supplies "
                f"{round(amount * 100)}% of this market, states: " + " ".join(sentences)
            ]
    return " ".join(best_sentences)


#: How a market's name says it is one — the same rule the search indexer uses (search/indexer.py).
_MARKET_PREFIXES = ("market group for ", "market for ")


def market_main_supplier_comment(act) -> dict | None:
    """For a market: the comment of the supplier it mostly consists of, with name and share.

    A market's own comment is boilerplate ("Each market represents the consumption mix…") and the
    sentence that decides a dataset choice sits one level down, on the producer. Measured on a
    solar-lamp run: ``market for battery, NiMH, rechargeable`` carried 41 % of the result,
    and the producer behind it says "This dataset represents the production of 1 kg of a NiMH battery
    for laptop applications … as used in a Fujitsu-Siemens laptop, model: C4135". Reading that
    sentence took a second lookup nobody made. This puts it in the market's own detail answer, so the
    one lookup a model does make (or the review dossier makes for it) carries the calibration
    sentence — the same market inheritance :func:`service_only_note` already does for the narrower
    "processing only" case, generalised to the whole producer comment without judging its text.

    Markets only (by the indexer's own name rule): on a production dataset the comment IS the
    activity's comment, and inheriting a supplier's story onto a producer would attribute words to
    the wrong dataset. The largest same-product supplier, because that is what the market mostly is;
    transport and losses inside the market have different products and never qualify.
    """
    name = (act.get("name") or "").lower()
    if not name.startswith(_MARKET_PREFIXES):
        return None
    product = act.get("reference product")
    if not product:
        return None
    best, best_amount = None, 0.0
    for e in act.technosphere():
        try:
            supplier = e.input
        except Exception as exc:  # noqa: BLE001 - a broken link must never fail a read
            _log.swallowed(exc, "market_main_supplier_comment")
            continue
        if supplier.get("reference product") != product or supplier.key == act.key:
            continue
        amount = e.get("amount") or 0
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


def activity_metadata(database: str, code: str) -> dict:
    """Comments + all scalar metadata of an activity (for the process-details window): the dataset
    comment, ISIC/CPC classifications, every simple stored field, and any per-exchange comments."""
    act = get_activity(database, code)
    try:
        fields = {k: v for k, v in dict(act).items() if isinstance(v, (str, int, float, bool)) or v is None}
    except Exception as exc:  # pragma: no cover - defensive if the backend isn't a plain mapping
        _log.swallowed(exc, "activity_metadata")
        fields = {k: act.get(k) for k in ("name", "reference product", "location", "unit", "comment", "type")}
    fields.pop("exchanges", None)
    classifications = [
        {"system": str(c[0]), "value": str(c[1])}
        for c in (act.get("classifications") or [])
        if isinstance(c, (list, tuple)) and len(c) >= 2
    ]
    exchange_comments = []
    for ex in act.exchanges():
        cm = ex.get("comment")
        if cm:
            exchange_comments.append({"flow": ex.input.get("name"), "type": ex.get("type"), "comment": cm})
    return {
        "activity": activity_info(act),
        "comment": act.get("comment"),
        "classifications": classifications,
        "fields": fields,
        "exchange_comments": exchange_comments,
    }


# --- reference-product flow properties -------------------------------------
# ecoinvent products carry properties on the production exchange (carbon content,
# dry mass, price, heating value …) as {name: {amount, unit, comment?}}. Foreground
# products may edit them as long as the (name, unit) stays consistent with ecoinvent.

def production_exchange(act):
    prods = [e for e in act.exchanges() if e.get("type") == "production"]
    if not prods:
        raise PrismError(
            "This activity has no production (reference product) exchange.",
            code="no_production_exchange",
            hint="Only processes with a reference product have flow properties.",
        )
    return prods[0]


def _clean_properties(props) -> dict:
    out: dict[str, dict] = {}
    if isinstance(props, dict):
        for name, v in props.items():
            if isinstance(v, dict):
                entry = {"amount": v.get("amount"), "unit": v.get("unit")}
                if v.get("comment"):
                    entry["comment"] = v["comment"]
                out[name] = entry
    return out


def _find_input_exchange(act, text: str):
    """The technosphere exchange whose input is named or coded ``text``: code or exact name first, then
    a substring of the name. Returns (exchange | None, the names of all inputs) — the names are what an
    error message lists, so the next call can name one that exists."""
    q = (text or "").strip().lower()
    tech = [e for e in act.exchanges() if e.get("type") == "technosphere"]
    names = [str(e.input.get("name") or "") for e in tech]
    if not q:
        return None, names
    exact = [e for e, n in zip(tech, names, strict=True) if n.lower() == q or str(e.input.key[1]).lower() == q]
    if len(exact) == 1:
        return exact[0], names
    loose = [e for e, n in zip(tech, names, strict=True) if q in n.lower()]
    if len(loose) == 1:
        return loose[0], names
    if len(loose) > 1:
        raise PrismError(
            f"'{text}' matches {len(loose)} inputs of '{act.get('name')}'.",
            code="input_ambiguous",
            hint="Name one of: " + "; ".join(sorted({str(e.input.get('name')) for e in loose})[:12]),
        )
    return None, names


def product_properties(database: str, code: str, input: str | None = None) -> dict:
    """Flow properties of the reference product — or, with ``input``, of one of the activity's inputs
    (the heating value of the gas a boiler burns, the carbon content of the plastic a moulding draws).
    ecoinvent stores properties on every technosphere exchange, and until now only the production one
    could be read."""
    act = get_activity(database, code)
    if input:
        ex, names = _find_input_exchange(act, input)
        if ex is None:
            raise PrismError(
                f"No input of '{act.get('name')}' matches '{input}'.",
                code="input_not_found",
                hint=("Its inputs are: " + "; ".join(names[:20])) if names else "It has no technosphere inputs.",
                status_code=404,
            )
        inp = ex.input
        props = _clean_properties(ex.get("properties"))
        source = "exchange"
        if not props:
            # A foreground link carries no properties of its own — ecoinvent writes them on ITS
            # exchanges, not on the one the modeller drew. So read them where the input dataset
            # states them: on its reference product. Measured (an MCP session): the
            # steel market answered `{}` through `input` and a full table when asked directly.
            try:
                props = _clean_properties(production_exchange(inp).get("properties"))
                source = "input's reference product"
            except Exception:  # noqa: BLE001 - an input without a production exchange has none
                props = {}
        return {
            "database": database,
            "code": code,
            "input": {
                "database": inp.key[0],
                "code": inp.key[1],
                "name": inp.get("name"),
                "unit": inp.get("unit"),
                "location": inp.get("location"),
            },
            "amount": ex.get("amount"),
            "read_only": True,
            "properties": props,
            "properties_from": source,
        }
    ex = production_exchange(act)
    return {
        "database": database,
        "code": code,
        "product": act.get("reference product"),
        "unit": act.get("unit"),
        "read_only": is_read_only(database),
        "properties": _clean_properties(ex.get("properties")),
    }


def product_properties_snapshot(database: str, code: str) -> dict:
    act = get_activity(database, code)
    ex = production_exchange(act)
    return dict(ex.get("properties") or {})


def restore_product_properties(database: str, code: str, snap: dict) -> None:
    act = get_activity(database, code)
    ex = production_exchange(act)
    ex["properties"] = snap
    ex.save()


def set_product_properties(database: str, code: str, properties: dict) -> dict:
    """Replace the reference product's properties (foreground only). Each (name, unit)
    must match the ecoinvent vocabulary so foreground products stay comparable."""
    assert_writable(database)
    vocab = property_vocabulary()
    clean: dict[str, dict] = {}
    for name, v in (properties or {}).items():
        unit = (v or {}).get("unit")
        expected = vocab.get(name)
        if expected is None:
            raise PrismError(
                f"'{name}' is not a known ecoinvent property.",
                code="unknown_property",
                hint="Pick a property from the ecoinvent vocabulary.",
            )
        if unit and unit != expected:
            raise PrismError(
                f"Property '{name}' must use unit '{expected}' to stay consistent with ecoinvent.",
                code="inconsistent_property",
                hint=f"Use unit '{expected}'.",
            )
        try:
            amount = float(v.get("amount") or 0)
        except (TypeError, ValueError) as e:
            raise PrismError(f"Property '{name}' needs a numeric amount.", code="invalid_amount") from e
        entry = {"amount": amount, "unit": expected}
        if v.get("comment"):
            entry["comment"] = v["comment"]
        clean[name] = entry
    act = get_activity(database, code)
    ex = production_exchange(act)
    ex["properties"] = clean
    ex.save()
    return product_properties(database, code)


# The vocabulary (property name -> canonical unit) used across ecoinvent. Scanning every
# activity takes ~30 s, so cache it in memory and persist to disk for instant reloads.
# Combined vocabulary: {"properties": {name: unit}, "units": [str, ...]}. Both are scanned in a
# single pass over the read-only inventory (~30 s), cached in memory and on disk.
_VOCAB: dict | None = None
_VOCAB_LOCK = threading.Lock()
#: The model generation the in-memory vocabulary was scanned at — only consulted while it is empty.
_VOCAB_GEN = -1

# Fallback unit list if nothing could be scanned (keeps unit pickers usable).
_FALLBACK_UNITS = [
    "kilogram", "cubic meter", "megajoule", "kilowatt hour", "ton kilometer", "unit",
    "hour", "meter", "square meter", "square meter-year", "litre", "person kilometer",
    "kilometer", "hectare",
]


def _vocab_cache_file():
    return get_settings().data_dir / "prism_meta" / "vocab.json"


def _scan_vocab() -> dict:
    bd = get_bd()
    props: dict[str, str] = {}
    units: set[str] = set()
    cpc: dict[str, str] = {}  # CPC code -> name, for classifying foreground processes
    if "biosphere3" in bd.databases:
        for f in bd.Database("biosphere3"):
            u = f.get("unit")
            if u:
                units.add(u)
    for name in bd.databases:
        if name == "biosphere3" or not is_read_only(name):
            continue
        for act in bd.Database(name):
            u = act.get("unit")
            if u:
                units.add(u)
            for cls in (act.get("classifications") or []):
                if not isinstance(cls, (list, tuple)) or len(cls) < 2:
                    continue
                if "CPC" in str(cls[0]).upper():
                    parts = str(cls[1]).split(":", 1)
                    code = parts[0].strip()
                    if code and code not in cpc:
                        cpc[code] = parts[1].strip() if len(parts) > 1 else ""
            for ex in act.exchanges():
                if ex.get("type") != "production":
                    continue
                p = ex.get("properties")
                if isinstance(p, dict):
                    for k, v in p.items():
                        if isinstance(v, dict) and v.get("unit") and k not in props:
                            props[k] = v["unit"]
    if not units:
        units.update(_FALLBACK_UNITS)
    return {"properties": props, "units": sorted(units), "cpc": cpc}


def _vocab_is_empty(data: dict) -> bool:
    return not data.get("properties") and not data.get("cpc")


def _vocab() -> dict:
    """The property/unit/CPC vocabulary, scanned once from the read-only inventory and cached.

    An EMPTY scan — the app started before any background was imported — is kept in memory only
    until the model generation moves (an import bumps it) and is never written to disk. It used to
    be cached for good: every ecoinvent property was "unknown" from then on, restart included, until
    somebody deleted vocab.json by hand.
    """
    global _VOCAB, _VOCAB_GEN
    from prism_lca.engine import lca as _lca

    if _VOCAB is not None and (not _vocab_is_empty(_VOCAB) or _VOCAB_GEN == _lca.model_generation()):
        return _VOCAB
    with _VOCAB_LOCK:
        if _VOCAB is not None and (not _vocab_is_empty(_VOCAB) or _VOCAB_GEN == _lca.model_generation()):
            return _VOCAB
        cache = _vocab_cache_file()
        try:
            if cache.exists():
                data = json.loads(cache.read_text(encoding="utf-8"))
                if (
                    isinstance(data, dict) and "properties" in data and "units" in data and "cpc" in data
                    and not _vocab_is_empty(data)
                ):
                    _VOCAB = data
                    return _VOCAB
        except Exception as exc:  # pragma: no cover - corrupt cache → rebuild
            _log.swallowed(exc, "_vocab")
        data = _scan_vocab()
        if not _vocab_is_empty(data):
            try:
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            except Exception as exc:  # pragma: no cover - cache is an optimisation, not required
                _log.swallowed(exc, "_vocab")
        _VOCAB = data
        _VOCAB_GEN = _lca.model_generation()
        return _VOCAB


def property_vocabulary() -> dict[str, str]:
    return _vocab()["properties"]


def unit_vocabulary() -> list[str]:
    return _vocab()["units"]


def location_vocabulary() -> list[dict]:
    """Every location the workspace's datasets use, for the location field's suggestions.

    ``[{code, own}]``, sorted by code; ``own`` marks the ones a model or library of the user's own
    already uses — those are the likeliest next answer. Read live with one DISTINCT query on the
    activity table rather than from the vocabulary cache above: own processes change, and the query
    takes milliseconds even with ecoinvent installed. Rows of a database no longer registered are
    skipped.
    """
    from bw2data.backends import ActivityDataset as AD

    names = set(get_bd().databases)
    seen: set[str] = set()
    own: set[str] = set()
    for loc, db in AD.select(AD.location, AD.database).distinct().tuples():
        code = str(loc or "").strip()
        if not code or db not in names:
            continue
        seen.add(code)
        if not is_read_only(db):
            own.add(code)
    return [{"code": c, "own": c in own} for c in sorted(seen)]


def cpc_vocabulary() -> list[dict]:
    """[{code, name}] of CPC classes seen in the read-only inventory, for foreground autocomplete."""
    cpc = _vocab().get("cpc") or {}
    return [{"code": k, "name": v} for k, v in sorted(cpc.items())]


def isic_sections() -> list[dict]:
    """The fixed 21 ISIC Rev.4 sections [{code, name}] for the foreground classifier dropdown."""
    from prism_lca.engine.lca import _ISIC_SECTION_NAMES

    return [{"code": k, "name": v} for k, v in _ISIC_SECTION_NAMES.items()]


# --- foreground classification (ISIC/CPC override for stacked-bar attribution) --------------
_CLASS_FIELDS = ("prism_isic", "prism_cpc", "prism_cpc_name")


def classification_snapshot(database: str, code: str) -> dict:
    act = get_activity(database, code)
    return {k: act.get(k) for k in _CLASS_FIELDS}


def _apply_class_fields(act, values: dict) -> None:
    for k in _CLASS_FIELDS:
        v = values.get(k)
        if v:
            act[k] = v
        else:
            try:
                del act[k]
            except Exception as exc:  # noqa: BLE001 - field simply absent
                _log.swallowed(exc, "_apply_class_fields")


def set_classification(database: str, code: str, isic: str | None, cpc: str | None,
                       cpc_name: str | None = None) -> dict:
    """Set the ISIC section / CPC code override on a foreground activity so its own direct impact
    lands in a real class in the ISIC/CPC stacked breakdown (instead of '(no ISIC)'/'(no CPC)')."""
    assert_writable(database)
    act = get_activity(database, code)
    _apply_class_fields(act, {
        "prism_isic": isic or None,
        "prism_cpc": cpc or None,
        "prism_cpc_name": (cpc_name or None) if cpc else None,
    })
    act.save()
    return {"activity": activity_info(act)}


def restore_classification(database: str, code: str, snap: dict) -> None:
    act = get_activity(database, code)
    _apply_class_fields(act, snap)
    act.save()


def warm_vocabulary() -> None:
    """Build the vocabulary on a background thread so the first use is instant."""
    threading.Thread(target=_vocab, name="prism-vocab-warmup", daemon=True).start()


# --- elementary / product flow search (for defining exchanges) -------------
def search_flows(query: str, direction: str | None = None, limit: int = 50) -> list[dict]:
    """Search the existing elementary (biosphere) flows to attach as a process exchange.

    ``direction`` filters by where the flow belongs: 'input' = drawn from nature (natural
    resources), 'output' = released to nature (emissions). Own elementary flows are never
    created — the biosphere vocabulary is fixed."""
    bd = get_bd()
    if "biosphere3" not in bd.databases:
        return []
    q = (query or "").strip().lower()
    matches: list[dict] = []
    for f in bd.Database("biosphere3"):
        cats = f.get("categories") or ()
        is_resource = bool(cats) and cats[0] == "natural resource"
        if direction == "input" and not is_resource:
            continue
        if direction == "output" and is_resource:
            continue
        name = f.get("name") or ""
        if q and q not in name.lower():
            continue
        matches.append(
            {
                "database": f.key[0],
                "code": f.key[1],
                "name": name,
                "unit": f.get("unit"),
                "categories": list(cats),
                "direction": "input" if is_resource else "output",
            }
        )
    matches.sort(key=lambda m: (not m["name"].lower().startswith(q), m["name"].lower()))
    return matches[:limit]


def list_activities(database: str) -> list[dict]:
    bd = get_bd()
    database = _db_or_404(bd, database)
    # Sorted by name (case-insensitive), then code: Brightway's iteration order differed from call to call,
    # and the Results rail and the own processes' default colours followed it.
    acts = [activity_info(a) for a in bd.Database(database)]
    return sorted(acts, key=lambda a: (str(a.get("name") or "").casefold(), str(a.get("code") or "")))


def node_id(act) -> str:
    return f"{act.key[0]}/{act.key[1]}"


def reference_candidates(database: str) -> list[dict]:
    """The model's likely reference processes, best guess first.

    A foreground model is a tree that ends in one process — the packaged product, the delivered
    service — and everything else feeds it. That process is exactly the one no other foreground
    process consumes, so it can be derived rather than guessed. Worth deriving: picking an arbitrary
    activity instead produced a report titled after an end-of-life sub-process, and a results view
    that compared packaging components with each other.

    Ties (a model with several roots, or a cycle so that nothing is a root) are broken by how much
    the process pulls in, then by name, and the whole list is returned so a caller can offer the
    alternatives instead of pretending the first one is certain. A model that states its reference
    quantity (``set_reference_quantity``) has said which process is the functional unit, so that one
    comes first and nothing is guessed — a leftover pulling in more must not take its place.
    """
    bd = get_bd()
    database = _db_or_404(bd, database)
    db = bd.Database(database)
    acts = list(db)
    consumed: set = set()
    upstream: dict = {}
    for act in acts:
        n = 0
        for ex in act.exchanges():
            if ex.get("type") != "technosphere":
                continue
            n += 1
            inp_key = ex.input.key
            if inp_key != act.key and inp_key[0] == database:
                consumed.add(inp_key)
        upstream[act.key] = n

    def sort_key(a):
        return (not a.get(REF_QUANTITY_KEY), -upstream.get(a.key, 0), (a.get("name") or "").lower())

    roots = sorted((a for a in acts if a.key not in consumed), key=sort_key)
    # No root at all means every activity is consumed by another — a cycle. Rather than return
    # nothing, fall back to the whole list in the same order, so the caller still has a best guess.
    ranked = roots or sorted(acts, key=sort_key)
    return [
        {
            "database": database,
            "code": a.key[1],
            "name": a.get("name"),
            "product": a.get("reference product"),
            "location": a.get("location"),
            "unit": a.get("unit"),
            "upstream": upstream.get(a.key, 0),
            "is_root": a.key not in consumed,
        }
        for a in ranked
    ]


def partition_by_tag_group(database: str, dimension: str) -> dict:
    """Split a model's own processes by one tag group — the rule behind "group processes based on tags".

    Answered here rather than in the renderer, although the canvas already has every foreground node
    with its tags attached. Two reasons, and the second is the one that matters:

    * The rule is a statement about the **model**, not about what is drawn. The canvas is a view; a
      process can be off it (a collapsed upstream) and still be in the model.
    * It is the same rule ``TagStore.set_tag`` already states — at most one value per dimension — and a
      rule stated in two places is a rule that will disagree with itself. ``set_tag`` enforces it going
      forward, so a *stored* violation can only come from somewhere that predates it or bypasses it
      (``tags/bulk`` adds rather than sets, and an imported bundle carries whatever it carries). That is
      exactly the case this has to refuse, and it can only be seen from the file.

    ``partition`` follows the group's declared value order, so the boxes come out in the order the user
    arranged the tags in, not in whatever order the activities happen to iterate. ``conflicts`` names
    the offending processes — the refusal has to say *which* ones, or it is not actionable — and when it
    is non-empty the caller must refuse; the partition is still returned, because computing half an
    answer and then hiding it makes the endpoint harder to test, not safer.
    """
    from prism_lca.engine.tag_groups import TagGroupStore
    from prism_lca.engine.tags import TagStore

    bd = get_bd()
    database = _db_or_404(bd, database)
    group = next((g for g in TagGroupStore().list_groups() if g["name"] == dimension), None)
    if group is None:
        raise PrismError(f"Tag group '{dimension}' does not exist.", code="unknown_tag_group", status_code=404)

    tag_map = TagStore().load_map()  # one read for the whole model
    by_value: dict[str, list[str]] = {}
    conflicts: list[dict] = []
    untagged: list[str] = []
    for act in bd.Database(database):
        key = f"{act.key[0]}/{act.key[1]}"
        values = [t["value"] for t in tag_map.get(key, []) if t["dimension"] == dimension]
        if len(values) > 1:
            conflicts.append({"id": key, "name": act.get("name") or key, "values": sorted(set(values))})
            continue
        if not values:
            untagged.append(key)
            continue
        by_value.setdefault(values[0], []).append(key)
    # Declared order first, then any value that is in the tags but no longer in the taxonomy — a value
    # removed from the group cascades the tags away, so this is only reachable for a hand-edited file,
    # and dropping such a process silently would be worse than putting it at the end.
    ordered = [v for v in group.get("values", []) if v in by_value]
    ordered += sorted(v for v in by_value if v not in ordered)
    return {
        "database": database,
        "group": dimension,
        "partition": [{"value": v, "members": by_value[v]} for v in ordered],
        "conflicts": conflicts,
        "untagged": untagged,
    }


def report_context(database: str) -> dict:
    """What a report needs about the model itself: the foreground's own descriptions, and the background
    datasets it actually uses.

    Two things a reviewer asks for and no calculation produces.

    ``foreground`` carries each foreground process with its ``description`` — the process comment, where
    the modeller (or the assistant that built the model) recorded what the process is and where its data
    comes from. A writer that has these can explain a hotspot instead of naming it.

    Each process also carries its ``exchange_notes``: the non-empty comments on its inputs and emissions,
    where the reason for one exchange is kept — why this dataset over an equivalent one, why a proxy
    geography, what a producer's own dataset said, why a waste flow has its sign.

    ``background`` lists **tier-1** datasets only: the ones a foreground process links to directly. That
    is deliberate and was the author's instruction — a market dataset drags in hundreds of upstream
    datasets, and listing those says nothing about what this study chose. Deduplicated by key, because
    the same market is usually referenced from several processes.
    """
    bd = get_bd()
    database = _db_or_404(bd, database)
    db = bd.Database(database)
    own = {a.key for a in db}

    foreground: list[dict] = []
    background: dict[tuple[str, str], dict] = {}
    for act in db:
        notes: list[dict] = []
        foreground.append(
            {
                "code": act.key[1],
                "name": act.get("name") or "",
                "product": act.get("reference product") or "",
                "location": act.get("location") or "",
                "unit": act.get("unit") or "",
                "description": (act.get("comment") or "").strip(),
                "exchange_notes": notes,
            }
        )
        for ex in act.exchanges():
            note = (ex.get("comment") or "").strip()
            if note and ex.get("type") in ("technosphere", "biosphere"):
                # `own` marks an input from this model: its name is the modeller's and is translated.
                notes.append({"input": ex.input.get("name") or "", "location": ex.input.get("location") or "",
                              "note": note, **({"own": True} if tuple(ex.input.key) in own else {})})
            if ex.get("type") != "technosphere":
                continue
            key = tuple(ex.input.key)
            if key in own or key in background:
                continue
            inp = ex.input
            background[key] = {
                "database": key[0],
                "code": key[1],
                "name": inp.get("name") or "",
                "product": inp.get("reference product") or "",
                "location": inp.get("location") or "",
                "unit": inp.get("unit") or "",
            }
            # A dataset from the user's own library is not background data and a report must not
            # imply it is: it says so, and it says where the user got it — the import stamps the
            # source on the activity (see dataimport.session.commit). Written as prose because
            # everything in this dict is read by the report writer, not by code.
            if inp.get("prism_import_batch"):
                background[key]["library"] = True
                source = str(inp.get("prism_import_label") or "").strip()
                fmt = str(inp.get("prism_import_format") or "").strip()
                date = str(inp.get("prism_import_date") or "").strip()
                background[key]["origin"] = (
                    "the user's own library — imported"
                    + (f" from “{source}”" if source else "")
                    + (f" ({fmt.replace('_', ' ')})" if fmt else "")
                    + (f" on {date}" if date else "")
                )
            elif key[0] == LIBRARY_DB:
                background[key]["library"] = True
                background[key]["origin"] = "the user's own library, built by hand"
    foreground.sort(key=lambda a: a["name"])
    return {
        "foreground": foreground,
        "background": sorted(background.values(), key=lambda a: (a["name"], a["location"])),
        # Stated so a chapter can say how many processes carry no description yet, instead of a writer
        # guessing whether the silence means "no data" or "not documented".
        "undocumented": sum(1 for a in foreground if not a["description"]),
    }


def exchange_uncertainty_snapshot(database: str, code: str, uid: str) -> dict:
    act = get_activity(database, code)
    ex = find_exchange(act, uid)
    return {k: ex.get(k) for k in _UNC_KEYS}


def exchange_comment(database: str, code: str, uid: str) -> str | None:
    """The exchange's comment, for snapshotting before it is overwritten."""
    act = get_activity(database, code)
    return find_exchange(act, uid).get("comment") or None


def set_exchange_comment(database: str, code: str, uid: str, comment: str | None) -> dict:
    """Write the comment of a single exchange. This is where an amount's *reason* belongs — why a
    waste flow carries the sign it does, why a proxy dataset stands in for the real one, what a
    formula is meant to express. The read path always exposed it (``exchange_info``) and the report
    hands it to the writers; until now nothing could set it, so the rationale had to be crammed into
    the consuming process's description next to unrelated sourcing text."""
    assert_writable(database)
    act = get_activity(database, code)
    ex = find_exchange(act, uid)
    text = (comment or "").strip()
    if text:
        ex["comment"] = text
    else:
        # Empty means "clear", not "store an empty string" — an empty comment would otherwise show
        # up as a documented exchange in the report's undocumented count.
        try:
            del ex["comment"]
        except Exception as exc:  # noqa: BLE001
            _log.swallowed(exc, "set_exchange_comment")
    ex.save()
    return exchange_info(ex)


def restore_exchange_fields(database: str, code: str, uid: str, snap: dict) -> None:
    act = get_activity(database, code)
    ex = find_exchange(act, uid)
    for k in _UNC_KEYS:
        v = snap.get(k)
        if v is None:
            try:
                del ex[k]
            except Exception as exc:  # noqa: BLE001
                _log.swallowed(exc, "restore_exchange_fields")
        else:
            ex[k] = v
    ex.save()


def apply_exchange_uncertainty(database: str, code: str, uid: str, distribution: str, params: dict) -> dict:
    assert_writable(database)
    act = get_activity(database, code)
    ex = find_exchange(act, uid)
    d = (distribution or "none").lower()
    amount = ex.get("amount")
    try:
        if d in ("none", ""):
            new = {"uncertainty type": _DISTS["none"], "amount": amount}
        elif d == "lognormal":
            median = float(params["median"])
            gsd = float(params.get("gsd", 1.0))
            new = {"uncertainty type": _DISTS["lognormal"], "loc": math.log(median),
                   "scale": math.log(gsd) if gsd > 0 else 0.0, "amount": median}
        elif d == "normal":
            mean = float(params["mean"])
            new = {"uncertainty type": _DISTS["normal"], "loc": mean,
                   "scale": float(params["std"]), "amount": mean}
        elif d == "triangular":
            lo, hi = float(params["min"]), float(params["max"])
            mode = float(params.get("mode", amount if amount is not None else (lo + hi) / 2))
            new = {"uncertainty type": _DISTS["triangular"], "minimum": lo, "maximum": hi,
                   "loc": mode, "amount": mode}
        elif d == "uniform":
            lo, hi = float(params["min"]), float(params["max"])
            new = {"uncertainty type": _DISTS["uniform"], "minimum": lo, "maximum": hi,
                   "amount": (lo + hi) / 2}
        else:
            raise PrismError(f"Unknown distribution '{distribution}'.", code="unknown_distribution",
                             hint="Use none, lognormal, normal, triangular or uniform.")
    except KeyError as e:
        raise PrismError(f"Missing parameter {e} for '{d}' distribution.", code="missing_param",
                         hint="Provide the distribution's parameters (e.g. median+gsd, mean+std, min+max).") from e

    for k in _UNC_KEYS:
        if k in new:
            ex[k] = new[k]
        else:
            try:
                del ex[k]
            except Exception as exc:  # noqa: BLE001
                _log.swallowed(exc, "apply_exchange_uncertainty")
    ex.save()
    # A distribution states its own centre (median, mean, mode), and that centre was written into
    # `amount` above. On a parameterised exchange the formula owns the amount: without this step the
    # centre stood as the amount until the next recalculation happened to pass — and once
    # recalculation was scoped to the model being edited (V331), nothing passed at all, so the
    # formula's number was silently replaced by the distribution's. The spread
    # (loc/scale) stays; only the amount goes back to what the formula says.
    if ex.get("formula"):
        from prism_lca.engine import params as _params

        _params.recalc_activity_group(database, code)
        ex = find_exchange(get_activity(database, code), uid)
    return exchange_info(ex)


def activity_fields_snapshot(database: str, code: str) -> dict:
    act = get_activity(database, code)
    snap = {k: act.get(k) for k in _ACT_FIELDS}
    snap[_DOC_KEY] = act.get(_DOC_KEY)
    return snap


def set_activity_fields(database: str, code: str, fields: dict) -> dict:
    assert_writable(database)
    act = get_activity(database, code)
    old_unit = act.get("unit")
    mapping = {"name": "name", "location": "location", "unit": "unit",
               "product": "reference product", "comment": "comment"}
    for key, bw_key in mapping.items():
        if fields.get(key) is not None:
            act[bw_key] = fields[key]
    doc = fields.get("doc")
    if doc is not None:
        current = dict(act.get(_DOC_KEY) or {})
        current.update({k: v for k, v in doc.items() if v is not None})
        act[_DOC_KEY] = current
    act.save()
    # `doc` only when there is documentation: an empty `{}` on every rename read as noise (V391).
    result = {"activity": activity_info(act), **({"doc": act.get(_DOC_KEY)} if act.get(_DOC_KEY) else {})}
    # A unit change silently rescales the physical meaning of every consuming exchange —
    # the amounts stay numerically the same but now mean the NEW unit. Warn, don't block.
    new_unit = fields.get("unit")
    if new_unit is not None and new_unit != old_unit:
        consumers = sum(1 for _ in act.upstream())
        if consumers:
            result["warning"] = (
                f"Unit changed from '{old_unit}' to '{new_unit}': {consumers} consuming "
                f"exchange amount(s) keep their numbers but now mean the new unit — review them."
            )
    return result


def restore_activity_fields(database: str, code: str, snap: dict) -> None:
    act = get_activity(database, code)
    for k in (*_ACT_FIELDS, _DOC_KEY):
        v = snap.get(k)
        if v is None:
            try:
                del act[k]
            except Exception as exc:  # noqa: BLE001
                _log.swallowed(exc, "restore_activity_fields")
        else:
            act[k] = v
    act.save()


def apply_exchange_pedigree(database: str, code: str, uid: str, scores: list[int],
                            basic_gsd: float = 1.0) -> dict:
    act = get_activity(database, code)
    ex = find_exchange(act, uid)
    median = ex.get("amount")
    if not median:
        raise PrismError("Pedigree needs a non-zero exchange amount (used as the median).",
                         code="zero_amount", hint="Set the exchange amount first.")
    gsd = gsd_from_pedigree(scores, basic_gsd)
    info = apply_exchange_uncertainty(database, code, uid, "lognormal", {"median": median, "gsd": gsd})
    act = get_activity(database, code)
    ex = find_exchange(act, uid)
    ex["pedigree"] = list(scores)
    ex.save()
    return {**info, "pedigree": list(scores), "gsd": round(gsd, 4)}


def create_activity(database: str, code: str, name: str, product: str | None,
                    unit: str | None, location: str | None):
    bd = get_bd()
    database = _db_or_404(bd, database)
    assert_writable(database)
    db = bd.Database(database)
    act = db.new_activity(code=code, name=name, unit=unit or "unit", location=location or "GLO")
    if product:
        act["reference product"] = product
    act["type"] = "process"
    act.save()
    try:
        prod = act.new_edge(input=act, amount=1.0, type="production")
        prod["prism_uid"] = new_uid()
        prod.save()
    except Exception:
        # Never leave a half-created activity (saved head, no reference product) behind.
        act.delete()
        raise
    return act


def exchange_extra_fields(ex) -> dict:
    """Every exchange field beyond identity/link/amount/type — formula, uncertainty
    (uncertainty type/loc/scale…), pedigree, comment, properties — so copy and undo paths
    restore an exchange COMPLETELY instead of silently dropping its distributions."""
    d = dict(ex)
    for k in ("input", "output", "amount", "type", "prism_uid"):
        d.pop(k, None)
    return d


# Every field a delete+undo has to bring back. The prism_* fields are listed by name: the ISIC/CPC
# classification, the reference-quantity marker and the bundle origin were lost on undo before,
# and a contribution split by ISIC then filed the restored process elsewhere.
_SNAP_FIELDS = (
    "name", "unit", "location", "reference product", "type", "comment", _DOC_KEY,
    *_CLASS_FIELDS, "prism_ref_quantity", "prism_bundle_origin",
)


def activity_snapshot(database: str, code: str) -> dict:
    """Full snapshot (fields + all exchanges) so a deletion can be undone precisely."""
    act = get_activity(database, code)
    fields = {k: act.get(k) for k in _SNAP_FIELDS if act.get(k) is not None}
    exchanges = [dict(ex) for ex in act.exchanges()]
    return {"code": code, "fields": fields, "exchanges": exchanges}


def restore_activity(database: str, code: str, snap: dict) -> None:
    """Recreate an activity from :func:`activity_snapshot` (used to undo a delete)."""
    bd = get_bd()
    db = bd.Database(database)
    f = snap["fields"]
    new = db.new_activity(code=code, name=f.get("name"), unit=f.get("unit") or "unit",
                          location=f.get("location") or "GLO")
    for k in _SNAP_FIELDS:
        if k in ("name", "unit", "location"):
            continue  # given to new_activity above
        if f.get(k) is not None:
            new[k] = f[k]
    new.save()
    for exd in snap["exchanges"]:
        d = dict(exd)
        inp = d.pop("input", None)
        d.pop("output", None)
        amount = d.pop("amount", 0.0)
        etype = d.pop("type", "technosphere")
        target = new if etype == "production" else bd.get_node(database=inp[0], code=inp[1])
        edge = new.new_edge(input=target, amount=amount, type=etype)
        for k, v in d.items():
            edge[k] = v
        edge.save()


def delete_activity(database: str, code: str) -> None:
    assert_writable(database)
    get_activity(database, code).delete()


def consumers(database: str, input_database: str, input_code: str) -> dict:
    """Which activities of ``database`` consume a given dataset, with their amounts.

    The reverse of every other read: the model is stored as "what does this process buy", so
    answering "where is this dataset used" meant listing every process and scanning it. Replacing a
    background dataset after a review — the commonest repair there is — therefore started with the
    assistant recalling from memory where it had linked the thing.
    """
    bd = get_bd()
    database = _db_or_404(bd, database)
    target = (input_database, input_code)
    out: list[dict] = []
    for act in bd.Database(database):
        for ex in act.exchanges():
            if ex.get("type") == "production":
                continue
            key = ex.input.key if ex.input else None
            if key and tuple(key) == target:
                out.append(
                    {
                        "database": act.key[0],
                        "code": act.key[1],
                        "name": act.get("name") or "",
                        "uid": ex.get("prism_uid"),
                        "amount": ex.get("amount"),
                        "formula": ex.get("formula"),
                        "comment": ex.get("comment") or None,
                    }
                )
    out.sort(key=lambda r: r["name"])
    return {"input": {"database": input_database, "code": input_code}, "count": len(out), "consumers": out}


#: Marks the small process that divides a model by a parameter, so a second call finds it instead of
#: stacking another one on top. Two of them would divide twice and make every result 1/n² of the
#: truth — the one failure mode this feature must not have (V233).
REF_QUANTITY_KEY = "prism_ref_quantity"


def find_reference_quantity(database: str) -> dict | None:
    """The model's reference-quantity process, if it has one."""
    bd = get_bd()
    database = _db_or_404(bd, database)
    for act in bd.Database(database):
        marker = act.get(REF_QUANTITY_KEY)
        if marker:
            return {"code": act.get("code"), "name": act.get("name"), **dict(marker)}
    return None


def set_reference_quantity(
    database: str, code: str, parameter: str, name: str, unit: str, product: str | None = None
) -> dict:
    """Make ``1 <unit>`` the model's functional unit, by dividing an existing process by a parameter.

    A study says "per kWh" in its goal and scope; the model says "per installation", and the division
    lives in prose where nothing computes it. Closing that gap by hand means knowing a trick — put a
    process above the reference process and give its input the amount ``1 / denominator`` — and a
    balcony-solar study is the evidence that it is not obvious: the assistant computed the
    denominator, wrote it down, and never connected it, which left seven parameters and three of four
    scenarios unable to move a number (V233).

    Division in the *matrix*, deliberately, not in the view. A displayed quotient is computed once
    against the baseline denominator and then repeated under every scenario — and the scenarios that
    matter for a per-unit figure are exactly the ones that change the denominator, not the numerator.
    Here Brightway re-evaluates the formula under each scenario's parameter values, so a yield
    scenario moves the result because it really does move it.

    Idempotent: called again it re-points the existing node instead of stacking a second divider.
    """
    from prism_lca.engine import params as _params

    bd = get_bd()
    database = _db_or_404(bd, database)
    assert_writable(database)
    known = {p["name"]: p for p in _params.list_params(database)}
    if parameter not in known:
        raise PrismError(
            f"'{parameter}' is not a parameter of this model.",
            code="unknown_parameter",
            hint="Pick the parameter that holds the total the result should be divided by.",
        )
    denominator = known[parameter].get("amount")
    if not denominator:
        raise PrismError(
            f"Parameter '{parameter}' is {denominator!r}; a reference quantity cannot divide by it.",
            code="zero_denominator",
            hint="Give the parameter a non-zero value first — it is the total the result is spread over.",
        )
    target = get_activity(database, code)
    if target.get(REF_QUANTITY_KEY):
        raise PrismError(
            "That process is itself a reference quantity; pick the process it divides.",
            code="reference_quantity_recursion",
            hint="Choose the process that produces the whole thing — the one being spread over the total.",
        )

    existing = find_reference_quantity(database)
    act = get_activity(database, existing["code"]) if existing else None
    if act is None:
        act = create_activity(database, new_uid(), name, product, unit, target.get("location") or "GLO")
    else:
        act["name"] = name
        act["unit"] = unit
        if product:
            act["reference product"] = product
        for ex in list(act.technosphere()):
            ex.delete()
    act[REF_QUANTITY_KEY] = {"parameter": parameter, "of": code}
    act.save()

    uid = new_uid()
    edge = act.new_edge(input=target, amount=1.0 / float(denominator), type="technosphere")
    edge["prism_uid"] = uid
    edge["comment"] = (
        f"One {unit} is a share 1 / {parameter} of '{target.get('name')}'. The division sits in the "
        f"model rather than in the view, so every scenario that moves {parameter} moves this result."
    )
    edge.save()
    # The formula goes through `params.set_exchange_formula`, NOT onto the field. Writing
    # `edge["formula"]` stores a string; it does not register the exchange with bw2data's parameter
    # group, so the amount is frozen at whatever was written and no scenario ever recomputes it. That
    # failure is invisible from the outside — the formula reads back correctly, the health check sees
    # it, the baseline score is right — and it shows up only as the yield scenarios returning Δ 0
    # again, which is the exact symptom this whole feature exists to remove.
    _params.set_exchange_formula(database, act.get("code"), uid, f"1 / {parameter}")
    return {
        "activity": {"database": database, "code": act.get("code"), "name": act.get("name"),
                     "unit": act.get("unit"), "product": act.get("reference product")},
        "parameter": parameter,
        "of": code,
        "replaced": bool(existing),
    }
