"""Which sources a report can put in its bibliography — collected from the data snapshot.

Extracted from ``report_render`` because two modules need the same answer: the renderer prints the
tables, and ``report_prompts`` has to know whether they will exist so the writing brief can offer
their labels (`t-sources`, `t-web-research`). While the collectors lived in the renderer, prompts
could only reach them through a call-time import of the module that imports it back — the one real
cycle in the report family — and through two private names. Now both sides import the leaf.
"""

from __future__ import annotations

import re
from typing import Any

#: A bare URL in a note. Stops before the punctuation that ends the sentence around it — a comment
#: reads "… (https://example.org/x)." and the closing bracket and stop are not part of the address.
_URL = re.compile(r"https?://[^\s<>\"'()\[\]]+")


def cited_sources(data: dict[str, Any]) -> list[tuple[str, str]]:
    """Every source the study cites in its own notes, deduplicated, with where it was cited.

    The bibliography lists what the *calculation* used — the background database, the method
    families, the standards. It cannot list what the study **researched**, and after a real run that is
    most of its evidence: the packaging masses, the end-of-life split rates, the dose per wash, each
    with a URL in the comment of the process or parameter it belongs to. Those comments are printed —
    in the inventory chapter and the annex table — but scattered one per row, so a reader checking the
    study's sources had to read the whole document and copy them out. A bibliography is exactly the
    place that job is done once.

    Collected from the data rather than from the finished blocks (which is how the glossary works): a
    study's sources are its sources even when the inventory chapter is set to print names only. And
    deterministic — a URL needs no model to explain it, so unlike the glossary this collector asks
    nobody and can invent nothing.
    """
    seen: dict[str, str] = {}
    scopes: list[tuple[str, str]] = []
    for entry in data.get("foreground") or []:
        scopes.append((str(entry.get("name") or ""), str(entry.get("description") or "")))
    for entry in data.get("parameters") or []:
        scopes.append((str(entry.get("name") or ""), str(entry.get("description") or entry.get("comment") or "")))
    study = data.get("study") or {}
    scopes.append(("", str(study.get("notes") or "")))
    for item in study.get("limitations") or []:
        scopes.append(("", str((item or {}).get("text") or "")))
    for where, text in scopes:
        for match in _URL.finditer(text):
            url = match.group(0).rstrip(".,;:")
            if url not in seen:
                seen[url] = where
    return sorted(seen.items())


def researched_sources(data: dict[str, Any], exclude: set[str] | None = None) -> list[tuple[str, str]]:
    """The research log's sources that no note happens to cite, with the question each answered.

    The cited table lists what survived inside a comment; this lists the rest of what the build
    demonstrably consulted (`web_research`, recorded by the research tools). Measured before it
    existed: a run's 42,000-character research answer held the primary sources for the packaging mass
    and the reuse count, and an hour later the bibliography could not name either. Deduplicated
    against the cited table — a URL a comment already cites is one source, not two rows.
    """
    exclude = exclude or set()
    seen: dict[str, str] = {}
    for entry in data.get("web_research") or []:
        question = str(entry.get("question") or "").strip()
        for finding in entry.get("findings") or []:
            for url in finding.get("sources") or []:
                url = str(url).rstrip(".,;:")
                if url and url not in exclude and url not in seen:
                    seen[url] = question[:160]
    return sorted(seen.items())


def research_text(data: dict[str, Any]) -> str:
    """The words of the study's research findings — what a chapter discussing the literature may quote.

    Two places hold them: the research log (`web_research`, everything the research tools recorded for
    this model) and the lookups of the chapter being judged (`looked_up`), where a writer's own
    `research_web` call sits even when recording it in the log failed. Only the findings' text and the
    engine's excerpt of the cited page are taken — never a URL, whose digits are no figure anybody
    stated — and only from a finding that names its source: research may be run allowing unsourced
    statements, and a figure nobody can be cited for is no quotation.
    """
    import json

    parts: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            sourced = bool(node.get("sources")) or bool(node.get("url"))
            for key, value in node.items():
                if key in ("text", "excerpt") and isinstance(value, str):
                    if sourced:
                        parts.append(value)
                elif isinstance(value, (dict, list)):
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk([entry.get("findings") for entry in data.get("web_research") or [] if isinstance(entry, dict)])
    for lookup in data.get("looked_up") or []:
        if isinstance(lookup, dict) and lookup.get("name") == "research_web":
            try:
                walk(json.loads(str(lookup.get("result") or "")))
            except ValueError:
                continue
    return " ".join(parts)
