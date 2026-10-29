"""A tripwire against giant files — the backend twin of ``frontend/src/fileSize.test.ts``.

Large modules grow by accretion: each feature puts its block where the related code already lives, until a
module needs its own refactoring round. The rule says where new code goes instead (CLAUDE.md, "No new giant
files"); this makes the moment of deciding unmissable:

- a module without an entry below stays within ``LIMIT`` lines;
- a module over it has a ceiling it must not outgrow. A ceiling is always the line count when it was set plus
  ``HEADROOM`` — room for the import and the call that wire in code moved elsewhere; a block-sized addition does
  not fit, and that is the point;
- when a module shrinks by ``SHRINK`` lines or more, its ceiling has to come down with it, or the freed room
  becomes a growth budget;
- ``EXEMPT`` holds flat catalogues and pure data, each with its reason: length is not their problem.

Lines are counted like ``wc -l``: newline bytes. Raising a ceiling is allowed and sometimes right; the
comment beside it says why the new lines belong in this module, not merely what the feature was. Frequent raises
on one module are the signal to cut it. Getting under a count by squeezing — deleting comments, joining lines,
dropping checks — is not a cut; the failure messages say so where they are read. Only ``backend/src`` is measured; scripts and tests are not.
"""

from __future__ import annotations

from pathlib import Path

LIMIT = 1000
HEADROOM = 25
SHRINK = 50

SRC = Path(__file__).resolve().parents[1] / "src"

#: Paths relative to backend/src. ``<count + HEADROOM>`` — the comment keeps the count it was set from.
CEILINGS: dict[str, int] = {
    # 2436 — prompts AND the proposal gate, so not exempt. The abbreviations moved to report_abbreviations;
    # the literal-number rule is the next part with a home of its own.
    "prism_lca/engine/report_prompts.py": 2461,
    "prism_lca/engine/health.py": 1984,  # 1959
    "prism_lca/engine/report_claims.py": 1759,  # 1734
    "prism_lca/engine/report_render.py": 1626,  # 1601
    "prism_lca/engine/model.py": 1550,  # 1525
    # 1564 — raised by 5 for the exchange notes in `sources_of`, the one function that fingerprints every text a
    # chapter read; a second home for one of those sources would split the list it exists to keep whole.
    "prism_lca/engine/report_staleness.py": 1594,
    "prism_lca/engine/params.py": 1362,  # 1337
    "prism_lca/search/service.py": 1242,  # 1217, after the index builds moved to builds.py
    "prism_lca/engine/backgrounds/flow_mapping.py": 1300,  # 1275
    "prism_lca/engine/lca.py": 1299,  # 1274
    "prism_lca/engine/dataimport/session.py": 1274,  # 1249
    "prism_lca/engine/bundle.py": 1152,  # 1127, after the unknown sections and the background lookups moved out
    "prism_lca/api/v1/report.py": 1115,  # 1090
    # Raised for the review refresh on a snapshot hit (`_current_review`): it belongs beside
    # `analysis_snapshot`, as the memo refresh belongs in `render_inputs`.
    "prism_lca/engine/report_pipeline.py": 1160,  # 1135
    "prism_lca/engine/report_bindings.py": 1075,  # 1050
    "prism_lca/engine/dataimport/readers.py": 1046,  # 1021
}

EXEMPT: dict[str, str] = {
    "prism_lca/engine/commands.py": (
        "a flat catalogue: one Command class per state-changing operation on the same execute/undo contract, "
        "and the attribution and LCA-lock tripwires scan exactly this file"
    ),
}

RULE = 'CLAUDE.md, "No new giant files"'
#: The cheap way under a count is to make the module worse; it is ruled out where the failure is read.
NOT_BY_SQUEEZING = (
    "Do not squeeze the module under the count: no deleting comments or docstrings, no joining lines, no "
    "dropping checks, no shorter names — that hides the size and makes the module worse. Delete code only "
    "where that is plainly an improvement in itself, such as code nothing calls any more."
)


def _sizes() -> dict[str, int]:
    return {str(p.relative_to(SRC)).replace("\\", "/"): p.read_bytes().count(b"\n") for p in SRC.rglob("*.py")}


SIZES = _sizes()


def test_the_test_is_looking_at_the_real_tree():
    """An empty walk would pass everything below."""
    assert len(SIZES) > 100
    # Existence and a real count, not "over LIMIT": a module cut down below it must not trip this.
    assert SIZES.get("prism_lca/engine/commands.py", 0) > 0


def test_every_module_without_a_ceiling_stays_within_the_limit():
    over = [
        f"{p} has {n} lines, over the {LIMIT}-line limit for modules without a ceiling. Split it by "
        f"responsibility before committing ({RULE}). Only a flat catalogue of uniform entries or pure data "
        f"belongs in EXEMPT in tests/test_file_size.py instead, with the reason. {NOT_BY_SQUEEZING}"
        for p, n in sorted(SIZES.items())
        if n > LIMIT and p not in CEILINGS and p not in EXEMPT
    ]
    assert over == []


def test_no_module_outgrows_its_ceiling():
    grown = [
        f"{p} grew to {SIZES[p]} lines; its ceiling is {ceiling}. The module is already too large to keep growing "
        f"({RULE}). Move the code you added into its own module beside it — a helper or a self-contained step "
        f"into a sibling module of its package — and import it from here. Raise the ceiling only when the new "
        f"lines belong to what this module already does, and write in a comment next to the ceiling why "
        f"they could not live elsewhere. {NOT_BY_SQUEEZING}"
        for p, ceiling in CEILINGS.items()
        if SIZES.get(p, 0) > ceiling
    ]
    assert grown == []


def test_the_ceilings_come_down_with_the_modules():
    loose = []
    for p, ceiling in CEILINGS.items():
        n = SIZES.get(p)
        if n is None:
            continue
        if n <= LIMIT:
            loose.append(
                f"{p} is down to {n} lines, within the {LIMIT}-line limit. Remove its entry from CEILINGS in "
                f"tests/test_file_size.py — the limit holds it from now on."
            )
        elif ceiling - n >= HEADROOM + SHRINK:
            loose.append(
                f"{p} is down to {n} lines, {ceiling - n} below its ceiling of {ceiling}. Lower the ceiling in "
                f"tests/test_file_size.py to {n + HEADROOM} (the count plus the {HEADROOM}-line headroom every "
                f"ceiling gets) so the freed room cannot be refilled."
            )
    assert loose == []


def test_the_lists_name_only_modules_that_exist_each_in_one_list():
    ghosts = [p for p in [*CEILINGS, *EXEMPT] if p not in SIZES]
    assert ghosts == [], f"listed in tests/test_file_size.py but missing — remove or rename: {ghosts}"
    assert not set(CEILINGS) & set(EXEMPT)
    assert all(len(reason) > 20 for reason in EXEMPT.values())
