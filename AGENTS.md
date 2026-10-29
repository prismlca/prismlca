# AGENTS.md

Guidance for coding agents working in this repository. The project's working rules are in
`CLAUDE.md`; they apply to every agent, whichever tool it runs in.

## Licensed data stays unread

`databases/` holds licensed LCA databases (ecoinvent, BAFU) for local use only. Do not read, extract
(the `.7z` archives included) or quote anything under `databases/`, and do not pass such content to any
tool or service. Neither code review nor tests need it: the import paths are tested against the
invented fixtures in `backend/tests/fixtures/import/`, and licensed formats are described in the code.
