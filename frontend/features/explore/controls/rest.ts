// Positive control for restAfterInput: a fixed flow, the same in every run. After the startup reload: observe the
// Model page, then step through the pages and the Settings dialog three times, each step followed by an
// observation. On a build with the canvas selection render loop brought back (canvas-loop.patch) the Model steps
// are "busy"; on a sound build every step comes to rest.
import { extract, registerCustomAction, actions, type ActionTemplate } from "@antithesishq/bombadil/browser";
import {
  beginObservation,
  continueObservation,
  isStarted,
  observing,
  startupActions,
  type AnyWindow,
} from "../lib.ts";

// The properties this control turns red (and those it watches on the sound build), as explore.ts runs them.
export {
  noConsoleErrors,
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
  restAfterInput,
  restWasMeasured,
} from "../properties.ts";

const STEPS = [
  "nav:Results",
  "nav:LCIA",
  "nav:Parameters",
  "nav:Scenarios",
  "nav:Overview",
  "open:Settings",
  "close:Settings",
  "nav:Model",
];
const CYCLES = 3;

const script = extract((state) => {
  const s = (state.window as AnyWindow).__exploreScript;
  return s ? { k: s.k as number, phase: s.phase as string } : null;
});

function stepLabel(k: number): string {
  return k === 0 ? "start:Model" : `${Math.ceil(k / STEPS.length)}:${STEPS[(k - 1) % STEPS.length]}`;
}

const scriptStep = registerCustomAction("scriptStep", async (document, window, k: number) => {
  const w = window as AnyWindow;
  w.__exploreScript = { k, phase: "observe" };
  const [verb, name] = STEPS[(k - 1) % STEPS.length]!.split(":") as [string, string];
  let el: HTMLElement | undefined;
  if (verb === "nav") {
    el = Array.from(document.querySelectorAll<HTMLElement>('nav[aria-label="Pages"] button')).find(
      (b) => b.textContent?.replace(/›/g, "").trim() === name,
    );
  } else if (verb === "open") {
    el =
      document.querySelector<HTMLElement>(`button[aria-label="${name}"]`) ??
      document.querySelector<HTMLElement>(`button[title="${name}"]`) ??
      undefined;
  } else {
    const dlg = document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${name}"]`);
    el =
      Array.from(dlg?.querySelectorAll<HTMLElement>("button") ?? []).find((b) =>
        /^(Close|Done)$/.test(b.getAttribute("aria-label") ?? b.textContent?.trim() ?? ""),
      ) ?? undefined;
  }
  if (!el) throw new Error(`step ${stepLabel(k)}: control not found`);
  el.click();
});

const scriptObserve = registerCustomAction("scriptObserve", async (document, window) => {
  const w = window as AnyWindow;
  const k = w.__exploreScript?.k ?? 0;
  w.__exploreScript = { k, phase: "observing" };
  await beginObservation(document, w, stepLabel(k));
});

const next = registerCustomAction("next", async (_document, window) => {
  const w = window as AnyWindow;
  w.__exploreScript = { ...w.__exploreScript, phase: "next" };
});

const scripted = actions((): ActionTemplate[] => {
  const s = script.current ?? { k: 0, phase: "observe" };
  if (s.phase === "observe") return [scriptObserve()];
  if (s.phase === "observing") return [next()];
  if (s.k >= STEPS.length * CYCLES) return ["Wait"];
  return [scriptStep(s.k + 1)];
}).when(() => isStarted() && !observing());

export const steps = scripted;
export const startup = startupActions;
export const observation = continueObservation;
