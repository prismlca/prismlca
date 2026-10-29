"""The document's abbreviations: which ones it actually uses, and which proposed expansions are kept.

Finding them is deterministic — a model asked to *find* abbreviations invents ones the text never used —
and a model only explains a fixed list, whose answers `accept_abbreviations` filters to that list. Kept
apart from the writing brief and the proposal gate (`report_prompts`): the glossary chapter, the
render's "used but not explained" notice and the resolve endpoint need it, the chapter writers do not.
"""
from __future__ import annotations

import re

#: An address in the document: a researched source's URL, a link the study cites. Its path segments
#: ("…/TXT/?uri=CELEX…", "…/ALL/…") look like acronyms and are none — they were listed as "used but not
#: explained" and no model could explain them.
_URL = re.compile(r"https?://[^\s\"'<>()\[\]]+")

#: An acronym as it appears in prose: 2–6 upper-case letters, optionally with digits ("GWP", "GWP100",
#: "PEF", "EPD"). Deliberately narrow — a wide net produces candidates nobody wants explained.
_ACRONYM = re.compile(r"\b([A-Z]{2,6}[0-9]{0,3})\b")

#: Never worth a glossary entry: they are either the document's own furniture or already spelled out.
_ACRONYM_STOPLIST = frozenset(
    {
        "ISO", "EN", "DIN", "IEC", "CEN", "PDF", "SVG", "PNG", "JSON", "CSV", "XLSX", "URL", "ID", "OK",
        # Our own furniture: UTC comes from the colophon timestamp, GLO/RoW from location codes. A
        # reader of an LCA report does not need "coordinated universal time" explained to them.
        "UTC", "GMT", "GLO", "RoW",
    }
)


def abbreviation_candidates(*texts: str, extra: list[str] | None = None) -> list[str]:
    """Acronyms actually present in the document, plus terms we know are in it.

    Extraction is deterministic on purpose: a model asked to *find* the abbreviations invents ones the
    text never used, and asked to explain a fixed list it can only be wrong about the meaning — which a
    reader can check. Finding and explaining are different jobs and only one of them needs a model.
    """
    found: list[str] = []
    for text in texts:
        for match in _ACRONYM.finditer(_URL.sub(" ", text or "")):
            token = match.group(1)
            if token in _ACRONYM_STOPLIST or token in found:
                continue
            found.append(token)
    for term in extra or []:
        token = str(term).strip()
        if token and token not in found:
            found.append(token)
    return sorted(found)


#: Typst commands and placeholder calls that stand between the words of the document source.
_TYPST_NOISE = re.compile(r'#pval\("[^"]*"\);?|#[a-z]+(?:\([^()]*\))?\[?|[\]\\]|@[a-z][\w-]*')
_CONTEXT_WINDOW = 110


def abbreviation_contexts(text: str, candidates: list[str]) -> dict[str, str]:
    """A short window of document text around each abbreviation's first occurrence (V410).

    The model that expands the list is otherwise shown bare tokens, and a bare EURO is a currency
    until the lorry class next to it says otherwise. Cut from the Typst source the candidates were
    found in, with the commands and placeholder calls taken out; whitespace collapsed. Deterministic,
    so the same document always hands the same context — and nothing here reaches the PDF."""
    out: dict[str, str] = {}
    body = text or ""
    for token in candidates:
        match = re.search(rf"(?<![\w-]){re.escape(token)}(?![\w-])", body)
        if not match:
            continue
        start = max(0, match.start() - _CONTEXT_WINDOW)
        end = min(len(body), match.end() + _CONTEXT_WINDOW)
        window = _TYPST_NOISE.sub(" ", body[start:end])
        window = re.sub(r"\s+", " ", window).strip()
        if window:
            out[token] = ("…" if start > 0 else "") + window + ("…" if end < len(body) else "")
    return out


def accept_abbreviations(candidates: list[str], proposed: dict[str, str]) -> dict[str, str]:
    """Keep only expansions for candidates we actually extracted.

    This is the guard that makes asking a model safe here: it cannot add an entry for something the
    document never mentions, because a key that is not a candidate is dropped.
    """
    allowed = {c.lower(): c for c in candidates}
    accepted: dict[str, str] = {}
    for key, value in (proposed or {}).items():
        canonical = allowed.get(str(key).strip().lower())
        text = str(value or "").strip()
        if not canonical or not text or text.lower() == canonical.lower():
            continue
        # First valid expansion wins, so two spellings of the same key ("GWP", "gwp") give a
        # predictable result instead of depending on dict order.
        accepted.setdefault(canonical, text)
    return dict(sorted(accepted.items()))
