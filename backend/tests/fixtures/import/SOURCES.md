# Where these samples come from

Test data for the import assistant, fetched from public sources. Kept small on purpose: the files show
structure, they do not deliver content.

| File | Format | Source |
|---|---|---|
| `es1-abs-resin.xml` | EcoSpold 1 | `brightway-lca/brightway2-io`, `tests/fixtures/ecospold1/` — reads cleanly: 230 exchanges, 224 of them elementary flows |
| `es1-aluminium-extrusion.xml` | EcoSpold 1, **schema-invalid** | same source — `<technology>` sits in the wrong place. Test case for telling the user WHICH element is at fault |
| `es1-acetic-acid.xml` | **not** EcoSpold (root `notecoSpold`) | same source — negative case for format detection |
| `es2-sample.spold` | EcoSpold 2 | `brightway-lca/brightway2-io`, `tests/fixtures/ecospold2/` |
| `simapro-inventory.csv` | SimaPro CSV | `brightway-lca/brightway2-io`, `tests/fixtures/simapro/` |
| `simapro-allocation.csv` | SimaPro CSV (allocation) | same source |
| `ilcd-process.xml` | **ILCD+EPD**, aggregated | Ökobaudat via the soda4LCA API, dataset `c54c16f6-4295-4749-bff0-ba7ed4bc9117` ("'LinCrete' Glasfaserverstärkter Beton") |

The ILCD file is deliberately an **aggregated EPD**, not a unit process: 19 `<exchange>` elements that are
EPD indicators, and 19 `<LCIAResult>` elements. It is the test case for the assistant recognising this kind
of dataset instead of trying to match elementary flows that do not exist.

Still missing: a downloaded ILCD **unit process** (EF reference package or an LCDN node).

## Written by hand

`ilcd-unitprocess/` is **not** a download but built by hand: one process, three flows (a product, an
elementary flow with a compartment path, a technosphere input), two flow properties, two unit groups.
Ökobaudat and the EF packages deliver **aggregated** datasets; for the unit-process path there was nothing
small and licence-free online.

It is minimal and still fully chained: only the fourth file (the unit group) knows that the 2.5 in the
process are kilograms. That chain is exactly what the test checks.

`es2-package/` is also built **by hand**: two EcoSpold 2 datasets, *widget assembly* buys 2 kg of *steel
part* and names the supplier by `activityLinkId`; *steel part production* sits in the same folder. All UUIDs
are made up (`aaaaaaaa-…`, `bbbbbbbb-…`), no number comes from a database. Only the elements the bw2io
extractor requires.

`jsonld-package/` is built **by hand** from the openLCA schema (olca-schema v2: `Process`, `Flow`,
`FlowProperty`, `UnitGroup`, `Location`): the same two processes, one elementary flow, one mass unit group
(kg, g), the supplier as `defaultProvider`. The widget's CO₂ is deliberately stated in grams — the test
checks the conversion to the reference unit. The zip variant is created by the test itself from the folder.
