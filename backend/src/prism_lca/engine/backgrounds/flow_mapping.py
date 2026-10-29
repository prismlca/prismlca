"""Map the elementary flows of an ecoSpold-1 database (BAFU:20XY) onto a target biosphere.

The algorithm decides, a review table keeps it honest. Every unique source flow runs down a
ladder of rungs (see ``RUNGS``): the reviewer's own decision, the identical name, the shipped
fallback file, the land-use vocabulary, ecoinvent's v2.2→v3 correspondence, its 3.9→3.12
renaming, systematic rewrites, CAS, synonyms, compartment moves, a guarded fuzzy match — or
``unresolved``, which the importer turns into a new, uncharacterised flow. The review table
(one row per flow, one column group per target, a ``status`` column) is how the ladder was
built: the review of all 2 679 BAFU:2026 flows against ecoinvent 3.12 confirmed
every heuristic proposal and turned the rest into rules or fallback entries, so that the engine
WITHOUT the table reproduces the table — ``scripts/bafu_flow_mapping.py --check`` proves it
(0 differences, control values in ``expected.json``). Nothing here touches a Brightway project;
the target biosphere comes in as plain flow records, read from wherever the caller likes.

Measured on BAFU:2026 v1 against ecoinvent 3.12, share of 293 747 exchanges:
exact 60.5 %, ei2to3 (ecoinvent's own v2.2→v3 correspondence, shipped with bw2io) 30.8 %, the
heuristic rungs 7.8 %, unresolved 0.9 % (106 flows, 2 788 exchanges: noise, BAFU's own energy
accounting, two PFCs, uranium as a mass). Lessons built in: a unit conflict must not end the
search ("Manganese" in kg shares its CAS with the isotope "Manganese-55" in kBq); a synonym or
CAS that points at several flows ("Chromium" → III and VI, water's CAS on every water flow) is
a question, not an answer; name rules run before the CAS rung ("Gas, mine, off-gas" carries
natural gas's CAS); a near-identical spelling with other locants is another substance.

Data sources (see ``docs/DATENHERKUNFT.md``): the v2.2→v3 correspondence and the 3.9 flow list are
read from the user's bw2io installation at runtime — Brightway ships them, this repository never
copies them; the target biosphere is the user's own ecoinvent import; ``KNOWN_CAS`` holds public
substance identifiers only. Every proposal records its rung, and ``ei2to3`` is by itself the
provenance note "ecoinvent's correspondence via bw2io".
"""

from __future__ import annotations

import csv
import difflib
import re
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path

# --------------------------------------------------------------------------------------------
# Source side: the ecoSpold-1 flows
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SourceFlow:
    """One unique elementary flow of the source database, with how often it is used."""

    name: str
    category: str
    subcategory: str
    unit: str
    cas: str = ""
    formula: str = ""
    count: int = 0
    example: str = ""

    @property
    def key(self) -> tuple[str, str, str, str]:
        return (self.name, self.category, self.subcategory, self.unit)


#: ecoSpold-1 compartment pairs → ecoinvent 3 categories. BAFU writes ``resources`` (plural)
#: where ecoinvent 2 wrote ``resource``; both spellings are listed. ``non material emissions``
#: (noise) has no ecoinvent home — it maps to bare ``air`` only so that a NEW flow created for it
#: lands in a defined compartment; no existing flow will ever match there.
COMPARTMENTS: dict[tuple[str, str], tuple[str, ...]] = {
    ("emissions to air", "unspecified"): ("air",),
    ("emissions to air", "high. pop."): ("air", "urban air close to ground"),
    ("emissions to air", "low. pop."): ("air", "non-urban air or from high stacks"),
    ("emissions to air", "stratosphere + troposphere"): (
        "air",
        "lower stratosphere + upper troposphere",
    ),
    ("emissions to air", "low. pop., long-term"): ("air", "low population density, long-term"),
    ("emissions to air", "indoor"): ("air", "indoor"),
    ("emissions to soil", "unspecified"): ("soil",),
    ("emissions to soil", "forestry"): ("soil", "forestry"),
    ("emissions to soil", "agricultural"): ("soil", "agricultural"),
    ("emissions to soil", "industrial"): ("soil", "industrial"),
    ("emissions to water", "ocean"): ("water", "ocean"),
    ("emissions to water", "river"): ("water", "surface water"),
    ("emissions to water", "lake"): ("water", "surface water"),
    ("emissions to water", "river, long-term"): ("water", "surface water"),
    ("emissions to water", "unspecified"): ("water",),
    ("emissions to water", "groundwater"): ("water", "ground-"),
    ("emissions to water", "groundwater, long-term"): ("water", "ground-, long-term"),
    ("emissions to water", "fossilwater"): ("water", "fossil well"),
    ("economic issues", "unspecified"): ("economic", "primary production factor"),
    ("resources", "in ground"): ("natural resource", "in ground"),
    ("resources", "in water"): ("natural resource", "in water"),
    ("resources", "in air"): ("natural resource", "in air"),
    ("resources", "land"): ("natural resource", "land"),
    ("resources", "biotic"): ("natural resource", "biotic"),
    ("resources", "unspecified"): ("natural resource",),
    ("resource", "in ground"): ("natural resource", "in ground"),
    ("resource", "in water"): ("natural resource", "in water"),
    ("resource", "in air"): ("natural resource", "in air"),
    ("resource", "land"): ("natural resource", "land"),
    ("resource", "biotic"): ("natural resource", "biotic"),
    ("resource", "unspecified"): ("natural resource",),
    ("non material emissions", "unspecified"): ("air",),
}

#: Short unit spellings → Brightway's long unit names (what ``normalize_units`` would do), for
#: both sides: the ecoSpold-1 files (``m2a``, ``personkm``) and ecoinvent's flow-list XML
#: (``m2*year``, ``Sm3``). Plain, normal and standard cubic metres compare as equal — see
#: ``UNIT_EQUIVALENTS``.
UNIT_ALIASES: dict[str, str] = {
    "m2*year": "square meter-year",
    "m3*year": "cubic meter-year",
    "m*year": "meter-year",
    "km*year": "kilometer-year",
    "kg*day": "kilogram day",
    "Sm3": "standard cubic meter",
    "kg": "kilogram",
    "l": "litre",
    "MJ": "megajoule",
    "kWh": "kilowatt hour",
    "m2": "square meter",
    "m3": "cubic meter",
    "Nm3": "cubic meter",
    "m2a": "square meter-year",
    "m3y": "cubic meter-year",
    "my": "meter-year",
    "kmy": "kilometer-year",
    "kBq": "kilo Becquerel",
    "Bq": "Becquerel",
    "km": "kilometer",
    "m": "meter",
    "ha": "hectare",
    "a": "year",
    "hr": "hour",
    "p": "unit",
    "unit": "unit",
    "tkm": "ton kilometer",
    "personkm": "person kilometer",
}

#: The ONLY unit conversions the mapping may apply, and to which flows. Anything else is a
#: conflict the reviewer sees, never a silent factor. Water in kilograms (or litres) against a
#: target in cubic metres is safe by definition (density 1 000 kg/m³); becquerel ↔ kilobecquerel
#: is a pure prefix; kWh → MJ is exact (3.6). Decided deliberately.
UNIT_CONVERSIONS: tuple[tuple[str, str, str, float], ...] = (
    # (name prefix, source long unit, target long unit, factor)
    ("Water", "kilogram", "cubic meter", 0.001),
    ("Water", "litre", "cubic meter", 0.001),
    ("", "Becquerel", "kilo Becquerel", 0.001),
    ("", "kilo Becquerel", "Becquerel", 1000.0),
    ("", "kilowatt hour", "megajoule", 3.6),
    ("", "megajoule", "kilowatt hour", 1 / 3.6),
)

#: Units that compare as equal without a factor. ecoinvent's gas volumes are standard cubic
#: metres and BAFU writes plain (or normal) cubic metres for the same flows — the few percent
#: between the reference temperatures are below the data's own precision.
UNIT_EQUIVALENTS: dict[str, str] = {"standard cubic meter": "cubic meter"}


def scan_ecospold1_flows(directory: Path) -> list[SourceFlow]:
    """Collect every unique elementary flow of an ecoSpold-1 folder, with usage counts.

    Tolerant by design: no schema validation, namespace or not, because the BAFU files carry
    neither a namespace nor ``xs:date``-clean dates and bw2io's validating extractor refuses
    them. Elementary exchanges are the ones with ``inputGroup 4`` (from nature) or
    ``outputGroup 4`` (to nature) — the ecoSpold-1 convention.
    """
    from lxml import etree

    counts: Counter[tuple[str, str, str, str]] = Counter()
    meta: dict[tuple[str, str, str, str], tuple[str, str, str]] = {}
    for path in sorted(Path(directory).glob("*.xml")):
        root = etree.parse(str(path)).getroot()
        ref = root.xpath('.//*[local-name()="referenceFunction"]')
        example = ref[0].get("name", "") if ref else path.stem
        for exc in root.iter("{*}exchange", "exchange"):
            group = _group(exc)
            if group != 4:
                continue
            key = (
                exc.get("name") or "",
                exc.get("category") or "",
                exc.get("subCategory") or "",
                exc.get("unit") or "",
            )
            counts[key] += 1
            if key not in meta:
                meta[key] = (
                    (exc.get("CASNumber") or "").strip(),
                    exc.get("formula") or "",
                    example,
                )
    # BAFU writes the CAS number on some rows of a substance and not on others ("1-Butanol"
    # carries it to air, not to water). A name is one substance: the CAS travels with it.
    cas_by_name: dict[str, str] = {}
    for key, (cas, _formula, _example) in meta.items():
        if cas:
            cas_by_name.setdefault(key[0], _norm_cas(cas))
    return [
        SourceFlow(
            *key,
            cas=_norm_cas(meta[key][0]) or cas_by_name.get(key[0], ""),
            formula=meta[key][1],
            count=n,
            example=meta[key][2],
        )
        for key, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]


def _group(exc) -> int | None:
    for tag in ("inputGroup", "outputGroup"):
        for child in exc:
            if child.tag == tag or child.tag.endswith("}" + tag):
                try:
                    return int((child.text or "").strip())
                except ValueError:
                    return None
    return None


def _norm_cas(cas: str) -> str:
    """CAS numbers compare without leading zeros: ``000115-07-1`` and ``115-07-1`` are one."""
    cas = cas.strip()
    return cas.lstrip("0") if cas else ""


# --------------------------------------------------------------------------------------------
# Target side: a biosphere as plain records
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class TargetFlow:
    code: str
    name: str
    categories: tuple[str, ...]
    unit: str
    cas: str = ""
    synonyms: tuple[str, ...] = ()


def _fold(text: str) -> str:
    """Case- and punctuation-insensitive key. ``<`` and ``>`` survive on purpose: folding them
    away would make "Particulate Matter, < 10 um" and "… > 10 um" the same flow."""
    return re.sub(r"[^a-z0-9<>]+", " ", text.lower()).strip()


class TargetBiosphere:
    """A target flow list with the indexes the rungs need. Built once, queried thousands of times."""

    def __init__(self, flows: Iterable[TargetFlow], label: str = "") -> None:
        self.label = label
        self.flows: list[TargetFlow] = list(flows)
        self.by_code = {f.code: f for f in self.flows}
        self.by_name_cats: dict[tuple[str, tuple[str, ...]], TargetFlow] = {}
        self.by_fold_cats: dict[tuple[str, tuple[str, ...]], TargetFlow] = {}
        #: A CAS number is shared by every flow of one substance — all the regionalised water
        #: flows carry water's, the isotope "Manganese-55" carries manganese's. Kept as a list so
        #: the ladder treats several hits as ambiguity, not as "the first one".
        self.by_cas_cats: dict[tuple[str, tuple[str, ...]], list[TargetFlow]] = defaultdict(list)
        #: Same CAS anywhere inside one top-level compartment — the fallback when the source's
        #: sub-compartment simply does not exist for that substance in the target.
        self.by_cas_top: dict[tuple[str, str], list[TargetFlow]] = defaultdict(list)
        #: A synonym may point at SEVERAL flows ("Chromium" is a synonym of both "Chromium III"
        #: and "Chromium VI") — the list is kept so the ladder can refuse the ambiguous ones.
        self.by_synonym_cats: dict[tuple[str, tuple[str, ...]], list[TargetFlow]] = defaultdict(
            list
        )
        self.names_by_compartment: dict[str, list[str]] = defaultdict(list)
        self.cats_by_name: dict[str, set[tuple[str, ...]]] = defaultdict(set)
        for f in self.flows:
            self.by_name_cats.setdefault((f.name, f.categories), f)
            self.by_fold_cats.setdefault((_fold(f.name), f.categories), f)
            if f.cas:
                bucket = self.by_cas_cats[(_norm_cas(f.cas), f.categories)]
                if f.code not in {b.code for b in bucket}:
                    bucket.append(f)
                self.by_cas_top[(_norm_cas(f.cas), f.categories[0])].append(f)
            for syn in f.synonyms:
                bucket = self.by_synonym_cats[(_fold(syn), f.categories)]
                if f.code not in {b.code for b in bucket}:
                    bucket.append(f)
            self.names_by_compartment[f.categories[0]].append(f.name)
            self.cats_by_name[f.name].add(f.categories)
        for comp, names in self.names_by_compartment.items():
            self.names_by_compartment[comp] = sorted(set(names))

    def __len__(self) -> int:
        return len(self.flows)

    @classmethod
    def from_ecospold2_xml(cls, path: Path, label: str = "") -> TargetBiosphere:
        """Read an ecoinvent ``ElementaryExchanges.xml`` (also bw2io's bundled 3.9 copy)."""
        from lxml import etree

        root = etree.parse(str(path)).getroot()
        flows = []
        for el in root.iter("{*}elementaryExchange"):
            comp = el.find("{*}compartment")
            cats: tuple[str, ...] = (comp.find("{*}compartment").text,)
            sub = comp.find("{*}subcompartment").text
            if sub and sub != "unspecified":
                cats = (*cats, sub)
            flows.append(
                TargetFlow(
                    code=el.get("id"),
                    name=el.find("{*}name").text,
                    categories=cats,
                    unit=UNIT_ALIASES.get(el.find("{*}unitName").text, el.find("{*}unitName").text),
                    cas=_norm_cas(el.get("casNumber") or ""),
                    synonyms=tuple(s.text for s in el.iter("{*}synonym") if s.text),
                )
            )
        return cls(flows, label or path.stem)

    @classmethod
    def from_records(cls, records: Iterable[Mapping], label: str = "") -> TargetBiosphere:
        """Build from Brightway-style dicts (``code``, ``name``, ``categories``, ``unit``, ``CAS number``)."""
        flows = [
            TargetFlow(
                code=str(r["code"]),
                name=r["name"],
                categories=tuple(r["categories"]),
                unit=r.get("unit", ""),
                cas=_norm_cas(str(r.get("CAS number") or r.get("cas") or "")),
                synonyms=tuple(r.get("synonyms") or ()),
            )
            for r in records
        ]
        return cls(flows, label)

    def candidates(
        self, name: str, categories: tuple[str, ...], n: int = 3, cutoff: float = 0.6
    ) -> list[TargetFlow]:
        """The closest names inside the same top-level compartment — a head start for the reviewer.

        A hit that exists in the exact categories is returned in them; otherwise in the first
        categories it does exist in, so the reviewer sees where the name lives.
        """
        pool = self.names_by_compartment.get(categories[0], [])
        hits = difflib.get_close_matches(name, pool, n=n, cutoff=cutoff)
        out: list[TargetFlow] = []
        for hit in hits:
            exact = self.by_name_cats.get((hit, categories))
            if exact:
                out.append(exact)
            else:
                for cats in sorted(self.cats_by_name[hit]):
                    out.append(self.by_name_cats[(hit, cats)])
                    break
        return out


#: ecoSpold-1 compartment spellings → the spellings ecoinvent's own v2.2→v3 correspondence
#: table uses (bw2io ships it as ``data/lci/ecoinvent elementary flows 2-3.xlsx``).
V2_COMPARTMENTS: dict[tuple[str, str], tuple[str, str]] = {
    ("emissions to air", "unspecified"): ("air", "unspecified"),
    ("emissions to air", "high. pop."): ("air", "high population density"),
    ("emissions to air", "low. pop."): ("air", "low population density"),
    ("emissions to air", "low. pop., long-term"): ("air", "low population density, long-term"),
    ("emissions to air", "stratosphere + troposphere"): (
        "air",
        "lower stratosphere + upper troposphere",
    ),
    ("emissions to water", "unspecified"): ("water", "unspecified"),
    ("emissions to water", "river"): ("water", "river"),
    ("emissions to water", "lake"): ("water", "lake"),
    ("emissions to water", "ocean"): ("water", "ocean"),
    ("emissions to water", "river, long-term"): ("water", "river, long-term"),
    ("emissions to water", "groundwater"): ("water", "ground-"),
    ("emissions to water", "groundwater, long-term"): ("water", "ground-, long-term"),
    ("emissions to water", "fossilwater"): ("water", "fossil-"),
    ("emissions to soil", "unspecified"): ("soil", "unspecified"),
    ("emissions to soil", "agricultural"): ("soil", "agricultural"),
    ("emissions to soil", "forestry"): ("soil", "forestry"),
    ("emissions to soil", "industrial"): ("soil", "industrial"),
    ("resources", "in ground"): ("resource", "in ground"),
    ("resources", "in water"): ("resource", "in water"),
    ("resources", "in air"): ("resource", "in air"),
    ("resources", "land"): ("resource", "land"),
    ("resources", "biotic"): ("resource", "biotic"),
    ("resource", "in ground"): ("resource", "in ground"),
    ("resource", "in water"): ("resource", "in water"),
    ("resource", "in air"): ("resource", "in air"),
    ("resource", "land"): ("resource", "land"),
    ("resource", "biotic"): ("resource", "biotic"),
}


class Correspondence:
    """ecoinvent's own v2.2 → v3 elementary-flow correspondence: ``(v2 name, v2 compartment,
    v2 subcompartment) → v3 UUID``, plus the v2 rows that v3 dropped (no UUID).

    An ecoSpold-1 database like BAFU speaks ecoinvent-2.2 vocabulary, and v3 UUIDs are stable
    into 3.12 (90.9 % measured), so this table settles most of what names and CAS numbers leave
    open — including ecoinvent's own reading of a generic metal emission ("Chromium" →
    "Chromium III", "Sodium" → "Sodium I"). It is read at runtime from the bw2io installation,
    never copied into this repository (BYOD rule).
    """

    def __init__(
        self,
        rows: Iterable[tuple[str, str, str, str | None, str | None] | tuple],
        source: str = "",
    ) -> None:
        #: Where the table came from, for provenance in logs and metadata (docs/DATENHERKUNFT.md):
        #: e.g. "bw2io 0.9.17: .../data/lci/ecoinvent elementary flows 2-3.xlsx".
        self.source = source
        self.uuid: dict[tuple[str, str, str], str] = {}
        self.dropped: dict[tuple[str, str, str], str] = {}
        #: v2 name → CAS, so a source flow that omits its CAS can still take the CAS rung.
        self.cas_by_name: dict[str, str] = {}
        for row in rows:
            name, comp, sub, uuid, v3_name = row[:5]
            cas = _norm_cas(str(row[5])) if len(row) > 5 and row[5] else ""
            key = (name, comp or "", sub or "")
            if uuid:
                self.uuid.setdefault(key, uuid)
            else:
                self.dropped.setdefault(key, v3_name or "")
            if cas:
                self.cas_by_name.setdefault(name, cas)

    @classmethod
    def from_bw2io(cls) -> Correspondence:
        import bw2io

        path = Path(bw2io.__file__).parent / "data" / "lci" / "ecoinvent elementary flows 2-3.xlsx"
        version = getattr(bw2io, "__version__", "?")
        return cls.from_xlsx(path, source=f"bw2io {version}: {path}")

    @classmethod
    def from_xlsx(cls, path: Path, source: str = "") -> Correspondence:
        import openpyxl

        ws = openpyxl.load_workbook(path, read_only=True).worksheets[0]
        rows = ws.iter_rows(values_only=True)
        header = [str(c) for c in next(rows)]
        i_name, i_cat, i_sub = (
            header.index("Elementary Name v2.2"),
            header.index("Category v2.2"),
            header.index("SubCategory v2.2"),
        )
        i_uuid, i_v3 = (
            header.index("UUID Elementary Flow v3"),
            header.index("Elementary Flow Name v3"),
        )
        i_cas = header.index("CAS")
        return cls(
            (
                (
                    str(r[i_name]),
                    str(r[i_cat] or ""),
                    str(r[i_sub] or ""),
                    r[i_uuid],
                    r[i_v3],
                    r[i_cas],
                )
                for r in rows
                if r[i_name]
            ),
            source=source or str(path),
        )

    @staticmethod
    def _variants(src: SourceFlow, comp: tuple[str, str]) -> list[str]:
        """The v2 spellings a BAFU name may stand for: dissolved metals were "X, ion" in water
        and soil, resources carried ", in ground" / ", in water" suffixes BAFU drops."""
        names = [src.name]
        # ecoinvent 2 wrote American spellings for a few elements; BAFU writes the British ones.
        for british, american in SPELLINGS:
            if british in src.name:
                names.append(src.name.replace(british, american))
        if comp[0] in ("water", "soil") and ", ion" not in src.name:
            names += [f"{n}, ion" for n in list(names)]
        if comp[0] == "resource":
            names += [
                f"{src.name}, in ground",
                f"{src.name}, in water",
                f"{src.name}, unspecified, in ground",
            ]
        return names

    def lookup(self, src: SourceFlow) -> tuple[str | None, bool]:
        """``(v3 UUID or None, dropped)`` for a source flow.

        Sub-compartments ecoinvent 3 merged away (lake and long-term river into surface water,
        fossil water into groundwater) fall back to the surviving v2 sub-compartment, so a row
        that is "dropped" only because its compartment vanished still finds its flow.
        """
        comp = V2_COMPARTMENTS.get((src.category, src.subcategory))
        if comp is None:
            return None, False
        comps = [comp]
        fallback = V2_SUB_FALLBACK.get(comp)
        if fallback:
            comps.append(fallback)
        dropped = False
        for c in comps:
            for name in self._variants(src, c):
                key = (name, *c)
                if key in self.uuid:
                    return self.uuid[key], False
                if key in self.dropped:
                    dropped = True
        return None, dropped

    def parent_lookup(self, src: SourceFlow) -> tuple[str | None, str]:
        """For a flow v3 dropped: the UUID of its parent class, found by stripping the last
        ", qualifier" ("Occupation, industrial area, built up" → "Occupation, industrial area").
        ecoinvent 3 merged these sub-classes into the parent; the reviewer still confirms."""
        comp = V2_COMPARTMENTS.get((src.category, src.subcategory))
        if comp is None or ", " not in src.name:
            return None, ""
        parent = src.name.rsplit(", ", 1)[0]
        key = (parent, *comp)
        if key in self.uuid:
            return self.uuid[key], parent
        return None, ""

    def cas_of(self, name: str) -> str:
        return self.cas_by_name.get(name, "")


#: British → American spellings ecoinvent 2 used in its flow names, plus the PAH prefix
#: ecoinvent 3 shortened ("Benzo(a)anthracene" → "Benz(a)anthracene").
SPELLINGS: tuple[tuple[str, str], ...] = (
    ("Aluminium", "Aluminum"),
    ("Sulfur", "Sulphur"),
    ("Caesium", "Cesium"),
    ("sulfate", "sulphate"),
    ("Benzo(a)", "Benz(a)"),
)

#: Public CAS registry numbers for source-flow names that carry none in the ecoSpold-1 files.
#: Substance identifiers, not database content — the CAS rung then finds whatever the user's
#: biosphere calls the substance. Every number was checked against PubChem.
KNOWN_CAS: dict[str, str] = {
    "Toluene, 2-chloro-": "95-49-8",
    "Methane, tetrafluoro-, CFC-14": "75-73-0",
    "Methane, tetrachloro-, CFC-10": "56-23-5",
    "1-Butanol": "71-36-3",
    "1-Propanol": "71-23-8",
    "Benzene, chloro-": "108-90-7",
    "Benzene, 1,2-dichloro-": "95-50-1",
    "Ethene": "74-85-1",
    "Hydrogen chloride": "7647-01-0",
    "Carbon monoxide": "630-08-0",
    "Carbon dioxide": "124-38-9",
    "Acetylene, dichloro-": "7572-29-4",
    "Isobutene": "115-11-7",
    "Propane, perfluorocyclo-": "931-91-9",
    "Butane, perfluorocyclo-, PFC-318": "115-25-3",
    "Ethane, 1,1,2,2-tetrachloro-": "79-34-5",
    "Ethane, 1,1-dichloro-": "75-34-3",
    "Ethene, 1,1-dichloro-": "75-35-4",
    "Ethene, 1,2-dichloro-": "540-59-0",
    "Ethane, 1,2-dibromo-": "106-93-4",
    "Ethane, 1,1,2-trifluoro-, HFC-143": "430-66-0",
    "Propane, 1,1,1,3,3-pentafluoro-, HFC-245fa": "460-73-1",
    "Propane, 1,2-dichloro-": "78-87-5",
    "Butadiene, hexachloro-": "87-68-3",
    "Benzene, dichloro-": "25321-22-6",
    "Benzene, 1,2,4-trimethyl-": "95-63-6",
    "Benzene (as BTEX)": "71-43-2",
    "Phenol, 2-chloro-": "95-57-8",
    "Phenol, 4-chloro-": "106-48-9",
    "P-cyanophenol": "767-00-0",
    "4,4'-Biphenol": "92-88-6",
    "Cresol": "1319-77-3",
    "m-Cresol": "108-39-4",
    "p-Cresol": "106-44-5",
    "N-octane": "111-65-9",
    "Decane": "124-18-5",
    "Octene (mixture of isomers)": "25377-83-7",
    "Trichloroethane": "71-55-6",
    "Vinyl acetate": "108-05-4",
    "Ethylene glycol": "107-21-1",
    "Propylene glycol methyl ether acetate": "108-65-6",
    "1-Methyl-2-pyrrolidinone": "872-50-4",
    "Caprolactam": "105-60-2",
    "Hexamethylene diamine": "124-09-4",
    "Methyl mercaptan": "74-93-1",
    "Methyl methacrylate": "80-62-6",
    "Tributylstannane": "688-73-3",
    "Tributyltin oxide": "56-35-9",
    "Chlorine dioxide": "10049-04-4",
    "Nitric acid": "7697-37-2",
    "Hydrogen bromide": "10035-10-6",
    "Hydrogen iodide": "10034-85-2",
    "Hydrogen cyanide": "74-90-8",
    "Hydrogen fluoride": "7664-39-3",
    "Sodium carbonate": "497-19-8",
    "Sodium chloride": "7647-14-5",
    "Sodium bromide": "7647-15-6",
    "Calcium chloride": "10043-52-4",
    "Magnesium chloride": "7786-30-3",
    "Arsenic trioxide": "1327-53-3",
    "Lead dioxide": "1309-60-0",
    "Zinc oxide": "1314-13-2",
    "Tin oxide": "18282-10-5",
    "Cerium": "7440-45-1",
    "Iridium": "7439-88-5",
    "Platinum": "7440-06-4",
    "Bauxite": "1318-16-7",
    "Barite": "7727-43-7",
    "Kerosene": "8008-20-6",
    "Petrol": "8006-61-9",
    "Sodium sulfate": "7757-82-6",
    "Azadirachtin A+B": "11141-17-6",
    "Disodium acid methane arsenate": "144-21-8",
    "Fluoride": "16984-48-8",
    "Chloride": "16887-00-6",
    "Bromide": "24959-67-9",
    "Phosphate": "14265-44-2",
    "Sulfide": "18496-25-8",
    "Nitrate": "14797-55-8",
    "Sulfate": "14808-79-8",
}

#: v2 sub-compartments that ecoinvent 3 folded into another one.
V2_SUB_FALLBACK: dict[tuple[str, str], tuple[str, str]] = {
    ("water", "lake"): ("water", "river"),
    ("water", "river, long-term"): ("water", "river"),
    ("water", "fossil-"): ("water", "ground-"),
}

#: ecoinvent 3.10 replaced ore flows that named their grade ("Copper, 0.99% in sulfide, Cu 0.36%
#: and Mo 8.2E-3% in crude ore") by the bare element ("Copper"). The element is the first word
#: of such a name. Amounts were converted stoichiometrically by ecoinvent where the old flow
#: was an oxide (TiO2 → Titanium) — that factor is the reviewer's, so this rung only PROPOSES.
#: Two shapes: "…, in ore / in crude ore / in ground" at the end, or a grade right after the
#: element ("Silver, 0.007% in sulfide, Ag 0.004%, Pb, Zn, Cd, In"). An oxide ("TiO2, 54% in
#: ilmenite") is not an element name and stays out — its stoichiometric factor is a decision.
ORE_GRADE_RE = re.compile(
    r"^([A-Z][a-z]+(?:, [a-z]+)?), (?:\d[\d.]*% in .*|.*(?:in ore|in crude ore|in ground))$"
)


def renamed_flows(
    old: TargetBiosphere, new: TargetBiosphere
) -> dict[tuple[str, tuple[str, ...]], str]:
    """Flows that kept their UUID but changed name between two releases: ``(old name, cats) → code``.

    3.9 → 3.12 renamed 422 flows this way ("Calcium" → "Calcium II", "2-Propanol" →
    "Isopropanol"). The old names are exactly the ecoinvent-2 vocabulary an ecoSpold-1 database
    speaks, so this list is the generated replacement for most of a hand-written synonym table.
    """
    out = {}
    for f in old.flows:
        current = new.by_code.get(f.code)
        if current is not None and current.name != f.name:
            out[(f.name, f.categories)] = f.code
    return out


# --------------------------------------------------------------------------------------------
# The ladder
# --------------------------------------------------------------------------------------------

RUNGS = (
    "curated",
    "exact",
    "fallback",
    "land_use",
    "ei2to3",
    "rename",
    "rewrite",
    "cas",
    "synonym",
    "ei2to3_parent",
    "ore_element",
    "resource_sub",
    "parent",
    "sibling",
    "unique_home",
    "cas_parent",
    "cas_sibling",
    "fuzzy",
    "unresolved",
)

#: Every resolving rung is applied by the importer without a human eye. The review of
#: all 2 679 BAFU:2026 flows against ecoinvent 3.12 confirmed every proposal the heuristic rungs
#: made (0 wrong out of 500+), so the rungs are trusted; the import report still lists the
#: exchanges per rung, and ``VERIFIED_RUNGS`` names the ones that need no trust at all.
AUTO_RUNGS = tuple(r for r in RUNGS if r != "unresolved")

#: Rungs where the target said so itself: the reviewer, an identical name, ecoinvent's v2.2→v3
#: correspondence, ecoinvent's own renaming under a stable UUID, or the shipped fallback file.
VERIFIED_RUNGS = ("curated", "exact", "fallback", "ei2to3", "rename")

#: ecoinvent-2 → ecoinvent-3 vocabulary shifts that are systematic, not per-flow: "biogenic"
#: became "non-fossil" (3.0), the "unspecified origin" qualifier was dropped, "Particulates"
#: became "Particulate Matter" (3.10), the unit suffix left the name for the unit field, the
#: region left the flow for the activity, "process" water is plain water, and the "resource
#: correction" bookkeeping flows are the resource itself. Applied in order, cumulatively; the
#: rewritten name is then looked up like an exact one (rung ``rewrite``).
NAME_REWRITES: tuple[tuple[str, str], ...] = (
    (r", biogenic$", ", non-fossil"),
    (r", unspecified origin$", ""),
    (r"^Particulates, ", "Particulate Matter, "),
    (r"/(m3|kg|MJ)$", ""),
    # Geography suffixes ("Water, CH", "Water, unspecified natural origin, RER"): ecoinvent 3
    # carries the region on the activity, not the flow, so the generic flow is the target.
    (r", (?:[A-Z]{2,4}|Europe|OECD|RoW)$", ""),
    (r"^Water, process, ", "Water, "),
    (r", resource correction$", ""),
)

#: ecoinvent-2 land-use classes → ecoinvent-3 classes (rung ``land_use``; names starting with
#: "Occupation" or "Transformation, from/to" only). Vocabulary shifts documented in Nemecek &
#: Frischknecht, "Land use in ecoinvent 3" (2014): "arable" became "annual crop", the organic
#: flag has no class of its own, "industrial area, built up / vegetation" merged into
#: "industrial area", "unspecified, used" is plain "unspecified", "pasture and meadow" is
#: "pasture, man made", "agriculture" is "arable land, unspecified use" and its "mosaic" variant
#: "heterogeneous, agricultural". Decisions taken with the LCIA factor tables open:
#: "diverse-intensive" is intensive (ecoinvent's 2013 correspondence said extensive; 3.12's own
#: conventional cereals use intensive — E10), sealed soil is continuously built urban land,
#: bare "urban" is discontinuously built, bare "traffic area" is the road network, tropical rain
#: forest is primary forest, "forest, natural" is secondary forest (non-use).
LAND_USE_RE = re.compile(r"^(?:Occupation, |Transformation, (?:from|to) )")
LAND_USE_REWRITES: tuple[tuple[str, str], ...] = (
    (r"\barable\b(?! land)", "annual crop"),
    (r", organic$", ""),
    (r", diverse-intensive$", ", intensive"),
    (r"\bindustrial area, (?:built up|vegetation)$", "industrial area"),
    (r"\bunspecified, used$", "unspecified"),
    (r"\bsealed soil$", "urban, continuously built"),
    (r"\burban$", "urban, discontinuously built"),
    (r"\btraffic area$", "traffic area, road network"),
    (r"\btropical rain forest$", "forest, primary (non-use)"),
    (r"\bforest, natural$", "forest, secondary (non-use)"),
    (r"\bpasture and meadow$", "pasture, man made"),
    (r"\bagriculture, mosaic$", "heterogeneous, agricultural"),
    (r"\bagriculture$", "arable land, unspecified use"),
)

#: The fuzzy rung only proposes near-identical spellings; below this ratio a name is a candidate
#: in the review column, never a proposal.
FUZZY_CUTOFF = 0.9


def _digits(name: str) -> list[str]:
    """The numbers in a name — and the comparison signs beside them. "< 10 um" and "> 10 um" share
    every digit and name opposite size classes."""
    return re.findall(r"[<>≤≥]|\d+", name)


# --------------------------------------------------------------------------------------------
# The shipped fallback file: name-to-name decisions, no identifiers
# --------------------------------------------------------------------------------------------

#: Where the repository's own decisions live. Names only — the source flow as the ecoSpold-1
#: database writes it (after ``NAME_REWRITES``), the target flow by name, never by UUID — so the
#: file is a list of judgements, not a copy of anybody's nomenclature (BYOD).
FALLBACKS_PATH = Path(__file__).resolve().parents[2] / "assets" / "flow_mapping_fallbacks.json"


@dataclass(frozen=True)
class Fallback:
    """One shipped decision. ``target`` ``None`` means: this flow has no counterpart, keep it as
    a new flow of its own even if a heuristic rung would find something."""

    name: str
    compartment: str  # top-level category of the source after COMPARTMENTS, or "*"
    target: str | None
    target_categories: tuple[str, ...] | None = None
    factor: float = 1.0
    reason: str = ""


def load_fallbacks(path: Path | None = None) -> list[Fallback]:
    import json

    path = path or FALLBACKS_PATH
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as fh:
        data = json.load(fh)
    out = []
    for row in data.get("flows", []):
        tc = row.get("target_categories")
        out.append(
            Fallback(
                name=row["name"],
                compartment=row.get("compartment", "*"),
                target=row.get("target"),
                target_categories=tuple(tc.split("/")) if tc else None,
                factor=float(row.get("factor", 1.0)),
                reason=row.get("reason", ""),
            )
        )
    return out


class FallbackIndex:
    """Fallbacks by ``(name, compartment)``; ``find`` tries the exact compartment, then ``*``."""

    def __init__(self, fallbacks: Iterable[Fallback]) -> None:
        self._by_key: dict[tuple[str, str], Fallback] = {}
        for fb in fallbacks:
            self._by_key.setdefault((fb.name, fb.compartment), fb)

    def __len__(self) -> int:
        return len(self._by_key)

    def find(self, names: Iterable[str], compartment: str) -> Fallback | None:
        for name in names:
            fb = self._by_key.get((name, compartment)) or self._by_key.get((name, "*"))
            if fb is not None:
                return fb
        return None


@dataclass
class Proposal:
    source: SourceFlow
    target: TargetFlow | None
    rung: str
    factor: float = 1.0
    unit_conflict: str = ""
    candidates: list[TargetFlow] = field(default_factory=list)
    target_categories: tuple[str, ...] = ()

    @property
    def resolved(self) -> bool:
        return self.target is not None and not self.unit_conflict


def _reconcile_units(source: SourceFlow, target: TargetFlow) -> tuple[float, str]:
    """Return ``(factor, conflict)``: identical units → 1.0; a listed conversion → its factor;
    anything else → factor 1.0 plus a conflict text the reviewer must resolve."""
    src_unit = UNIT_ALIASES.get(source.unit, source.unit)
    tgt_unit = UNIT_ALIASES.get(target.unit, target.unit)
    if UNIT_EQUIVALENTS.get(src_unit, src_unit) == UNIT_EQUIVALENTS.get(tgt_unit, tgt_unit):
        return 1.0, ""
    for prefix, from_unit, to_unit, factor in UNIT_CONVERSIONS:
        # The prefix may sit on either side: "Waste water" in kg lands on "Water" in m³.
        named = source.name.startswith(prefix) or target.name.startswith(prefix)
        if named and src_unit == from_unit and tgt_unit == to_unit:
            return factor, ""
    return 1.0, f"{src_unit} → {tgt_unit}"


def _rewritten(name: str) -> str:
    for pattern, repl in NAME_REWRITES:
        name = re.sub(pattern, repl, name)
    return name


def _land_use(name: str) -> str:
    if not LAND_USE_RE.match(name):
        return name
    for pattern, repl in LAND_USE_REWRITES:
        name = re.sub(pattern, repl, name)
    return name


def _spelled(name: str) -> str:
    for british, american in SPELLINGS:
        if british in name:
            return name.replace(british, american)
    return name


def _lookup_name(target: TargetBiosphere, name: str, cats: tuple[str, ...]) -> TargetFlow | None:
    """A name in its compartment, folded spelling allowed, then the places ecoinvent 3 keeps
    what an ecoSpold-1 file files elsewhere: the one resource sub-compartment that has it, the
    bare parent compartment, and the ", unspecified" variant ("Sand" → "Sand, unspecified")."""
    hit = target.by_name_cats.get((name, cats)) or target.by_fold_cats.get((_fold(name), cats))
    if hit:
        return hit
    homes = [c for c in target.cats_by_name.get(name, ()) if c[0] == cats[0]]
    if cats[0] == "natural resource":
        if len(homes) == 1:
            return target.by_name_cats[(name, homes[0])]
        # A water withdrawal filed under "land" or bare "resources" is a withdrawal from water.
        if name.startswith("Water") and ("natural resource", "in water") in homes:
            return target.by_name_cats[(name, ("natural resource", "in water"))]
    if len(cats) == 2 and (name, (cats[0],)) in target.by_name_cats:
        return target.by_name_cats[(name, (cats[0],))]
    siblings = [c for c in homes if c != cats]
    if len(cats) == 2 and len(siblings) == 1:
        return target.by_name_cats[(name, siblings[0])]
    return target.by_name_cats.get((f"{name}, unspecified", cats))


def _ladder(
    src: SourceFlow,
    cats: tuple[str, ...],
    target: TargetBiosphere,
    renames: Mapping[tuple[str, tuple[str, ...]], str],
    curated: Mapping[tuple[str, str, str, str], str],
    correspondence: Correspondence | None,
    fallbacks: FallbackIndex | None = None,
) -> tuple[list[tuple[str, TargetFlow]], list[TargetFlow], Fallback | None]:
    """Every rung's hit in ladder order (dict rungs only; ``fuzzy`` is computed lazily by the
    caller), the flows an ambiguous synonym or CAS pointed at (never a hit), and the fallback
    entry that applied, if any — a fallback with ``target None`` ends the ladder right there."""
    hits: list[tuple[str, TargetFlow]] = []
    code = curated.get(src.key)
    if code and code in target.by_code:
        hits.append(("curated", target.by_code[code]))
    exact = target.by_name_cats.get((src.name, cats)) or target.by_fold_cats.get(
        (_fold(src.name), cats)
    )
    if exact:
        hits.append(("exact", exact))
    rewritten = _rewritten(src.name)
    fallback = fallbacks.find((src.name, rewritten), cats[0]) if fallbacks else None
    if fallback is not None:
        if fallback.target is None:
            return hits, [], fallback
        hit = _lookup_name(target, fallback.target, fallback.target_categories or cats)
        if hit:
            hits.append(("fallback", hit))
    land = _land_use(src.name)
    if land != src.name and (hit := _lookup_name(target, land, cats)):
        hits.append(("land_use", hit))
    dropped = False
    if correspondence is not None:
        uuid, dropped = correspondence.lookup(src)
        if uuid and uuid in target.by_code:
            hits.append(("ei2to3", target.by_code[uuid]))
    code = renames.get((src.name, cats))
    if code and code in target.by_code:
        hits.append(("rename", target.by_code[code]))
    # Name rules come before the CAS number: a CAS is shared by every flow of a substance
    # ("Gas, mine, off-gas" carries natural gas's), a systematic rewrite is not.
    for variant in (rewritten, _spelled(src.name), _spelled(rewritten)):
        if variant != src.name and (hit := _lookup_name(target, variant, cats)):
            hits.append(("rewrite", hit))
            break
    cas = _source_cas(src, correspondence)
    ambiguous = _substance_rungs(src, cats, target, cas, hits)
    if dropped and correspondence is not None:
        uuid, _parent = correspondence.parent_lookup(src)
        if uuid and uuid in target.by_code:
            hits.append(("ei2to3_parent", target.by_code[uuid]))
    _compartment_rungs(src, cats, target, cas, hits)
    return hits, ambiguous, fallback


def _source_cas(src: SourceFlow, correspondence: Correspondence | None) -> str:
    """The source flow's CAS number: its own, else the one ecoinvent's correspondence gives the name, else a
    known one."""
    return (
        src.cas
        or (correspondence.cas_of(src.name) if correspondence else "")
        or KNOWN_CAS.get(src.name, "")
    )


#: A grade or concentration in a flow name ("25 % in sylvinite", "0.08% in natural gas", "3.2ppm").
_GRADE = re.compile(r"\d\s*%|\d\s*ppm", re.IGNORECASE)


def _substance_rungs(
    src: SourceFlow,
    cats: tuple[str, ...],
    target: TargetBiosphere,
    cas: str,
    hits: list[tuple[str, TargetFlow]],
) -> list[TargetFlow]:
    """CAS and synonym in the source's own compartment; several flows behind one identifier are
    returned as the ambiguous candidates, never appended as a hit — unless exactly one of them names
    no grade and the source names none either: older flow lists keep the ore-grade variants beside
    the mineral ("Sylvite" and "Sylvite, 25 % in sylvinite"), and a plain source means the plain one."""
    ambiguous: list[TargetFlow] = []
    if cas:
        same_cas = target.by_cas_cats.get((cas, cats), [])
        plain = [f for f in same_cas if not _GRADE.search(f.name)]
        if len(same_cas) == 1:
            hits.append(("cas", same_cas[0]))
        elif len(plain) == 1 and not _GRADE.search(src.name):
            hits.append(("cas", plain[0]))
        elif same_cas:
            ambiguous += same_cas
    synonyms = target.by_synonym_cats.get((_fold(src.name), cats), [])
    if len(synonyms) == 1:
        hits.append(("synonym", synonyms[0]))
    elif synonyms:
        ambiguous += [s for s in synonyms if s.code not in {a.code for a in ambiguous}]
    return ambiguous


def _compartment_rungs(
    src: SourceFlow,
    cats: tuple[str, ...],
    target: TargetBiosphere,
    cas: str,
    hits: list[tuple[str, TargetFlow]],
) -> None:
    """The rungs that keep the name and move the compartment: ore grade → element, the one
    resource sub-compartment that has the flow, the bare parent compartment, the one sibling
    sub-compartment, the inventory-indicator home, then the same by CAS."""
    if cats[0] == "natural resource":
        m = ORE_GRADE_RE.match(src.name)
        if m and (m.group(1), cats) in target.by_name_cats:
            hits.append(("ore_element", target.by_name_cats[(m.group(1), cats)]))
        # A resource filed under a bare or wrong sub-compartment ("Uranium" under land, land-use
        # flows under "unspecified"): if the name lives in exactly one resource sub-compartment
        # of the target, that is where it belongs.
        homes = [c for c in target.cats_by_name.get(src.name, ()) if c[0] == "natural resource"]
        if len(homes) == 1 and homes[0] != cats:
            hits.append(("resource_sub", target.by_name_cats[(src.name, homes[0])]))
    if len(cats) == 2:
        parent = (cats[0],)
        if (src.name, parent) in target.by_name_cats:
            hits.append(("parent", target.by_name_cats[(src.name, parent)]))
        # The substance exists under this top-level compartment in exactly one other
        # sub-compartment ("Naphthalene" to ocean, ecoinvent 3 has it only in surface water).
        siblings = [
            c for c in target.cats_by_name.get(src.name, ()) if c[0] == cats[0] and c != cats
        ]
        if len(siblings) == 1:
            hits.append(("sibling", target.by_name_cats[(src.name, siblings[0])]))
    # ecoinvent 3 moved the landfill bookkeeping flows ("Waste mass, total, placed in landfill")
    # out of the resources into "inventory indicator"; an ecoSpold-1 file still files them as a
    # resource. A name with exactly one home in the target, and that home an inventory
    # indicator, goes there.
    homes = list(target.cats_by_name.get(src.name, ()))
    if len(homes) == 1 and homes[0][0] == "inventory indicator" and homes[0] != cats:
        hits.append(("unique_home", target.by_name_cats[(src.name, homes[0])]))
    if not cas:
        return
    if len(cats) == 2 and len(target.by_cas_cats.get((cas, (cats[0],)), [])) == 1:
        hits.append(("cas_parent", target.by_cas_cats[(cas, (cats[0],))][0]))
    # The substance exists in this top-level compartment, only not in this sub-compartment
    # ("Monochlorobenzene" to urban air, BAFU says unspecified air): one name → propose the
    # bare compartment if there is one, else the first sibling.
    siblings = target.by_cas_top.get((cas, cats[0]), [])
    if siblings and len({f.name for f in siblings}) == 1:
        bare = [f for f in siblings if len(f.categories) == 1]
        hits.append(("cas_sibling", (bare or siblings)[0]))


def propose(
    flows: Iterable[SourceFlow],
    target: TargetBiosphere,
    renames: Mapping[tuple[str, tuple[str, ...]], str] | None = None,
    curated: Mapping[tuple[str, str, str, str], str] | None = None,
    correspondence: Correspondence | None = None,
    curated_factors: Mapping[tuple[str, str, str, str], float] | None = None,
    fallbacks: Iterable[Fallback] | None = None,
) -> list[Proposal]:
    """Run every source flow down the ladder against one target biosphere.

    ``curated`` maps a source key to a target code the reviewer has confirmed; it wins over every
    rung. ``fallbacks`` are the shipped name-to-name decisions (:func:`load_fallbacks`); one with
    ``target None`` blocks every heuristic rung — the flow stays a new flow of its own.
    ``renames`` is the output of :func:`renamed_flows` for this target; ``correspondence`` is
    ecoinvent's v2.2→v3 table (:meth:`Correspondence.from_bw2io`). A hit whose unit cannot be
    reconciled does not end the search — the next rung may hold the right flow ("Manganese" in
    kg must not stop at the isotope "Manganese-55" in kBq that shares its CAS). Only when no rung
    fits is the first unit-conflicting hit reported, conflict flagged.
    """
    renames = renames or {}
    curated = curated or {}
    curated_factors = curated_factors or {}
    index = FallbackIndex(fallbacks) if fallbacks is not None else None
    out: list[Proposal] = []
    for src in flows:
        cats = COMPARTMENTS.get((src.category, src.subcategory))
        if cats is None:
            out.append(Proposal(src, None, "unresolved", unit_conflict="unknown compartment"))
            continue
        hits, ambiguous, fallback = _ladder(
            src, cats, target, renames, curated, correspondence, index
        )
        if src.key in curated and src.key in curated_factors and hits and hits[0][0] == "curated":
            # A reviewer-set factor (stoichiometry: kg TiO2 → kg Ti) overrides unit reconciling.
            out.append(
                Proposal(
                    src,
                    hits[0][1],
                    "curated",
                    factor=curated_factors[src.key],
                    target_categories=cats,
                )
            )
            continue
        blocked = fallback is not None and fallback.target is None
        conflicted: Proposal | None = None
        chosen: Proposal | None = None
        for rung, hit in hits:
            if blocked and rung not in ("curated", "exact"):
                break
            factor, conflict = _reconcile_units(src, hit)
            if rung == "fallback" and fallback is not None and fallback.factor != 1.0:
                # A factor in the fallback file is a decision (stoichiometry), not a unit rule.
                factor, conflict = fallback.factor, ""
            if not conflict:
                chosen = Proposal(src, hit, rung, factor=factor, target_categories=cats)
                break
            if conflicted is None:
                conflicted = Proposal(
                    src, hit, rung, unit_conflict=conflict, target_categories=cats
                )
        if chosen is None and not blocked:
            cas = _source_cas(src, correspondence)
            for near in target.candidates(src.name, cats, n=1, cutoff=FUZZY_CUTOFF):
                factor, conflict = _reconcile_units(src, near)
                # Isomers and congeners differ only in their locants ("Ethane, 1,1-dichloro-"
                # vs "1,2-dichloro-", "HFC-143" vs "HFC-143a"): a near-identical spelling with
                # different digits is a different substance, never a fuzzy hit. So is one whose
                # CAS number differs from the source's ("Ethene, 1,2-dichloro-" vs "Ethane, …").
                if (
                    not conflict
                    and near.categories == cats
                    and _digits(near.name) == _digits(src.name)
                    and not (cas and near.cas and _norm_cas(near.cas) != _norm_cas(cas))
                ):
                    chosen = Proposal(src, near, "fuzzy", factor=factor, target_categories=cats)
        if chosen is None:
            chosen = conflicted or Proposal(src, None, "unresolved", target_categories=cats)
        if chosen.rung not in AUTO_RUNGS:
            # Every proposal a person has to judge comes with the alternatives next to it —
            # the ambiguous synonyms first, then the closest names in the compartment.
            seen = {c.code for c in ambiguous} | ({chosen.target.code} if chosen.target else set())
            chosen.candidates = ambiguous + [
                c for c in target.candidates(src.name, cats) if c.code not in seen
            ]
        out.append(chosen)
    return out


def summarize(proposals: Iterable[Proposal]) -> dict[str, tuple[int, int]]:
    """``rung → (unique flows, exchanges)``, plus ``unit_conflict`` as its own line."""
    flows: Counter[str] = Counter()
    exchanges: Counter[str] = Counter()
    for p in proposals:
        key = "unit_conflict" if p.target is not None and p.unit_conflict else p.rung
        flows[key] += 1
        exchanges[key] += p.source.count
    return {k: (flows[k], exchanges[k]) for k in (*RUNGS, "unit_conflict") if k in flows}


# --------------------------------------------------------------------------------------------
# The review table
# --------------------------------------------------------------------------------------------

STATUS_OPEN, STATUS_AUTO, STATUS_CONFIRMED, STATUS_REJECTED = (
    "open",
    "auto",
    "confirmed",
    "rejected",
)

SOURCE_COLUMNS = ("name", "category", "subcategory", "unit", "cas", "formula", "count", "example")
TARGET_COLUMNS = (
    "rung",
    "code",
    "target_name",
    "target_categories",
    "target_unit",
    "factor",
    "unit_conflict",
    "candidates",
    "relevance",
)
#: ``confidence`` is the reviewer-facing estimate (hoch / mittel / niedrig) of how sure a proposal
#: is; ``review_comment`` is the reviewer's own remark. Both are carried over like ``status`` and
#: ``note`` — the generated columns are never the place for hand-written text.
REVIEW_COLUMNS = ("status", "note", "confidence", "review_comment")


def _target_columns(prefix: str) -> list[str]:
    return [f"{prefix}.{c}" for c in TARGET_COLUMNS]


def write_review_table(
    path: Path,
    flows: list[SourceFlow],
    proposals: Mapping[str, list[Proposal]],
    relevance: Mapping[str, Mapping[str, Iterable[str]]] | None = None,
    previous: Mapping[tuple[str, str, str, str], Mapping[str, str]] | None = None,
) -> None:
    """One row per source flow; one column group per target; review columns carried over.

    ``relevance[target][code]`` names the method families that characterise a target flow
    (e.g. ``GWP``, ``UBP``, ``EF``) — the reviewer sorts by it, because an unresolved flow
    nobody characterises is not worth an evening. ``previous`` is the last table (by source key):
    ``status`` and ``note`` survive a re-run, and a ``confirmed`` row is fed back as curated.
    """
    relevance = relevance or {}
    previous = previous or {}
    targets = list(proposals)
    by_key = {t: {p.source.key: p for p in proposals[t]} for t in targets}
    header = [*SOURCE_COLUMNS, *(c for t in targets for c in _target_columns(t)), *REVIEW_COLUMNS]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        for src in flows:
            row: list[str] = [
                src.name,
                src.category,
                src.subcategory,
                src.unit,
                src.cas,
                src.formula,
                str(src.count),
                src.example,
            ]
            any_open = False
            for t in targets:
                p = by_key[t].get(src.key)
                rel = relevance.get(t, {})
                cands = "; ".join(
                    f"{c.name} [{'/'.join(c.categories)}]"
                    + (f" ({','.join(sorted(rel.get(c.code, ())))})" if rel.get(c.code) else "")
                    for c in (p.candidates if p else [])
                )
                if p is None or p.target is None:
                    row += [
                        "unresolved",
                        "",
                        "",
                        "/".join(p.target_categories) if p else "",
                        "",
                        "",
                        p.unit_conflict if p else "",
                        cands,
                        "",
                    ]
                    any_open = True
                else:
                    row += [
                        p.rung,
                        p.target.code,
                        p.target.name,
                        "/".join(p.target.categories),
                        p.target.unit,
                        repr(p.factor),
                        p.unit_conflict,
                        cands,
                        ",".join(sorted(rel.get(p.target.code, ()))),
                    ]
                    if p.unit_conflict or p.rung not in AUTO_RUNGS:
                        any_open = True
            prev = previous.get(src.key, {})
            status = prev.get("status") or (STATUS_OPEN if any_open else STATUS_AUTO)
            row += [
                status,
                prev.get("note", ""),
                prev.get("confidence", ""),
                prev.get("review_comment", ""),
            ]
            w.writerow(row)


def read_review_table(path: Path) -> dict[tuple[str, str, str, str], dict[str, str]]:
    """The table by source key, so a re-run can carry ``status``/``note`` and curated codes over."""
    out: dict[tuple[str, str, str, str], dict[str, str]] = {}
    if not Path(path).exists():
        return out
    with Path(path).open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            out[(row["name"], row["category"], row["subcategory"], row["unit"])] = row
    return out


def curated_from_review(
    rows: Mapping[tuple[str, str, str, str], Mapping[str, str]], target: str
) -> dict[tuple[str, str, str, str], str]:
    """Confirmed rows become the curated input for the next run of :func:`propose`."""
    col = f"{target}.code"
    return {
        key: row[col]
        for key, row in rows.items()
        if row.get("status") == STATUS_CONFIRMED and row.get(col)
    }


def curated_factors_from_review(
    rows: Mapping[tuple[str, str, str, str], Mapping[str, str]], target: str
) -> dict[tuple[str, str, str, str], float]:
    """Factors the reviewer typed into confirmed rows (anything but the default 1.0)."""
    col = f"{target}.factor"
    out: dict[tuple[str, str, str, str], float] = {}
    for key, row in rows.items():
        if row.get("status") != STATUS_CONFIRMED or not row.get(col):
            continue
        try:
            factor = float(row[col])
        except ValueError:
            continue
        if factor != 1.0:
            out[key] = factor
    return out
