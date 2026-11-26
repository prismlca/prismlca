// The properties the exploring spec ships — defined once, here. explore.ts exports all of them, and each positive
// control (controls/*.ts) re-exports the ones it turns red, so a control tests exactly what explore runs.
import { atRest, loadingEnds, noServerError, restMeasured } from "./lib.ts";

// Not noHttpErrorCodes: it reads only the status of the page's own navigation, a file:// URL here, and never
// fires. The backend's answers reach the window as banners (noServerErrorBanner) and its log (read after the run).
export {
  noConsoleErrors,
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
} from "@antithesishq/bombadil/browser/defaults/properties";

export const restAfterInput = atRest;
export const restWasMeasured = restMeasured;
export const startEnds = loadingEnds("start");
export const calculationEnds = loadingEnds("calc");
export const loadEnds = loadingEnds("load");
export const busyEnds = loadingEnds("busy");
export const noServerErrorBanner = noServerError;
