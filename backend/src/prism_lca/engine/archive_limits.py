"""How much an archive from somewhere else may unpack to, and the counted read that holds a reader to it.

Every zip a reader opens here was written by someone else: a model bundle, an import package, a workbook
attached to a chat. Its declared sizes are checked before anything is inflated, and the bytes actually
inflated are counted while a member is read, because a header can understate them. What each kind of archive
may hold is set side by side below; the counting is one rule for all of them.
"""

from __future__ import annotations

import lzma
import zipfile
import zlib
from collections.abc import Callable, Iterator
from dataclasses import dataclass

from prism_lca.errors import PrismError

MB = 1024 * 1024
#: Bytes asked of a member per read, which is also what one decompression step may produce.
CHUNK = 1 << 16


@dataclass(frozen=True)
class Limits:
    #: Entries in the archive.
    members: int
    #: Bytes one member may unpack to.
    member: int
    #: Bytes all members read from one archive may unpack to.
    total: int


#: A `.prism` model bundle. A model with many reports, each with a full-size cover and logo, stays well inside.
BUNDLE = Limits(members=10_000, member=128 * MB, total=256 * MB)
#: The bundle's manifest: a list of sections, a few kilobytes even for a full export.
BUNDLE_MANIFEST = 1 * MB
#: Sections one manifest may declare: the registry has about a dozen, newer versions may add some.
BUNDLE_SECTIONS = 64
#: An openLCA JSON-LD package.
JSON_LD = Limits(members=20_000, member=50 * MB, total=200 * MB)
#: An ILCD package: one file per flow, so far more members than JSON-LD, and LCIA method files of tens of MB.
ILCD = Limits(members=100_000, member=128 * MB, total=1024 * MB)
#: A Word or Excel file attached to a chat, by the sizes its zip declares.
OFFICE = Limits(members=10_000, member=1024 * MB, total=1024 * MB)


def too_large_bundle() -> PrismError:
    return PrismError(
        "This bundle unpacks to more than PrismLCA reads from one model file — not reading it.",
        code="bundle_too_large",
        hint=f"At most {BUNDLE_SECTIONS} sections, {BUNDLE.member // MB} MB each, {BUNDLE.total // MB} MB "
        "in all. Nothing has been written.",
    )


def too_large_import(limits: Limits) -> PrismError:
    return PrismError(
        "This archive unpacks to more than PrismLCA reads from one package — not reading it.",
        code="import_archive_too_large",
        hint=f"At most {limits.members} files, {limits.member // MB} MB each, "
        f"{limits.total // MB} MB in all.",
    )


def declared_within(zf: zipfile.ZipFile, wanted: list[zipfile.ZipInfo], limits: Limits) -> bool:
    """Whether the archive's own numbers fit, before a byte of it is inflated."""
    if len(zf.infolist()) > limits.members:
        return False
    sizes = [m.file_size for m in wanted]
    return all(s <= limits.member for s in sizes) and sum(sizes) <= limits.total


class Budget:
    """What is left of one archive's allowance while its members are read."""

    def __init__(self, limits: Limits, too_large: Callable[[], PrismError]) -> None:
        self.limits = limits
        self.left = limits.total
        self.too_large = too_large

    def chunks(self, zf: zipfile.ZipFile, info: zipfile.ZipInfo, cap: int | None = None) -> Iterator[bytes]:
        """The member's bytes, refused as soon as they pass its cap or what is left of the total."""
        limit = min(self.limits.member if cap is None else cap, self.left)
        if info.file_size > limit:
            raise self.too_large()
        size = 0
        with zf.open(info) as source:
            while chunk := source.read(CHUNK):
                size += len(chunk)
                if size > limit:  # counted, because the declared size is the archive's word for it
                    raise self.too_large()
                yield chunk
        self.left -= size

    def read(self, zf: zipfile.ZipFile, info: zipfile.ZipInfo, cap: int | None = None) -> bytes:
        out = bytearray()
        for chunk in self.chunks(zf, info, cap):
            out += chunk
        return bytes(out)


#: What a damaged member raises while it is inflated: a bad CRC, a cut-off or invalid stream.
READ_ERRORS = (zipfile.BadZipFile, zlib.error, lzma.LZMAError, EOFError, OSError)
