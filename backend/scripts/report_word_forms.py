"""Dev-only list-authoring aid for the report claim word lists (`engine/report_claims.py`).

The gate's word lists are matched exactly and deterministically: a sentence is folded (accents,
apostrophes, case) and every entry is searched as ``\\b{entry}\\w{0,2}\\b`` — two characters of
inflection tolerance at the **end of the whole entry**. That tolerance reaches unevenly across
languages (V212 measured it: most of the German and French verb paradigm, about a third of the
Spanish one, and nothing at all inside a multi-word entry), so the forms have to be *named*. Naming
them by hand has one failure mode: the form nobody thought of is invisible.

This script is the offline half of the fix. It proposes the paradigm of a lemma, says which of the
proposed forms the current matcher already reaches, warns where a proposed entry would fire on
ordinary report prose, and — in ``--audit`` mode — runs the whole thing backwards over every entry
in every list and prints the gaps.

**When a maintainer should run it.** Twice, and only twice: (1) *before* adding or changing an entry
in `report_claims.py` — ``--lemma`` tells you which sibling forms the tolerance already covers, so
you add the two entries the language actually needs instead of six, and it tells you whether the
short stem you were about to use collides with ordinary prose (this is how ``domin`` was rejected and
``predomin`` accepted); and (2) *after* a live run turns up a wording the gate missed — run
``--audit --lang xx`` for that language and read the gap list, which usually already contains the
form the run found. It is not a linter and not part of the suite's job: its output is a proposal for a
human to accept or reject, and every accepted form is a word-list change with its own risk.

**What it cannot find, measured against the V212 additions it was asked to reproduce.** It proposes
other *forms of a lemma already in the list*, so it never finds a missing lemma: run against the
pre-V212 lists it proposed *dominando*, *dominating*, *ecológica* and the whole romance comparator
paradigm, and it had nothing to say about *predominio*, *höchste* or *bedeutendste*, because no entry
those could be a form of was there. It also does not do irregular morphology (English *led to*,
German *führen zu*) or German compound-noun plurals (*hauptbeiträge*), and the German declension of
an attributive adjective is reported as a question rather than an answer, because which of the five
endings is grammatical depends on the noun's gender.

A stemmer is used **offline only**. Stemming at match time was built and rejected with evidence: the
German Snowball stemmer collapses *bedeutendste*/*wichtigste*/*höchste* to *bedeut*/*wichtig*/*hoch*,
so "Das bedeutet, dass…" and "Ein wichtiger Beitrag…" were blocked by the gate. Nothing under
``src/`` may import this file or `snowballstemmer`; the dependency lives in the ``dev`` extra.

Usage::

    cd backend
    uv run python scripts/report_word_forms.py --audit
    uv run python scripts/report_word_forms.py --audit --lang es
    uv run python scripts/report_word_forms.py --lemma dominante --lang es
    uv run python scripts/report_word_forms.py --lemma "mayor contribuyente" --lang es --verbose
"""
from __future__ import annotations

import argparse
import ast
import itertools
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

try:
    import snowballstemmer
except ModuleNotFoundError:  # pragma: no cover - dev tool
    sys.exit("snowballstemmer is missing: run `uv sync --extra dev` (dev extra, never a runtime dep).")

from prism_lca.engine import report_claims as rc

LANGS = ("en", "de", "fr", "es", "pt")
_SNOWBALL = {"en": "english", "de": "german", "fr": "french", "es": "spanish", "pt": "portuguese"}


# ---------------------------------------------------------------------------------------------
# The lists, read from the module rather than copied. `kind` is the matcher the gate actually uses
# for that list: the comparators are matched as bare words with no tolerance (`_says`, V213), the
# ordinals get a second arm that matches a stem glued to a superlative ("zweitgrößte",
# `_disarming_ordinal`), everything else goes through `_mentions`.
# ---------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class ListSpec:
    name: str
    entries: dict[str, tuple[str, ...]]
    kind: str = "mentions"


def _comparators(side: int) -> dict[str, tuple[str, ...]]:
    return {lang: pair[side] for lang, pair in rc._COMPARATORS.items()}


LISTS: tuple[ListSpec, ...] = (
    ListSpec("superlatives", rc._SUPERLATIVES),
    ListSpec("value", rc._VALUE_WORDS),
    ListSpec("neutrality", rc._NEUTRALITY_WORDS),
    ListSpec("causal", rc._CAUSAL),
    ListSpec("comparative-superlatives", rc._COMPARATIVE_SUPERLATIVES),
    ListSpec("ordinals", rc._ORDINALS, kind="ordinal"),
    ListSpec("higher", _comparators(0), kind="word"),
    ListSpec("lower", _comparators(1), kind="word"),
)
BY_NAME = {spec.name: spec for spec in LISTS}


def _matches(entry: str, text: str, spec: ListSpec, lang: str) -> bool:
    """Does this entry match this text, the way the gate matches it?"""
    low = rc.fold(text)
    pattern = re.escape(rc.fold(entry))
    if spec.kind == "word":
        return re.search(rf"\b{pattern}\b", low) is not None
    if spec.kind == "ordinal":
        tail = "|".join(re.escape(rc.fold(w)) for w in rc._SUPERLATIVES.get(lang, ()))
        glued = rf"|(?={tail})" if tail else ""
        return re.search(rf"\b{pattern}(?:\w{{0,2}}\b{glued})", low) is not None
    # Borrowed rather than rebuilt: a few entries carry no inflection tolerance at all
    # (`rc._NO_INFLECTION`), and a copy of the pattern here would tell the author that a form the gate
    # cannot see is "already reached".
    return re.search(rc._entry_pattern(entry), low) is not None


def _reached_by(candidate: str, spec: ListSpec, lang: str) -> str | None:
    for entry in spec.entries.get(lang, ()):
        if _matches(entry, candidate, spec, lang):
            return entry
    return None


# ---------------------------------------------------------------------------------------------
# The guard corpus: the negative sentences the suite already keeps, harvested from the test module
# by AST so it cannot drift. Only named collections are read — a test's *positive* sentences would
# turn every correct candidate into a false alarm.
# ---------------------------------------------------------------------------------------------
_TEST_FILE = Path(__file__).resolve().parent.parent / "tests" / "test_report_claims.py"

#: name -> default language for the strings inside it (a (lang, sentence) pair overrides it).
_GUARD_SOURCES: dict[str, str] = {
    "_OWN_NOT_CLEAN": "fr",                                    # V207: "des estimations propres"
    "_ORDINARY_PROSE": "",                                     # V207: vertu / Gründe / verdad
    "_DOMAIN_NOT_DOMINANCE": "",                               # V212: dominio / dominó / dominical
    "test_the_discipline_is_not_a_boast": "",                  # sustainability, limpieza
    "test_a_comparator_is_a_word_and_not_a_substring": "",     # V213: excedente / superar / dépassement
    "test_secondary_data_does_not_switch_the_superlative_rule_off": "",   # V209: secondary data
    "test_the_bare_stem_of_exceed_stays_out": "en",            # exceedingly
    "test_according_to_is_not_an_ordinal_in_portuguese": "pt",  # V213: segundo a norma
    "test_honest_prose_stays_silent": "en",
}
_PLACEHOLDER = re.compile(r"\{\{.*?\}\}")


def _strings(node: ast.AST, default: str) -> list[tuple[str, str]]:
    """Every sentence-like string under `node`, paired with a language.

    A tuple that carries a two-letter language code tags its own strings; anything else falls back
    to the collection's default language. Placeholders are stripped — a guard sentence is prose.
    """
    doc = ast.get_docstring(node) if isinstance(node, ast.FunctionDef) else None
    out: list[tuple[str, str]] = []
    tagged: set[str] = set()
    for sub in ast.walk(node):
        if not isinstance(sub, ast.Tuple):
            continue
        texts = [e.value for e in sub.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
        tags = [t for t in texts if t in LANGS]
        lang = tags[0] if tags else default
        for text in texts:
            if text in LANGS or " " not in text or len(text) < 12:
                continue
            tagged.add(text)
            out.append((lang, _PLACEHOLDER.sub(" ", text).strip()))
    # Loose strings — a `for text in [...]` list, a bare assert — that sit in no tuple at all. They
    # inherit the collection's default language; a sentence already tagged above is not repeated,
    # because an untagged copy would be checked against every language.
    for sub in ast.walk(node):
        if not isinstance(sub, ast.Constant) or not isinstance(sub.value, str):
            continue
        text = sub.value
        if text in tagged or text == doc or text in LANGS:
            continue
        if " " in text and 12 <= len(text) < 200 and "\n" not in text:
            out.append((default, _PLACEHOLDER.sub(" ", text).strip()))
    return out


def guard_corpus() -> list[tuple[str, str]]:
    tree = ast.parse(_TEST_FILE.read_text(encoding="utf-8"))
    found: list[tuple[str, str]] = []
    for node in tree.body:
        name = ""
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
        elif isinstance(node, ast.FunctionDef):
            name = node.name
        if name in _GUARD_SOURCES:
            found += _strings(node, _GUARD_SOURCES[name])
    # A docstring is prose about prose, not prose: drop anything that reads like one.
    seen: dict[tuple[str, str], None] = {}
    for lang, text in found:
        if text.startswith(("V2", "The two", "What stays", "Restraint", "Seven notes")):
            continue
        seen.setdefault((lang, text), None)
    return list(seen)


GUARDS = guard_corpus()


def unsafe_on(candidate: str, spec: ListSpec, lang: str) -> list[str]:
    """Guard sentences this candidate would fire on that the list is silent on today.

    "That the list is silent on today" is the whole test. A guard sentence for the *ordinals* may
    well contain a real superlative ("Secondary data was used, and the dominant group is …"), and a
    new superlative form firing there adds no risk the list does not already carry. A candidate that
    fires where every current entry keeps quiet is the one that changes the gate's behaviour.
    """
    hits = []
    for glang, sentence in GUARDS:
        if glang and glang != lang:
            continue
        if not _matches(candidate, sentence, spec, lang):
            continue
        if any(_matches(e, sentence, spec, lang) for e in spec.entries.get(lang, ())):
            continue
        hits.append(sentence)
    return hits


# ---------------------------------------------------------------------------------------------
# Paradigm rules. Surface-suffix swaps on the *lemma*, never on a stem: the stem is where the
# runtime experiment died (base "bedeut" regenerates "bedeutet", and "Das bedeutet, dass…" is a
# sentence, not a claim to the top). Longest matching suffix wins, so "höchste" is read as a
# superlative and "grün" as a base form. Each ending carries number and gender, so a multi-word
# entry only ever combines forms that agree.
#   (suffix, family, ((ending, number, gender), ...))
#
# The first version of this table inflected every word of every entry and produced "respetuoso cons
# els medios ambientes". Three rules keep it honest now: function words never inflect (STOPWORDS),
# adverbs never inflect, and an entry of more than two words only ever inflects its first content
# word — which is where romance agreement actually sits ("respetuosa con el medio ambiente").
# ---------------------------------------------------------------------------------------------
Ending = tuple[str, str, str]
#: (suffix, family, inflect, derived-groups). `inflect` is the same word in another number or gender
#: and is always offered. Each *derived* group crosses word class — the verb behind a Spanish
#: "-ante", the noun behind a French "-ant" — and is offered only when another entry of the same list
#: already spells a form from **that** group: "dominante" beside "domina" is a verb and wants its
#: gerund, "importante" beside nothing is an adjective, and wanting "importando" is how a word list
#: fills up with words no author writes. The groups are separate for a reason measured here:
#: "preponderancia" corroborates the *noun*, not the verb, and one shared gate let it unlock nine
#: verb forms nobody writes.
Rule = tuple[str, str, tuple[Ending, ...], tuple[tuple[Ending, ...], ...]]

#: Function words. They carry no inflection an author would write differently, and inflecting them
#: was the single biggest source of nonsense ("más" → "máses", "con" → "cons").
STOPWORDS: dict[str, frozenset[str]] = {
    "en": frozenset("a an the of to in on for and by as than at with is are was were not no".split()),
    "de": frozenset("der die das den dem des ein eine einer einem als zu von durch für im mit auf "
                    "über unter und ist sind nicht mehr weniger".split()),
    "fr": frozenset("le la les l' de des du d' à au aux en dans sur pour et que qu' est sont plus "
                    "moins ne pas parce raison".split()),
    "es": frozenset("el la los las un una de del a al en con y que es son más menos no por para "
                    "o os as".split()),
    "pt": frozenset("o a os as um uma de do da dos das ao à aos às em no na com e que é são mais "
                    "menos não por para".split()),
}
_ADVERB_SUFFIX = {"en": ("ly",), "de": (), "fr": ("ment",), "es": ("mente",), "pt": ("mente",)}

_ROM_O = (("o", "s", "m"), ("a", "s", "f"), ("os", "p", "m"), ("as", "p", "f"))
_ROM_E = (("e", "s", "-"), ("es", "p", "-"))
#: Comparatives in the romance languages are invariable in gender (mayor/menor/superior), so the
#: "-or" rule offers number only. Adding "-ora" produced "superiora a", which no report writes.
_ROM_OR = (("or", "s", "-"), ("ores", "p", "-"))
#: An agent noun *does* carry gender ("respeitadora do ambiente"), unlike the bare comparative.
_ROM_DOR = (("dor", "s", "m"), ("dores", "p", "m"), ("dora", "s", "f"), ("doras", "p", "f"))


def _tag(endings: tuple[str, ...]) -> tuple[Ending, ...]:
    known = {
        "ado": ("s", "m"), "ada": ("s", "f"), "ados": ("p", "m"), "adas": ("p", "f"),
        "ante": ("s", "-"), "antes": ("p", "-"), "ancia": ("s", "f"), "ância": ("s", "f"),
        "al": ("s", "-"), "ales": ("p", "-"), "ais": ("p", "-"),
        "ción": ("s", "f"), "ciones": ("p", "f"), "ção": ("s", "f"), "ções": ("p", "f"),
        "dad": ("s", "f"), "dades": ("p", "f"), "dade": ("s", "f"),
        "ble": ("s", "-"), "bles": ("p", "-"), "bilidad": ("s", "f"),
        "vel": ("s", "-"), "veis": ("p", "-"),
        "or": ("s", "-"), "ors": ("p", "-"), "ity": ("s", "-"), "ities": ("p", "-"),
        "ste": ("s", "-"), "sten": ("p", "-"),
        "ité": ("s", "f"), "ités": ("p", "f"),
    }
    return tuple((e, *known.get(e, ("-", "-"))) for e in endings)


_ES_VERB = _tag(("a", "an", "ar", "ado", "ada", "ados", "adas", "ando", "ó"))
_PT_VERB = _tag(("a", "am", "ar", "ado", "ada", "ados", "adas", "ando", "ou"))
_ES_ANTE = _tag(("ante", "antes"))
_PT_ANTE = _tag(("ante", "antes"))
_ES_PART = _tag(("ado", "ada", "ados", "adas"))
_PT_PART = _tag(("ado", "ada", "ados", "adas"))
_FR_ANT = (("ant", "s", "m"), ("ants", "p", "m"), ("ante", "s", "f"), ("antes", "p", "f"))
_FR_IF = (("if", "s", "m"), ("ifs", "p", "m"), ("ive", "s", "f"), ("ives", "p", "f"))
_FR_AL = (("al", "s", "m"), ("aux", "p", "m"), ("ale", "s", "f"), ("ales", "p", "f"))
_FR_EUR = (("eur", "s", "m"), ("eurs", "p", "m"), ("eure", "s", "f"), ("eures", "p", "f"))
_FR_IER = (("ier", "s", "m"), ("iers", "p", "m"), ("ière", "s", "f"), ("ières", "p", "f"))
_FR_E_ACUTE = (("é", "s", "m"), ("és", "p", "m"), ("ée", "s", "f"), ("ées", "p", "f"))
_FR_T = (("t", "s", "m"), ("ts", "p", "m"), ("te", "s", "f"), ("tes", "p", "f"))
_EN_ATE = _tag(("ate", "ates", "ated", "ating"))
_EN_ANT = _tag(("ant",))
_EN_ANCE = _tag(("ance",))

RULES: dict[str, tuple[Rule, ...]] = {
    "es": (
        ("ando", "verb", _tag(("ando",)), (_ES_VERB, _ES_ANTE, _tag(("ancia",)))),
        ("antes", "verb", _ES_ANTE, (_ES_VERB, _tag(("ancia",)))),
        ("ante", "verb", _ES_ANTE, (_ES_VERB, _tag(("ancia",)))),
        ("ancia", "verb", _tag(("ancia",)), (_ES_VERB, _ES_ANTE)),
        ("ad", "verb", _ES_PART, (_ES_VERB, _ES_ANTE)),
        ("ciones", "noun", _tag(("ción", "ciones")), ()),
        ("ción", "noun", _tag(("ción", "ciones")), ()),
        ("bilidad", "noun", _tag(("bilidad",)), (_tag(("ble", "bles")),)),
        ("bles", "adj", _tag(("ble", "bles")), (_tag(("bilidad",)),)),
        ("ble", "adj", _tag(("ble", "bles")), (_tag(("bilidad",)),)),
        ("dades", "noun", _tag(("dad", "dades")), ()),
        ("dad", "noun", _tag(("dad", "dades")), ()),
        ("doras", "adj", _ROM_DOR, ()), ("dora", "adj", _ROM_DOR, ()),
        ("dores", "adj", _ROM_DOR, ()), ("dor", "adj", _ROM_DOR, ()),
        ("ores", "adj", _ROM_OR, ()), ("or", "adj", _ROM_OR, ()),
        ("ales", "adj", _tag(("al", "ales")), ()), ("al", "adj", _tag(("al", "ales")), ()),
        ("os", "adj", _ROM_O, ()), ("as", "adj", _ROM_O, ()),
        ("o", "adj", _ROM_O, ()), ("a", "adj", _ROM_O, ()),
        ("es", "noun", _ROM_E, ()), ("e", "noun", _ROM_E, ()),
        ("s", "noun", (("", "s", "-"), ("s", "p", "-")), ()),
    ),
    "pt": (
        ("ando", "verb", _tag(("ando",)), (_PT_VERB, _PT_ANTE, _tag(("ância",)))),
        ("antes", "verb", _PT_ANTE, (_PT_VERB, _tag(("ância",)))),
        ("ante", "verb", _PT_ANTE, (_PT_VERB, _tag(("ância",)))),
        ("ância", "verb", _tag(("ância",)), (_PT_VERB, _PT_ANTE)),
        ("ad", "verb", _PT_PART, (_PT_VERB, _PT_ANTE)),
        ("ções", "noun", _tag(("ção", "ções")), ()),
        ("ção", "noun", _tag(("ção", "ções")), ()),
        ("veis", "adj", _tag(("vel", "veis")), ()), ("vel", "adj", _tag(("vel", "veis")), ()),
        ("dades", "noun", _tag(("dade", "dades")), ()),
        ("dade", "noun", _tag(("dade", "dades")), ()),
        ("doras", "adj", _ROM_DOR, ()), ("dora", "adj", _ROM_DOR, ()),
        ("dores", "adj", _ROM_DOR, ()), ("dor", "adj", _ROM_DOR, ()),
        ("ores", "adj", _ROM_OR, ()), ("or", "adj", _ROM_OR, ()),
        ("ais", "adj", _tag(("al", "ais")), ()), ("al", "adj", _tag(("al", "ais")), ()),
        ("os", "adj", _ROM_O, ()), ("as", "adj", _ROM_O, ()),
        ("o", "adj", _ROM_O, ()), ("a", "adj", _ROM_O, ()),
        ("es", "noun", _ROM_E, ()), ("e", "noun", _ROM_E, ()),
        ("s", "noun", (("", "s", "-"), ("s", "p", "-")), ()),
    ),
    "fr": (
        ("ant", "adj", _FR_ANT, (_tag(("ance",)),)),
        ("ance", "noun", _tag(("ance",)), (_FR_ANT,)),
        ("euses", "adj", (("eux", "-", "m"), ("euse", "s", "f"), ("euses", "p", "f")), ()),
        ("eux", "adj", (("eux", "-", "m"), ("euse", "s", "f"), ("euses", "p", "f")), ()),
        ("ives", "adj", _FR_IF, ()), ("ive", "adj", _FR_IF, ()),
        ("ifs", "adj", _FR_IF, ()), ("if", "adj", _FR_IF, ()),
        ("aux", "adj", _FR_AL, ()), ("ales", "adj", _FR_AL, ()), ("al", "adj", _FR_AL, ()),
        ("eurs", "noun", _FR_EUR, ()), ("eur", "noun", _FR_EUR, ()),
        ("iers", "adj", _FR_IER, ()), ("ier", "adj", _FR_IER, ()),
        ("ités", "noun", _tag(("ités",)), (_tag(("ité",)),)),
        ("ité", "noun", _tag(("ité",)), (_tag(("ités",)),)),
        ("ées", "adj", _FR_E_ACUTE, ()), ("és", "adj", _FR_E_ACUTE, ()),
        ("ée", "adj", _FR_E_ACUTE, ()), ("é", "adj", _FR_E_ACUTE, ()),
        ("os", "adj", (("os", "-", "m"), ("osse", "s", "f"), ("osses", "p", "f")), ()),
        ("tes", "adj", _FR_T, ()), ("ts", "adj", _FR_T, ()),
        ("te", "adj", _FR_T, ()), ("t", "adj", _FR_T, ()),
        ("es", "noun", _ROM_E, ()), ("e", "noun", _ROM_E, ()),
        ("s", "noun", (("", "s", "-"), ("s", "p", "-")), ()),
    ),
    # English inflects at the end, which is where the two characters of tolerance already reach:
    # "dominate" carries *dominates* and *dominated* for free. So there is no catch-all rule here on
    # purpose — a default that appends "-s"/"-est" to anything produced "becauseest" and "secondest".
    # Only the families whose forms fall *outside* the tolerance are named.
    "en": (
        ("ant", "adj", _EN_ANT, (_EN_ANCE, _EN_ATE)),
        ("ent", "adj", _tag(("ent",)), (_tag(("ence",)),)),
        ("ance", "noun", _EN_ANCE, (_EN_ANT, _EN_ATE)),
        ("ating", "verb", _EN_ATE, (_EN_ANT, _EN_ANCE)),
        ("ated", "verb", _EN_ATE, (_EN_ANT, _EN_ANCE)),
        ("ates", "verb", _EN_ATE, (_EN_ANT, _EN_ANCE)),
        ("ate", "verb", _EN_ATE, (_EN_ANT, _EN_ANCE)),
        ("able", "adj", _tag(("able", "ably")), ()),
        ("less", "adj", _tag(("less", "lessly")), ()),
        # A superlative's comparative is a different claim, not another spelling of the same one:
        # "larger" belongs in the comparator list if anywhere, never here. So "-est" offers no "-er".
        ("est", "adj", _tag(("est",)), ()),
        ("ities", "noun", _tag(("ities",)), (_tag(("ity",)),)),
        ("ity", "noun", _tag(("ity",)), (_tag(("ities",)),)),
        ("ors", "noun", _tag(("or", "ors")), ()), ("or", "noun", _tag(("or", "ors")), ()),
    ),
    "de": (
        ("ste", "adj", _tag(("ste", "ster", "stes", "sten", "stem")), ()),
        ("ierend", "verb", _tag(("iert", "ierte", "ierten", "ierend", "ierende", "ierender",
                                "ierendes", "ierenden")), ()),
        ("iert", "verb", _tag(("iert", "ierte", "ierten", "ierend", "ierende", "ierender",
                              "ierendes", "ierenden")), ()),
        ("end", "adj", _tag(("end", "ende", "ender", "endes", "enden", "endem", "endste",
                             "endsten")), ()),
        ("ant", "adj", _tag(("ant", "ante", "anter", "antes", "anten")), (_tag(("anz",)),)),
        ("anz", "noun", _tag(("anz",)), (_tag(("ant", "ante", "anten")),)),
        ("ität", "noun", _tag(("ität",)), ()),
        # The nominalisation is productive and unambiguous in German, so it is not gated:
        # "kohlenstoffneutral" really does want "kohlenstoffneutralität" beside it.
        ("al", "adj", _tag(("al", "ale", "aler", "ales", "alen", "alität")), ()),
        ("ig", "adj", _tag(("ig", "ige", "iger", "iges", "igen", "igste", "igster", "igstes",
                            "igsten")), ()),
        ("lich", "adj", _tag(("lich", "liche", "licher", "liches", "lichen", "lichste",
                              "lichster", "lichstes", "lichsten")), ()),
    ),
}



#: German declension endings. Which of the five is grammatical depends on the noun's gender and case,
#: which a word list cannot know — so where they land on an *attributive* adjective ("grüner strom")
#: they are reported as one advisory line rather than as five separate gaps.
_DE_DECLENSION = ("e", "er", "es", "en", "em")

#: German adjectives whose base form ends in what looks like a declension ending. Stripping the "er"
#: off *sauber* leaves *saub*, and Snowball does not help (it stems both to "saub"), so the exception
#: is a named list. Extend it when an entry like *teuer* or *dunkel* lands in a list.
_DE_BASE = frozenset(("sauber", "grün", "hoch", "rein", "teuer", "dunkel", "klein", "warm", "kalt"))


@dataclass
class Candidate:
    form: str
    family: str
    verdict: str = ""          # in-list | reached | gap | unsafe
    via: str = ""              # the entry that reaches it
    guards: list[str] = field(default_factory=list)


def _invariable(word: str, lang: str) -> bool:
    if word in STOPWORDS.get(lang, ()):
        return True
    if any(word.endswith(s) for s in _ADVERB_SUFFIX.get(lang, ())):
        return True
    # A German past participle used predicatively does not decline ("getrieben durch").
    return lang == "de" and word.startswith("ge") and word.endswith(("en", "t")) and len(word) > 5


def _corroborated(base: str, siblings: tuple[str, ...], group: tuple[Ending, ...]) -> bool:
    """Does another single-word entry of the same list already spell a form from *this* group?"""
    endings = {e for e, _n, _g in group}
    return any(" " not in sib and sib.startswith(base) and sib[len(base):] in endings
               for sib in siblings)


def _german_forms(word: str, attributive: bool) -> list[tuple[str, str, str, str]]:
    if word in _DE_BASE:
        return [(word, "self", "-", "-")] + [
            (word + e, "de-base", "-", "-")
            for e in (*_DE_DECLENSION, "ste", "ster", "stes", "sten")
        ]
    for suffix, family, inflect, _derive in sorted(RULES["de"], key=lambda r: -len(r[0])):
        if suffix and word.endswith(suffix) and len(word) - len(suffix) >= 3:
            base = word[: -len(suffix)]
            return [(base + e, family, n, g) for e, n, g in inflect]
    # A bare declension ending, but only on a participial or superlative stem ("größten", "dritte").
    # Applying it to any word ending in "-er" turned the noun *haupttreiber* into "haupttreibem".
    if attributive or word.endswith(("te", "ter", "tes", "ten", "tem")):
        for end in sorted(_DE_DECLENSION, key=len, reverse=True):
            if word.endswith(end) and len(word) - len(end) >= 4:
                base = word[: -len(end)]
                family = "de-attributive" if attributive else "de-declension"
                return [(base + e, family, "-", "-") for e in _DE_DECLENSION]
    return [(word, "self", "-", "-")]


def _word_forms(word: str, lang: str, *, attributive: bool, siblings: tuple[str, ...],
                gender_frozen: bool) -> list[tuple[str, str, str, str]]:
    """(form, family, number, gender) for one word, the word itself included.

    The word's own form carries the number and gender its rule gives it — not a wildcard. That
    matters for a collocation: with a wildcard, "énergies propre" agreed with itself and turned up as
    a gap.
    """
    if lang == "de":
        return _german_forms(word, attributive)
    best: Rule | None = None
    for rule in RULES.get(lang, ()):
        suffix = rule[0]
        if not word.endswith(suffix) or len(word) - len(suffix) < 2:
            continue
        if best is None or len(suffix) > len(best[0]):
            best = rule
    if best is None:
        return [(word, "self", "-", "-")]
    suffix, family, inflect, derive = best
    base = word[: len(word) - len(suffix)]
    endings = list(inflect)
    for group in derive:
        if _corroborated(base, siblings, group):
            endings += list(group)
    own = next((t for t in endings if base + t[0] == word), None)
    if gender_frozen and own is not None:
        endings = [t for t in endings if t[2] in ("-", own[2])]
    out = [(base + e, family, n, g) for e, n, g in endings]
    if own is None:
        out.insert(0, (word, "self", "-", "-"))
    return out


def _positions(words: list[str], lang: str) -> set[int]:
    """Which words of a multi-word entry are worth inflecting.

    German inflects in front of the noun ("grüner strom"), English behind the adjective ("main
    contributor"), and the romance languages agree across the phrase — but only for two words. An
    entry of three or more words has a preposition in it, and there the inflection an author varies
    is the leading adjective ("respetuosa con el medio ambiente"), never the noun behind the
    preposition.
    """
    content = [i for i, w in enumerate(words) if not _invariable(w, lang)]
    if not content:
        return set()
    if len(words) == 1:
        return {0}
    if lang == "de":
        # A German entry with a function word in it is a fixed phrase ("höher als", "über dem").
        if any(w in STOPWORDS["de"] for w in words):
            return set()
        return {i for i in content if i < len(words) - 1}
    if lang == "en":
        return {content[-1]}
    return set(content) if len(words) == 2 else {content[0]}


def propose(lemma: str, lang: str, siblings: tuple[str, ...] = (), limit: int = 40) -> list[Candidate]:
    """The surface forms a competent author might write for this lemma, deduplicated."""
    words = lemma.split()
    vary = _positions(words, lang)
    # Two content words agreeing means the noun's gender is fixed by the noun, so only number may
    # move: "énergie propre" → "énergies propres" and never "énergie propres" or "produite propre".
    frozen = len(vary) > 1
    per_word = [
        _word_forms(w, lang, attributive=(lang == "de" and i < len(words) - 1),
                    siblings=siblings, gender_frozen=frozen)
        if i in vary else [(w, "self", "-", "-")]
        for i, w in enumerate(words)
    ]
    stemmer = snowballstemmer.stemmer(_SNOWBALL[lang])
    seen: dict[str, Candidate] = {}
    for combo in itertools.product(*per_word):
        tags = [(n, g) for _f, _fam, n, g in combo]
        if any(not _agrees(a, b) for a, b in itertools.combinations(tags, 2)):
            continue
        form = " ".join(f for f, _fam, _n, _g in combo)
        family = next((fam for _f, fam, _n, _g in combo if fam != "self"), "self")
        if form in seen or not _plausible(form, lemma, lang, stemmer):
            continue
        seen[form] = Candidate(form=form, family=family)
        if len(seen) >= limit:
            break
    return list(seen.values())


def _agrees(a: tuple[str, str], b: tuple[str, str]) -> bool:
    return all(x == "-" or y == "-" or x == y for x, y in zip(a, b, strict=True))


def _plausible(form: str, lemma: str, lang: str, stemmer) -> bool:
    """Snowball as a verifier: word for word, is this still the same lemma?

    Deliberately lenient, and measured that way. Portuguese *contribuição* and *contribuições* stem
    to "contribuiçã"/"contribuiçõ" — the same word, not the same string — and a strict test drops
    exactly the plural collocations V212 had to add by hand. The Spanish stemmer leaves *alto* and
    *alta* untouched (both are short), so requiring four shared characters threw away the feminine
    comparator, which is the single form the audit most needs to find. So the test is only that the
    stems do not diverge early.

    The honest summary of this function is that it rejects almost nothing. A stemmer cannot verify a
    form it was never built to generate; what Snowball genuinely earns its place for in this script
    is `stem_note` — whether the *stem* would be a safe entry — and that is the question V212
    answered by hand for `domin` and `predomin`.
    """
    a, b = form.split(), lemma.split()
    if len(a) != len(b):
        return False
    for x, y in zip(a, b, strict=True):
        if x == y:
            continue
        sx, sy = rc.fold(stemmer.stemWord(x)), rc.fold(stemmer.stemWord(y))
        shared = len(sx) if sx == sy else len(_common_prefix(sx, sy))
        if shared < 3 or shared < min(len(sx), len(sy)) - 2:
            return False
    return True


def _common_prefix(a: str, b: str) -> str:
    out = []
    for x, y in zip(a, b, strict=False):
        if x != y:
            break
        out.append(x)
    return "".join(out)


def classify(lemma: str, lang: str, spec: ListSpec) -> list[Candidate]:
    siblings = spec.entries.get(lang, ())
    entries = {rc.fold(e) for e in siblings}
    out = []
    for cand in propose(lemma, lang, siblings):
        if rc.fold(cand.form) in entries:
            cand.verdict, cand.via = "in-list", cand.form
            out.append(cand)
            continue
        guards = unsafe_on(cand.form, spec, lang)
        if guards:
            cand.verdict, cand.guards = "unsafe", guards
            out.append(cand)
            continue
        via = _reached_by(cand.form, spec, lang)
        cand.verdict, cand.via = ("reached", via) if via else ("gap", "")
        out.append(cand)
    return out


def stem_note(lemma: str, lang: str, spec: ListSpec) -> str:
    """Would the bare stem do the job of the whole paradigm, or does it collide with prose?

    This is the question V212 answered by hand for `domin` (rejected: it reaches *dominio*, the word
    a goal-and-scope chapter uses for its own scope, and this rule blocks) and `predomin` (accepted,
    and it earned the noun and the past tense with it). Mechanising that question is the one thing
    the stemmer genuinely earns its place for here.

    It is never phrased as a clearance. Forty-four guard sentences are not a language, and the
    stemmer is happy to hand back a stem that is an ordinary word: *höchste* stems to *hoch*,
    *wichtigste* to *wichtig*, and using either as an entry is precisely how the runtime experiment
    blocked "Ein wichtiger Beitrag…". So the note says what was measured and how far it reaches.
    """
    word = lemma.split()[-1]
    if len(lemma.split()) > 1:
        return ""
    stem = snowballstemmer.stemmer(_SNOWBALL[lang]).stemWord(word)
    if len(stem) < 4 or stem == word:
        return ""
    guards = unsafe_on(stem, spec, lang)
    if guards:
        return f"stem `{stem}` is UNSAFE — fires on {guards[0]!r}; name the forms instead"
    short = len(word) - len(stem)
    return (f"stem `{stem}` fires on none of the {len(GUARDS)} guard sentences — but that corpus is "
            f"not the language, and `{stem}` is {short} character(s) shorter than the entry. Read it "
            f"as a word first (this is where `wichtigste` → `wichtig` broke).")


# ---------------------------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------------------------
def _fmt(cands: list[Candidate], verdict: str) -> list[str]:
    return [c.form for c in cands if c.verdict == verdict]


def _minimal(forms: list[str], spec: ListSpec, lang: str) -> list[str]:
    """The fewest entries that cover all of these forms.

    German declines its superlative ("unbedenklichste", "-ster", "-stes", "-sten"), and the two
    characters of tolerance carry four of them off the first — so proposing all four is proposing
    three entries a maintainer would then have to delete. Shortest first, and anything a kept form
    already reaches drops out.
    """
    kept: list[str] = []
    for form in sorted(set(forms), key=lambda f: (len(f), f)):
        if not any(_matches(k, form, spec, lang) for k in kept):
            kept.append(form)
    return kept


def report_lemma(lemma: str, lang: str, spec: ListSpec, verbose: bool) -> None:
    cands = classify(lemma, lang, spec)
    print(f"\n{lang}  {spec.name}  ·  lemma {lemma!r}   ({len(cands)} forms proposed)")
    attr = [c for c in cands if c.family == "de-attributive" and c.verdict == "gap"]
    gaps = [c for c in cands if c.verdict == "gap" and c not in attr]
    for label, forms in (("in list ", _fmt(cands, "in-list")), ("reached ", _fmt(cands, "reached"))):
        if forms and (verbose or label.strip() == "in list"):
            print(f"  {label} {', '.join(forms)}")
        elif forms:
            print(f"  {label} {len(forms)} forms the tolerance already covers (--verbose to list)")
    if gaps:
        print(f"  GAP      {', '.join(_minimal([c.form for c in gaps], spec, lang))}")
    if attr:
        print(f"  gender?  {', '.join(c.form for c in attr)}   (German declension — check the noun)")
    for c in cands:
        if c.verdict == "unsafe":
            print(f"  UNSAFE   {c.form}  fires on: {c.guards[0]!r}")
    note = stem_note(lemma, lang, spec)
    if note:
        print(f"  note     {note}")


def _grouped(attr: dict[str, list[str]]) -> dict[str, list[str]]:
    """German attributive gaps, keyed by the noun behind them.

    Five declension endings on eleven collocations is fifty-five lines that all say the same thing.
    A maintainer wants one line per noun: these forms are covered, those are not, and the noun's
    gender decides which of them is grammatical at all.
    """
    out: dict[str, list[str]] = {}
    for form in attr:
        out.setdefault(" ".join(form.split()[1:]), []).append(form)
    return out


def report_audit(langs: tuple[str, ...], names: tuple[str, ...], verbose: bool) -> None:
    """Every entry of every list, run backwards: which sibling forms is the gate not reaching?

    Aggregated per list rather than per entry — three Portuguese entries all want *predominado*, and
    a maintainer wants to read the form once with the entries that asked for it beside it.
    """
    total_gaps = total_attr = total_unsafe = 0
    for lang in langs:
        header = False
        for name in names:
            spec = BY_NAME[name]
            entries = spec.entries.get(lang, ())
            if not entries:
                continue
            known = {rc.fold(e) for e in entries}
            gaps: dict[str, list[str]] = {}
            attr: dict[str, list[str]] = {}
            unsafe: dict[str, str] = {}
            for entry in entries:
                for cand in classify(entry, lang, spec):
                    if cand.verdict == "gap" and rc.fold(cand.form) not in known:
                        bucket = attr if cand.family == "de-attributive" else gaps
                        bucket.setdefault(cand.form, []).append(entry)
                    elif cand.verdict == "unsafe" and verbose:
                        unsafe[cand.form] = cand.guards[0]
            least = _minimal(list(gaps), spec, lang)
            if not (least or attr or unsafe):
                continue
            if not header:
                print(f"\n=== {lang} " + "=" * 58)
                header = True
            print(f"  {spec.name}")
            for form in least:
                print(f"    {form:<34} ← {', '.join(sorted(set(gaps[form])))}")
            for tail, missing in sorted(_grouped(attr).items()):
                have = sorted({e.split()[0] for f in missing for e in attr[f]})
                print(f"    …{tail:<33} ? {', '.join(sorted(f.split()[0] for f in missing))}"
                      f"   (German declension; in list: {', '.join(have)})")
            for form, sentence in sorted(unsafe.items()):
                print(f"    UNSAFE {form:<27} fires on {sentence!r}")
            total_gaps += len(least)
            total_attr += len(_grouped(attr))
            total_unsafe += len(unsafe)
    print(f"\n{total_gaps} gap(s), {total_attr} gender-dependent form(s)"
          + (f", {total_unsafe} unsafe candidate(s)" if verbose else "")
          + f" · guard corpus: {len(GUARDS)} sentences")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="report_word_forms.py",
        description="Offline authoring aid for the report claim word lists: propose a lemma's "
                    "paradigm, say what the gate's matcher already reaches, and warn where a "
                    "proposed entry would fire on ordinary report prose. Never imported at runtime.",
        epilog="Run it before adding or changing an entry in engine/report_claims.py, and after a "
               "practice run turns up a wording the gate missed. Its output is a proposal for a "
               "human — it changes nothing.",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--lemma", help="a single word or a collocation, e.g. 'mayor contribuyente'")
    mode.add_argument("--audit", action="store_true",
                      help="run every entry of every list backwards and print the gaps")
    parser.add_argument("--lang", choices=LANGS, action="append",
                        help="report language (repeatable; default: all five)")
    parser.add_argument("--list", choices=sorted(BY_NAME), action="append", dest="lists",
                        help="which word list to judge against (repeatable; default: all, or the "
                             "ones that already contain the lemma)")
    parser.add_argument("--verbose", action="store_true",
                        help="also print the forms the tolerance already reaches, and the unsafe ones")
    args = parser.parse_args(argv)

    langs = tuple(dict.fromkeys(args.lang)) if args.lang else LANGS
    names = tuple(dict.fromkeys(args.lists)) if args.lists else tuple(BY_NAME)

    if args.audit:
        report_audit(langs, names, args.verbose)
        return 0

    for lang in langs:
        chosen = [n for n in names if any(rc.fold(e) == rc.fold(args.lemma)
                                         for e in BY_NAME[n].entries.get(lang, ()))]
        if not chosen:
            chosen = list(names) if args.lists else ["superlatives"]
            if not args.lists:
                print(f"({lang}: {args.lemma!r} is in no list — judging against `superlatives`; "
                      f"pass --list to pick another)")
        for name in chosen:
            report_lemma(args.lemma, lang, BY_NAME[name], args.verbose)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
