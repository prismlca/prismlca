/**
 * Where a chapter writer's lookups run: the read-only tool context, and the model fence in front of it.
 *
 * The writer works on the report's model. Its lookups may read that model, the models it is compared
 * with (`compared_with` in its study record, linked by the user), the library and the background and
 * biosphere databases — the chat's read fence (modelScope.ts), applied before each lookup runs.
 *
 * Electron-free, like the tools package.
 */
import { kindMap, kindsPerCall, namedDatabases, scopeRefusal, type ModelScope } from '../modelScope'
import type { Tool, ToolCtx } from '../tools'

export interface WriterLookupOpts {
  api: ToolCtx['api']
  /** The report's model. */
  activeDb: string | null
  /** Whether this chapter may search the literature (writer/lookups.ts). */
  literature: boolean
  researchWeb?: ToolCtx['researchWeb']
  maxResearchQuestions?: number
}

export interface WriterLookups {
  /** Run one lookup the chapter's allow-list let through: the fence first, then the tool. */
  run: (tool: Tool, rawArgs: string) => Promise<unknown>
}

/** What the writer is told when a lookup names a database outside the report's models. */
export function outsideReport(own: string | null, scope: ModelScope): string {
  const compared = scope.readable.length
    ? `, the models it is compared with (${scope.readable.map((n) => `"${n}"`).join(', ')})`
    : ''
  return (
    `This lookup did not run: while writing this chapter, lookups read only the report's model` +
    `${own ? ` "${own}"` : ''}${compared}, the library and the background databases, each named exactly ` +
    `as the brief and earlier lookups name it. Write the chapter from what you have.`
  )
}

export function writerLookups(opts: WriterLookupOpts): WriterLookups {
  const own = opts.activeDb
  const ctx: ToolCtx = {
    api: opts.api,
    // The writer's tools are read-only and never touch the interface; a call would be a bug, so it
    // fails loudly rather than silently doing nothing.
    ui: async () => {
      throw new Error('A chapter writer cannot drive the interface.')
    },
    activeDb: own,
    webSearchAllowed: opts.literature,
    researchWeb: opts.literature ? opts.researchWeb : undefined,
    maxResearchQuestions: opts.maxResearchQuestions
  }
  // Loaded once per chapter, and only when a lookup names a database other than the report's own.
  // A study that cannot be read links nothing: the fence stays closed rather than open.
  let scope: Promise<ModelScope> | null = null
  const loadScope = async (): Promise<ModelScope> => {
    if (!own) return { readable: [] }
    try {
      const study = await opts.api('GET', `/api/v1/study?database=${encodeURIComponent(own)}`)
      const linked: unknown[] = Array.isArray(study?.compared_with) ? study.compared_with : []
      return {
        readable: linked.filter((n): n is string => typeof n === 'string' && !!n.trim() && n !== own)
      }
    } catch {
      return { readable: [] }
    }
  }
  const kindsForOneCall = kindsPerCall(async () => {
    const kinds = kindMap(await opts.api('GET', '/api/v1/databases'))
    if (!kinds) throw new Error('The list of databases could not be read, so this lookup did not run.')
    return kinds
  })
  return {
    run: async (tool, rawArgs) => {
      const args = JSON.parse(rawArgs || '{}') as Record<string, unknown>
      if (namedDatabases(args).some((n) => n.name !== own)) {
        scope ??= loadScope()
        const fence = await scope
        const refusal = await scopeRefusal(tool.spec.function.name, args, own, fence, kindsForOneCall())
        if (refusal) return outsideReport(own, fence)
      }
      return tool.run(args, ctx)
    }
  }
}
