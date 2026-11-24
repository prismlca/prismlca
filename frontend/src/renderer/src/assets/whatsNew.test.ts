/**
 * The What's-new list on the Overview: readers scan it newest first, to find what changed and where.
 *
 * This holds the mechanical part of CLAUDE.md, "Keep What's-new current": every entry is exactly
 * `{date, title, details}`, the date is a real day, the list runs newest first, and `details` stays short.
 * Whether an entry is a feature rather than a fix, and whether it tells readers what they need, is still a
 * judgement for review.
 */
import { describe, expect, it } from 'vitest'

import entries from './whats-new.json'

/** The hard limit for `details`. The aim is two to three sentences, about 300–450 characters; past this, an
 *  entry explains its reasons instead of pointing readers to the feature. */
const MAX_DETAILS = 500
const RULE = `CLAUDE.md, "Keep What's-new current"`
const FIELDS = ['date', 'details', 'title']

type Entry = Record<string, unknown>
const list = entries as Entry[]

const label = (e: Entry): string => `"${String(e.title)}" (${String(e.date)})`

/** A calendar day written YYYY-MM-DD: 2026-02-30 has the form but is no day. */
function isDay(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const day = new Date(Date.UTC(y, m - 1, d))
  return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d
}

describe("What's-new entries", () => {
  it('reads the real list — an empty one would pass everything below', () => {
    expect(list.length).toBeGreaterThan(100)
  })

  it('has exactly date, title and details in every entry, each as non-empty text', () => {
    const wrong = list
      .map((e, i) => {
        const keys = Object.keys(e).sort()
        const empty = FIELDS.filter((k) => typeof e[k] !== 'string' || !(e[k] as string).trim())
        if (keys.join() === FIELDS.join() && !empty.length) return ''
        return `entry ${i + 1}, ${label(e)}: has ${keys.join(', ') || 'no fields'}${empty.length ? `; empty or not text: ${empty.join(', ')}` : ''}`
      })
      .filter(Boolean)
    expect(
      wrong,
      `Every entry is {"date", "title", "details"} with non-empty text, nothing else (${RULE})`
    ).toEqual([])
  })

  it('dates every entry as a real day, YYYY-MM-DD', () => {
    const wrong = list.filter((e) => !isDay(e.date)).map(label)
    expect(wrong, 'Write the date as YYYY-MM-DD, the day the feature ships').toEqual([])
  })

  it('lists the newest entry first', () => {
    const wrong: string[] = []
    for (let i = 1; i < list.length; i++) {
      const [above, below] = [list[i - 1], list[i]]
      if (String(below.date) > String(above.date)) wrong.push(`${label(below)} stands below ${label(above)}`)
    }
    expect(
      wrong,
      `The list runs newest first. A new entry goes at the top, dated the day it ships; an older entry ` +
        `keeps its date and moves down to where that date belongs (${RULE})`
    ).toEqual([])
  })

  it(`keeps details within ${MAX_DETAILS} characters`, () => {
    const long = list
      .filter((e) => String(e.details).length > MAX_DETAILS)
      .map((e) => `${label(e)}: ${String(e.details).length} characters`)
    expect(
      long,
      `Shorten these details to two or three sentences, about 300–450 characters: what the feature does ` +
        `and where readers find it. The reasons behind it belong in the commit message, not in a second ` +
        `entry (${RULE})`
    ).toEqual([])
  })
})
