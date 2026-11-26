// Positive control for the properties no known bug of the app sets off on demand: the defaults (console errors,
// uncaught exceptions, unhandled promise rejections), restWasMeasured, and the loading kinds without a real
// control (start, calc, busy). After the startup reload it makes each condition happen once, by hand: an error
// logged, an exception thrown, a promise rejected, an observation without the commit counter, and an indicator of
// each kind that stays. Each property must go red; the run lasts past the longest deadline.
import { actions, extract, registerCustomAction, type ActionTemplate } from "@antithesishq/bombadil/browser";
import {
  beginObservation,
  continueObservation,
  isStarted,
  observing,
  startupActions,
  waitAlways,
  type AnyWindow,
} from "../lib.ts";

// The properties this control turns red (and those it watches on the sound build), as explore.ts runs them.
export {
  noConsoleErrors,
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
  restWasMeasured,
  startEnds,
  calculationEnds,
  busyEnds,
} from "../properties.ts";

const MARK = "explore positive control";
const step = extract((state) => ((state.window as AnyWindow).__exploreSyntheticStep as number | undefined) ?? 0);

const cause = registerCustomAction("cause", async (document, window, k: number) => {
  const w = window as AnyWindow;
  w.__exploreSyntheticStep = k;
  if (k === 1) w.console.error(`${MARK}: a logged error`);
  else if (k === 2)
    w.setTimeout(() => {
      throw new Error(`${MARK}: an uncaught exception`);
    }, 0);
  else if (k === 3) void w.Promise.reject(new Error(`${MARK}: an unhandled rejection`));
  else if (k === 4) {
    // An observation with nothing to count: the counter is gone, as it would be if launch() had not put it in.
    delete w.__prismE2eReactCommits;
    await beginObservation(document, w, "no counter");
  } else if (k === 5) {
    // One indicator of each kind, outside the app's root so React leaves them alone; they stay.
    const box = document.createElement("div");
    box.setAttribute("aria-label", MARK);
    box.style.cssText = "position:fixed;left:4px;bottom:4px;z-index:2147483647;background:#fff;padding:2px";
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.style.cssText = "display:inline-block;width:8px;height:8px";
    const dots = document.createElement("span");
    dots.className = "dots";
    dots.textContent = "...";
    const start = document.createElement("span");
    start.textContent = "Starting backend…";
    box.append(spinner, dots, start);
    document.body.append(box);
  }
});

const steps = actions((): ActionTemplate[] => (step.current < 5 ? [cause(step.current + 1)] : [])).when(
  () => isStarted() && !observing(),
);

export const flow = steps;
export const startup = startupActions;
export const observation = continueObservation;
export const idle = waitAlways.when(() => isStarted() && step.current >= 5 && !observing());
