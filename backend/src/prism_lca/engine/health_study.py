"""Health checks on the study record — its goal & scope fields and what its prose claims — as opposed to the
inventory checks of ``health``, which turns these into findings.

The assistant never opens the report's scope panel or its limitations chapter: it has no report tools and no
reason to go there. The health check is the one report it runs by itself, so what the report will say about
the study text has to be said here as well, while it can still be changed with `model_info` action="set".
"""
from __future__ import annotations

#: The wording the health check gives for a study without a critical review. The review tool's answer to a
#: review without a result gives the same sentence (frontend `tools/groups/reviewFailure.ts`, where a test
#: holds the two together), so the assistant is never told two different things about the same field.
NO_CRITICAL_REVIEW = "No critical review according to ISO 14044 was carried out."


def unrecorded_scope_note(database: str) -> str | None:
    """The ISO 14044 §5.2 fields this study leaves empty, as one sentence — or None if it records them.

    The report's scope panel says the same thing, and the assistant never reads it. In the run that prompted
    this, five of the six were left empty by an assistant that had used `model_info` to set the functional
    unit an hour earlier.
    """
    from prism_lca.engine.study import StudyMetaStore, unrecorded_scope

    missing = [label for _key, label in unrecorded_scope(StudyMetaStore().get(database))]
    if not missing:
        return None
    # The sentence itself, not just "record it": asked only to fill the field, an assistant wrote that an
    # AI second opinion had been obtained — after the review it meant had timed out.
    review = (
        " An empty critical review is a legitimate answer, but record it as one instead of leaving "
        f'the field blank: "{NO_CRITICAL_REVIEW}" — an AI review by the assistant is not one and does not '
        "belong there."
        if "critical review" in missing
        else ""
    )
    return (
        f"The study records no {', no '.join(missing)}. ISO 14044 §5.2 expects a report to state "
        "them, and the report's goal-and-scope chapter is written from these fields — an empty one "
        "becomes \"not defined\" in the document. Set them with `model_info` action=\"set\"; ask the "
        f"user where the answer is theirs to give rather than inventing one.{review}"
    )


def claimed_review_note(database: str) -> str | None:
    """Study text that claims an internal review of the model while the model's review log holds none — or None.

    The report prints a limitation for the same claim (`report_checks.claimed_review_not_run`); this tells the
    assistant before the report is written. In the run that prompted it, both attempts of the review had timed
    out, the tool had said that nothing was judged, and the assistant still wrote "eine interne KI-gestützte
    Zweitmeinung (Review) wurde während des Aufbaus eingeholt" into `critical_review` — encouraged, if
    anything, by this very check asking for the empty field to be filled.
    """
    from prism_lca.engine.review_claims import claimed_review_fields
    from prism_lca.engine.review_log import ReviewLogStore
    from prism_lca.engine.study import StudyMetaStore

    if ReviewLogStore().list(database):
        return None
    fields = claimed_review_fields(StudyMetaStore().get(database))
    if not fields:
        return None
    where = " and ".join(f"`{f}`" for f in fields)
    # Both readings of the sentence are spelled out: "internal review" may mean people, whom the log never
    # holds, and told only to rewrite, a test model replaced a user's own note about such a review.
    return (
        f"The study text ({where}) says an internal or AI review of the model was carried out, but the "
        "model's review log — where every review by the assistant's AI reviewer (review_model) is kept — "
        "holds none. If the sentence means that reviewer, it claims a check that never happened, and a reader "
        "takes it as one the numbers passed: rewrite it to say only what was actually done; where there was no "
        "critical review by independent experts (ISO 14044), `critical_review` says: "
        f'"{NO_CRITICAL_REVIEW}" If it means a review by people, leave it as it is: the log knows only the AI '
        "reviewer's reviews."
    )
