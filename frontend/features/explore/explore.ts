// Random exploration of PrismLCA with an explicit, weighted action list — the spec control-prism's explore
// command runs. Its properties are those of properties.ts; each has a positive control in controls/ (controls.json
// says which), and controls/verified.json records the spec they last passed on.
import { weighted } from "@antithesishq/bombadil/browser";
import { inputs } from "@antithesishq/bombadil/browser/defaults/actions";
import {
  clickAnywhere,
  continueObservation,
  escapeAnywhere,
  escapeDialog,
  isStarted,
  newWorkspace,
  observing,
  safeClicks,
  scrollPanels,
  selects,
  startObservation,
  startupActions,
  waitAlways,
  whileLoading,
} from "./lib.ts";

// --- Properties: all of properties.ts ---------------------------------------------------------------------
export * from "./properties.ts";

// --- Actions -------------------------------------------------------------------------------------------
// Exactly one of the three groups offers actions in a state: startup (reload, wait, back to the model),
// an open rest observation (its next window, nothing else), or the exploration proper.
const exploring = weighted([
  [100, safeClicks],
  [50, inputs],
  [15, selects],
  [10, scrollPanels],
  [5, escapeDialog],
  [3, escapeAnywhere],
  [6, clickAnywhere],
  [1, newWorkspace],
  [8, startObservation],
  [150, whileLoading],
  [2, waitAlways],
]).when(() => isStarted() && !observing());

export const exploration = weighted([
  [1, startupActions],
  [1, continueObservation],
  [1, exploring],
]);
