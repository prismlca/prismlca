/**
 * The question a delete asks when the process still supplies others. The backend refuses with a
 * message for the assistant (consumer codes, `force=true`) and the same consumers as data
 * (`details.consumers`: database, code, name); the dialog is worded from the data, so a person reads
 * names — including the consumers in other models, which the canvas does not show but the cascade reaches.
 */

interface Consumer {
  database: string
  code: string
  name: string
}

/** The consumers a `delete_blocked` refusal lists, or none when it lists nothing readable. */
export function blockedConsumers(details: Record<string, unknown> | undefined): Consumer[] {
  const list = details?.consumers
  if (!Array.isArray(list)) return []
  return list.filter(
    (c): c is Consumer =>
      !!c && typeof c.database === 'string' && typeof c.code === 'string' && typeof c.name === 'string'
  )
}

/** "“A”", "“A” and “B”", "“A”, “B” and “C”", then "“A”, “B” and 3 more" — a long list would bury the question. */
function nameList(names: string[]): string {
  if (names.length > 3) return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]
}

/** The confirm text for deleting `label` from `model` while `consumers` still draw on it. Consumers of
 *  this model come first; one elsewhere is named with its model. With none listed, it still says what
 *  happens, just without naming who. */
export function inUseMessage(label: string, model: string, consumers: Consumer[]): string {
  const own = consumers.filter((c) => c.database === model)
  const elsewhere = consumers.filter((c) => c.database !== model)
  const names = [
    ...own.map((c) => `“${c.name}”`),
    ...elsewhere.map((c) => `“${c.name}” in the model “${c.database}”`)
  ]
  const one = names.length === 1
  const who = names.length ? nameList(names) : 'other processes'
  return (
    `“${label}” is still an input of ${who}. Deleting it removes ${one ? 'that input' : 'those inputs'} too. ` +
    `Delete anyway? Undo brings ${one ? 'it' : 'them'} back.`
  )
}
