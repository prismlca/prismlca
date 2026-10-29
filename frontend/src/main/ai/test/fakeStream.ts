/**
 * The scripted chat stream the offline agent/writer/sub-agent tests share.
 *
 * Three test files (loop, writer, subagent-brief) used to carry their own hand-rolled
 * `vi.mock` generator — thirty to sixty lines apiece, each a slightly different
 * dialect of the same idea, plus a re-declared fake error class. That not only copied the
 * machinery, it coupled the whole suite to the façade path: any move of `streamChat` out of
 * `./openrouter` breaks every file at once. The machinery lives here now; a test file mocks the
 * './client' module with `clientModuleMock()` and drives the shared `chat` instance (rounds,
 * fallback, recorded calls) itself.
 *
 * The dialect differences the three files relied on are options, not forks:
 * - `alwaysDelta` (writer): a scripted round without text still emits an empty delta, and a run
 *   past the end of the script answers with `fallbackText`.
 * - `defaultUsage` (writer): every round bills, whether the script says so or not.
 * - `gateCallsOnTools` (writer): tool calls are only emitted when tools were offered — honouring
 *   that here is what makes the writer's "withdraw the tools when the budget is spent" guarantee
 *   testable at all.
 * - `toolless` (loop): the history summariser calls without tools and is answered out of band,
 *   without consuming a scripted round and without being recorded in `seen`.
 */
import { AiProviderError } from '../providers/types'
import type { ChatMessage, StreamChatOpts, StreamEvent } from '../providers/types'

type Usage = Extract<StreamEvent, { type: 'usage' }>['usage']

/** The real AiProviderError under the tests' historical name. It EXTENDS the real class on
 *  purpose: production code checks `e instanceof AiProviderError` against providers/types, which is
 *  NOT the module the tests replace (only './client' is mocked) — a fake that merely mimicked the
 *  shape would fail every instanceof guard. */
export class FakeOpenRouterError extends AiProviderError {}

/** One scripted round: text the model streams, chain-of-thought chunk lengths, tool calls it asks
 *  for, its reported usage — or a throw instead of streaming (context-overflow tests). */
export interface ScriptedRound {
  text?: string
  reasoning?: number[]
  calls?: Array<{ id: string; name: string; arguments: string }>
  usage?: Usage
  throws?: unknown
  /** The provider's finish reason for the round ("length" = cut off at the output limit). */
  finish?: string
}

/** What the code under test actually sent — snapshot per streamChat call, messages deep-copied so
 *  later mutation by the loop cannot rewrite what a test already saw. */
export interface RecordedCall {
  model?: string
  messages: ChatMessage[]
  tools?: unknown[]
  reasoningEffort?: string
  maxTokens?: number
  /** Kept by reference, not copied: a test asks whether the caller's own signal arrived. */
  signal?: AbortSignal
}

class ScriptedChat {
  rounds: ScriptedRound[] = []
  seen: RecordedCall[] = []
  /** Served when `rounds` runs dry and `alwaysDelta` is on (the writer's standing reply). */
  fallbackText = ''
  /** Billed on every round that does not bring its own usage. */
  defaultUsage: Usage | undefined
  /** The finish reason of a round that states none. The writer needs one: an answer
   *  without a finish event is an incomplete answer, so its tests set this to 'stop' and switch it off
   *  for the one test that is about the missing signal. */
  defaultFinish: string | undefined
  /** Emit an empty delta for a scripted round without text (the writer dialect). */
  alwaysDelta = false
  /** Only emit tool calls when the request offered tools (the writer's withdrawal guarantee). */
  gateCallsOnTools = false
  /** Answer a call that offered no tools (the history summariser) out of band: the round returned
   *  here is played without consuming `rounds` and without being recorded in `seen`. Return
   *  undefined to treat the call like any other. */
  toolless: ((opts: StreamChatOpts) => ScriptedRound | undefined) | undefined
  toollessSeen = 0

  /** Assigned in the constructor as an arrow (a prototype method would lose `this` when handed to
   *  `vi.mock` as a bare function); the generator body lives in `run`, since arrows cannot be
   *  generators themselves. */
  streamChat: (opts: StreamChatOpts) => AsyncGenerator<StreamEvent>

  private async *play(round: ScriptedRound, opts: StreamChatOpts): AsyncGenerator<StreamEvent> {
    if (round.throws) throw round.throws
    for (const chars of round.reasoning ?? []) yield { type: 'reasoning', chars }
    const text = round.text ?? (this.alwaysDelta ? '' : undefined)
    if (text !== undefined) yield { type: 'delta', text }
    const usage = round.usage ?? this.defaultUsage
    if (usage) yield { type: 'usage', usage }
    const finish = round.finish ?? this.defaultFinish
    if (finish) yield { type: 'finish', reason: finish }
    if (round.calls?.length && (!this.gateCallsOnTools || opts.tools?.length))
      yield { type: 'tool_calls', calls: round.calls }
  }

  constructor() {
    this.streamChat = (opts: StreamChatOpts) => this.run(opts)
  }

  private async *run(opts: StreamChatOpts): AsyncGenerator<StreamEvent> {
    if (!opts.tools?.length && this.toolless) {
      const round = this.toolless(opts)
      if (round) {
        this.toollessSeen++
        yield* this.play(round, opts)
        return
      }
    }
    this.seen.push({
      model: opts.model,
      messages: JSON.parse(JSON.stringify(opts.messages)),
      tools: opts.tools,
      reasoningEffort: opts.reasoningEffort,
      maxTokens: opts.maxTokens,
      signal: opts.signal
    })
    const round = this.rounds.shift() ?? (this.alwaysDelta ? { text: this.fallbackText } : {})
    yield* this.play(round, opts)
  }
}

/** The one instance a test file and its `vi.mock` factory share (module cache is per test file, so
 *  files never see each other's script). */
export const chat = new ScriptedChat()

/** The module shape to hand to `vi.mock('./client', …)` — use an async factory:
 *  `vi.mock('./client', async () => (await import('./test/fakeStream')).clientModuleMock())`
 *  Only `streamChat` is faked: everything else the production graph pulls from './client' lives in
 *  modules the tests leave real (providers/state, providers/types). */
export const clientModuleMock = (): {
  streamChat: ScriptedChat['streamChat']
} => ({
  streamChat: chat.streamChat
})
