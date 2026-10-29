"""Built-in AI skills shipped with the app.

Unlike user skills (``skills_store.py``) these live in code, so every release updates them
automatically. They appear in the same skill list as user skills, cannot be edited or deleted,
but can be disabled (the enabled flag is persisted separately by the SkillStore).
"""
from __future__ import annotations

from pathlib import Path

#: The skill texts live beside the fonts and Typst templates, not in this module: ~1250 lines of
#: Markdown made the actual structure (the list below) impossible to find, and prose is easier to
#: review as prose. Same resolution pattern as `typst_render._ASSETS`; the PyInstaller spec bundles
#: the whole assets/ tree, so the files travel with the build.
_SKILLS_DIR = Path(__file__).resolve().parent.parent / "assets" / "skills"


def _content(skill_id: str) -> str:
    """Read once at import — module import yields finished strings, exactly as the literals did."""
    return (_SKILLS_DIR / f"{skill_id}.md").read_text(encoding="utf-8")


BUILTIN_SKILLS: list[dict] = [
    {
        "id": "builtin-model-building",
        "name": "LCA model building",
        "description": (
            "Step-by-step guidance for building a well-structured LCA model in PrismLCA: what to "
            "clarify first (goal & scope), how to structure the foreground by life-cycle phase "
            "with tags, and how to verify the result. Use whenever asked to build or extend a model."
        ),
        "content": _content("builtin-model-building"),
        "enabled": True,
        "builtin": True,
    },
    {
        "id": "builtin-proxy-selection",
        "name": "Choosing a proxy dataset",
        "description": (
            "How to pick a surrogate/proxy background dataset when the background database has no exact match: "
            "how to rank proxy strategies, judge technological/geographical/temporal similarity, "
            "avoid the known biases (waste-treatment sign, chemical underestimation), and document "
            "the choice. Use when search_background finds no well-fitting dataset for an input."
        ),
        "content": _content("builtin-proxy-selection"),
        "enabled": True,
        "builtin": True,
    },
    {
        "id": "builtin-parameters",
        "name": "Parameters & formulas",
        "description": (
            "What per-model parameters and exchange formulas are for, when to parameterise (recurring "
            "assumptions, relative quantities, what-if handles) and when not, how to book co-product "
            "allocation (the shared-step pattern with an alloc_share parameter), the formula syntax "
            "(functions, conditionals) and guard rails, and the tools to read/write them "
            "(list_parameters, edit_parameter, edit_exchange) — including "
            "keeping each parameter's comment accurate. Use when creating/using parameters or formulas, "
            "or when a process yields co-products."
        ),
        "content": _content("builtin-parameters"),
        "enabled": True,
        "builtin": True,
    },
    {
        "id": "builtin-goal-scope",
        "name": "Goal & scope",
        "description": (
            "How to pin a study down before modelling: writing a functional unit that names a "
            "function, amount and reference flow; fixing the system boundary (phases in/out, use "
            "phase, capital goods, region, year); cut-off rules; allocation; and persisting it all "
            "with model_info. Use at the start of a new study, whenever the functional unit is "
            "vague or missing, or before comparing anything."
        ),
        "content": _content("builtin-goal-scope"),
        "enabled": True,
        "builtin": True,
    },
    {
        "id": "builtin-bom",
        "name": "Bill of materials from a product description",
        "description": (
            "Turning a described product into a component list with materials and masses: what "
            "context to gather first, how to drive research_bom (and why every known specific must "
            "go into its context argument), the sanity checks that matter (mass balance, plausible "
            "component masses, concrete materials), and how to turn the result into processes with "
            "sourced comments. Use when the user describes a product but has no composition data."
        ),
        "content": _content("builtin-bom"),
        "enabled": True,
        "builtin": True,
    },
    {
        "id": "builtin-eol-scenarios",
        "name": "End-of-life & what-if scenarios",
        "description": (
            "Parameterising end-of-life fates as mass fractions that sum to 1, the ecoinvent "
            "waste-treatment sign convention and cut-off recycling trap, and building/comparing "
            "scenarios to report a range instead of a single number. Use for end-of-life modelling "
            "or any 'what if' question (transport distance, electricity mix, lifetime, loss rates)."
        ),
        "content": _content("builtin-eol-scenarios"),
        "enabled": True,
        "builtin": True,
    },
    {
        "id": "builtin-sea-distances",
        "name": "Sea freight distances",
        "description": (
            "Planning distances for the busiest ocean corridors and the routing decisions to record "
            "beside one. Load it for the Suez-or-Cape question, the PEF fallback, a plausibility check "
            "of a looked-up route — or for the figure itself when you cannot look the route up."
        ),
        "content": _content("builtin-sea-distances"),
        "enabled": True,
        "builtin": True,
    },
    {
        "id": "builtin-interpretation",
        "name": "Interpreting results",
        "description": (
            "Making sense of a computed result: magnitude anchors to sanity-check against, finding "
            "hotspots with explain_result, verifying the LCIA method variant, "
            "testing the conclusion with scenarios, and a report structure that survives review. Use "
            "after calculating, when a number looks implausible, or when asked what a result means."
        ),
        "content": _content("builtin-interpretation"),
        "enabled": True,
        "builtin": True,
    },
    {
        "id": "builtin-review",
        "name": "Critical review",
        "description": (
            "When and how to get a critical second opinion on a finished model with review_model, "
            "what a reviewer challenges (boundaries vs. what is modelled, proxy plausibility, LCIA "
            "method variant, treatment-process signs, single-hotspot dominance), and how to turn "
            "findings into fixes or named limitations. Use before reporting or comparing results."
        ),
        "content": _content("builtin-review"),
        "enabled": True,
        "builtin": True,
    },
    {
        "id": "builtin-the-app",
        "name": "PrismLCA, the app around you",
        "description": (
            "What each page of PrismLCA does, and what only the USER can do — write and render a report, "
            "import ecoinvent or BAFU, export to Excel, choose models and limits, switch on what a chat may "
            "use. Load it whenever you answer a question about the app itself — how something in PrismLCA "
            "is done, where a control is, what a page does — or are asked for something only the user can "
            "do there: name the page and the control instead of guessing, and never claim a feature you "
            "cannot verify."
        ),
        "content": _content("builtin-the-app"),
        "enabled": True,
        "builtin": True,
    },
]

BUILTIN_IDS = {s["id"] for s in BUILTIN_SKILLS}
