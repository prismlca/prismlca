// Positive control for noServerErrorBanner and for the backend log: calculate a model whose only process has no
// flows yet (controls.json prepares it). With empty-biosphere.patch the backend fails unexpectedly, the window shows
// "Unexpected server error" and the backend log an "Unhandled error"; a sound build says what is missing instead.
import { actions, extract, registerCustomAction, type ActionTemplate } from "@antithesishq/bombadil/browser";
import {
  isStarted,
  startupActions,
  topmostClickables,
  waitAlways,
  whileLoading,
  type AnyWindow,
} from "../lib.ts";

// The properties this control turns red (and those it watches on the sound build), as explore.ts runs them.
export {
  noConsoleErrors,
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
  noServerErrorBanner,
} from "../properties.ts";

const progress = extract((state) => ({
  selected: state.document.querySelectorAll(".react-flow__node.selected").length,
  calculated: Boolean((state.window as AnyWindow).__exploreCalculated),
}));

const CALCULATE = /^(Calculate|Compute LCIA)$/;
const calculate = registerCustomAction("calculate", async (document, window) => {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => CALCULATE.test(b.textContent?.trim() ?? "") && !b.disabled,
  );
  if (!button) throw new Error("Calculate is not there or not enabled");
  (window as AnyWindow).__exploreCalculated = true;
  button.click();
});

/** Select the box with a real click, then calculate once; afterwards only wait. */
const flow = actions((): ActionTemplate[] => {
  if (progress.current.calculated) return [];
  if (progress.current.selected === 0) {
    const boxes = topmostClickables.current
      .filter((t) => (t.fingerprint.testId ?? "").startsWith("rf__node"))
      .map((t) => ({ Click: t }) as ActionTemplate);
    // While the canvas has not drawn the box yet, wait for it.
    return boxes.length > 0 ? boxes : ["Wait"];
  }
  return [calculate()];
}).when(isStarted);

export const steps = flow;
export const startup = startupActions;
export const waiting = whileLoading.when(() => isStarted() && progress.current.calculated);
export const idle = waitAlways.when(() => isStarted() && progress.current.calculated);
