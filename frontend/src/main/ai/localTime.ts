/**
 * The machine's local calendar day and clock, written the way the model and the log read them.
 *
 * Local, not UTC: "today" for the user is the day on their wall calendar, and a log read beside the
 * user's notes has to show the same hour. Electron-free, so the chat, the MCP server and the tests
 * share it.
 */

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** `YYYY-MM-DD` of the local calendar day. */
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `YYYY-MM-DD HH:MM:SS.mmm` in local time — the stamp in front of a log line. */
export function localTimestamp(d: Date = new Date()): string {
  return (
    `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}`
  )
}
