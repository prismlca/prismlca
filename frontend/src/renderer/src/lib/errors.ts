/** The message of whatever was thrown. `e instanceof Error ? e.message : String(e)` had been typed
 *  out 75 times across 24 files — one helper, so a future change (say, unwrapping an ApiError's
 *  hint) has one place to land. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
