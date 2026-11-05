"""The pixel size of a picture a report places (cover, logos), read from its file header.

The compiler decodes the whole raster of every picture on every render, at about four bytes a pixel, so
the size that matters is width times height, not the length of the file. These are the only two formats
`report_pipeline.image_b64` accepts, and the header is all it takes to know their size.
"""
from __future__ import annotations

from prism_lca.errors import PrismError

#: Ten thousand pixels square. A cover printed 21 cm wide at 600 dpi needs a twentieth of that.
MAX_PIXELS = 100_000_000

_PNG = b"\x89PNG\r\n\x1a\n"
#: JPEG frame headers (SOF0–SOF15) carry the size; C4, C8 and CC share the range but are other segments.
_JPEG_FRAMES = frozenset(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}
#: Markers that stand alone, without a length: TEM, the restart markers, SOI and EOI.
_JPEG_STANDALONE = frozenset({0x01, *range(0xD0, 0xDA)})
_JPEG_SCAN = 0xDA


def pixel_size(blob: bytes) -> tuple[int, int] | None:
    """`(width, height)` of a PNG or JPEG, or None when the header does not say."""
    if blob.startswith(_PNG):
        # The first chunk is IHDR: length, type, then width and height as big-endian 32-bit integers.
        if len(blob) < 24 or blob[12:16] != b"IHDR":
            return None
        return int.from_bytes(blob[16:20], "big"), int.from_bytes(blob[20:24], "big")
    if blob.startswith(b"\xff\xd8"):
        return _jpeg_size(blob)
    return None


def _jpeg_size(blob: bytes) -> tuple[int, int] | None:
    """The largest frame declared before the image data starts; a decoder reads its size from there."""
    size: tuple[int, int] | None = None
    pos = 2
    while pos < len(blob):
        if blob[pos] != 0xFF:
            pos += 1  # stray bytes between segments, which decoders skip as well
            continue
        while pos < len(blob) and blob[pos] == 0xFF:
            pos += 1  # fill bytes before a marker
        if pos >= len(blob):
            break
        marker = blob[pos]
        pos += 1
        if marker in _JPEG_STANDALONE:
            continue
        if marker == _JPEG_SCAN or pos + 2 > len(blob):
            break
        length = int.from_bytes(blob[pos : pos + 2], "big")
        if marker in _JPEG_FRAMES and length >= 7 and pos + 7 <= len(blob):
            height = int.from_bytes(blob[pos + 3 : pos + 5], "big")
            width = int.from_bytes(blob[pos + 5 : pos + 7], "big")
            if size is None or width * height > size[0] * size[1]:
                size = (width, height)
        pos += max(length, 2)
    return size


def check_pixels(blob: bytes, what: str) -> None:
    """Refuse a picture whose header gives no size or more pixels than `MAX_PIXELS`."""
    size = pixel_size(blob)
    if size is None:
        raise PrismError(
            f"The {what} could not be read.",
            code="cover_image_invalid",
            hint="Upload a PNG or JPEG file.",
        )
    width, height = size
    if width * height > MAX_PIXELS:
        raise PrismError(
            f"The {what} is {width} × {height} pixels, more than {MAX_PIXELS // 1_000_000} megapixels.",
            code="cover_image_too_large",
            hint="Scale it down — a cover is printed at most 21 cm wide.",
        )
