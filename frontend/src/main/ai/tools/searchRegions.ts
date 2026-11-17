/**
 * The places a background search knows without being told: the regions the open model's study names, and
 * the regions a query names in its text. Both are read with `regionsInText` against the regions the searched
 * databases actually hold, so a place no dataset carries is never sent and never named in a hint.
 *
 * The study's regions decide which variant shows a collapsed hit when the query names no region
 * (`prefer_geographies`, backend search/collapse.py): a study sold in Germany sees the German electricity
 * market rather than whichever of 175 regions scored best. They never filter and never reorder the list.
 */
import type { GeoNames } from '../../../shared/geographyNames'
import { regionsInText } from '../../../shared/regionsInText'
import type { ToolCtx } from './context'

export interface SearchRegions {
  /** The regions `text` names, among those `databases` hold — in the order the text names them. */
  inText(text: string, databases: string[]): Promise<string[]>
  /** The same for the open model's study geography; empty without a model or without a geography. */
  ofStudy(databases: string[]): Promise<string[]>
}

/** One per tool call: every lookup is made once, however many queries the call carries. */
export function searchRegions(ctx: ToolCtx): SearchRegions {
  const held = new Map<string, Promise<string[]>>()
  let names: Promise<GeoNames> | undefined
  let study: Promise<string> | undefined

  // A database without an index answers 409; it then holds no region for this purpose.
  const codesOf = (databases: string[]): Promise<string[]> => {
    const key = [...databases].sort().join('\n')
    let codes = held.get(key)
    if (!codes) {
      codes = Promise.all(
        databases.map((db) =>
          (ctx.api('GET', `/api/v1/search/geographies/${encodeURIComponent(db)}`) as Promise<unknown>).catch(
            () => []
          )
        )
      ).then((lists) => [...new Set(lists.flatMap((l) => (Array.isArray(l) ? l.map(String) : [])))])
      held.set(key, codes)
    }
    return codes
  }
  const namesOf = (): Promise<GeoNames> =>
    (names ??= (ctx.api('GET', '/api/v1/search/geography-names') as Promise<{ names?: GeoNames }>)
      .then((r) => r?.names ?? {})
      .catch(() => ({})))

  const inText = async (text: string, databases: string[]): Promise<string[]> => {
    if (!text.trim() || !databases.length) return []
    const [codes, known] = await Promise.all([codesOf(databases), namesOf()])
    return regionsInText(text, codes, known)
  }
  return {
    inText,
    async ofStudy(databases) {
      const db = ctx.activeDb
      if (!db || !databases.length) return []
      study ??= (ctx.api('GET', `/api/v1/study?database=${encodeURIComponent(db)}`) as Promise<unknown>)
        .then((meta) => {
          const geography = (meta as { geography?: unknown } | null)?.geography
          return typeof geography === 'string' ? geography : ''
        })
        .catch(() => '')
      return inText(await study, databases)
    }
  }
}
