"""The ILCD reader — the one format Brightway has no importer for.

Two fixtures, and the pair is the point: a real aggregated EPD from Ökobaudat, which must be
recognised and refused, and a hand-written unit process, which must come through with units and
compartments intact.
"""

from __future__ import annotations

import zipfile
from pathlib import Path

from prism_lca.engine.dataimport import ilcd
from prism_lca.engine.dataimport.model import SourceKind

FIXTURES = Path(__file__).parent / "fixtures" / "import"


def test_a_unit_process_comes_through_with_its_units_and_compartments():
    """The full ILCD chain: process → flow → flow property → unit group. Only the last of those
    four files knows that the number means kilograms, so a reader that stops early invents units."""
    result = ilcd.read(FIXTURES / "ilcd-unitprocess")
    assert result.notes == []
    assert len(result.importable) == 1

    ds = result.datasets[0]
    assert ds.kind is SourceKind.unit_process
    assert ds.name == "Widget production, at plant"
    assert ds.location == "DE"          # an attribute, not the element's text
    assert ds.reference_product == "Widget"
    assert ds.unit == "kg"

    by_kind = {e.kind: e for e in ds.exchanges}
    assert by_kind["production"].amount == 1.0
    emission = by_kind["biosphere"]
    assert emission.name == "Carbon dioxide, fossil"
    assert emission.unit == "kg" and emission.direction == "output"
    assert emission.compartment == ("Emissions", "Emissions to air", "Emissions to air, unspecified")
    electricity = by_kind["technosphere"]
    assert electricity.unit == "MJ" and electricity.amount == 7.2


def test_an_epd_is_recognised_as_results_and_not_imported():
    """A real Ökobaudat EPD: 19 exchanges that are EPD indicators, 19 LCIAResults, and not one
    elementary flow. Matching its flows onto our biosphere would be looking for something that is
    not there, so it is refused — in words, not by failing later."""
    result = ilcd.read(FIXTURES / "ilcd-process.xml")
    assert len(result.datasets) == 1
    assert result.datasets[0].kind is SourceKind.aggregated
    assert result.importable == []
    assert any("results rather than an inventory" in n for n in result.notes)


def test_a_lone_process_file_says_its_package_is_missing():
    """A process without its flow files cannot know what its own amounts mean. Saying so beats
    importing numbers with no unit — which is how a 7.2 becomes 7.2 of whatever the matcher guessed."""
    result = ilcd.read(FIXTURES / "ilcd-process.xml")
    assert any("without the flow datasets" in n for n in result.notes)


def test_a_zipped_package_reads_like_a_folder(tmp_path: Path):
    """ILCD travels as a zip more often than as a folder, and it must not be a different code path."""
    archive = tmp_path / "pkg.zip"
    root = FIXTURES / "ilcd-unitprocess"
    with zipfile.ZipFile(archive, "w") as zf:
        for path in sorted(root.rglob("*.xml")):
            zf.write(path, str(path.relative_to(root)))

    zipped = ilcd.read(archive)
    folder = ilcd.read(root)
    assert [d.name for d in zipped.datasets] == [d.name for d in folder.datasets]
    assert zipped.summary() == folder.summary()


def test_a_duplicated_identifier_is_reported_rather_than_swallowed(tmp_path):
    """Found in the InData ILCD+EPD sample package: two process files under one UUID, so a folder
    of four datasets read as three. Keeping the last one is right — a UUID names one dataset — but
    doing it in silence is not, because nothing on screen says which one went."""
    pkg = tmp_path / "package" / "processes"
    pkg.mkdir(parents=True)
    original = (FIXTURES / "ilcd-process.xml").read_text(encoding="utf-8")
    (pkg / "first.xml").write_text(original, encoding="utf-8")
    (pkg / "second-copy-of-the-same-uuid.xml").write_text(original, encoding="utf-8")

    result = ilcd.read(tmp_path / "package")
    assert len(result.datasets) == 1
    note = next((n for n in result.notes if "identifier" in n), None)
    assert note, result.notes
    # By file name, not by path: the reader is told a package, the user knows their files.
    assert "second-copy-of-the-same-uuid.xml" in note
    assert "/" not in note.split("(")[1]


def _as_type(src: Path, dst: Path, declared: str) -> Path:
    """Copy the unit-process fixture package and relabel its declared type."""
    import shutil

    shutil.copytree(src, dst)
    process = next((dst / "processes").glob("*.xml"))
    process.write_text(
        process.read_text(encoding="utf-8").replace(
            "<typeOfDataSet>Unit process, single operation</typeOfDataSet>",
            f"<typeOfDataSet>{declared}</typeOfDataSet>",
        ),
        encoding="utf-8",
    )
    return dst


def test_an_aggregated_inventory_is_imported_and_said_to_be_one(tmp_path):
    """ILCD calls an LCI result aggregated, and it is — a black box with no supply chain. But it
    carries the full list of elementary flows, which is exactly what the matcher works on.

    Judging by the label alone put the EU's own EF reference data (93 LCI results) in the same bin
    as an EPD and refused it with the words "no elementary flows to match" — untrue of every one of
    them. So the content decides, and the note says what a black box costs the reader.
    """
    pkg = _as_type(FIXTURES / "ilcd-unitprocess", tmp_path / "as-lci-result", "LCI result")
    result = ilcd.read(pkg)

    assert [d.kind for d in result.datasets] == [SourceKind.lci_result]
    assert len(result.importable) == 1
    assert any("black box" in n for n in result.notes), result.notes
    # …and the elementary flows really are there to be matched.
    assert any(e.kind == "biosphere" for e in result.datasets[0].exchanges)


def test_results_without_flows_are_still_refused(tmp_path):
    """The other half of the distinction: an EPD carries characterised results per module and no
    elementary flows. Nothing to map onto our biosphere, so nothing to import."""
    pkg = _as_type(FIXTURES / "ilcd-unitprocess", tmp_path / "as-epd", "EPD")
    process = next((pkg / "processes").glob("*.xml"))
    # Strip the exchanges: what is left is the shape of a results-only dataset.
    text = process.read_text(encoding="utf-8")
    start, end = text.index("<exchanges"), text.index("</exchanges>") + len("</exchanges>")
    process.write_text(text[:start] + text[end:], encoding="utf-8")

    result = ilcd.read(pkg)
    assert [d.kind for d in result.datasets] == [SourceKind.aggregated]
    assert result.importable == []
    assert any("characterised results" in n for n in result.notes), result.notes



def test_an_unparseable_file_is_named_not_swallowed(tmp_path: Path):
    """A cut-off process file vanished from the package without a word, and the
    import of the rest looked complete."""
    import shutil

    pkg = tmp_path / "pkg"
    shutil.copytree(FIXTURES / "ilcd-unitprocess", pkg)
    (pkg / "processes" / "99999999-9999-9999-9999-999999999999.xml").write_text("<processDataSet", encoding="utf-8")
    result = ilcd.read(pkg)
    assert len(result.datasets) == 1
    assert any("could not be parsed" in n and "99999999" in n for n in result.notes), result.notes


# --- limits of a zipped package ----------------------------------------------------------------


def _package_zip(archive: Path, extra: dict[str, bytes], method: int = zipfile.ZIP_DEFLATED) -> Path:
    root = FIXTURES / "ilcd-unitprocess"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(root.rglob("*.xml")):
            zf.write(path, str(path.relative_to(root)))
        for name, body in extra.items():
            zf.writestr(name, body, compress_type=method)
    return archive


def _declare(archive: Path, member: str, size: int) -> None:
    """Set `member`'s uncompressed size in the central directory to `size`."""
    import struct

    data = bytearray(archive.read_bytes())
    at = data.find(b"PK\x01\x02")
    while at != -1:
        name_len = struct.unpack_from("<H", data, at + 28)[0]
        if data[at + 46 : at + 46 + name_len].decode() == member:
            struct.pack_into("<I", data, at + 24, size)
            archive.write_bytes(bytes(data))
            return
        at = data.find(b"PK\x01\x02", at + 4)
    raise AssertionError(member)


def _refusal_and_peak(target: Path) -> tuple[str, int]:
    import tracemalloc

    from prism_lca.errors import PrismError

    tracemalloc.start()
    try:
        ilcd.read(target)
        code = ""
    except PrismError as exc:
        code = exc.code
    finally:
        peak = tracemalloc.get_traced_memory()[1]
        tracemalloc.stop()
    return code, peak


def test_a_member_declared_above_the_limit_is_refused_before_it_is_inflated(tmp_path, monkeypatch):
    from dataclasses import replace

    from prism_lca.engine import archive_limits

    monkeypatch.setattr(archive_limits, "ILCD", replace(archive_limits.ILCD, member=1 << 20))
    archive = _package_zip(tmp_path / "pkg.zip", {"flows/big.xml": bytes(32 << 20)}, zipfile.ZIP_BZIP2)
    code, peak = _refusal_and_peak(archive)
    assert code == "import_archive_too_large"
    assert peak < 4 << 20


def test_a_member_is_read_no_further_than_its_declared_size(tmp_path):
    archive = _package_zip(tmp_path / "pkg.zip", {"flows/big.xml": bytes(64 << 20)}, zipfile.ZIP_BZIP2)
    _declare(archive, "flows/big.xml", 1000)
    code, peak = _refusal_and_peak(archive)
    assert code == "import_unreadable"
    assert peak < 4 << 20


def test_markup_denser_than_any_dataset_is_refused_while_it_is_parsed(tmp_path):
    body = b'<flowDataSet xmlns="http://lca.jrc.it/ILCD/Flow">' + b"<a/>" * 500_000 + b"</flowDataSet>"
    archive = _package_zip(tmp_path / "pkg.zip", {"flows/dense.xml": body})
    code, peak = _refusal_and_peak(archive)
    assert code == "import_archive_too_large"
    assert peak < 8 * len(body)


def test_the_datasets_kept_from_one_package_are_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(ilcd, "MAX_KEPT_ELEMENTS", 40)
    code, _peak = _refusal_and_peak(FIXTURES / "ilcd-unitprocess")
    assert code == "import_archive_too_large"


def test_every_fixture_reads_within_the_limits():
    for target in (FIXTURES / "ilcd-unitprocess", FIXTURES / "ilcd-process.xml"):
        assert ilcd.read(target).datasets
