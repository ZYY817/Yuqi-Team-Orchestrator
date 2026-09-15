import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle, HistoryEntry } from '@deepseek-ai/dsh-client-connection/client'

type LegacyApi = ConnectionHandle['api']
type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
type Value<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>> extends { result: infer R } ? Extract<R, { ok: true }> extends { value: infer V } ? V : never : never
type Method<F extends (...args: never[]) => unknown> = (...args: Parameters<F>) => Promise<{ result: Result<Value<F>> }>
export interface HostClientApi {
  workspace: { list: Method<LegacyApi['workspace']['list']> }
  agentPresets: { list: Method<LegacyApi['agentPresets']['list']> }
  sessions: {
    create: Method<LegacyApi['sessions']['create']>
    prompt: (request: Parameters<LegacyApi['sessions']['prompt']>[0] & { requestId?: string }) => ReturnType<Method<LegacyApi['sessions']['prompt']>>
    models: Method<LegacyApi['sessions']['models']>
    history: Method<LegacyApi['sessions']['history']>
  }
  subagents: { history: Method<LegacyApi['subagents']['history']> }
}
type ModelCatalog = Omit<Value<LegacyApi['sessions']['models']>, 'current' | 'routable'> & {
  default: { provider: string; model: string }
  routableProviders: readonly string[]
}
type Address = { kind: 'session'; sessionId: string } | { kind: 'subagent'; parentSessionId: string; childSessionId: string; mode: string }
type Page = { records: readonly { type: string; event: HistoryEntry['event'] }[]; hasMore: boolean }
interface ModernRemote {
  session: {
    create(request: Parameters<LegacyApi['sessions']['create']>[0]): Promise<Result<Value<LegacyApi['sessions']['create']>>>
    prompt(request: Parameters<LegacyApi['sessions']['prompt']>[0] & { requestId: string }): Promise<Result<Value<LegacyApi['sessions']['prompt']>>>
    modelCatalog(): Promise<Result<ModelCatalog>>
    follow(request: { address: Address; maxMessages?: number }, signal: AbortSignal): AsyncIterable<Page & { type: string; cursor: number }>
    page(request: { address: Address; throughSeq: number; beforeSeq: number; maxMessages?: number }, signal: AbortSignal): Promise<Result<Page>>
  }
  agentPresets: { list(): Promise<Result<Value<LegacyApi['agentPresets']['list']>>> }
}

/** Translate the official Remote facade at one boundary; never mutate Host services. */
export function hostClientApi(ctx: ClientContext): HostClientApi {
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  if (connection.api !== undefined) {
    const legacy = connection.api
    return { ...legacy, sessions: { ...legacy.sessions, prompt: ({ requestId: _requestId, ...request }) => legacy.sessions.prompt(request) } }
  }
  // Read the exact declared namespace services through Cordis' guarded facade.
  const remote: ModernRemote = {
    session: Reflect.get(ctx, 'remote.session'),
    agentPresets: Reflect.get(ctx, 'remote.agentPresets'),
  }
  if (!remote?.session || !remote.agentPresets) throw new Error('Official Client Remote services unavailable')
  const history = async (address: Address, beforeSeq: number | undefined, maxMessages: number | undefined, signal?: AbortSignal) => {
    const abort = new AbortController()
    const cancel = () => abort.abort(signal?.reason)
    if (signal?.aborted) cancel()
    signal?.addEventListener('abort', cancel, { once: true })
    const timeout = setTimeout(() => abort.abort(new Error('History read timed out')), 30_000)
    try {
      for await (const opening of remote.session.follow({ address, ...(maxMessages === undefined ? {} : { maxMessages }) }, abort.signal)) {
        if (opening.type !== 'snapshot') throw new Error('History opening snapshot missing')
        const result = beforeSeq === undefined ? { ok: true as const, value: opening }
          : await remote.session.page({ address, throughSeq: opening.cursor, beforeSeq, ...(maxMessages === undefined ? {} : { maxMessages }) }, abort.signal)
        if (!result.ok) return { result }
        return { result: { ok: true as const, value: {
          // Packed assistant deltas are not file tool evidence. Preserve raw events and pagination.
          events: result.value.records.filter(record => record.type === 'event') as HistoryEntry[],
          hasMore: result.value.hasMore,
        } } }
      }
      throw new Error('History stream closed before its snapshot')
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); abort.abort() }
  }
  // Only these documented methods are consumed by this plugin. The legacy shape
  // is retained at the boundary while the actual transport is the modern Remote.
  return {
    workspace: { list: async () => {
      const snapshot = ctx.workspaces.list.getSnapshot() as unknown as Value<LegacyApi['workspace']['list']> & { phase: string; state: string }
      if (snapshot.phase !== 'ready' || snapshot.state !== 'idle') throw new Error('Workspace registry is not ready')
      return { result: { ok: true, value: { items: snapshot.items, archivedSessionIds: snapshot.archivedSessionIds } } }
    } },
    agentPresets: { list: async () => ({ result: await remote.agentPresets.list() }) },
    sessions: {
      create: async request => ({ result: await remote.session.create(request) }),
      prompt: async request => ({ result: await remote.session.prompt({ ...request, requestId: request.requestId ?? crypto.randomUUID() }) }),
      models: async ({ sessionId }) => {
        if (!ctx.sessions.list.getSnapshot().byId[sessionId]) throw new Error('Session no longer available')
        const result = await remote.session.modelCatalog()
        if (!result.ok) return { result }
        const row = ctx.sessions.list.getSnapshot().byId[sessionId]
        if (!row) throw new Error('Session no longer available')
        const projection = row.projectionValues as unknown as { modelSelection?: { next?: { provider: string; model: string } | null } } | undefined
        const current = projection?.modelSelection?.next ?? result.value.default
        return { result: { ok: true, value: { ...result.value, current, routable: result.value.routableProviders.includes(current.provider) } } }
      },
      history: ({ sessionId, beforeSeq, maxMessages }, signal) => history({ kind: 'session', sessionId }, beforeSeq, maxMessages, signal),
    },
    subagents: { history: ({ parentSessionId, childSessionId, mode, beforeSeq, maxMessages }, signal) => history({ kind: 'subagent', parentSessionId, childSessionId, mode }, beforeSeq, maxMessages, signal) },
  }
}
