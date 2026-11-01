import { useEffect, useState } from 'react'

const read = (): string => document.documentElement.getAttribute('data-theme') ?? 'light'

/**
 * The app's light/dark theme as a value a chart can put in its dependency list.
 *
 * ECharts takes its colours once, when the option is built, so a chart has to be rebuilt when the theme
 * flips. Reading the `data-theme` attribute during render looked like enough and was one switch late: the
 * Workbench sets the attribute in an effect AFTER the render the toggle caused, so that render still saw the
 * old theme, nothing rebuilt, and a chart switched back to light kept the dark theme's pale text on white.
 * Watching the attribute itself re-renders once the new theme is really in place.
 */
export function useThemeKey(): string {
  const [key, setKey] = useState(read)
  useEffect(() => {
    const obs = new MutationObserver(() => setKey(read()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    setKey(read())
    return () => obs.disconnect()
  }, [])
  return key
}
