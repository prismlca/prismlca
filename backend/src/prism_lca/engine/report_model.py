"""The report's document model: ordered blocks, rendered to Typst.

One neutral representation between "what the report says" and "how it is typeset". It exists so that

* the same content can be rendered to Typst today and to DOCX later without rebuilding it,
* the AI writes *blocks* rather than markup, so its output can be validated before it is stored,
* numbers and cross-references stay **placeholders** until render time — changing a figure then costs
  no tokens, and re-ordering chapters cannot break a "see Figure 3".

Blocks are plain dicts because they are persisted as JSON (see ``report_store``). Rendering is pure:
no I/O, no state — which is what makes it cheap to test.
"""
from __future__ import annotations

import hashlib
import re
from typing import Any

# The section-kind vocabulary lives in the registry (report_kinds, the deepest leaf) since the
# ChapterKind consolidation — re-exported here because half the engine and the API read it off this
# module. The tuples' own documentation stands at their definition.
from prism_lca.engine.report_kinds import DETERMINISTIC_KINDS, PROSE_KINDS  # noqa: F401


def esc(value: object) -> str:
    """Escape text for Typst markup. Typst gives special meaning to fewer characters than Markdown,
    but `#`, `$`, `@`, `*`, `_`, `<`, `` ` `` and `\\` all do something — a dataset name like
    ``market for electricity #2`` would otherwise start a code expression."""
    text = "" if value is None else str(value)
    return "".join("\\" + ch if ch in "\\#$@*_`<>[]" else ch for ch in text)


#: `**bold**`, and `*italic*` / `_italic_`. Only these two, and only around a single line's worth of text:
#: a report is not a chat message, and every further construct is a way for a model to produce something
#: nobody asked for.
_STRONG = re.compile(r"\*\*(?P<strong>.+?)\*\*", re.S)
_EMPH = re.compile(r"(?<![\w*])[*_](?=\S)(?P<emph>[^*_\n]+?)(?<=\S)[*_](?![\w*])")
#: A code span \u2014 and the one construct that is recognised in order to be *removed*.
#:
#: Writers fence things out of Markdown habit: a method family, a parameter name, a field. Nothing
#: translated it, so the backticks were escaped and printed, and a real report said
#: "drawn from the \\`EF v3.1\\` method family" to a client. Setting them in a code face instead was
#: the obvious alternative and is worse: `mass_kg` would look right and `EF v3.1` would look like a
#: filename, and which of the two a writer fenced is not knowable here. Dropped, therefore \u2014 the words
#: stay, the fence goes, and prose that was meant as prose reads as prose.
#: Any run of backticks may open the span as long as the same run closes it, and it may not cross a
#: line: an unpaired backtick stays the literal character it probably is.
_CODE = re.compile(r"(?P<fence>`+)(?P<code>[^\n]+?)(?P=fence)")
_BULLET = re.compile(r"^[-*\u2022]\s+")
_NUMBERED = re.compile(r"^\d+[.)]\s+")

#: Code first: a fenced span wins over emphasis inside it, as it does in Markdown.
_INLINE = re.compile(f"{_CODE.pattern}|{_STRONG.pattern}|{_EMPH.pattern}", re.S)


def drop_code_fences(text: str) -> str:
    """Take the backticks off a code span and keep the words — the rule `_CODE` states, on its own.

    `markup` cannot expose it: there the fence is dropped inside one combined pass, because a fenced
    span has to win over emphasis inside it. But the *preview* needs the same rule without any of the
    rest of that pass, and a preview that keeps a fence the page will not print is showing something
    the reader will never see. Both read `_CODE`, so the fence a document loses and the fence a
    preview loses are decided by one pattern.
    """
    return _CODE.sub(lambda m: m.group("code"), text or "")


def _inline(text: str) -> str:
    """Escape a line, turning the two emphasis markers into Typst calls and unfencing code spans."""
    out: list[str] = []
    pos = 0
    for match in _INLINE.finditer(text):
        out.append(esc(text[pos : match.start()]))
        strong, emph, code = match.group("strong"), match.group("emph"), match.group("code")
        if strong is not None:
            out.append(f"#strong[{esc(strong)}]")
        elif emph is not None:
            out.append(f"#emph[{esc(emph)}]")
        else:
            out.append(esc(code))
        pos = match.end()
    out.append(esc(text[pos:]))
    return "".join(out)


#: Every double and single quotation mark a writer or an author types, mapped to the straight one.
#: Typst sets the straight marks as the document language's own pair (`set text(lang: …)` in every
#: template: „…“ in German, “…” in English, « … » in French) and tells opening from closing itself.
#: A typographic mark it is NOT given to pair stays as typed — which is how a German chapter came out
#: with „methanol production, from coal gasification„: the model wrote „ as the opener and a straight
#: " as the closer, and the compiler read the straight one as a fresh opener (V409). The
#: other half of the finding was three chapters in three styles („…“, «…», ‚…‘) from four parallel
#: writer lanes; one pair per language is the compiler's job, so everything is handed to it uniform.
_DOUBLE_QUOTES = str.maketrans({c: '"' for c in "\u201e\u201c\u201d\u00ab\u00bb\u201f\u301d\u301e\u2033\u02ba"})
_SINGLE_QUOTES = str.maketrans({c: "'" for c in "\u201a\u2018\u2019\u2039\u203a\u201b"})


def normalise_quotes(text: str) -> str:
    """Author prose with every quotation mark straightened — see `_DOUBLE_QUOTES` for why.

    Apostrophes go the same way (’ → ') and come back typeset: Typst's smartquote reads a straight
    apostrophe inside a word as the apostrophe it is. Not for table cells or dataset names: those are
    data, and a name is printed as its database spells it."""
    return (text or "").translate(_DOUBLE_QUOTES).translate(_SINGLE_QUOTES)


def markup(text: str) -> str:
    """The author's own words, made safe for Typst — with bold, italics and lists carried over.

    Two jobs in one pass, because they are the same decision. Prose used to reach the compiler
    unescaped: a chapter containing a plain `#` failed the whole document ("expected expression"), and a
    model could have written `#link(...)` straight into a client's PDF. Escaping alone would print
    `**important**` as asterisks, so the small Markdown subset a writer actually needs — bold, italic,
    bullet and numbered lists — is translated into Typst instead, and everything else is escaped.

    Deliberately not a Markdown implementation: no headings (the chapter has one), no tables (they come
    from the data), no links, no images, no code. What is not translated is printed literally, which is
    the safe direction.
    """
    lines: list[str] = []
    for line in (text or "").split("\n"):
        stripped = line.lstrip()
        indent = line[: len(line) - len(stripped)]
        marker = ""
        if _BULLET.match(stripped):
            marker, stripped = "- ", _BULLET.sub("", stripped)
        elif _NUMBERED.match(stripped):
            # Typst numbers an enumeration itself, so the author's "1." becomes "+" and a reordered list
            # cannot end up numbered 1, 2, 2.
            marker, stripped = "+ ", _NUMBERED.sub("", stripped)
        rendered = _inline(stripped)
        if not marker and rendered[:1] in ("=", "+", "/"):
            # Line-leading Typst syntax `esc` does not cover: `=` starts a real heading (in the TOC of a
            # client PDF), `+` an enum item, `/` a term list. Escaped after `_inline`, because `esc`
            # would double the backslash into a printed one.
            rendered = "\\" + rendered
        lines.append(indent + marker + rendered)
    return "\n".join(lines)


def esc_str(value: object) -> str:
    """Escape for a Typst **string literal**, which is not the same thing as escaping markup.

    A string literal only needs its backslashes and quotes escaped. Running `esc` over one is actively
    wrong: it escapes `_` and `#`, and a path like ``charts/contribution_grouped.svg`` came out as
    ``charts/contribution\\_grouped.svg``, which Typst refuses with "path must not contain a backslash" —
    it failed a whole 15-page document over a filename.
    """
    text = "" if value is None else str(value)
    return text.replace("\\", "\\\\").replace('"', '\\"')


def heading(text: str, level: int = 1, *, numbered: bool = True) -> dict[str, Any]:
    # No label parameter: a `#label(…)` on its own line does not attach to the heading above it, so the
    # old parameter emitted a reference target that could never be referenced.
    # `numbered=False` = front matter: the heading keeps its place in the contents but carries no
    # chapter number (the executive summary).
    out: dict[str, Any] = {"type": "heading", "level": max(1, min(level, 4)), "text": text}
    if not numbered:
        out["numbered"] = False
    return out


def prose(text: str) -> dict[str, Any]:
    return {"type": "prose", "text": text}


def kv(pairs: list[tuple[str, str]] | list[list[str]]) -> dict[str, Any]:
    return {"type": "kv", "pairs": [list(p) for p in pairs]}


def table(
    headers: list[str],
    rows: list[list[str]],
    *,
    caption: str | None = None,
    align_right: list[int] | None = None,
    label: str | None = None,
    key: str | None = None,
) -> dict[str, Any]:
    """`label` is the cross-reference target (`@t-lcia`); `key` is the table's identity in `tables.json`.

    Two things on purpose: a label may be dropped as a duplicate or never exist, and a
    positional one (`t-contribution-1`) points at whichever indicator is second today. A key names what the
    table *is* — the indicator, the dimension — so a refresh either finds that table again or finds a gap,
    never another indicator's numbers under the old caption. None = the renderer derives one.
    """
    return {
        "type": "table",
        "headers": headers,
        "rows": rows,
        "caption": caption,
        "align_right": align_right or [],
        "label": label,
        "key": key,
    }


def figure(
    path: str,
    *,
    caption: str | None = None,
    width: str = "100%",
    label: str | None = None,
    caption_safe: bool = False,
    key: str | None = None,
) -> dict[str, Any]:
    """`caption_safe` means the caption is already Typst content — it came out of the placeholder
    resolver and may contain `#pval(…)` calls, which escaping would print as literal text.

    `key` is the chart's identity in `figures.json` (see `chart_key`), the counterpart of a table's key:
    with it, the document reads the file through `#pfigure("<key>", …)` and a refresh that no longer
    carries that chart prints a gap instead of whatever SVG still lies in `charts/`. `path` is where the
    chart is placed (`chart_path(key)`), for an inline render and for the reader of the block."""
    return {
        "type": "figure",
        "path": path,
        "caption": caption,
        "width": width,
        "label": label,
        "caption_safe": caption_safe,
        "key": key,
    }


# ---- chart identities --------------------------------------------------------------------------------
# A chart is named by what it shows, the way a table is: `contribution-1.svg` was whichever
# indicator stood second in the method list, and after the list changed an "update data only" archive put
# another indicator's chart under the old caption without a word. The keys are built in the renderer
# (lib/report/figures.ts), which draws the charts, and here, which places them — the two builders below
# and their mirrors there must produce the same strings, character for character.


def key_part(value: object, *, slash: bool = False) -> str:
    """One component of a chart or table identity, with the delimiters it could be confused with escaped.

    `%` → `%25`, `|` → `%7C`, and — where the slash separates components, as between a chapter and its
    figure's place — `/` → `%2F`. Without it `("tag:a|b", "c")` and `("tag:a", "b|c")` were the same
    identity. The method path keeps its ` / ` readable: inside an identity no slash is a delimiter. The
    renderer's `keyPart` (lib/report/figures.ts) does exactly this.
    """
    text = str(value if value is not None else "").replace("%", "%25").replace("|", "%7C")
    return text.replace("/", "%2F") if slash else text


def indicator_identity(dimension: str, method_label: str) -> str:
    """One indicator's breakdown in one dimension — the identity a contribution TABLE and its CHART share.

    `method_label` is the flat method path (`"EF v3.1 / climate change / GWP100"`), the same string the
    snapshot carries on every result and every contribution view. One function for both, so the table and
    the chart of an indicator are either both there after a refresh or both a visible gap.
    """
    return f"{key_part(dimension)}|{key_part(method_label)}"


def chart_key(kind: str, identity: str) -> str:
    """`<kind>:<identity>` — e.g. `lcia:t / gwp / a`, `contribution-stacked:geo|t / gwp / a`."""
    return f"{kind}:{identity}"


#: What a chapter's figure falls back to when its spec leaves a field out — the renderer's defaults, so
#: an absent field and the explicit default are one identity (figures.ts reads `rows ?? 15`,
#: `horizontal !== false`).
_SECTION_DEFAULT_ROWS = 15


def section_chart_key(
    section_id: str, index: int | None, spec: dict[str, Any], lead_method: str, dimension: str = ""
) -> str:
    """A chapter's own figure: its chapter, its place in the chapter's list, and everything it draws.

    `index` None is the writer's single proposal (a report from before the list existed), written
    `single` so it cannot meet an indexed figure. Every row source (`contribution.groups`,
    `inventory.flows`, `hotspots`, `subjects`) is read against the leading indicator, so the lead's
    method path is part of the identity, and `contribution.groups` is split by the report's own dimension
    (`breakdown_dimensions[0]`), so that is too — a refresh that splits by phase instead of geography
    leaves a gap under a caption written for the geography. So are the settings that change the drawing
    (stacked, horizontal, rows, the label and value fields). The heatmap and the radar span every
    indicator and depend on none of it.
    """
    kind = str(spec.get("kind") or "")
    place = f"{key_part(section_id, slash=True)}/{'single' if index is None else int(index)}"
    if kind in ("heatmap", "radar"):
        return f"section:{place}|{key_part(kind)}"
    source = str(spec.get("source") or "")
    rows = spec.get("rows")
    parts = [
        kind,
        source,
        str(spec.get("label") or ""),
        str(spec.get("value") or ""),
        str(_SECTION_DEFAULT_ROWS if rows is None else int(rows)),
        "h" if spec.get("horizontal") is not False else "v",
        "stacked" if spec.get("stacked") else "",
        dimension if source == "contribution.groups" else "",
        lead_method,
    ]
    return f"section:{place}|" + "|".join(key_part(p) for p in parts)


#: The report-wide charts (`heatmap`, `radar`, `system-model`) show the same thing whatever the method
#: list, and so keep the names every export already has. Every other key is hashed — a positional name
#: (`lcia-1.svg`) is never a chart's file: an export from before 29 Sept 2026 embeds those names directly.
FLAT_CHARTS = frozenset({"heatmap", "radar", "system-model"})


def chart_path(key: str) -> str:
    """Where a chart with this key lives in the project: `charts/<readable part>-<hash>.svg`.

    The key itself holds slashes, bars and whatever the method names hold, so the file is named by a
    slug of it plus a digest — deterministic (the same key is the same file in every export), readable
    enough to find by eye, and unable to leave `charts/`. Sixty-four bits of digest: at forty, two keys
    with one slug were a birthday search away from one file. `place_charts` refuses a collision anyway.
    """
    if key in FLAT_CHARTS:
        return f"charts/{key}.svg"
    slug = re.sub(r"[^a-z0-9]+", "-", key.lower()).strip("-")[:48].rstrip("-")
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
    return f"charts/{slug}-{digest}.svg" if slug else f"charts/chart-{digest}.svg"


def note(text: str) -> dict[str, Any]:
    return {"type": "note", "text": text}


def raw_block(text: str) -> dict[str, Any]:
    """Typst we generate ourselves — never user or model input, which is why it is not escaped."""
    return {"type": "raw", "text": text}


def pagebreak() -> dict[str, Any]:
    return {"type": "pagebreak"}


def _typst_list(values: list[str]) -> str:
    """A Typst array literal of escaped strings; a single element still needs the trailing comma.

    `esc_str`, not `esc`: these are string literals, where markup escapes are kept literally — the flow
    "Particulates, < 2.5 um" printed as "Particulates, \\< 2.5 um" in every inventory table."""
    inner = ", ".join(f'"{esc_str(v)}"' for v in values)
    return f"({inner},)" if len(values) == 1 else f"({inner})"


def _render_figure(block: dict[str, Any], *, keyed: bool) -> str:
    """A figure block: `#pfigure("<key>", …)` when it has a key and the document reads `figures.json`
    (`keyed`, the same switch that sends tables to `tables.json`), else the literal `#lca-figure(path, …)`."""
    options: list[str] = []
    if block.get("caption"):
        text = block["caption"] if block.get("caption_safe") else esc(block["caption"])
        options.append(f"  caption: [{text}],")
    if block.get("width"):
        options.append(f"  width: {block['width']},")
    if block.get("label"):
        options.append(f'  label-name: "{esc_str(block["label"])}",')
    if keyed and block.get("key"):
        # Read through `figures.json` (see `figure`): a chart the data no longer has is a gap.
        return "#pfigure(\n" + "\n".join([f'  "{esc_str(block["key"])}",', *options]) + "\n)\n"
    return "#lca-figure(\n" + "\n".join([f'  "{esc_str(block.get("path", ""))}",', *options]) + "\n)\n"


def render_block(
    block: dict[str, Any], tables: dict[str, dict] | None = None, cited: set[str] | None = None
) -> str:
    """One block as Typst markup.

    `tables`, when given, collects the tables instead of inlining them: EVERY table is written into it
    (headers, rows, right-aligned columns) under its data key, and the markup becomes `#ptable("<key>", …)`,
    which reads them back from `tables.json` while compiling. That is what lets the "update data only"
    archive refresh a table under prose the author has rewritten — the same split `values.json` makes for
    the numbers in a sentence. Without `tables` the table is inlined as before.
    """
    kind = block.get("type")

    if kind == "heading":
        text = esc(block.get("text", ""))
        if block.get("numbered") is False:
            # Front matter: in the contents, but without a chapter number - the numbered
            # chapters start counting after it instead of skipping a value.
            return f"#heading(level: {int(block.get('level', 1))}, numbering: none)[{text}]\n"
        marks = "=" * int(block.get("level", 1))
        return f"{marks} {text}\n"

    if kind == "prose":
        # Prose is already Typst-safe: it comes from the placeholder resolver, which escapes the
        # values it substitutes and emits `@label` references deliberately.
        return f"{block.get('text', '')}\n"

    if kind == "kv":
        pairs = [p for p in block.get("pairs", []) if len(p) >= 2 and str(p[1]).strip()]
        if not pairs:
            return ""
        inner = ",\n  ".join(f'("{esc_str(k)}", "{esc_str(v)}")' for k, v in ((p[0], p[1]) for p in pairs))
        return f"#lca-kv((\n  {inner},\n))\n"

    if kind == "table":
        headers = [str(h) for h in block.get("headers", [])]
        rows = [[str(c) for c in r] for r in block.get("rows", [])]
        if not headers:
            return ""
        label = str(block.get("label") or "")
        if tables is not None:
            # The data key, not the label: the label is the cross-reference target and may be missing or
            # dropped as a duplicate, the key is what the table is (see `table`). The stored-report
            # renderer gives every table one; anything else falls back to the label, then to its place.
            # Presentation that follows the data's shape travels with the data — a refreshed comparison
            # with one more variant brings one more right-aligned column. The caption and the label stay
            # here: the caption is prose and the author's to reword, the label is what their text cites.
            base = str(block.get("key") or label or f"table-{len(tables) + 1}")
            key, n = base, 1
            while key in tables:
                n += 1
                key = f"{base}~{n}"
            tables[key] = {
                "headers": headers,
                "rows": rows,
                "align-right": [int(i) for i in block.get("align_right") or []],
            }
            args = [f'  "{esc_str(key)}",']
            if label:
                args.append(f'  label-name: "{esc_str(label)}",')
            if block.get("caption"):
                args.append(f"  caption: [{esc(block['caption'])}],")
            elif label and label in (cited or set()):
                # A captionless table is printed bare by every theme, label and all dropped; one the text
                # cites has to become a reference target (see `report_typst._PTABLE`).
                args.append("  cited: true,")
            return "#ptable(\n" + "\n".join(args) + "\n)\n"
        if not rows:
            return "#emph[No data.]\n"
        body = ",\n    ".join(_typst_list(r) for r in rows)
        args = [f"  {_typst_list(headers)},", f"  (\n    {body},\n  ),"]
        if block.get("caption"):
            args.append(f"  caption: [{esc(block['caption'])}],")
        if block.get("align_right"):
            idx = ", ".join(str(int(i)) for i in block["align_right"])
            args.append(f"  align-right: ({idx},),")
        if block.get("label"):
            args.append(f'  label-name: "{esc_str(block["label"])}",')
        return "#lca-table(\n" + "\n".join(args) + "\n)\n"

    if kind == "figure":
        return _render_figure(block, keyed=tables is not None)

    if kind == "note":
        return f"#emph[{esc(block.get('text', ''))}]\n"

    if kind == "pagebreak":
        return "#pagebreak()\n"

    if kind == "raw":
        # Escape hatch for generated Typst we build ourselves (never for AI or user input).
        return f"{block.get('text', '')}\n"

    raise ValueError(f"Unknown report block type: {kind!r}")


#: A reference the resolver emitted: an `@label` not escaped by `esc` (which writes a literal `@` as `\@`).
_REFERENCE = re.compile(r"(?<![\\\w])@([A-Za-z][A-Za-z0-9_-]*)")


def cited_labels(blocks: list[dict[str, Any]]) -> set[str]:
    """The labels the document's prose and resolved figure captions reference."""
    found: set[str] = set()
    for block in blocks:
        if block.get("type") == "prose":
            text = block.get("text")
        elif block.get("type") == "figure" and block.get("caption_safe"):
            text = block.get("caption")
        else:
            continue
        found.update(_REFERENCE.findall(str(text or "")))
    return found


def render_blocks(blocks: list[dict[str, Any]], tables: dict[str, dict] | None = None) -> str:
    cited = cited_labels(blocks) if tables is not None else None
    return "\n".join(render_block(b, tables, cited) for b in blocks)
