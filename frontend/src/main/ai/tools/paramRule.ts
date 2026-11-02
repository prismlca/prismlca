/**
 * The rule the assistant may give a parameter it creates: its schema and the form the backend stores.
 *
 * The four kinds the assistant is offered are not the four the backend stores: a list rule is offered only as
 * "switch", and becomes the list 0, 1. Which other discrete values a study admits is the modeller's choice,
 * so the schema does not carry a list of values at all; the backend refuses any other list, and any rule on
 * a parameter that already exists, for the chat and the MCP server alike (param_rules.check_assistant_rule).
 */
import { num } from './schema'

export const RULE_SCHEMA = {
  type: 'object',
  description:
    'Only when you CREATE this parameter, and only when its meaning fixes what it may be: kind="range" with ' +
    'min 0 and max 1 for a share, rate, efficiency or loss; kind="positive" for a mass, distance, count or ' +
    'duration; kind="switch" for an on/off choice (0 or 1); kind="negative" for a credit kept as a negative ' +
    'number. Omit it for a parameter that already exists, and when you are unsure.',
  properties: {
    kind: { type: 'string', enum: ['positive', 'negative', 'range', 'switch'] },
    min: num('kind="range": the lowest allowed value; omit for no lower bound.'),
    max: num('kind="range": the highest allowed value; omit for no upper bound.')
  },
  required: ['kind']
} as const

/** The rule as the parameter endpoints take it, or undefined when none was given. A rule sent as a JSON
 * string (some models stringify nested objects) is read rather than dropped. */
export function ruleFor(raw: unknown): Record<string, unknown> | undefined {
  let rule = raw
  if (typeof rule === 'string') {
    try {
      rule = JSON.parse(rule)
    } catch {
      return { kind: rule } // the backend names what it does not know
    }
  }
  if (!rule || typeof rule !== 'object') return undefined
  const r = rule as Record<string, unknown>
  if (r.kind === 'switch') return { kind: 'list', values: [0, 1] }
  return r
}
