"""The comparison brief: what the assistant building model B is told about model A, the one B will be
compared with on the Results page.

Generated from A's own records, deterministically — no LLM in the loop. A compaction by a model costs
a call per selection, is not reproducible, and drops exactly what the comparison needs: tag values
verbatim, parameter names, dataset names. The brief is made compact by *selection* instead: no
results (they tempt a modeller to build the second model "to fit"), no health check, no review log,
comments capped. What is left out can be read with the tools — `model_info`, `get_process_details`
and `get_model_graph` take a `database` argument.

Measured on `PET-Wasserflasche 500 ml (IBWA-Nachbau)` (5 processes, 16 tier-1 datasets, 27
parameters, 5 scenarios) on 2026-09-06: raw dump 48k characters, this brief 14.5k (~4k tokens). Tested
on a model with the rule in `frontend/src/main/ai/systemPrompt.ts` — positive case, planted defects,
counter-check.
"""
from __future__ import annotations

from typing import Any

from prism_lca.engine import model as model_engine
from prism_lca.engine import params as params_engine
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.scenarios import ScenarioStore
from prism_lca.engine.study import StudyMetaStore
from prism_lca.engine.tags import TagStore

#: Caps, all in one place. Per field so that one long description cannot crowd out the numbers.
FIELD_CHARS = 600
LIMITATION_CHARS = 220
COMMENT_CHARS = 110
DESCRIPTION_CHARS = 160
MAX_PROCESSES = 40
MAX_EXCHANGES = 25
MAX_PARAMS = 60
MAX_SCENARIOS = 20

#: The study fields that make up the frame, in the order they are printed.
FRAME_FIELDS = (
    "functional_unit",
    "geography",
    "reference_year",
    "system_boundaries",
    "scope",
    "cutoff_criteria",
    "allocation",
    "system_allocation",
    "language",
    "date",
)


def _cap(value: Any, limit: int) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _num(value: Any) -> str:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return str(value)
    return f"{f:.6g}"


def _exchange_line(ex: Any, own: set) -> str:
    """One input of a foreground process: name, geography, where it comes from, and how much."""
    inp = ex.input
    where = f" [{inp.get('location')}]" if inp.get("location") else ""
    # Database AND code: the first live run (MiniMax M3, 06.09.2026) knew the lorry dataset by its name
    # from this brief, guessed the code, and had the exchange rejected — then spent a round reading the
    # other model's process to find it. The code is what `edit_exchange` takes.
    if ex.get("type") != "technosphere":
        source = " (elementary flow)"
    elif tuple(inp.key) in own:
        source = f" ({inp.key[0]})"
    else:
        source = f" ({inp.key[0]} · {inp.key[1]})"
    if ex.get("formula"):
        amount = f" = `{ex.get('formula')}`"
    else:
        amount = f" = {_num(ex.get('amount'))} {inp.get('unit') or ''}".rstrip()
    return f"    - {inp.get('name')}{where}{source}{amount}"


def brief(database: str) -> dict[str, Any]:
    """The brief for `database` as Markdown, plus what it took to make it.

    A model that is not in the project (a bundle imported elsewhere, a deleted model whose name is
    still recorded) yields `exists: False` and a one-line brief that says so, rather than an error:
    the system prompt is built per turn and one missing model must not stop the chat.
    """
    bd = get_bd()
    if database not in bd.databases:
        return {
            "database": database,
            "exists": False,
            "chars": 0,
            "markdown": f"# Comparison model: `{database}`\nThis model is not in the current workspace, so nothing "
            "about it can be shown. Tell the user if the comparison matters.",
        }
    lines = [f"# Comparison model: `{database}`"]
    study = StudyMetaStore().get(database)
    db = bd.Database(database)
    acts = sorted(db, key=lambda a: str(a.get("name") or ""))
    own = {a.key for a in acts}

    # --- study frame ---------------------------------------------------------------------------
    lines.append("\n## Study frame (align with this, or say why not)")
    frame = [(k, study.get(k)) for k in FRAME_FIELDS if str(study.get(k) or "").strip()]
    if frame:
        for key, value in frame:
            lines.append(f"- **{key}**: {_cap(value, FIELD_CHARS)}")
    else:
        lines.append("- No study metadata recorded yet (goal & scope, functional unit, boundaries are empty).")
    roots = model_engine.reference_candidates(database) if acts else []
    if roots:
        root = roots[0]
        lines.append(
            f"- **reference process**: {root.get('name')} → 1 {root.get('unit')} of "
            f"\"{root.get('product') or root.get('reference product') or ''}\" [{root.get('location')}]"
        )
    backgrounds: set[str] = set()
    for act in acts:
        for ex in act.exchanges():
            if ex.get("type") == "technosphere" and tuple(ex.input.key) not in own:
                backgrounds.add(ex.input.key[0])
    lines.append(
        f"- **background database(s)**: {', '.join(sorted(backgrounds)) if backgrounds else 'none linked yet'}"
    )
    tag_map = TagStore().load_map()
    vocab: dict[str, set[str]] = {}
    codes = {act.key[1] for act in acts}
    for key, tags in tag_map.items():
        # Process tags and the tags its inputs carry of their own (key "code#uid") alike: a phase that
        # only ever sits on inputs is still a value the bars are split by.
        if key.startswith(f"{database}/") and TagStore.split_code(key[len(database) + 1:])[0] in codes:
            for t in tags:
                vocab.setdefault(str(t.get("dimension")), set()).add(str(t.get("value")))
    if vocab:
        lines.append(
            "- **tag vocabulary** (the Results page splits stacked bars by these — reuse the exact values): "
            + "; ".join(f"{dim}: {', '.join(sorted(vals))}" for dim, vals in sorted(vocab.items()))
        )
    else:
        lines.append("- **tag vocabulary**: no tags yet.")

    # --- what the study itself says it left out or assumed ---------------------------------------
    limitations = [entry for entry in (study.get("limitations") or []) if isinstance(entry, dict)]
    if limitations:
        lines.append("\n## Exclusions, assumptions and limitations recorded there")
        for entry in limitations:
            head = f"[{entry.get('kind') or 'limitation'}]"
            subject = f" {entry.get('subject')}:" if entry.get("subject") else ""
            lines.append(f"- {head}{subject} {_cap(entry.get('text'), LIMITATION_CHARS)}")

    # --- foreground structure ------------------------------------------------------------------
    lines.append(f"\n## Foreground structure ({len(acts)} processes; what each links to)")
    if not acts:
        lines.append("- No processes yet.")
    for act in acts[:MAX_PROCESSES]:
        tags = ", ".join(str(t.get("value")) for t in tag_map.get(f"{database}/{act.key[1]}", [])) or "—"
        lines.append(
            f"- **{act.get('name')}** — 1 {act.get('unit')} {act.get('reference product') or ''} "
            f"[{act.get('location')}], tag: {tags}"
        )
        desc = _cap(act.get("comment"), DESCRIPTION_CHARS)
        if desc:
            lines.append(f"    - _{desc}_")
        exchanges = [ex for ex in act.exchanges() if ex.get("type") != "production"]
        lines.extend(_exchange_line(ex, own) for ex in exchanges[:MAX_EXCHANGES])
        if len(exchanges) > MAX_EXCHANGES:
            lines.append(f"    - … {len(exchanges) - MAX_EXCHANGES} more exchanges")
    if len(acts) > MAX_PROCESSES:
        lines.append(f"- … {len(acts) - MAX_PROCESSES} more processes (read them with get_model_graph)")

    # --- parameters and scenarios --------------------------------------------------------------
    params = params_engine.list_params(database)
    lines.append(f"\n## Parameters ({len(params)}; decide which are shared assumptions and which are product-specific)")
    if not params:
        lines.append("- No parameters.")
    for p in params[:MAX_PARAMS]:
        unit = f" {p.get('unit')}" if p.get("unit") and p.get("unit") != "dimensionless" else ""
        formula = f" = `{p.get('formula')}`" if p.get("formula") else ""
        note = _cap(p.get("comment") or p.get("description"), COMMENT_CHARS)
        lines.append(f"- `{p.get('name')}` = {_num(p.get('amount'))}{unit}{formula}" + (f" — {note}" if note else ""))
    if len(params) > MAX_PARAMS:
        lines.append(f"- … {len(params) - MAX_PARAMS} more parameters")
    scenarios = ScenarioStore().list_all(database)
    if scenarios:
        lines.append(f"\n## Scenarios ({len(scenarios)})")
        for s in scenarios[:MAX_SCENARIOS]:
            overrides = ", ".join(f"`{k}`" for k in (s.get("overrides") or {}).keys()) or "no overrides"
            lines.append(f"- {s.get('name')}: overrides {overrides}")
    markdown = "\n".join(lines)
    return {"database": database, "exists": True, "chars": len(markdown), "markdown": markdown}
