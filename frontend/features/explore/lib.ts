// What the exploring spec (explore.ts) and the positive controls (controls/*.ts) share.
// Bombadil `browser test-external` against a sealed control-prism instance of PrismLCA; control-prism's explore
// command runs it (node scripts/control-prism.mjs explore). This file is bundled by Bombadil, not by the app.
import { always, eventually, now, type Formula } from "@antithesishq/bombadil";
import {
  actions,
  extract,
  getFingerprint,
  registerCustomAction,
  type ActionTemplate,
} from "@antithesishq/bombadil/browser";
import { lastAction } from "@antithesishq/bombadil/browser/defaults/actions";

export type AnyWindow = Window & Record<string, any>;

/** A string cut to at most n characters without splitting a surrogate pair. */
export const cut = (s: string, n: number): string => Array.from(s).slice(0, n).join("");

// --- Where the app is --------------------------------------------------------------------------------
// Per state, for the trace and the report: the document (a reload starts a new one), the page, the topmost
// dialog and, inside it, the section that is on (Settings' sections, the tour's card).
export const where = extract((state) => {
  const d = state.document;
  const page =
    d
      .querySelector('nav[aria-label="Pages"] [aria-current="page"]')
      ?.textContent?.replace(/›/g, "")
      .trim() ?? null;
  const dialogs = Array.from(d.querySelectorAll('[role="dialog"]')).filter(
    (e) => e.getClientRects().length > 0,
  );
  const top = dialogs[dialogs.length - 1];
  let dialog: string | null = null;
  let section: string | null = null;
  if (top) {
    const by = top.getAttribute("aria-labelledby");
    dialog =
      top.getAttribute("aria-label") ??
      (by ? (d.getElementById(by)?.textContent?.trim() ?? null) : null) ??
      top.querySelector("h2,h3")?.textContent?.trim() ??
      "?";
    const on = top.querySelector(
      '[aria-current="page"],[aria-current="true"],[aria-selected="true"],button.on,.tab.on',
    );
    section = on?.textContent ? cut(on.textContent.trim(), 40) : null;
  }
  return {
    doc: Math.round(state.window.performance.timeOrigin),
    page,
    dialog: dialog ? cut(dialog, 60) : null,
    section,
  };
});

// --- Startup: one controlled reload, then back to the model -----------------------------------------
// The renderer's bundle is instrumented only when it loads through Bombadil, so the first action is a
// reload. After it the app is back on the Overview with the model still active; `startup` opens the Model
// page and marks the document as started. A document that is not marked (a reload nobody asked for) goes
// through `startup` again, and the trace shows it.
const started = extract((state) => Boolean((state.window as AnyWindow).__exploreStarted));
const navReady = extract(
  (state) => state.document.querySelector('nav[aria-label="Pages"]') !== null,
);

const startup = registerCustomAction("startup", async (document, window) => {
  const w = window as AnyWindow;
  const model = Array.from(
    document.querySelectorAll<HTMLButtonElement>('nav[aria-label="Pages"] button'),
  ).find((b) => /^Model/.test(b.textContent?.trim() ?? ""));
  if (model && !model.disabled) model.click();
  w.__exploreStarted = { at: Date.now(), modelOpened: Boolean(model && !model.disabled) };
});

/** Reload at the very first state, wait while the start screen has no controls, then `startup`. */
export const startupActions = actions((): ActionTemplate[] => {
  if (lastAction.current === null) return ["Reload"];
  if (started.current) return [];
  return navReady.current ? [startup()] : ["Wait"];
});

/** Whether the exploration may begin in this state. */
export const isStarted = (): boolean => lastAction.current !== null && started.current;

// --- Loading ends ------------------------------------------------------------------------------------
// Indicators by kind, each with its own deadline. Found by structure where the app has one — the spinner of a
// calculation or search, the moving dots of a Busy label and the BusyClock of a long wait, aria-busy on a dialog
// that submits — and by text where it has none ("Loading…", "Starting backend…"). A kind is "loading" while one
// of its indicators is visible. It has ended when it is gone in the same document, page and dialog. Leaving that
// context also releases the obligation (a spinner that vanishes because someone navigated away is not an end,
// but it is not a failure either); the trace keeps the context, so those episodes can be counted afterwards.
export const DEADLINES: Record<string, number> = { start: 60, calc: 120, load: 30, busy: 120 };

export function loadingKinds(doc: Document): string[] {
  const kinds: string[] = [];
  if (!doc.body) return kinds;
  const shown = (e: Element): boolean => e.getClientRects().length > 0;
  const add = (k: string): void => {
    if (!kinds.includes(k)) kinds.push(k);
  };
  if (Array.from(doc.querySelectorAll(".spinner")).some(shown)) add("calc");
  if (Array.from(doc.querySelectorAll(".dots, .busy-clock, [aria-busy='true']")).some(shown)) add("busy");
  const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.nodeValue ?? "").trim();
    if (!text.endsWith("…") || text.length > 160) continue;
    const kind = /^Starting backend…$/.test(text) ? "start" : /^Loading\b/.test(text) ? "load" : null;
    if (kind && n.parentElement && shown(n.parentElement)) add(kind);
  }
  return kinds;
}

export const loading = extract((state) => loadingKinds(state.document));

const context = extract((state) => {
  const d = state.document;
  const page = d.querySelector('nav[aria-label="Pages"] [aria-current="page"]')?.textContent ?? "";
  const dialogs = d.querySelectorAll('[role="dialog"]');
  const top = dialogs[dialogs.length - 1];
  return `${Math.round(state.window.performance.timeOrigin)}|${page}|${top?.getAttribute("aria-label") ?? (top ? "?" : "")}`;
});

export function loadingEnds(kind: string): Formula {
  return always(() => {
    const here = context.current;
    return now(() => loading.current.includes(kind)).implies(
      eventually(() => !loading.current.includes(kind) || context.current !== here).within(
        DEADLINES[kind]!,
        "seconds",
      ),
    );
  });
}

/** While something loads, mostly wait for it: up to 4 s per action (Bombadil gives a command 5 s). */
const waitLoading = registerCustomAction("waitLoading", async (document) => {
  const deadline = Date.now() + 4000;
  while (loadingKinds(document).length > 0 && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 100));
});
export const whileLoading = actions((): ActionTemplate[] =>
  loading.current.length > 0 ? [waitLoading()] : [],
);

// --- Server errors the window shows ------------------------------------------------------------------
// An error the backend did not expect reaches the window as a red banner whose text carries the backend's
// hint "Unexpected server error"; the console stays clean, so no default property sees it. The backend log
// has the traceback (control-prism explore reads it after the run).
const SERVER_ERROR = "Unexpected server error";
export const serverErrorBanner = extract((state): string | null => {
  const doc = state.document;
  if (!doc.body) return null;
  const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue ?? "";
    const el = n.parentElement;
    if (text.includes(SERVER_ERROR) && el && el.getClientRects().length > 0)
      return cut((el.textContent ?? text).trim(), 200);
  }
  return null;
});
export const noServerError: Formula = always(() => serverErrorBanner.current === null);

// --- Rest (idle) -------------------------------------------------------------------------------------
// The E2E check (e2e/idle.ts) in Bombadil's terms: windows of 1 s without input, after loading has
// visibly ended, up to 15 windows; at rest on the first window with at most 3 React commits. Commits come
// from the stand-in for React's DevTools hook that control-prism's launch() puts into every document.
// Script time is recorded per state (resources.script_duration) but not judged: Bombadil's own capture
// between two windows (extractors, screenshot, coverage) runs script in the same renderer.
// Bombadil waits at most 5 s for a custom action, so each window is an action of its own, and while an
// observation is open the only action offered is its next window.
const MAX_COMMITS = 3;
const MAX_WINDOWS = 15;

export async function measureWindow(window: AnyWindow): Promise<void> {
  const r = window.__exploreRest;
  const c = window.__prismE2eReactCommits;
  if (!r || r.verdict) return;
  if (!c || !c.renderers) {
    r.verdict = "no-counter";
    return;
  }
  const before = c.commits;
  const t0 = window.performance.now();
  await new Promise((res) => setTimeout(res, 1000));
  const commits = c.commits - before;
  r.windows.push({ commits, ms: Math.round(window.performance.now() - t0) });
  if (commits <= MAX_COMMITS) r.verdict = "rest";
  else if (r.windows.length >= MAX_WINDOWS) r.verdict = "busy";
}

/** Opens an observation (labelled with the page, or a step of a scripted flow) and measures its first window. */
export async function beginObservation(document: Document, window: AnyWindow, label?: string): Promise<void> {
  window.__exploreRest = {
    id: (window.__exploreRest?.id ?? 0) + 1,
    page:
      label ??
      document
        .querySelector('nav[aria-label="Pages"] [aria-current="page"]')
        ?.textContent?.replace(/›/g, "")
        .trim() ??
      null,
    windows: [],
    verdict: null,
  };
  await measureWindow(window);
}

const observeRest = registerCustomAction("observeRest", async (document, window) => {
  await beginObservation(document, window as AnyWindow);
});
const observeRestMore = registerCustomAction("observeRestMore", async (_document, window) => {
  await measureWindow(window as AnyWindow);
});

export const rest = extract((state) => {
  const r = (state.window as AnyWindow).__exploreRest;
  if (!r) return null;
  return {
    id: r.id as number,
    page: r.page as string | null,
    verdict: r.verdict as string | null,
    windows: (r.windows as { commits: number; ms: number }[]).length,
    last: (r.windows as { commits: number; ms: number }[]).slice(-3),
  };
});

/** True while an observation is open: then nothing but its next window may happen. */
export const observing = (): boolean => rest.current !== null && rest.current.verdict === null;

export const continueObservation = actions((): ActionTemplate[] =>
  observing() ? [observeRestMore()] : [],
);
/** Start an observation, offered only when nothing visibly loads. */
export const startObservation = actions((): ActionTemplate[] =>
  !observing() && loading.current.length === 0 ? [observeRest()] : [],
);

export const atRest: Formula = always(() => rest.current?.verdict !== "busy");
/** The commit counter must be there: without it an observation measures nothing and would pass. */
export const restMeasured: Formula = always(() => rest.current?.verdict !== "no-counter");

// --- Clicks on the topmost element -------------------------------------------------------------------
// Bombadil's default clicks check style visibility only, so behind an app modal they hit the backdrop.
// These offer a point only where the target is the topmost element. Canvas boxes and links are divs with
// handlers, so they are added by class. Points are whole pixels.
const CLICKABLE =
  "a,button:not(:disabled),input:not(:disabled):not([type=file]),textarea:not(:disabled),label[for]," +
  "[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem]," +
  "[role=option],[role=treeitem],[role=combobox]:not(select),summary,.react-flow__node,.react-flow__edge";

export const topmostClickables = extract((state) => {
  const doc = state.document;
  if (!doc.body) return [];
  const out: { fingerprint: ReturnType<typeof getFingerprint>; point: { x: number; y: number } }[] =
    [];
  const seen = new Set<Element>();
  for (const e of Array.from(doc.querySelectorAll(CLICKABLE))) {
    if (seen.has(e)) continue;
    seen.add(e);
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    if (x < 0 || y < 0 || x >= state.window.innerWidth || y >= state.window.innerHeight) continue;
    const top = doc.elementFromPoint(x, y);
    if (!top || !(top === e || e.contains(top))) continue;
    out.push({ fingerprint: getFingerprint(e), point: { x, y } });
  }
  return out;
});

// The block list does not guard the outside (the instance is sealed). It keeps the run out of what would
// eat it: deleting the only workspace lands on the setup sheet, whose import needs a native dialog, and the
// ten-card welcome tour took half the states of a 3-minute trial (Next and Back are its targets).
const BLOCKED = /^(Delete workspace|Run the first-start tour again|Take the tour again|New workspace)$/;
function blocked(fp: { accessibleName: string | null; textContent: string | null }): boolean {
  return BLOCKED.test((fp.accessibleName ?? "").trim()) || BLOCKED.test((fp.textContent ?? "").trim());
}
// "New workspace" leads to the setup sheet of an empty workspace. There it is one of the few targets, so a
// 15-minute run clicked it 150 times and spent 62 % of its states there. It stays reachable, rarely.
const NEW_WORKSPACE = /^New workspace$/;
export const newWorkspace = actions(() =>
  topmostClickables.current
    .filter((t) => NEW_WORKSPACE.test((t.fingerprint.accessibleName ?? "").trim()))
    .map((t) => ({ Click: t }) as ActionTemplate),
);
export const safeClicks = actions(() =>
  topmostClickables.current
    .filter((t) => !blocked(t.fingerprint))
    .map((t) => ({ Click: t }) as ActionTemplate),
);

// --- <select> ----------------------------------------------------------------------------------------
// Not a default target. An option is chosen through the value setter and a change event, as React's
// controlled selects need it; the trace marks these as the custom action "chooseOption".
// Only a select a person could reach: the topmost element at its centre. Without this check a run switched the
// workspace in the sidebar while a dialog lay over it, and reached states no person can.
const reachable = (s: HTMLSelectElement): boolean => {
  const r = s.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const top = s.ownerDocument.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
  return top !== null && (top === s || s.contains(top));
};
const selectShape = extract((state) =>
  Array.from(state.document.querySelectorAll("select"))
    .filter((s) => !s.disabled && reachable(s))
    .map((s) => ({
      chosen: s.selectedIndex,
      // only what a person can pick: not a disabled option, nor one in a disabled group
      choosable: Array.from(s.options)
        .map((o, i) => (o.disabled || o.hidden || (o.parentElement as HTMLOptGroupElement | null)?.disabled ? -1 : i))
        .filter((i) => i >= 0),
    })),
);
const chooseOption = registerCustomAction(
  "chooseOption",
  async (document, window, index: number, option: number) => {
    const selects = Array.from(document.querySelectorAll("select")).filter(
      (s) => !s.disabled && reachable(s),
    );
    const s = selects[index];
    if (!s || !s.options[option] || s.options[option]!.disabled) throw new Error("select or option gone");
    const setter = Object.getOwnPropertyDescriptor(
      (window as AnyWindow).HTMLSelectElement.prototype,
      "value",
    )!.set!;
    setter.call(s, s.options[option]!.value);
    s.dispatchEvent(new (window as AnyWindow).Event("change", { bubbles: true }));
  },
);
/** The first 12 choosable options of each reachable select; longer lists are offered only in part. */
export const selects = actions(() => {
  const out: ActionTemplate[] = [];
  selectShape.current.forEach((s, i) => {
    for (const o of s.choosable.slice(0, 12)) if (o !== s.chosen) out.push(chooseOption(i, o));
  });
  return out;
});

// --- Scrolling panels --------------------------------------------------------------------------------
// Bombadil scrolls the document only; lists and tables here scroll inside panels. A wheel at the centre
// of a scrollable panel (where it is the topmost thing) scrolls that panel.
const panels = extract((state) => {
  const doc = state.document;
  const out: { x: number; y: number; down: number; up: number }[] = [];
  for (const e of Array.from(
    doc.querySelectorAll<HTMLElement>("div,section,main,aside,ul,ol,table,tbody,nav,form"),
  )) {
    if (e.scrollHeight <= e.clientHeight + 8 || e.clientHeight < 40) continue;
    const oy = state.window.getComputedStyle(e).overflowY;
    if (oy !== "auto" && oy !== "scroll") continue;
    const r = e.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + Math.min(r.height / 2, 200));
    if (x < 0 || y < 0 || x >= state.window.innerWidth || y >= state.window.innerHeight) continue;
    const top = doc.elementFromPoint(x, y);
    if (!top || !e.contains(top)) continue;
    out.push({
      x,
      y,
      down: Math.floor(e.scrollHeight - e.clientHeight - e.scrollTop),
      up: Math.floor(e.scrollTop),
    });
    if (out.length >= 8) break;
  }
  return out;
});
export const scrollPanels = actions(() => {
  const out: ActionTemplate[] = [];
  for (const p of panels.current) {
    if (p.down >= 1)
      out.push({ ScrollDown: { origin: { x: p.x, y: p.y }, distance: Math.min(400, p.down) } });
    if (p.up >= 1) out.push({ ScrollUp: { origin: { x: p.x, y: p.y }, distance: Math.min(400, p.up) } });
  }
  return out;
});

// --- Escape in a dialog ------------------------------------------------------------------------------
// The default typing presses Escape only in a focused text field; a dialog whose focus sits on a button
// would otherwise be left only by its own buttons.
export const escapeDialog = actions((): ActionTemplate[] =>
  where.current.dialog ? [{ PressKey: { code: 27 } }] : [],
);

// Popovers (tags, colours, menus) close on Escape or a click outside, on a transparent layer that is no
// control. Without these two the run stays inside the first popover it opens.
export const escapeAnywhere = actions((): ActionTemplate[] => [{ PressKey: { code: 27 } }]);
const viewport = extract((state) => ({
  w: state.window.innerWidth,
  h: state.window.innerHeight,
  body: state.document.body ? getFingerprint(state.document.body) : null,
}));
export const clickAnywhere = actions((): ActionTemplate[] =>
  viewport.current.body
    ? [
        {
          Click: {
            fingerprint: viewport.current.body,
            point: { x: [0, viewport.current.w - 1], y: [0, viewport.current.h - 1] },
          },
        },
      ]
    : [],
);

/** Always possible, so a screen without controls never ends the run. */
export const waitAlways = actions((): ActionTemplate[] => ["Wait"]);
