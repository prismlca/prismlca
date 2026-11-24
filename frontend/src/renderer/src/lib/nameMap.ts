/**
 * A lookup keyed by a name a person chose, a model's above all.
 *
 * A plain `{}` answers for names it was never given: `of['constructor']` is Object's constructor,
 * truthy, so a model called "constructor" or "toString" matched no folder and was not "in none"
 * either, and vanished from the model list. This map has no prototype: a name finds its own entry or
 * nothing, and "__proto__" is a key like any other.
 */
export function nameMap<T>(entries: Iterable<readonly [string, T]> = []): Record<string, T> {
  const map = Object.create(null) as Record<string, T>
  for (const [name, value] of entries) map[name] = value
  return map
}
