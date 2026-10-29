/**
 * Main's share of "is PrismLCA working?" for the keep-awake rule (main/keepAwake.ts): the runs that
 * live in this process — assistant chats with their research legs, report-writer calls, the
 * assistant's import matching. The backend reports its own jobs.
 *
 * A chat whose run waits on the user (an ask_user or an approval card) does not count: a person who
 * has walked away is no reason to keep the computer up, and the card times out on its own. Other
 * chats, the writer and the backend's jobs still do.
 */
export function activeWork(
  /** Keys of the run registry: a chat id, `<chatId>:<lane>` for its legs, `report:ai:<id>` for the writer. */
  runKeys: Iterable<string>,
  /** Chats with a question open (PendingAsks); external sessions carry an empty id. */
  waitingChats: Iterable<string>,
  importMatching: boolean
): string[] {
  const waiting = [...waitingChats].filter(Boolean)
  const working = [...runKeys].filter((k) => !waiting.some((c) => k === c || k.startsWith(`${c}:`)))
  const work: string[] = []
  if (working.some((k) => !k.startsWith('report:'))) work.push('an assistant run')
  if (working.some((k) => k.startsWith('report:'))) work.push('the report writer')
  if (importMatching) work.push('the assistant matching an import')
  return work
}
