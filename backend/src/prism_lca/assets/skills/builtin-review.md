# Critical review: how to use a second opinion, and what to do with it

A model you built yourself is the hardest to see clearly. `review_model` gathers the evidence
(health check, biggest contributors, goal & scope on record, background datasets) and has a separate
reviewer judge it. It changes nothing — acting on the findings is your job.

## 1. Review when it can still change something
- **Before reporting.** A finding that arrives after the user has the number is worth much less.
- **After a structural change** (new phase, swapped background dataset, changed allocation).
- **Before a comparison is drawn.** Comparative claims are what reviewers attack hardest.
Pass `code` and `method` — without them there is no contribution tree and the review can only judge
structure and goal & scope, not what actually drives the result.

## 2. Record goal & scope FIRST
An empty goal & scope makes a review nearly pointless: completeness, cut-off and method choice can
only be assessed against a stated intent. If `model_info` returns nothing, clarify it with the user
and save it before asking for a review.

## 3. What the reviewer is looking for
- **Boundaries vs. reality:** does the modelled system cover what the scope claims (use phase,
  end-of-life, packaging, transport)? Silent omissions are the most common real defect.
- **Proxy plausibility:** a dataset standing in for something else must match in geography,
  technology and reference year. "Same material, wrong continent" quietly moves a result.
- **Method variant:** GWP100 vs GWP20, with or without biogenic carbon, IPCC vs a package method.
- **Signs on treatment processes:** waste treatment in cut-off databases carries conventions that
  invert results when applied wrongly.
- **Single-hotspot dominance:** if one process carries most of the impact, the whole study rests on
  that one assumption — say so in the report and test it with a scenario.

## 4. Handling the findings
Every finding is anchored in the evidence — a figure, or the name of a process or dataset it quotes
(a dataset whose own comment says it is the wrong application is a finding without a number). A claim
with no such anchor is not a finding, it is noise — ignore it rather than chasing it. Work top-down: Blocking, then Should fix, then Worth a look. Fix
what you can, and hand the rest to the user as **named limitations** — an acknowledged limitation is
sound practice, an unmentioned one is a defect.

"Open" is for what cannot be settled here: data nobody has, a decision that is the user's. Two things
are never open:
- **What one more call settles.** "Datasets carrying 30 % were not opened" is fixed by opening them
  with `get_process_details` and writing what you found into the exchange comment — not by recording
  that you did not.
- **A baseline that contradicts your own words.** When the review quotes your comment or limitation
  against your baseline ("recycling share too high for a consumer product", said by you, modelled
  anyway), make them agree: move the baseline to the case you believe, and let the scenario hold the
  other one. A scenario is for the alternative, not for the case you yourself think is right. Then re-run the review if you changed anything
structural.

Two duties close the loop:
- **Re-read what you wrote before the fix.** When a finding makes you change the inventory, a
  formula or the cut-off, the prose written earlier still describes the old model: re-read the
  process comments and the study fields the finding touches and bring them up to date. A real run
  shipped a process comment saying the label was "excluded per cut-off" — thirty calls after the
  review had put the label into the inventory.
- **Record each finding's outcome** by calling `review_model` with `resolutions`
  (`[{finding, resolution: fixed|rejected|open, reason}]`). Fixed things are visible in the model,
  but "rejected, because …" and "still open" exist nowhere else — and the report prints the open
  ones in its Limitations chapter, so an outcome you do not record is an outcome the study cannot
  show.
