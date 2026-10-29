# Hand-maintained licence texts for THIRD-PARTY-NOTICES.md

`backend/scripts/third_party_notices.py` reads these files so that it runs offline. They are
upstream texts, stored unmodified. All were fetched on 2026-09-30, except the Lucide and LobeHub texts
(2026-10-22). Refetch only when the upstream component changes (new font version in the `typst` wheel,
new model revision, ...), and update the date here.

| File | Used for | Source |
|---|---|---|
| `feather-LICENSE.txt` | Feather Icons (most icons in `frontend/src/renderer/src/components/icons.tsx`, inline glyphs in `splash.ts`, `ComposerMenu.tsx`, `ModelPicker.tsx`) | <https://raw.githubusercontent.com/feathericons/feather/main/LICENSE> |
| `simple-icons-LICENSE.md` | Simple Icons (provider logos in `frontend/src/renderer/src/assets/logos/`), CC0-1.0 | <https://raw.githubusercontent.com/simple-icons/simple-icons/develop/LICENSE.md> |
| `simple-icons-DISCLAIMER.md` | Simple Icons trademark disclaimer | <https://raw.githubusercontent.com/simple-icons/simple-icons/develop/DISCLAIMER.md> |
| `lucide-LICENSE.txt` | Lucide (ISC; the icons in `icons.tsx` and the microphone glyphs that its source notes name), including Lucide's own MIT notice for its Feather-derived icons | <https://raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE> (identical to the `LICENSE` of `lucide-static` 1.61.0) |
| `lobehub-icons-LICENSE.txt` | LobeHub Icons (MIT; the Tencent logo in `assets/logos/`) | <https://raw.githubusercontent.com/lobehub/lobe-icons/master/LICENSE> |
| `libertinus-OFL.txt` | Libertinus Serif, embedded in the `typst` wheel | <https://raw.githubusercontent.com/alerque/libertinus/master/OFL.txt> |
| `newcm-GUST-FONT-LICENSE.txt` | New Computer Modern, embedded in the `typst` wheel (GUST Font License 1.0) | <https://www.gust.org.pl/projects/e-foundry/licenses/GUST-FONT-LICENSE.txt> |
| `newcm-License.txt` | New Computer Modern licence statement (GPL-3.0-or-later + Font Exception + Distribution Exception for NewCM10-Regular) | <https://mirrors.ctan.org/fonts/newcomputermodern/License.txt> |
| `dejavu-LICENSE.txt` | DejaVu Sans Mono, embedded in the `typst` wheel | <https://raw.githubusercontent.com/dejavu-fonts/dejavu-fonts/master/LICENSE> (the licence linked from dejavu-fonts.github.io) |
| `typst-assets-NOTICE.txt` | Notice for every asset the Typst compiler embeds (fonts, ICC profiles, ...) | <https://raw.githubusercontent.com/typst/typst-assets/v0.15.0/NOTICE> |
| `EUPL-1.2.txt` | Eurostat marnet shipping-lane network inside `searoute` | <https://raw.githubusercontent.com/spdx/license-list-data/main/text/EUPL-1.2.txt> (the joinup.ec.europa.eu attachment URL returned 404) |
| `spdx-MIT.txt`, `spdx-BSD-2-Clause.txt`, `spdx-BSD-3-Clause.txt`, `spdx-Apache-2.0.txt` | Standard texts for packages that ship no licence file, and for the embedding models | <https://raw.githubusercontent.com/spdx/license-list-data/main/text/> |

The embedding models have no LICENSE file in their Hugging Face repositories at the pinned revisions;
their model cards declare `license: mit` (checked 2026-09-30):
<https://huggingface.co/BAAI/bge-m3/blob/5617a9f61b028005a4858fdac845db406aefb181/README.md> and
<https://huggingface.co/intfloat/multilingual-e5-large/blob/3d7cfbdacd47fdda877c5cd8a79fbcc4f2a574f3/README.md>.
The script reproduces the SPDX MIT text with the authors named on those cards.
