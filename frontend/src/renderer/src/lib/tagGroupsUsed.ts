/**
 * The tag groups with the ones the open model uses first — how the Tags window and a box's tag menu list
 * them, so the groups this model is sorted by are at hand and the workspace's other groups come below.
 * Within each half the order stays the workspace's own. `databases` comes from the server: the models whose
 * processes or inputs carry a tag of the group.
 */
export function usedFirst<G extends { databases?: string[] }>(
  groups: G[],
  database: string | null
): (G & { used: boolean })[] {
  const marked = groups.map((g) => ({ ...g, used: !!database && !!g.databases?.includes(database) }))
  return [...marked.filter((g) => g.used), ...marked.filter((g) => !g.used)]
}
