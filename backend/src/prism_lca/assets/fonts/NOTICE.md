# Bundled fonts

This file is the notice that travels with the font files.

These font files ship with PrismLCA and are embedded (subset) into the PDFs the report module
produces. Only fonts under the **SIL Open Font License 1.1** or **Apache 2.0** are bundled — both
licences explicitly permit redistribution and embedding in documents.

Reports are typeset with `ignore_system_fonts=True`, so the output depends solely on the fonts listed
here plus the ones the Typst compiler embeds itself. A report therefore looks identical on every
machine, and no font is ever fetched at runtime.

| Family | Version | Licence | Source |
|---|---|---|---|
| Noto Sans | 2.015 | SIL OFL 1.1 (`NotoSans/OFL.txt`) | <https://github.com/notofonts/latin-greek-cyrillic> — static Regular / Italic / SemiBold / Bold, and CondensedBold |
| Source Serif 4 | 4.005 | SIL OFL 1.1 (`SourceSerif4/OFL.txt`) | <https://github.com/adobe-fonts/source-serif> — static Regular (OTF) |
| IBM Plex Sans | 1.1.0 (`@ibm/plex-sans@1.1.0` release) | SIL OFL 1.1 (`IBMPlexSans/OFL.txt`) | <https://github.com/IBM/plex/releases> — static Regular / Italic / Medium / SemiBold / Bold |
| JetBrains Mono | 2.304 | SIL OFL 1.1 (`JetBrainsMono/OFL.txt`) | <https://github.com/JetBrains/JetBrainsMono/releases> — static Regular / Medium / Bold |
| Instrument Sans | 1.000 | SIL OFL 1.1 (`InstrumentSans/OFL.txt`) | <https://github.com/Instrument/instrument-sans> (`fonts/ttf`, master, 2023-06-14) — static Regular / Italic / Medium / SemiBold / Bold |
| Source Sans 3 | 3.052R | SIL OFL 1.1 (`SourceSans3/LICENSE.md`) | <https://github.com/adobe-fonts/source-sans/releases> — static Regular / Italic / Semibold / Bold (OTF) |
| Montserrat | 7.222 (`v7.222` release) | SIL OFL 1.1 (`Montserrat/OFL.txt`) | <https://github.com/JulietaUla/Montserrat> (`fonts/ttf` at tag `v7.222`) — static Regular / SemiBold / Bold |
| Libre Franklin | 3.000 | SIL OFL 1.1 (`LibreFranklin/OFL.txt`) | <https://github.com/googlefonts/Libre-Franklin> (`fonts/ttf` at commit `310b7ee`, 2024-09-05) — static Regular / Medium / SemiBold / Bold |
| Libre Baskerville | 2.005 | SIL OFL 1.1 with Reserved Font Name "Libre Baskerville" (`LibreBaskerville/OFL.txt`) | <https://github.com/impallari/Libre-Baskerville> (`fonts/ttf` at commit `9852edf`, 2025-10-16) — static Regular / Italic / Bold |
| Open Sans | 3.003 | SIL OFL 1.1 (`OpenSans/OFL.txt`) | <https://github.com/googlefonts/opensans> (`fonts/ttf` at commit `bd7e376`, 2023-11-16, "Fix version number to v3.003") — static Regular / Italic / SemiBold / Bold |

IBM Plex Sans and JetBrains Mono are what the **Network** themes are set in: a monospace for the eyebrows,
headings and table heads, a humanist sans for the prose. IBM Plex Sans carries a Reserved Font Name ("Plex"),
as do Source Serif 4 and Source Sans 3 ("Source"); JetBrains Mono, Noto Sans and Instrument Sans declare none
(checked against each family's own OFL.txt). All files stay unmodified under their own names either way.

The other two themes take the faces of the drafts they were built from: **Serif and rule** sets its title,
chapter numbers and page numbers in Source Serif 4 over Noto Sans prose, and **Panel and year** sets its
display type in Noto Sans CondensedBold over the same prose. The condensed cut lives beside the other Noto
Sans files because it *is* Noto Sans — one release (2.015), one copyright, one licence file, and the same
2,965 characters; only its width class and its full name ("Noto Sans Condensed") differ, which is the name a
template has to ask for.

**Gradient strip** is set in IBM Plex Sans throughout — the face its design draft names.
**Ribbons** is set in Noto Sans throughout, the face of its draft as well.

**Flows** pairs Montserrat for the title and the headings with Open Sans for everything that is read —
the two faces its draft names. Neither licence declares a Reserved Font Name (checked against each family's
own OFL.txt); the files stay unmodified under their own names. They are the static cuts from the
projects' own repositories, not the variable fonts the draft embedded: Typst sets a static cut by its
weight reliably.

**Facets** comes from a sibling of the same draft and takes the same pair; its cover sets the subtitle
large in Montserrat Regular, the one cut it adds — from the same `v7.222` tag.

**Planes** pairs Libre Franklin for the title, the headings, the labels and the tables with Libre Baskerville
for the prose — again the faces of its draft, again as the projects' static cuts. Libre Baskerville carries
the Reserved Font Name "Libre Baskerville": the files are bundled unmodified under their own names, which the
licence allows; a modified version could not be called that. Libre Franklin declares none. The Libre
Baskerville OFL.txt is kept byte for byte as the project ships it, including a stray non-UTF-8 byte in one
author's e-mail address (it reads "hello¨rfuenzalida.com" in the generated notices).

**Declining emissions** is set in Instrument Sans for everything that labels
(title, headings, contents, table heads, running header) and Source Sans 3 for the prose — the two faces
its design draft names. Source Sans 3 carries the Reserved Font Name "Source" like its serif sibling, so the
files stay unmodified under their own names.

The files in the drafts themselves were **not** usable: both HTML drafts carry their fonts as base64 WOFF2,
subset to the few hundred characters the mock-up prints (42 kB uncompressed against 621 kB here). A report
that reaches beyond Western European text — an indicator name, a Greek letter, a chemical subscript — would
have printed holes. Subsetting had also stripped the licence out of the name table, so the files could not
even say what they were. Both families were therefore fetched whole from their own projects and verified
against the licence recorded *inside* the font.

Files are shipped **unmodified**; the OFL's Reserved Font Name clause is therefore untouched.

## Also available, shipped inside the Typst compiler wheel

The `typst` dependency embeds these libre families, so they need no files here and are listed in the
dependency licence overview like any other package:

- **Libertinus Serif** — offered as an alternative body face via the template's `body-font` parameter
- **New Computer Modern** (and Math)
- **DejaVu Sans Mono** — used for codes, identifiers and units

## Adding a font

1. Verify the licence is OFL 1.1 or Apache 2.0. Anything else (Helvetica, Arial, Calibri, Frutiger,
   DIN, the Microsoft core fonts) does not get bundled — that is the actual legal risk surface.
2. Copy the files unmodified into `assets/fonts/<Family>/` together with the licence text.
3. Add a row to the table above naming version and source.
4. Regenerate the third-party notices (`backend/scripts/third_party_notices.py`).
5. Never fetch a font at runtime. Remote Google Fonts embedding triggered a wave of German
   cease-and-desist letters over transmitting the visitor's IP address — a data-protection problem
   rather than a licensing one, and one that bundling avoids entirely.
