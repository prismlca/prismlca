"""Format detection against real exports (tests/fixtures/import, see SOURCES.md for provenance)."""

from __future__ import annotations

from pathlib import Path

import pytest

from prism_lca.engine.dataimport import SourceFormat, detect

FIXTURES = Path(__file__).parent / "fixtures" / "import"


@pytest.mark.parametrize(
    ("filename", "expected"),
    [
        ("es1-aluminium-extrusion.xml", SourceFormat.ecospold1),
        ("es2-sample.spold", SourceFormat.ecospold2),
        ("ilcd-process.xml", SourceFormat.ilcd),
        ("simapro-inventory.csv", SourceFormat.simapro_csv),
        ("simapro-allocation.csv", SourceFormat.simapro_csv),
    ],
)
def test_every_format_announces_itself(filename: str, expected: SourceFormat) -> None:
    """No dropdown asks the user which format they exported — the file says so."""
    found = detect(FIXTURES / filename)
    assert found.format is expected, found
    assert found.files == (FIXTURES / filename,)
    assert found.evidence


def test_the_namespace_decides_and_not_the_root_tag():
    """brightway2-io's own negative fixture: root <notecoSpold>, EcoSpold01 namespace. A detector
    that trusted the namespace alone would import it as EcoSpold 1 and fail somewhere deeper, where
    the message is about a missing field rather than about the wrong file."""
    found = detect(FIXTURES / "es1-acetic-acid.xml")
    assert found.format is SourceFormat.unknown, found
    assert found.files == ()
    # And the refusal names what actually stands in the file: "<notecoSpold>" sends the user to a
    # damaged file; "XML, but no" sent them hunting through export settings.
    assert "notecoSpold" in found.evidence


def test_an_unreadable_file_says_so_rather_than_guessing(tmp_path: Path):
    (tmp_path / "notes.docx").write_bytes(b"PK\x03\x04 not really")
    found = detect(tmp_path / "notes.docx")
    assert found.format is SourceFormat.unknown
    assert ".docx" in found.evidence


def test_a_folder_of_datasets_is_one_package(tmp_path: Path):
    """An ILCD export is a folder of thousands of files, not a file. It counts as one source."""
    pkg = tmp_path / "ilcd-export" / "processes"
    pkg.mkdir(parents=True)
    for i in range(3):
        (pkg / f"p{i}.xml").write_text((FIXTURES / "ilcd-process.xml").read_text(encoding="utf-8"), encoding="utf-8")
    found = detect(tmp_path / "ilcd-export")
    assert found.format is SourceFormat.ilcd
    assert len(found.files) == 3


def test_a_zip_is_recognised_without_unpacking(tmp_path: Path):
    import zipfile

    archive = tmp_path / "export.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.write(FIXTURES / "ilcd-process.xml", "processes/one.xml")
        zf.write(FIXTURES / "ilcd-process.xml", "processes/two.xml")
    found = detect(archive)
    assert found.format is SourceFormat.ilcd
    assert found.files == (archive,)


def test_a_simapro_export_without_braces_is_still_a_simapro_export(tmp_path: Path):
    """Braces were the whole test once, and real exports do not always have them: two of
    brightway2-io's fixtures — both genuine process exports from real users — open with
    `SimaPro 8.0.4.30;process;Date:;…` and a tab-separated variant. We answered "not a format
    PrismLCA reads" to a person holding a SimaPro export."""
    semicolon = tmp_path / "unbraced.csv"
    semicolon.write_text(
        "SimaPro 8.0.4.30;process;Date:;26.08.2016;Time:;15:28;;;\nProject;Hydrogen book;;;\n",
        encoding="utf-8",
    )
    tabbed = tmp_path / "tabbed.txt"
    tabbed.write_text("SimaPro don't even know\tprocesses\tDate:\t29.08.2013\nProject\tW00t\n", encoding="utf-8")

    for path in (semicolon, tabbed):
        found = detect(path)
        assert found.format is SourceFormat.simapro_csv, (path.name, found)
        assert "SimaPro" in found.evidence


def test_a_file_that_merely_mentions_simapro_is_not_an_export(tmp_path: Path):
    """The negative case the second signal exists for. One signal alone would take a note about
    SimaPro for a database, and then fail somewhere deeper with a message about a missing block."""
    note = tmp_path / "notes.csv"
    note.write_text("SimaPro is what the client uses\nWe should ask them for an export\n", encoding="utf-8")
    assert detect(note).format is SourceFormat.unknown
