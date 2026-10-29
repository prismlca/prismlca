# End-of-life splits and what-if scenarios

End-of-life is where a screening LCA most often turns from "roughly right" to "misleading", and it
is the natural place to use parameters + scenarios instead of hard-coded numbers.

## Parameterise the split, do not hard-code it
Create one parameter per fate, as **fractions of the mass they apply to**, e.g.
`eol_recycling`, `eol_incineration`, `eol_landfill` — and make them sum to 1. A product of several
materials gets one group per material (`eol_plastic_*`, `eol_steel_*`), each summing to 1 and each
multiplied by the mass of that material only. A remainder the statistics leave over (Eurostat's
"other recovery", a few tenths of a percent) is its own parameter, `eol_other`, with a comment saying what it
is — never folded into landfill or incineration just to close the sum: the health check reads the group
and tells you when the shares do not add up. Drive each waste exchange with a formula
(`edit_exchange`), e.g. `mass * eol_recycling`. Now the split is a single, documented handle instead of
three magic numbers, and the sum is checkable at a glance.

**Which statistic: the product's function first, then the route it leaves the household by** — never
its material alone. Whatever contains, protects or carries goods on their way to the user — bottle,
film, can, crate, carton, pallet, sack — is packaging waste in the sense of Directive 94/62/EC, so the
packaging table (`env_waspac`, by material) is the source. The same PET in a fleece, the same wood in a
chair is not packaging, and its route decides:
- **Residual waste** — a hose reel, a garden chair, a toothbrush — goes to incineration or landfill,
  not to a recycling plant. Take the incineration and landfill shares of municipal waste
  (`env_wasmun`), rescaled to sum to 1, and say in the comment that they stand in for residual waste;
  leave out its recycling share, which is the separately collected paper, glass, packaging and bio
  waste. Metals recovered from the incineration bottom ash are part of the incineration, not a
  recycling share you add on top.
- **Collected separately as that material** — scrap metal taken to a recycling yard — takes its waste
  category in `env_wastrt`. That table pools every waste of the category treated in the country,
  industrial scrap and imports included: it reads 80 % recycling for plastics where packaging shows
  51 % and residual waste shows none, so it fits only this route.
- **A stream of its own** — anything with electronics or a battery (WEEE), a sealant that leaves the
  building with the renovation (construction waste), a take-back scheme — is not what these
  tables describe. Use that stream's own statistics, or state the assumption and ask.

A product can take more than one route — its plastic in residual waste, its steel to the recycling
yard. When the route is not obvious, ask. `env_wasoper` is the country's mix of all waste, industrial
waste included and without a breakdown by material: a coarse fallback when none of the above can be
established, never the default for a product.

Regional defaults differ enormously (municipal plastic packaging: high incineration in DE/CH/NL,
high landfill in much of the world). Take the region from the study's `geography` (where the product is
used and thrown away), never from the language of the conversation, and state it and the source of
the split in the parameter comments.
<!-- if eurostat -->
For an EU country, `eurostat_eol` gives the official figures directly — it needs no web search.
<!-- endif -->
<!-- if web -->
With web search on, national statistics and industry figures can be looked up rather than guessed.
<!-- endif -->

The sign an end-of-life exchange needs is the **LCA model building** skill's §4 — load it if you have
not. Run `check_model_health` after building end-of-life either way: it flags a negative amount on a
provider whose reference product is positive, which is the mistake that turns burdens into credits.

## The cut-off approach, in one rule and one example

The cut-off rule settles who pays for what: **whoever makes the waste pays to treat it; whoever uses
the recyclate gets it free of the burden of making the material new.** The burden is cut at the bin.
Nothing crosses it in either direction. ecoinvent's cut-off system model is built on it; BAFU:20XY's
datasets (ecoinvent-2 lineage, recycled content inside the material datasets) follow the same logic.
What differs between the two is the **sign** of the disposal link — see below.

<!-- if bafu -->
### With BAFU:20XY

1. **Your product is made of recycled material.** Take the material dataset whose recycling share
   fits (`Steel profile, uncoated, recycling share 2008 (98% Rec.)`, `Copper sheet, uncoated, high
   recycling share (85% Rec.)`) as a normal **positive** input. There is no separate recyclate market.
2. **Your product's waste goes to incineration or landfill.** Link the disposal dataset — `Disposal,
   <material>, to municipal waste incineration` / `…, to sanitary landfill` — with a **positive**
   amount: in BAFU a disposal dataset is a service with a positive reference product, and the amount
   is the waste going in. (11 323 of the 11 355 disposal inputs in BAFU:2026 are positive; the
   handful of negatives are corrections, not the convention.)
3. **Your product's waste goes to recycling.** Link **nothing at all** — that fraction leaves your
   system burden-free. A `Disposal, …, to recycling` dataset exists for the collection/sorting
   service where BAFU models it; read its comment before using it, and never take a credit.

The check that catches the sign error: `check_model_health` flags a negative amount on a provider
whose reference product is positive. Under BAFU that is every disposal dataset.
<!-- endif -->
<!-- if ecoinvent -->
### With ecoinvent

That gives you exactly three cases, and they are different links:

1. **Your product is made of recycled material.** Link the recyclate market — `market for
   polyethylene terephthalate, pellets, recycled` — with a **positive** amount, as an input to the
   process that consumes it. It is cheap precisely because the primary production was cut off.
2. **Your product's waste goes to incineration or landfill.** Link the treatment activity —
   `treatment of waste polyethylene terephthalate, municipal incineration` — with a **negative**
   amount. Negative because a treatment activity's reference flow is negative; the amount is the
   waste going in.
3. **Your product's waste goes to recycling.** Link **nothing at all.** That fraction leaves your
   system burden-free — it becomes somebody else's input, and they pay for turning it into
   recyclate. There is no exchange to add and no credit to take.

The trap is that cases 1 and 3 sound like the same word and are opposite ends of the bin. Worked
example, from a real run that got it wrong: a shampoo bottle of 22 g PET, 51.7 % of it recycled at
end of life. The end-of-life process was given

    market for polyethylene terephthalate, pellets, recycled   +0.011374 kg

which reads as *this bottle buys 11.4 g of recycled pellets* — the input side, case 1, attached to a
process that models disposal. The study was charged for producing recyclate it never used, on top of
disposing of a bottle. The correct end-of-life process holds **one** exchange for the PET:

    treatment of waste PET, municipal incineration   −0.010626 kg   (the 48.3 % that is burnt)

and nothing for the 51.7 % that is recycled.

Two checks that catch it every time: a `market for …, recycled` **is a material you buy**, so it
never belongs on a disposal process — if you find one there, you meant case 3 and should delete it.
And raising the recycling rate must make the end-of-life climate impact **fall**; if it rises, you have
attached the input side to the output side.

Do not "credit" avoided primary production either — that is the same error mirrored, and it is what
the avoided-burden model does instead of cut-off. Under cut-off there are no credits at all.
<!-- endif -->

## Build the scenarios
1. Baseline stays the realistic, sourced split.
2. `edit_scenario` per alternative — "high recycling", "landfill-dominated", "incineration only" —
   overriding only the parameters that change (`edit_scenario` for single tweaks).
3. Keep the fractions summing to 1 in every scenario; a scenario that sums to 1.2 inflates the
   product's mass, not just its end-of-life.
4. `compare_scenarios` for one indicator against the baseline, then report the *spread* — "climate
   impact varies by ±12 % across plausible end-of-life routes" is the finding, not a single number.

## Scenarios are not only for end-of-life
The same pattern fits transport distance, electricity mix, lifetime/service life, loss rates and
recycled-content share. Reach for it whenever the user says "what if" or a number is an assumption
rather than a measurement.

## Testing a DATASET choice, not just a number
In a screening study the proxy is often the biggest unknown in the model — bigger than any parameter
you would think to vary. A scenario overrides parameters and not links, but that is no obstacle:
**link both datasets and let a parameter decide which one is on.**

    market for limestone, milled, loose            formula: share_caco3 * use_gcc
    market for calcium carbonate, precipitated     formula: share_caco3 * use_pcc

Baseline `use_gcc = 1`, `use_pcc = 0`; the scenario swaps the two. The dormant one contributes
nothing, both spellings of the assumption stay in the model where a reviewer can see them, and
`compare_scenarios` puts the proxy question in the same table as everything else.

Do NOT do it by hand — `edit_exchange action="replace_input"`, calculate, replace back — which is
what one run did: four calls, a saved model that was wrong in between, and a result that
ended up in no scenario and no comparison. It mattered: the three parameter scenarios of that study
moved the answer by at most 11 %, the dataset it did not test moved it by 32 %.

Two rules for the switch:
- **Comment the dormant exchange** — say it is a scenario switch and which scenario turns it on.
  A dataset sitting at amount 0 is otherwise a puzzle to anyone reading the inventory.
- **Keep the switches summing to 1** across the alternatives, the same discipline as the end-of-life
  fractions above; two datasets both at 1 is the material counted twice.
