# Dictionary source files

Source form of the bundled German spell-checking dictionary (`../de-de-3-0.bdic`), shipped next to
the compiled file because its licence (LGPL) requires the source to accompany the object form.

- Upstream: <https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/>
- Pinned commit: `8d9836211897933ca9972ef5cf88bbd26d9d40b8` (2022-03-04). At this commit the
  repository's `de-DE-3-0.bdic` is byte-identical to ours (same git blob `549373d1…`), and it is the
  last commit that also carries our `en-US-10-1.bdic`; the German files have not changed since 2012.
- Retrieved: 2026-09-30. Every file is the unmodified upstream blob at that commit.

Chromium compiles `de-DE-3-0.bdic` with its `convert_dict` tool from `de_DE_neu.aff` +
`de_DE_neu.dic` plus the Chromium additions in `de_DE_neu.dic_delta` (documented in
`README.chromium`). The word list is the "de_DE_neu" Hunspell dictionary from tkltrans
(<http://tkltrans.sf.net>), LGPL-licensed per `README_de_DE_neu.txt` and the `.aff` header, which
name no version; both LGPL texts from the upstream repository root are included.

| File | Bytes | SHA-256 |
|---|---:|---|
| `de-DE/de_DE_neu.dic` | 10038367 | `12776d068898107ec5bf60db6e75f5112c58bdf668de9d99440b2441768716ce` |
| `de-DE/de_DE_neu.aff` | 41166 | `18734086dd466fdd45cc70bebc1503b923fae107e75c5fc14b929809fe855486` |
| `de-DE/de_DE_neu.dic_delta` | 10347 | `18d660e20ad1b8dbbac6515a17351a17a2cfc6a87053a33c771206eab62c6beb` |
| `de-DE/README_de_DE_neu.txt` | 5731 | `9ef26e87938c4432ba4854663ba0196124880447a007c87d126fae87fdcade8c` |
| `de-DE/README.chromium` | 9763 | `c5b8ce58626509905a4b9a71f57839f795b1aebe874aa3d61f115d796f2c732e` |
| `de-DE/COPYING.LGPL` (LGPL-2.1) | 26532 | `5bbcbb737e60fe9deba08ecbd00920cfcc3403ba2e534c64fdeea49d6bb87509` |
| `de-DE/COPYING.LESSER` (LGPL-3.0) | 7795 | `d7137682540000e5f57ff3cb0b4943b66aa3ac4ecca28614ce46991fc291bd15` |
