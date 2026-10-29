"""Abbreviations in a search query — spelled out the way the background databases name the material.

ecoinvent spells polymers out ("polyethylene terephthalate, granulate, bottle grade") and carries the
abbreviation only in the names of waste streams and renaming activities ("wastewater from PET
pelletising", "… recycled to generic market for PET …"). A search for "PET" therefore found wastewater,
sludge and bottom ash, and no primary PET in its first 25 rows; "recycled PET" reached the first recyclate
on rank 16–21. Measured with two independent reviews.

The dictionary is DERIVED from the user's own data — the activity synonyms of the background databases
(ecoinvent records "PET" on its primary PET production activities) — so no ecoinvent nomenclature ships
with PrismLCA (BYOD) and no hand-maintained list ages. The search keeps the query as typed and adds the
spelled-out form as a second variant; both are ranked over the whole corpus and fused (see
``SearchService._fused_candidates``), because BAFU names several materials WITH the abbreviation
("Polyethylene, HDPE, granulate, at plant") and replacing the token would break exactly those searches.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field

#: Bumped when a rule below changes what the dictionary contains.
RULE_VERSION = 1

#: Weights of the two variants in the fused ranking (weighted RRF). The query as typed carries little
#: weight where the abbreviation names nothing but waste streams, and full weight where a searched
#: database names the material WITH the abbreviation — there the spelled-out form adds little and, at full
#: weight, pulled "LDPE-Folie" from BAFU's film dataset to the granulate (rank 1 → 7). Measured with
#: ``backend/scripts/search_eval.py``: 0.25 and 0.5 are the values; 1.0 and 0.25 for the
#: expansion in the second case were each worse.
RAW_WEIGHT, EXPANSION_WEIGHT = 0.25, 1.0
RAW_WEIGHT_NAMED, EXPANSION_WEIGHT_NAMED = 1.0, 0.5

_CANDIDATE = re.compile(r"[A-Z][A-Z/-]{1,5}")  # no digits: "C2F6" is a formula, not an acronym
_FORM_WORDS = frozenset({"granulate", "pellets", "flakes", "powder", "liquid"})
_WASTE_ROW = re.compile(
    r"\bwaste\b|^treatment of|^disposal|to generic market|recycling|scrap|sludge|wastewater", re.I
)
#: A query that asks for a waste stream means the literal token: "wastewater from PET pelletising" IS
#: the dataset. Deliberately NOT "recycl": "recycled PET" asks for a material.
_WASTE_INTENT = re.compile(
    r"\bwaste|wastewater|sewage|sludge|incinerat|landfill|disposal|treatment of|\bdump|\bash\b|residue|"
    r"leachate|sorting|collection|end of life|\beol\b|abfall|abwasser|schlamm|verbrenn|deponie|entsorg|"
    r"sortier",
    re.I,
)
_SPLIT = re.compile(r"(\s+|[,;()]+)")
_WORD = re.compile(r"[^\W_]+")  # letters and digits of any script, like the honesty checks
_LETTERS = re.compile(r"[A-Za-z]+")
_MIN_LOWERCASE_EVIDENCE = 5


def fold(text: str | None) -> str:
    return " ".join(re.sub(r"[-_]", " ", text or "").lower().split())


@dataclass
class Row:
    """What the derivation needs of one activity."""

    name: str
    product: str
    unit: str
    synonyms: list[str]


@dataclass
class Source:
    """One background database's contribution: its abbreviations, and how its names write words —
    counted for EVERY word, not only its own abbreviations: BAFU has no synonyms but writes "XPS" in its
    names, and that is evidence for ecoinvent's entry."""

    table: dict[str, str]
    upper: Counter = field(default_factory=Counter)
    lower: Counter = field(default_factory=Counter)


def derive(rows: Iterable[Row]) -> Source:
    """Abbreviation → expansion from the activity synonyms of ONE database.

    An upper-case synonym counts as the abbreviation of a MATERIAL when at least 80 % of its carriers are
    production datasets without a waste context, measured in kilograms, whose reference products share a
    comma prefix; that prefix, minus trailing form words, is the expansion. By-product rows of
    multi-output activities ("steam, in chemical industry" at LDPE production) count neither way: a row
    counts only when the first word of its product stands in the activity name. Heuristic — it is what
    keeps LDPE in (114 instead of 130 entries without it) and is not proven on foreign data.
    """
    rows = list(rows)
    carriers: dict[str, list[Row]] = defaultdict(list)
    for r in rows:
        for s in r.synonyms:
            s = (s or "").strip()
            if _CANDIDATE.fullmatch(s):
                carriers[s].append(r)
    table: dict[str, str] = {}
    for abbr, rs in carriers.items():
        rs = [r for r in rs if (r.product.split(",")[0].strip().lower().split(" ") or [""])[0] in r.name.lower()]
        if not rs:
            continue
        good = [r for r in rs if not r.name.lower().startswith("market ")
                and not _WASTE_ROW.search(f"{r.name} {r.product}")]
        if not good or len(good) / len(rs) < 0.8 or any(r.unit != "kilogram" for r in good):
            continue
        parts = [[p.strip() for p in r.product.split(",")] for r in good]
        prefix: list[str] = []
        for i in range(min(len(p) for p in parts)):
            if len({p[i].lower() for p in parts}) != 1:
                break
            prefix.append(parts[0][i])
        while len(prefix) > 1 and all(w in _FORM_WORDS for w in prefix[-1].lower().split()):
            prefix.pop()
        if prefix:
            table[abbr] = ", ".join(prefix)
    # How the database writes words in its names: the lowercase rule needs it.
    upper, lower = Counter(), Counter()
    for r in rows:
        for w in _LETTERS.findall(f"{r.name} {r.product}"):
            if len(w) >= 3:
                if w.isupper():
                    upper[w] += 1
                elif w.islower():
                    lower[w] += 1
    return Source(table, upper, lower)


@dataclass
class Dictionary:
    """The workspace's abbreviations, merged over its background databases."""

    table: dict[str, str] = field(default_factory=dict)
    lowercase: frozenset[str] = frozenset()

    @classmethod
    def merge(cls, sources: Iterable[Source]) -> Dictionary:
        table: dict[str, str] = {}
        conflicting: set[str] = set()
        upper: Counter = Counter()
        lower: Counter = Counter()
        for src in sources:
            for k, v in src.table.items():
                if k in table and fold(table[k]) != fold(v):
                    conflicting.add(k)  # two databases disagree: no silent winner, no expansion
                table.setdefault(k, v)
            upper.update(src.upper)
            lower.update(src.lower)
        for k in conflicting:
            table.pop(k, None)
        # Lower case only where the databases themselves never write the word in lower case: "pet"
        # (90 x upper, 0 x lower in ecoinvent + BAFU) is the polymer; "per" (0 / 103) and "art" (7 / 151)
        # are words and stay what they are.
        ok = frozenset(k for k in table if len(k) >= 3 and k.isalpha()
                       and upper[k] >= _MIN_LOWERCASE_EVIDENCE and lower[k.lower()] == 0)
        return cls(table, ok)

    def names_material(self, names: Iterable[str]) -> frozenset[str]:
        """Keys a database uses AS the name of the material ("Polyethylene, HDPE, granulate")."""
        heads = {k: (v.split(",")[0].strip().lower(),
                     re.compile(rf"(?<![A-Za-z0-9]){re.escape(k)}(?![A-Za-z0-9])"))
                 for k, v in self.table.items()}
        found = set()
        for name in names:
            low = name.lower()
            if _WASTE_ROW.search(name):
                continue
            for k, (head, pat) in heads.items():
                if k not in found and low.startswith(head) and pat.search(name):
                    found.add(k)
        return frozenset(found)


@dataclass
class Expansion:
    text: str
    #: The abbreviation as the query WROTE it → what it was read as: "rPET" → "recycled polyethylene
    #: terephthalate", "pet" → "polyethylene terephthalate". Kept in the written form, with the qualifier,
    #: because the honesty checks read the query's words: "rPET bottle" must find "rpet" in a recycled
    #: bottle-grade hit, and "r-PET" must NOT count as matched by virgin PET.
    aliases: dict[str, str]
    #: The dictionary keys behind them ("PET") — what the weight rule compares with a database's names.
    keys: frozenset[str] = frozenset()
    #: Key → its plain expansion, for the honesty checks (`with_aliases`): a hit carrying "polyethylene
    #: terephthalate" carries "PET". The recyclate qualifier is NOT in here — `honesty_query` turns
    #: "rPET" into "recycled PET", so "recycled" must stand in the hit itself.
    anchors: dict[str, str] = field(default_factory=dict)
    #: Written recyclate forms the dictionary recognised → their key ("rpet" → "PET"): `honesty_query` reads
    #: them as "recycled PET" too — the forms its own pattern cannot safely catch without the dictionary.
    recyclates: dict[str, str] = field(default_factory=dict)


class Expander:
    def __init__(self, dictionary: Dictionary, exact_names: frozenset[str] = frozenset()) -> None:
        self.table = dictionary.table
        self.lowercase = dictionary.lowercase
        self.exact = exact_names

    def _lookup(self, tok: str) -> tuple[str, str] | None:
        """(dictionary key, reading) for one written token under the case rules, or None."""
        if tok in self.table and any(c.isalpha() for c in tok):
            return tok, self.table[tok]
        if tok.islower() and tok.upper() in self.lowercase:
            return tok.upper(), self.table[tok.upper()]
        # The trade's recyclate prefix: rPET, r-PET, R-PET, RPET — and in lower case (rpet, r-pet) under the
        # same rule as the abbreviation itself, so "rubber" and "rice" never split into r + something.
        m = re.fullmatch(r"(?:r-?|R-?)([A-Z]{2,6})", tok)
        if m and m.group(1) in self.table:
            return m.group(1), f"recycled {self.table[m.group(1)]}"
        m = re.fullmatch(r"r-?([a-z]{2,6})", tok)
        if m and m.group(1).upper() in self.lowercase:
            return m.group(1).upper(), f"recycled {self.table[m.group(1).upper()]}"
        return None

    def _token(self, tok: str, found: dict[str, tuple[str, str]]) -> str:
        """The whole token first, then the longest run of ``-``/``/`` segments (IP/P, E-PVC-Rohr).
        ``found`` collects written form → (key, reading)."""
        hit = self._lookup(tok)
        if hit:
            found[tok] = hit
            return hit[1]
        segs = re.split(r"([-/])", tok)
        if len(segs) == 1:
            return tok
        out, i = [], 0
        while i < len(segs):
            for j in range(len(segs), i, -1):
                piece = "".join(segs[i:j])
                hit = None if piece in ("-", "/") else self._lookup(piece)
                if hit:
                    found[piece] = hit
                    out.append(hit[1])
                    i = j
                    break
            else:
                out.append(" " if segs[i] in ("-", "/") else segs[i])
                i += 1
        return " ".join(p.strip() for p in out if p.strip())

    def expand(self, query: str) -> Expansion | None:
        folded = fold(query)
        if not folded or not self.table:
            return None
        if folded in self.exact or fold(re.sub(r"^market (group )?for ", "", folded)) in self.exact:
            return None  # the query names a dataset exactly
        if _WASTE_INTENT.search(folded):
            return None  # the literal token is meant ("wastewater from PET pelletising")
        found: dict[str, tuple[str, str]] = {}
        parts = [self._token(p, found) if p.strip() and not _SPLIT.fullmatch(p) else p
                 for p in _SPLIT.split(query)]
        found = {w: kv for w, kv in found.items() if fold(kv[1]) not in folded}  # long form already there
        if not found:
            return None
        keys = frozenset(kv[0] for kv in found.values())
        return Expansion("".join(parts), {w: kv[1] for w, kv in found.items()}, keys,
                         {k: self.table[k] for k in keys},
                         {w: kv[0] for w, kv in found.items() if kv[1].startswith("recycled ")})


#: Letters only after the prefix: refrigerant designations ("R-134a", "R-C318", "R-E170", "R-1234yf") carry
#: digits, and reading them as recyclates put "recycled" into their checks.
_RECYCLATE = re.compile(r"(?<![A-Za-z0-9])(?:r-?|R-)([A-Z]{2,6})(?![A-Za-z0-9])")


def honesty_query(query: str, recyclates: dict[str, str] | None = None) -> str:
    """A query — or a hit's text — as the honesty checks should read it: the recyclate prefix spelled out.

    "rPET bottle" → "recycled PET bottle", "r-HDPE" → "recycled HDPE". Tokenised as written, "r-HDPE"
    loses its "r" and a VIRGIN HDPE hit reads as a full match — BAFU writes "Polyethylene, HDPE,
    granulate". Spelled out, "recycled" is a query word like any other, and a list
    without a recyclate says so. Also keeps "rPET" and "PET" apart as searches ("already searched").
    Applied to the hits too, so a dataset NAMED "rPET flakes" still matches "rPET".

    ``recyclates`` are the forms only the dictionary can vouch for ("rpet", "RPET" — see
    `Expansion.recyclates`); without it "REACH" would read as "recycled EACH"."""
    text = query or ""
    for written, key in (recyclates or {}).items():
        text = re.sub(rf"(?<![A-Za-z0-9]){re.escape(written)}(?![A-Za-z0-9])", f"recycled {key}", text)
    return _RECYCLATE.sub(lambda m: f"recycled {m.group(1)}", text)


def with_aliases(texts: list[str], aliases: dict[str, str]) -> list[str]:
    """Hit texts as the coverage checks should read them: a hit that carries an expansion also carries
    its abbreviation. Per hit, never assembled across hits — "PET bottle" against a hit named
    "polyethylene terephthalate, granulate, bottle grade" must read as 2 of 2, not 1 of 2."""
    if not aliases:
        return texts
    words = {k: set(_WORD.findall(unicodedata.normalize("NFKC", v).lower())) for k, v in aliases.items()}
    out = []
    for t in texts:
        have = set(_WORD.findall(unicodedata.normalize("NFKC", t).lower()))
        extra = [k for k, w in words.items() if w and w <= have]
        out.append(f"{t} {' '.join(extra)}" if extra else t)
    return out
