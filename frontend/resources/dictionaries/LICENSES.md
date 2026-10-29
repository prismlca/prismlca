# Bundled spell-checking dictionaries — origins and licences

The German dictionary's source form ships in `src/de-DE/`; the reasons are below.

These `.bdic` files are the unmodified Hunspell dictionaries compiled for Chromium, obtained from
the Chrome dictionary CDN (`https://redirector.gvt1.com/edgedl/chrome/dict/`) on 2026-08-17. Their
sources live in the Chromium project's dictionary repository:
<https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/>, which carries the full
licence and attribution texts per dictionary.

PrismLCA ships them as separate data files (mere aggregation — they are not linked into the program)
so that spell checking works offline and no request is ever made to Google from a user's machine.

All six are pinned to upstream commit `8d9836211897933ca9972ef5cf88bbd26d9d40b8` (2022-03-04): at that commit each of our `.bdic`
files is byte-identical to the repository's file of the same name (same git blob hash). The source
links below point at that commit.

| File | Language | Source project | Licence (chosen where multi-licensed) | Source at pinned commit |
|---|---|---|---|---|
| `en-us-10-1.bdic` | English (US) | SCOWL (<http://wordlist.aspell.net>) | SCOWL licence (permissive, BSD-like) | [`en_US.dic`](https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/+/8d9836211897933ca9972ef5cf88bbd26d9d40b8/en_US.dic) |
| `de-de-3-0.bdic` | German | de_DE_neu word list, tkltrans (<http://tkltrans.sf.net>) | MPL-1.1 (of MPL-1.1 / GPL-2.0 / LGPL-2.1 / LGPL-3.0, per `README_de_DE_neu.txt`; Chromium's added words in `de_DE_neu.dic_delta` under the same tri-licence) | [`de_DE_neu.dic`](https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/+/8d9836211897933ca9972ef5cf88bbd26d9d40b8/de_DE_neu.dic) — copy in `src/de-DE/` |
| `fr-fr-3-0.bdic` | French | Dicollecte / Grammalecte (<https://grammalecte.net>) | MPL-2.0 | [`fr_FR.dic`](https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/+/8d9836211897933ca9972ef5cf88bbd26d9d40b8/fr_FR.dic) |
| `es-es-3-0.bdic` | Spanish | rla-es (<https://github.com/sbosio/rla-es>) | MPL-1.1 (of GPL-3.0/LGPL-3.0/MPL-1.1) | [`es_ES.dic`](https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/+/8d9836211897933ca9972ef5cf88bbd26d9d40b8/es_ES.dic) |
| `pt-pt-3-0.bdic` | Portuguese (PT) | Natura project (<https://natura.di.uminho.pt>) | MPL-1.1 (of GPL-2.0/LGPL-2.1/MPL-1.1) | [`pt_PT.dic`](https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/+/8d9836211897933ca9972ef5cf88bbd26d9d40b8/pt_PT.dic) |
| `pt-br-3-0.bdic` | Portuguese (BR) | LibreOffice pt-BR dictionaries | LGPL-3.0 / MPL-1.1 (multi-licensed) | [`pt_BR.dic`](https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/+/8d9836211897933ca9972ef5cf88bbd26d9d40b8/pt_BR.dic) |

Each dictionary is compiled by Chromium from its `.aff` and `.dic` plus, where present, a
`.dic_delta` of Chromium-added words (see `README.chromium` in the repository).

The German dictionary is copyleft-licensed data in compiled form, so its source form ships with
PrismLCA: `src/de-DE/` holds the unmodified `de_DE_neu.aff`, `de_DE_neu.dic`, `de_DE_neu.dic_delta`,
the upstream README, `README.chromium` and the LGPL texts, pinned to the commit above (checksums in
`src/README.md`). This sits next to the compiled file in the installed app as well, which meets the
source obligation (GPL/LGPL §6) without relying on a third-party server. The MPL- and SCOWL-licensed
dictionaries are referenced by the pinned links above; no source copies are shipped for them.

Licence texts that ship in `licences/`: `MPL-1.1.txt` and `MPL-2.0.txt` (the Mozilla Public License
versions chosen above), and `README_en_US.txt`, the English dictionary's upstream README at the pinned
commit, unmodified — it carries the SCOWL copyright and permission notices, which the SCOWL licence asks
to appear in supporting documentation. The other dictionaries' upstream READMEs with their author
credits are at the pinned commit, e.g.
[`README_fr_FR.txt`](https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/+/8d9836211897933ca9972ef5cf88bbd26d9d40b8/README_fr_FR.txt).
