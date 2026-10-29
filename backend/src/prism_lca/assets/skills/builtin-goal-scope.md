# Goal & scope: pinning the study down before modelling

Nothing else in an LCA is meaningful until these are fixed. Settle them with the user *before*
building, write them into the model with `model_info`, and re-read them with `model_info`
when you continue an existing study.

**One answer, one field.** Each decision below has its own field, and the report's goal & scope
table prints every one of them: `functional_unit`, `geography`, `reference_year`,
`system_boundaries`, `cutoff_criteria`, `allocation` (multi-output processes) and
`system_allocation` (end of life). The `scope` says in a few sentences what the study covers —
the product, its variants, the region and the period — and does not repeat the other fields.
Masses, distances and rates belong in the parameters and the inventory, with their sources.

## The functional unit (FU)
The FU answers "the impacts of *what*, exactly?" and must contain a **function**, an **amount**,
and a **duration or reference flow** — not just a mass.

- Weak: "1 kg of packaging". Strong: "packaging for 1 l of beverage, delivered to the retailer".
- Weak: "one lamp". Strong: "20 000 h of 800 lm lighting".
- If the user gives a mass only, ask what service it delivers — otherwise comparisons later are
  meaningless (`ask_user` with two or three concrete options works well here).
- Everything in the model scales to the FU: if the FU is "1 l delivered", a 0.5 l bottle needs
  two bottles' worth of material.
- **A product named in the brief is a starting point, not a functional unit.** "One bucket of wall
  paint" is the thing you were handed; the function is square metres of wall covered, and the
  moment the FU is the container, pack size and coverage sit in the denominator where nobody can
  see them. Ask — do not compute the honest FU quietly and keep the convenient one. Measured
  2026-08-13: a study worked out that its bucket covered 42 m², wrote that into `functional_unit`,
  reported per bucket anyway, and never raised the question.

## System boundary
State it in `system_boundaries`:
- **Cradle-to-gate** (raw materials → factory gate), **cradle-to-grave** (incl. use + end-of-life),
  or **gate-to-gate**. Say which life-cycle phases are IN and which are OUT.
- **Capital goods / infrastructure**: the background databases include them (ecoinvent in its
  datasets, BAFU:20XY through its infrastructure datasets); your foreground usually does not. Say so
  rather than leaving it implicit.
- **Use phase**: often dominates for energy-using products and is often forgotten for packaging.
- **Geography and time**: where the product is made and sold, and which year the data should
  represent — the fields `geography` and `reference_year`. They drive every dataset choice afterwards
  (see the proxy-dataset skill). The language of the conversation says nothing about the market: when
  the brief does not name it, ask.

## Cut-off rules
Write down in `cutoff_criteria` what you left out and why — "cut off below 1 % of mass, provided the total omitted stays
under 5 %" is a defensible sentence; silence is not. Never cut off something you know to be
toxicologically or energetically relevant just because it is light.

## Allocation / multifunctionality
If a process yields several valuable outputs, say in `allocation` how burdens are split (mass,
energy, economic) or whether you avoid allocation by system expansion. How end-of-life burdens and
credits are handled — cut-off, avoided burden — goes into `system_allocation`. The background
database already embodies a choice — ecoinvent's cut-off system model, BAFU:20XY's attributional
datasets (data quality guideline DQRv2:2023, recycled content in the material datasets) — do not
silently mix conventions, and name the system model of each released database in
`system_allocation`. How to *book* a split so it stays visible and variable
— the shared-step pattern with an `alloc_share` parameter and a scenario for the competing key —
is in the *Parameters & formulas* skill.

## Data quality expectations
Note what is measured, what is literature/typical, and what is a proxy — in the comment of each
figure, and, where the result rests on it, as an entry in `limitations` (kind `data_gap` or
`assumption`). This is what makes the result reviewable, and it is exactly what
`check_model_health` cannot infer for you.

## Checklist before you build
1. FU stated with function + amount + reference flow.
2. Phases in/out listed in `system_boundaries`; use phase decided.
3. `geography` and `reference_year` recorded.
4. Cut-off rule written in `cutoff_criteria`.
5. `allocation` and `system_allocation` named.
6. All of it persisted with `model_info`, each in its own field — later sessions (and the report)
   read it from there.
