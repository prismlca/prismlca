# Contributing to PrismLCA

PrismLCA is free software under the GNU AGPL-3.0 with an additional permission under section 7 (see `LICENSE`). Contributions are welcome — bug reports,
pull requests, data checks, documentation.

## Contributor License Agreement

Before a pull request can be merged, its author has to accept the PrismLCA Contributor License Agreement
once: `CLA.md` for individuals, `CLA-ENTITY.md` if you contribute for your employer or another organisation.
It is the Harmony agreement, version 1.0: you keep your copyright, you grant PrismLCA a licence to use your
contribution, and PrismLCA promises to keep offering it under the AGPL-3.0 (with that permission). Read it — it is short.

To accept, post this sentence as a comment on your pull request:

> I have read the CLA Document and I hereby sign the CLA

A bot records the acceptance (name, GitHub account, date, commit) in the `cla-signatures` branch and marks
the pull request as cleared. You do this once; it covers all your later contributions. Until the bot is live
you can also send a signed copy of the agreement to harthjonas@gmail.com.

If your contribution includes work you do not own — third-party code, data, fonts, images — say so in the
pull request and name the source and its licence (CLA Section 7). Everything shipped is listed in
`THIRD-PARTY-NOTICES.md`, which `backend/scripts/third_party_notices.py` regenerates; a test fails if a
dependency changes without regenerating it.

## The usual

- Backend: `cd backend && uv run pytest -n auto` and `uv run ruff check src tests scripts`. After changing the
  BAFU import or bumping bw2io/bw2data, also `PRISM_FULL_BAFU=1 uv run pytest tests/test_backgrounds_bafu.py`
  (writes all of bw2io's bundled methods instead of one per family).
- Frontend: `cd frontend && npm run lint && npm run typecheck && npx vitest run`.
- Product name is "PrismLCA", one word; UI strings are English.
- Data sources the app ships or reads are recorded in `docs/DATENHERKUNFT.md`; add a row for a new one.
