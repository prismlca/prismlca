/**
 * A chat's title, kept by the chat IPC instead of the chat panel.
 *
 * `set_chat_title` reaches main as a UI call (the tool's `ctx.ui`). The title belongs to the chat
 * store, which main reaches without a window, so the run's UI calls go through {@link withChatTitle}:
 * this one is answered here — stored, then announced to the renderer as a `title` event — and every
 * other call goes on to the window. Left to the panel, a run going on while the user was on another
 * page waited out the UI timeout and its chat stayed untitled, because the panel exists only on the
 * Model page.
 */
import { aiLog } from '../ai/aiLog'
import type { UiCallOpts } from './uiBridge'

/** The longest title the chat list shows; a longer one is cut, as the panel used to. */
export const CHAT_TITLE_MAX = 80

/**
 * How long storing the title may take before the run goes on without it. A backend request waits
 * minutes for its answer; the window's round-trip gave up after 30 s and on Stop, and a label is not
 * worth holding a run for longer than that.
 */
export const CHAT_TITLE_TIMEOUT_MS = 10_000

type UiCall = (name: string, args: Record<string, unknown>, opts?: UiCallOpts) => Promise<any>
type Answer = { status: number; body: unknown }
type Request = (method: string, path: string, body?: unknown) => Promise<Answer>

/**
 * The run's UI round-trip, with `set_chat_title` answered in main. `chatPath` is read at call time,
 * so a title set after a tool renamed the chat's model lands under the new name. The answer is
 * `{ ok: true }` either way: the title is only the chat's label, nothing the model could act on. Stop
 * ends the wait at once, as it did for the window's round-trip.
 */
export function withChatTitle(
  callUiTool: UiCall,
  deps: {
    chatPath: () => string | null
    request: Request
    announce: (title: string) => void
    timeoutMs?: number
  }
): UiCall {
  return async (name, args, opts) => {
    if (name !== 'set_chat_title') return callUiTool(name, args, opts)
    if (opts?.signal?.aborted) throw new Error('Canceled.')
    const title = String(args.title ?? '')
      .trim()
      .slice(0, CHAT_TITLE_MAX)
    const base = deps.chatPath()
    if (title && base) {
      const ms = deps.timeoutMs ?? CHAT_TITLE_TIMEOUT_MS
      const deadline = AbortSignal.timeout(ms)
      const stop = opts?.signal ? AbortSignal.any([opts.signal, deadline]) : deadline
      const r = await until(deps.request('POST', `${base}/rename`, { title }), stop)
      if (!r && opts?.signal?.aborted) throw new Error('Canceled.')
      // Stored is stored: a Stop that came after the answer does not hide the title from the list.
      if (r && r.status > 0 && r.status < 400) deps.announce(title)
      else
        aiLog(r ? `chat title not saved (HTTP ${r.status})` : `chat title not saved (no answer in ${ms} ms)`)
    }
    return { ok: true }
  }
}

/**
 * The answer, or null once `stop` fires first. The request itself runs on, since a backend request
 * cannot be called back; arriving late, it stores the title the model chose and nothing else.
 */
function until(work: Promise<Answer>, stop: AbortSignal): Promise<Answer | null> {
  if (stop.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    const onStop = (): void => resolve(null)
    stop.addEventListener('abort', onStop, { once: true })
    const settle = (r: Answer): void => {
      stop.removeEventListener('abort', onStop)
      resolve(r)
    }
    work.then(settle, (e: unknown) => settle({ status: 0, body: String(e) }))
  })
}
