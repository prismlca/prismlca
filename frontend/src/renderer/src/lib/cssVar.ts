/** A design token's current value, with a fallback for contexts where no stylesheet is loaded
 *  (tests, detached canvases). Charts and canvas renderers read theme colours through this instead
 *  of hard-coding hex — the token file is the single source (see design/prism-theme.css).
 */
export function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}
