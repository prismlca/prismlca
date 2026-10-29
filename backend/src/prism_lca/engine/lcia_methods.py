"""Custom, project-scoped LCIA methods.

The shipped ecoinvent methods are read-only — a user can only *duplicate* one. A duplicate is a
real ``bw2data`` Method (so it works everywhere: LCIA page, Results, contribution) tagged with
``prism_custom`` in its metadata, and that tag is the *only* thing that makes a method editable.

Method *families* are simply the first tuple element (``method[0]``); their optional short
descriptions live in a tiny project-scoped JSON store next to the scenarios one.
"""
from __future__ import annotations

import re
import threading

from prism_lca import _log
from prism_lca.engine import hygiene, lca
from prism_lca.engine._store import JsonFileStore
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.ecoinvent import BIOSPHERE_DB
from prism_lca.errors import PrismError


class LciaFamilyStore(JsonFileStore):
    """Per-project {family_name: description} for user-created method families."""

    FILENAME = "lcia_families.json"

    def _write(self, data: dict) -> None:
        self._save(data)

    def get_all(self) -> dict[str, str]:
        return self._load()

    def set(self, family: str, description: str) -> None:
        data = self._load()
        data[family] = description or ""
        self._write(data)

    def remove(self, family: str) -> None:
        data = self._load()
        if family in data:
            data.pop(family)
            self._write(data)


_families = LciaFamilyStore()


def _is_custom(bd, m: tuple) -> bool:
    try:
        return bool(bd.methods[m].get("prism_custom"))
    except Exception as exc:  # noqa: BLE001
        _log.swallowed(exc, "_is_custom")
        return False


def _is_protected_family(bd, family: str) -> bool:
    """A shipped (ecoinvent) family: it exists among the methods but is neither in the family store
    nor made up of the user's own custom methods. Users must not add indicators to such families."""
    if family in _families.get_all():
        return False
    fam_methods = [m for m in bd.methods if m[0] == family]
    return bool(fam_methods) and not any(_is_custom(bd, m) for m in fam_methods)


def _require_custom(bd, t: tuple) -> None:
    if not _is_custom(bd, t):
        raise PrismError(
            "Shipped LCIA methods can't be edited — duplicate the method first.",
            code="method_read_only", status_code=400,
            hint="Use 'Duplicate' to make an editable copy.")


def _key_from_ref(ref):
    """A flow reference from the UI is a node id or a [db, code] pair — normalise it.

    Node ids are 64-bit integers (3.3e17 and up for ecoinvent's biosphere), which is more than a
    JavaScript number carries exactly: `_ref_of` hands them out as strings, and this takes the
    string back. Measured in an MCP session: the id came back rounded to the
    nearest multiple of 64, `remove_flow` silently removed nothing and `set_factor` ADDED a flow
    under an id no dataset has — the custom method kept scoring exactly like its template."""
    if isinstance(ref, (list, tuple)):
        return tuple(ref)
    if isinstance(ref, str) and re.fullmatch(r"-?\d+", ref.strip()):
        return int(ref.strip())
    return ref


def _ref_of(key):
    if isinstance(key, (list, tuple)):
        return list(key)
    # Strings survive the JSON round trip exactly; integers above 2**53 do not (see _key_from_ref).
    return str(key) if isinstance(key, int) and not isinstance(key, bool) else key


def _normalise(data: list) -> list:
    """Method.load() entries may be (key, amount) or (key, amount, geo); keep just (key, amount)."""
    return [(item[0], float(item[1])) for item in data]


def list_families() -> dict:
    """All method families with their indicators; ``editable`` marks the user's own methods."""
    bd = get_bd()
    desc = _families.get_all()
    fams: dict[str, dict] = {}
    for m in bd.methods:
        fam = m[0]
        entry = fams.setdefault(fam, {"family": fam, "description": desc.get(fam, ""), "methods": []})
        entry["methods"].append({
            "method": list(m),
            "name": " · ".join(m),
            "unit": bd.methods[m].get("unit", ""),
            "num_cfs": bd.methods[m].get("num_cfs"),
            "editable": _is_custom(bd, m),
        })
    for fam, d in desc.items():  # families created but still empty
        fams.setdefault(fam, {"family": fam, "description": d, "methods": []})
    out = list(fams.values())
    for f in out:
        f["custom"] = any(mm["editable"] for mm in f["methods"]) or f["family"] in desc
        f["methods"].sort(key=lambda mm: mm["name"].lower())
    out.sort(key=lambda f: f["family"].lower())
    return {"families": out}


def _method_detail(bd, t: tuple) -> dict:
    cache: dict = {}
    flows = []
    for key, cf in _normalise(bd.Method(t).load()):
        node = lca.resolve_flow_node(bd, key, cache)
        flows.append({
            "ref": _ref_of(key),
            "flow": node["name"] if node else str(key),
            "categories": list(node.get("categories") or []) if node else [],
            "unit": (node.get("unit") if node else "") or "",
            "cf": cf,
        })
    flows.sort(key=lambda f: (f["flow"].lower(), f["categories"]))
    return {
        "method": list(t), "name": " · ".join(t), "unit": bd.methods[t].get("unit", ""),
        "editable": _is_custom(bd, t), "flows": flows,
    }


def method_flows(method) -> dict:
    return _method_detail(get_bd(), lca.resolve_method(method))


def duplicate_method(src, family: str, name: str, description: str | None = None) -> dict:
    bd = get_bd()
    src_t = lca.resolve_method(src)
    family = (family or "").strip()
    name = (name or "").strip()
    if not family or not name:
        raise PrismError("Family and indicator name are required.", code="invalid_name",
                         hint="Give the copy a family and a name.")
    if _is_protected_family(bd, family):
        raise PrismError(
            f"'{family}' is a shipped ecoinvent family — you can't add indicators to it.",
            code="family_protected", status_code=400,
            hint="Pick one of your own families or type a new family name.")
    new = (family, name)
    if new in bd.methods:
        raise PrismError(f"A method '{' · '.join(new)}' already exists.", code="method_exists",
                         status_code=409, hint="Choose another name.")
    data = _normalise(bd.Method(src_t).load())
    unit = bd.methods[src_t].get("unit", "")
    M = bd.Method(new)
    M.register(unit=unit, prism_custom=True, description=(description or f"Copied from {' · '.join(src_t)}"))
    M.write(data)
    if description is not None:
        _families.set(family, description)
    lca.invalidate_lca_cache()
    return _method_detail(bd, new)


def create_method(family: str, name: str, unit: str = "", description: str | None = None) -> dict:
    """Create an empty custom method (no flows yet) in a user family — fill it via the editor."""
    bd = get_bd()
    family = (family or "").strip()
    name = (name or "").strip()
    if not family or not name:
        raise PrismError("Family and indicator name are required.", code="invalid_name",
                         hint="Give the method a family and a name.")
    if _is_protected_family(bd, family):
        raise PrismError(
            f"'{family}' is a shipped ecoinvent family — you can't add indicators to it.",
            code="family_protected", status_code=400,
            hint="Pick one of your own families or type a new family name.")
    new = (family, name)
    if new in bd.methods:
        raise PrismError(f"A method '{' · '.join(new)}' already exists.", code="method_exists",
                         status_code=409, hint="Choose another name.")
    M = bd.Method(new)
    M.register(unit=unit or "", prism_custom=True, description=(description or ""))
    M.write([])
    if description is not None:
        _families.set(family, description)
    lca.invalidate_lca_cache()
    return _method_detail(bd, new)


def rename_method(method, new_name: str) -> dict:
    """Rename a custom method (keeps its family), moving its factors + metadata to the new key."""
    bd = get_bd()
    t = lca.resolve_method(method)
    _require_custom(bd, t)
    new_name = (new_name or "").strip()
    if not new_name:
        raise PrismError("Indicator name must not be empty.", code="invalid_name")
    newkey = tuple(t[:-1]) + (new_name,)
    if newkey == t:
        return _method_detail(bd, t)
    if newkey in bd.methods:
        raise PrismError(f"A method '{' · '.join(newkey)}' already exists.", code="method_exists",
                         status_code=409, hint="Choose another name.")
    data = _normalise(bd.Method(t).load())
    M = bd.Method(newkey)
    M.register(unit=bd.methods[t].get("unit", ""), prism_custom=True,
               description=bd.methods[t].get("description", ""))
    M.write(data)
    hygiene.deregister_method(t)
    lca.invalidate_lca_cache()
    return _method_detail(bd, newkey)


#: A factor edit is load → filter → write of the WHOLE method; two of them in flight on the same
#: method (the endpoints are sync and run in the threadpool) both succeed and the second write drops
#: the first one's flow. One lock for the read-modify-write.
_FACTOR_WRITE_LOCK = threading.Lock()


def set_factor(method, ref, cf: float) -> dict:
    """Upsert a flow's characterisation factor (also used to add a new flow)."""
    bd = get_bd()
    t = lca.resolve_method(method)
    _require_custom(bd, t)
    key = _key_from_ref(ref)
    with _FACTOR_WRITE_LOCK:
        data = [(k, v) for (k, v) in _normalise(bd.Method(t).load()) if k != key]
        data.append((key, float(cf)))
        bd.Method(t).write(data)
    lca.invalidate_lca_cache()
    return _method_detail(bd, t)


def remove_flow(method, ref) -> dict:
    bd = get_bd()
    t = lca.resolve_method(method)
    _require_custom(bd, t)
    key = _key_from_ref(ref)
    with _FACTOR_WRITE_LOCK:
        before = _normalise(bd.Method(t).load())
        data = [(k, v) for (k, v) in before if k != key]
        if len(data) == len(before):
            # Nothing matched: say so instead of answering with an unchanged method that looks like
            # a success (an earlier modelling session read exactly that as "removed").
            raise PrismError(
                f"No flow with ref {ref!r} in this method — nothing was removed.",
                code="flow_not_in_method", status_code=404,
                hint="Take the ref from get_method_factors or search_biosphere_flows, exactly as given.")
        bd.Method(t).write(data)
    lca.invalidate_lca_cache()
    return _method_detail(bd, t)


def delete_method(method) -> dict:
    bd = get_bd()
    t = lca.resolve_method(method)
    _require_custom(bd, t)
    hygiene.deregister_method(t)
    lca.invalidate_lca_cache()
    return {"deleted": list(t)}


def set_family(family: str, description: str) -> dict:
    family = (family or "").strip()
    if not family:
        raise PrismError("Family name must not be empty.", code="invalid_name")
    if _is_protected_family(get_bd(), family):
        raise PrismError(f"'{family}' is a shipped ecoinvent family and can't be modified.",
                         code="family_protected", status_code=400,
                         hint="Create your own family instead.")
    _families.set(family, description or "")
    return {"family": family, "description": description or ""}


def edit_family(old: str, name: str, description: str) -> dict:
    """Rename a user family (moves all its custom methods to the new family) and/or set its
    description. Shipped families can't be edited, and a rename can't collide with existing methods."""
    bd = get_bd()
    old = (old or "").strip()
    name = (name or "").strip()
    if not name:
        raise PrismError("Family name must not be empty.", code="invalid_name")
    if _is_protected_family(bd, old):
        raise PrismError(f"'{old}' is a shipped ecoinvent family and can't be edited.",
                         code="family_protected", status_code=400)
    if name != old:
        if _is_protected_family(bd, name):
            raise PrismError(f"'{name}' is a shipped ecoinvent family.", code="family_protected",
                             status_code=400, hint="Choose a different name.")
        movers = [m for m in bd.methods if m[0] == old and _is_custom(bd, m)]
        for m in movers:
            newkey = (name,) + tuple(m[1:])
            if newkey in bd.methods:
                raise PrismError(f"A method '{' · '.join(newkey)}' already exists.",
                                 code="method_exists", status_code=409, hint="Rename that one first.")
        for m in movers:
            data = _normalise(bd.Method(m).load())
            unit = bd.methods[m].get("unit", "")
            M = bd.Method((name,) + tuple(m[1:]))
            M.register(unit=unit, prism_custom=True, description=bd.methods[m].get("description", ""))
            M.write(data)
            hygiene.deregister_method(m)
        _families.remove(old)
        lca.invalidate_lca_cache()
    _families.set(name, description or "")
    return {"family": name, "description": description or ""}


def delete_family(family: str) -> dict:
    """Delete a user family and all its custom methods. Shipped families are protected."""
    bd = get_bd()
    family = (family or "").strip()
    if _is_protected_family(bd, family):
        raise PrismError(f"'{family}' is a shipped ecoinvent family and can't be deleted.",
                         code="family_protected", status_code=400)
    removed = 0
    for m in [m for m in bd.methods if m[0] == family and _is_custom(bd, m)]:
        hygiene.deregister_method(m)
        removed += 1
    _families.remove(family)
    lca.invalidate_lca_cache()
    return {"deleted": family, "methods_removed": removed}


def flow_search(query: str | None = None, limit: int = 30) -> dict:
    """Biosphere flows for the add-flow autocomplete, ranked by relevance.

    A plain substring filter is unusable — searching "methane" surfaces "Dichloromethane" and
    hundreds of others in database order. Instead every token must appear, and results are ranked:
    exact name → name starts with the query → whole-word hit in the name → substring in the name →
    match only in the categories. Ties break on the shorter, then alphabetically-earlier name."""
    bd = get_bd()
    q = (query or "").strip().lower()
    if not q:
        return {"flows": []}
    tokens = q.split()
    # The biosphere DB is 'biosphere3' in real projects, but keep it robust to other names.
    dbs = [n for n in bd.databases if n == BIOSPHERE_DB] or [n for n in bd.databases if "biosphere" in n.lower()]

    def score(nl: str, cl: str) -> int | None:
        hay = f"{nl} {cl}"
        if not all(t in hay for t in tokens):
            return None  # every typed token must appear somewhere
        if nl == q:
            return 0
        if nl.startswith(q):
            return 1
        if re.search(r"\b" + re.escape(q), nl):
            return 2
        if q in nl:
            return 3
        if all(t in nl for t in tokens):  # all tokens in the name, out of order
            return 4
        return 5  # matched only via categories

    scored: list[tuple] = []
    for dbname in dbs:
        for f in bd.Database(dbname):
            name = f.get("name") or ""
            cats = list(f.get("categories") or [])
            s = score(name.lower(), " / ".join(cats).lower())
            if s is None:
                continue
            scored.append((s, len(name), name.lower(),
                           {"ref": _ref_of(f.id), "flow": name, "categories": cats, "unit": f.get("unit") or ""}))
    scored.sort(key=lambda t: (t[0], t[1], t[2]))
    return {"flows": [item for _, _, _, item in scored[:limit]]}
