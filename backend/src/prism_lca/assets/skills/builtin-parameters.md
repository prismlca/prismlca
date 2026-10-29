# Parameters & formulas in PrismLCA

**Parameters** are named variables (a mass, a distance, a rate). They are **model-scoped**: each
model (foreground database) owns its own parameters, so two models may reuse the same name with
independent values. An exchange amount can be a fixed number or a **formula** that references the
model's parameter names. Change a parameter and every dependent amount — and any result you
recompute — updates automatically. It all runs on Brightway's native parameter engine
(bw2parameters / asteval), so don't try to reinvent it.

## When to parameterise (and when not)

Reach for a parameter + formula when a figure is **not** a one-off constant:

- **One assumption used in many places** — product mass, transport distance, service life, a scrap
  or recycling rate. Define it once so the user revises one number, not ten.
- **Quantities defined relative to each other** — "packaging is 5 % of product mass", "transport =
  mass x distance". A formula keeps the relationship correct when the driver changes.
- **What-if handles** — the knobs a user will want to vary, and the basis for Scenarios (named
  parameter overrides).

Use a plain fixed amount for anything that occurs once and won't change. Do **not** over-parameterise
— it makes a model harder to read. Parameterise the handful of numbers that genuinely drive the study.

## Allocation via a parameter (co-products)

A foreground process has exactly ONE reference product, so a step that yields several valuable
outputs (co-products) cannot be booked as one multi-output process — its burdens have to be split,
and the split is a modelling decision the reader must be able to see and vary.

Follow ISO 14044's order, and only reach for a factor at step 3:

1. **Avoid allocation first.** Subdivide the step into smaller processes that each serve one
   product, or expand the system, if the data allows either. A process that serves only one
   product needs no allocation — do not introduce a factor where none is due, and waste sent to
   treatment is not a co-product.
2. **Physical key** (mass, energy content) where a physical relationship really drives the split.
3. **Other key** (economic value) when physics does not decide it.

When you do allocate, book it so the factor lives in ONE place:

- Model the shared step as its **own process** carrying ALL of its inputs and emissions, with
  "1 unit of the shared step" as its reference product.
- The product's process consumes `alloc_share` units of it — one exchange, one formula. With two
  co-products, the second consumes `1 - alloc_share`.
- `alloc_share` is a parameter (a share between 0 and 1) whose **comment names the key and its
  basis** ("economic allocation, price ratio 85:15, source …").
- Do **not** multiply each input of the shared step by the factor separately: a factor forgotten
  on one exchange misallocates silently, and no check catches that.

Two obligations ride along: record the chosen approach in the study's process-allocation field
(`model_info`) — the health check reports the field while it is empty, and the report prints it.
And if more than one key is defensible, ISO 14044 §4.3.4.2 expects a sensitivity analysis: make
the other key a **scenario** overriding `alloc_share` — that is exactly what parameters are for.

## What a parameter is allowed to hold

A parameter may carry a **rule** the modeller set — only positive, only negative, a range (one open end
means "at least" / "at most"), or one of a list of values. `list_parameters` reports it as `allowed`
("between 0 and 1", "one of 0.25, 0.5, 0.75"); a parameter without one accepts any number.

A value outside the rule is **refused** — the parameter's own amount, what a formula computes for it, a
scenario override, and every cell of an imported scenario workbook. The refusal names the parameter and
what it allows, so read it and act on it rather than retrying.

You cannot set or change a rule. It is a decision about the study, and it belongs to the modeller: if a
figure you were given breaks one — a recycling rate of 1.4 where the parameter allows 0 to 1 — do not
work around it by renaming the parameter or dropping the rule. Say which parameter, what it allows and
what you were given, and ask. Nine times out of ten the number was a percentage.

## The tools

- `list_parameters` — read all parameters (name, value/formula, unit, group, **comment**, and
  **`allowed`** where the modeller set a rule). Call it before writing formulas so you use the right
  names, and when the user asks what a parameter means. `comments_only=true` returns just names +
  comments + allowed.
- `edit_parameter` — create/update by name. Give **either** `value` **or** `formula`. Always set a
  **comment** when you create one, and keep it accurate when you change one — the user relies on it,
  and so will you next time. What belongs in it is set out below; write it in the creating call,
  because a comment left for later is a source lost.
- `edit_parameter` — remove one (fails if a formula still references it).
- `edit_exchange` — drive a specific exchange's amount by a formula (the inspector's "fx").
  Get the `uid` from `get_process_details`. Pass `formula=null` to detach and keep the fixed amount.

## The comment: what the number means, and where it came from

A parameter comment is **printed**. The report renders every parameter as a row of a table —
name, value, unit, comment — and that table is where a reader checks the study's assumptions.
So the comment is not a note to yourself; it is the data-source statement for that figure, and it
carries the same obligation as a process description:

1. **What the number means**, in the reader's terms, with its unit — "mass of the empty bottle
   body", not "bottle weight parameter".
2. **Where it came from**, as one of exactly three things:
   - **a source with its URL** — title/publisher, year, and the link, in the form a report would
     cite it.
<!-- if web -->
     If a `research_web` or `research_bom` finding gave you the figure, carry **its** URL across
     verbatim. That URL is the whole reason the finding has one.
<!-- endif -->
   - **the user's own data** — say so ("mass given by the user").
   - **your own estimate** — say that plainly: "own estimate from typical values, no primary
     source". An admitted estimate is a defensible study; a dressed-up one is not.

**A bare institution or publisher name is not a source.** "PlasticsEurope 2024", "ZSVR packaging
statistics", "MDPI Sustainability 2021", "manufacturer specification", "industry typical" — none of
these can be looked up by the person reading the table, and each of them *looks* checked while being
unverifiable. That is worse than "own estimate", because it spends credibility the figure does not
have. Either the full reference with its link, or the honest admission.

A calculated parameter (one carrying a formula) still needs the derivation and the source of every
input to it — "15 kg x 4.184 kJ/kg·K x 23 K / 0.90" is only half an answer until the 23 K has a
source too.

**Write a formula's derivation, never the value it gives today.** "Remainder to 100 %" stays true;
"(result 36 %)" or "currently 36 %, within the range" is wrong the moment another input moves — and
the table prints the current value beside the comment anyway. A range the result should stay inside
belongs in the comment; the number it lands on today does not.

**Name the source, never the tool that fetched it.** "Road distance, openrouteservice routing for
heavy goods vehicles, +5 % (GLEC)" is something a reader can check; "per distance tool" or "found by
the bill-of-materials research" is not, and the report never names the software it was made with.

## Formula syntax (a single expression)

- Parameter names, numbers, and arithmetic: `+ - * /`, powers `**`, parentheses.
- Functions: `sqrt`, `exp`, `log` (natural), `log10`, `log2`, `min`, `max`, `clip(x, low, high)`,
  `round`, `floor`, `ceil`, `abs`, `sign` (the full NumPy/math library is available for edge cases).
- A **conditional**: `<value> if <condition> else <other>` — e.g. `recycled_share if recycled_share < 1 else 1`
  (or `clip(recycled_share, 0, 1)`), or `0.9 if transport_km > 500 else 0.6`. Comparisons
  `< > <= >= ==` and combinations work. There are **no multi-line `if` blocks** — a formula is always
  one expression.

## Guard rails

- A formula naming an unknown parameter, or a circular reference, is **rejected** with a clear error —
  the previous amount stays; nothing is silently broken. Fix the name or define the missing parameter.
- Amounts recompute automatically on any parameter change; you don't call recalculate yourself.
- Exchange amounts are per 1 unit of the consuming process's reference product, and follow the
  sign convention of the background database (ecoinvent 3: treatment negative; BAFU: disposal positive) — the formula result inherits that meaning.

## One-line summary

Name the assumptions that recur or relate → `edit_parameter` with a comment → reference them in
`edit_exchange` / parameter formulas (single expression, conditionals via `A if c else B`) →
the engine recomputes everything. Read intent from the comments; keep them truthful.
