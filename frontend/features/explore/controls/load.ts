// Positive control for loadEnds: open the Report page's full reports and make a new report — the path where the
// page once stayed on "Loading…" at full CPU (report-loop.patch brings that back). Then only wait while something
// loads, and observe rest. Red within the 30 s deadline on the broken build, green on a sound one.
import { actions, registerCustomAction, extract, type ActionTemplate } from "@antithesishq/bombadil/browser";
import {
  continueObservation,
  isStarted,
  observing,
  startObservation,
  startupActions,
  waitAlways,
  whileLoading,
  type AnyWindow,
} from "../lib.ts";

// The properties this control turns red (and those it watches on the sound build), as explore.ts runs them.
export {
  noConsoleErrors,
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
  restAfterInput,
  restWasMeasured,
  loadEnds,
  busyEnds,
  calculationEnds,
} from "../properties.ts";

const step = extract((state) => ((state.window as AnyWindow).__exploreReportStep as number | undefined) ?? 0);

const reportStep = registerCustomAction("reportStep", async (document, window, k: number) => {
  (window as AnyWindow).__exploreReportStep = k;
  const byText = (sel: string, text: string): HTMLElement | undefined =>
    Array.from(document.querySelectorAll<HTMLElement>(sel)).find(
      (e) => e.textContent?.replace(/›/g, "").trim() === text,
    );
  const el =
    k === 1
      ? byText('nav[aria-label="Pages"] button', "Report")
      : k === 2
        ? byText('[role="tab"]', "Full reports (AI)")
        : byText("button", "New report");
  if (!el) throw new Error(`report step ${k}: control not found`);
  el.click();
});

const steps = actions((): ActionTemplate[] => (step.current < 3 ? [reportStep(step.current + 1)] : [])).when(
  () => isStarted() && !observing(),
);

export const flow = steps;
export const startup = startupActions;
export const observation = continueObservation;
export const waiting = whileLoading.when(() => isStarted() && step.current >= 3 && !observing());
export const resting = startObservation.when(() => isStarted() && step.current >= 3);
export const idle = waitAlways.when(() => isStarted() && step.current >= 3 && !observing());
