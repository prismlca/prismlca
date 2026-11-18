# From a product description to a bill of materials

Use this when the user describes a physical product but has no composition data. The goal is a
component list with materials and masses that you can turn into foreground processes — and that a
reviewer can check.

## 1. Collect what is already known
Before researching, pin down: total mass, size/volume/capacity, market or region (the study's
`geography`), standard or model number, year, intended use. Ask the user (`ask_user`) for the total mass
if it is unknown — it is the single most valuable number, because it makes the result checkable.

## 2. Research
Call `research_bom` with:
- `product`: as specific as you can phrase it,
- `context`: **every** specific from step 1 — the sub-agent shares none of your conversation, so
  anything you omit is simply lost and you will get a generic product instead of the user's,
- `total_mass_kg`: the product's own mass without packaging, when the user stated it or a source gave it — not
  your own estimate, which the balance would only check against itself. Without it the research looks for the
  product's weight itself, so do not list the total weight as a component,
- `components`: name them if you or the user know the breakdown — per-component research is much
  more accurate than letting it enumerate.

## 3. Sanity-check before you model anything
- **Mass balance**: read `summary` first. `balance_ok: false` is a red flag, not a detail: the parts miss the
  total by more than the tolerance — a component is missing, or a figure or the total is wrong. Say so and resolve
  it before building. `null` means not checked, and the note says why (a part without a mass, a failed request,
  overlapping entries, figures on different versions, no usable total); it does not stop you from booking the
  masses that are sound — it keeps the open points open. `residual_kg` is the total minus the parts found —
  never book it as one part's mass.
- **Versions**: when `versions.conflict` is true, figures that claim to be this product's own name different
  versions (another EAN, board thickness, weight). Settle from the user's description and the sources which one
  is meant, or whether they are one; ask the user only if that stays unclear.
- **Plausibility**: a 0.5 l PET bottle body is ~15–25 g, its cap ~2–3 g, its label well under 1 g. A
  figure an order of magnitude off is usually a unit error (g vs kg).
- **Materials must be concrete**: "PET", "HDPE", "aluminium 3104" — not "plastic". You cannot pick a
  dataset for "plastic".
- **Completeness**: adhesives, inks, coatings and fasteners are small but often forgotten; decide
  explicitly whether they fall under the cut-off rule. A researched component you leave out goes
  into `cutoff_criteria` by name — the health check reports every researched mass that no exchange
  books.

## 4. Turn it into a model
Book each mass as a **parameter** (*Parameters & formulas* skill), and let it drive the exchanges.
Its comment is what the report's parameter table prints for that figure: the **source URL**, the
**range** from `mass_range_kg`, and whether the figure belongs to this product, to a comparable
product (name it), or to the user.

`mass_kg` already covers all pieces of an entry (`count` says how many — do not multiply again). Where `overlaps`
names an entry that contains another listed part, book the contained part once; book the container only as its
remainder where the two figures fit together — subtract each contained part once (one that sits inside another
contained part comes out with it) — and say in the comment how you derived it.

For each component: `search_background` for a matching material dataset (proxy-dataset skill if
nothing fits), add it as an input driven by its parameter, then the manufacturing step(s) that
consume them; tag each process by its life-cycle phase and each material input as "Raw materials"
(model-building skill, section 3), and run `check_model_health`.

## 5. Report honestly
Tell the user which masses came from sources and which are typical industry values, and cite the
URLs. A researched BOM is a starting point for a screening study, not a verified inventory.
