# Interpreting results: hotspots, sanity checks, typical traps

A number without interpretation is not a result. Work through this before reporting.

## 1. Sanity-check the magnitude first
Anchors worth knowing (climate change, GWP100, order of magnitude):
- grid electricity: ~0.3–0.6 kg CO2e/kWh (EU); hydro/nuclear far lower, coal ~1.
- primary plastics (PET/PE/PP): ~2–3.5 kg CO2e/kg.
- primary aluminium ~8–18, low-alloyed steel ~2, stainless steel (18/8) ~5, glass ~1, corrugated
  board ~1 kg CO2e/kg.
- road freight: ~0.1–0.15 kg CO2e/tkm.
If your result is orders of magnitude away from these, the cause is almost always (a) the **wrong
method variant**, (b) a **unit error**, or (c) a **sign/treatment-process** problem — not a
surprising insight. Check those three before believing the number.

## 2. Find the hotspots
- `explain_result` mode="tree" gives the tree: which processes carry the impact. Use `cutoff` and
  `max_depth` to keep it readable, and `aggregate_by` a tag group to get impact per life-cycle phase.
- `explain_result` mode="flows" answers *why*: which emissions/resources drive the score. CO2 fossil
  dominating a climate result is expected; methane or N2O dominating tells a different story.
- A hotspot in the **background** means "pick a better dataset or challenge the amount"; a hotspot
  in your **foreground** means "check the amount and the assumption behind it".
- `aggregate_by` does not replace the contributor list — one call returns the per-phase breakdown
  **and** the flat top contributors. Asking twice for the two views wastes a round.

## 2a. Then open every dataset that carries the result — this is not optional
Once you have the contribution analysis you know which background datasets the conclusion rests on.
**Call `get_process_details` on every one `not_yet_inspected` names, right after the tree — before
scenarios, tags or `review_model`** — everything above ~10 %, plus the top 8 contributors down to
2 %; a flat 10 % bar let a 3.4 % tinplate lid ship as raw converter steel, +45 % on that item. Pass a
`codes` list to do them in one call. `explain_result` names them for you, so there is nothing to work
out. Skip it and the review names them again — and a finding that one call settles is not one you may
leave open.

Do it *before* you report, write limitations or declare a hotspot, because a dataset's own comment
regularly says what it was built for, and its name never does:

- `printed wiring board production, surface mounted, unspecified, Pb free` — "the composition of
  components is based on the printed wiring board for **desktop and laptop computer**". Used for a
  5 g garden-light driver board it carried 44 % of a result; correcting it moved the total by −39 %.
- `battery production, NiMH, rechargeable` — "a NiMH battery **for laptop applications** … as used
  in a Fujitsu-Siemens laptop, model: C4135". Used for an AA cell, unnoticed, at 41 % of the result.

Two rules that follow from those two examples:

- For a **market**, read the producer behind it as well. A market's comment is boilerplate ("Each
  market represents the consumption mix…"); the sentence that matters sits one level down, on the
  activity the market buys. That is a second `get_process_details` on the biggest input.
- What you find belongs in the **exchange comment** (why this proxy stands in, and what it was
  calibrated on) and, if it could change the conclusion, in a **scenario** with a different
  dataset — see the switch-parameter pattern in "End-of-life & what-if scenarios".

## 3. Check the method choice
LCIA lists contain many near-identical variants. Prefer entries with `recommended: true`; for a
carbon footprint use IPCC GWP100 **total** (excl. biogenic CO2). A "biogenic only" or "land use
only" sub-indicator answers a different question and is off by an order of magnitude for most
products. Report the exact indicator name and unit alongside every number.

## 4. Test the conclusion, do not just state it
- Vary the assumptions that carry the impact (scenarios / parameters) and report the **range**.
- If two options are within a few percent, they are **not** distinguishable at screening quality —
  say that instead of declaring a winner.
- Name the data-quality caveats: proxies used, typical-value masses, cut-offs applied.

## 5. Report structure that survives review
State the FU and indicator, the total, the top three contributors with shares, the sensitivity range,
and the limitations. Then say what would most improve the study — usually one specific measurement.
