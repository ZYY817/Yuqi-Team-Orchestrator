import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { TEAM_SIDECAR_CHANNEL, teamSidecarSnapshotSchema, type TeamSidecarEvent } from '../domain/team-sidecar-web-contract.ts'
import type { TeamConsoleSummary } from '../domain/team-console-contract.ts'
import { reduceSidecarSession } from './sidecar-projection.ts'

export interface SidecarState {
  readonly status: 'loading' | 'ready' | 'error' | 'cancelled'
  /** A bounded, transport-sanitized explanation for the retryable error UI. */
  readonly error?: string
  readonly mode?: 'sidecar' | 'legacy'
  readonly legacy: ReadonlySet<string>
  readonly unavailable?: ReadonlySet<string>
  readonly summaries: ReadonlyMap<string, TeamConsoleSummary>
  readonly events: ReadonlyMap<string, readonly TeamSidecarEvent[]>
}
type Catalog = ReturnType<ClientContext['sessions']['list']['getSnapshot']>
export interface TeamCatalogFace { getSnapshot(): Catalog; subscribe(listener: () => void): () => void }
const emptyState = (status: SidecarState['status'], error?: string): SidecarState => ({ status, ...(error === undefined ? {} : { error }), summaries: new Map(), events: new Map(), legacy: new Set() })

function safeFailureMessage(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : String(reason)
  // Host RPC errors are already redacted. Keep the UI useful without exposing
  // arbitrary transport payloads or turning a failed snapshot into a log sink.
  return raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300) || 'Unknown sidecar loading error'
}

/** One cancellable query per plugin instance; publication happens only after the whole bounded page walk. */
export function createSidecarStore(rpc: ClientConnectionRpc, sessions: ClientContext['sessions']) {
  let state = emptyState('loading')
  let catalog: Catalog
  const listeners = new Set<() => void>()
  let request: AbortController | undefined
  let poll: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let recoveryRefreshGeneration = 0
  let failures = 0
  // Complete payload equality (not merely seq) also detects derived compaction
  // and same-revision repairs. Reuse only a previously validated projection.
  let replayCache = new Map<string, { content: string; summary: TeamConsoleSummary | undefined }>()
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const rebuild = () => {
    const native = sessions.list.getSnapshot()
    if (state.mode === 'legacy' && state.status === 'ready') catalog = native
    else {
      const byId = { ...native.byId }
      for (const id of native.ids) {
        if (state.unavailable?.has(id)) { delete byId[id]; continue }
        const row = native.byId[id]
        if (row !== undefined) byId[id] = { ...row, projectionValues: { ...row.projectionValues,
          yuqiTeam: state.legacy.has(id) ? row.projectionValues?.yuqiTeam ?? null : state.summaries.get(id) ?? null } }
      }
      // A local display catalog may include controllers absent from the native visible list.
      const ids = native.ids.filter(id => !state.unavailable?.has(id))
      for (const [id, summary] of state.summaries) {
        if (byId[id as SessionId] !== undefined) continue
        const key = id as SessionId
        byId[key] = { id: key, displayTitle: summary.team.objective, projectionValues: { yuqiTeam: summary } } as Catalog['byId'][SessionId]
        ids.push(key)
      }
      catalog = { ...native, ids, byId }
    }
    for (const listener of listeners) listener()
  }
  const publish = (next: SidecarState) => { state = next; rebuild() }
  const stop = () => { clearTimeout(poll); clearTimeout(deadline); request?.abort(); request = undefined }
  const refresh = async (background = false) => {
    if (disposed) return
    stop()
    const controller = new AbortController()
    request = controller
    // Automatic retries retain the actionable failure instead of flashing a
    // fresh loading notice on every poll. Explicit refresh still shows work.
    if (!background) publish(emptyState('loading'))
    const schedule = () => {
      const active = [...state.summaries.values()].some(summary => summary.team.status === 'running')
      const interval = failures === 0 && active ? 2_000 : Math.min(30_000, 5_000 * 2 ** Math.min(failures, 3))
      if (!disposed) poll = setTimeout(() => { void refresh(true) }, interval)
    }
    deadline = setTimeout(() => {
      if (request !== controller) return
      request = undefined
      controller.abort()
      failures++
      publish(emptyState('error', 'Team data request timed out after 30 seconds.'))
      schedule()
    }, 30_000)
    try {
      const events = new Map<string, readonly TeamSidecarEvent[]>()
      const summaries = new Map<string, TeamConsoleSummary>()
      const legacy = new Set<string>()
      const unavailable = new Set<string>()
      const nextReplayCache = new Map<string, { content: string; summary: TeamConsoleSummary | undefined }>()
      let mode: 'sidecar' | 'legacy' | undefined
      let pageIndex = 0
      const query = async (sessionIds?: string[]) => {
        for (const id of sessionIds ?? []) { events.delete(id); summaries.delete(id); legacy.delete(id); unavailable.delete(id) }
        const cursors = new Set<string>()
        const seen = new Set<string>()
        let cursor: string | undefined
        for (;;) {
          if (pageIndex >= 100) throw new Error('Sidecar page limit exceeded')
          pageIndex++
          const result = await rpc.call(TEAM_SIDECAR_CHANNEL, 'snapshot', {
            ...(sessionIds === undefined ? {} : { sessionIds }), ...(cursor === undefined ? {} : { cursor }),
          }, controller.signal)
          if (request !== controller || controller.signal.aborted) throw new Error('Superseded query')
          if (!result.ok) throw new Error(result.error.message)
          const page = teamSidecarSnapshotSchema.parse(result.value)
          if (mode !== undefined && mode !== page.mode) throw new Error('Sidecar mode changed during pagination')
          mode = page.mode
          for (const session of page.sessions) {
            if (seen.has(session.sessionId)) throw new Error('Duplicate sidecar session across pages')
            if (sessionIds !== undefined && !sessionIds.includes(session.sessionId)) throw new Error('Unexpected sidecar identity')
            seen.add(session.sessionId)
            if (session.source === 'unavailable') {
              unavailable.add(session.sessionId)
              events.delete(session.sessionId)
              summaries.delete(session.sessionId)
              legacy.delete(session.sessionId)
              continue
            }
            unavailable.delete(session.sessionId)
            if (session.source === 'legacy') {
              legacy.add(session.sessionId)
              events.delete(session.sessionId)
              summaries.delete(session.sessionId)
              continue
            }
            legacy.delete(session.sessionId)
            events.set(session.sessionId, session.events)
            const content = JSON.stringify(session.events)
            const cached = replayCache.get(session.sessionId)
            const summary = cached?.content === content ? cached.summary : reduceSidecarSession(session.sessionId, session.events)
            nextReplayCache.set(session.sessionId, { content, summary })
            if (summary !== undefined) {
              const previous = state.summaries.get(session.sessionId)
              summaries.set(session.sessionId, previous !== undefined && JSON.stringify(previous) === JSON.stringify(summary) ? previous : summary)
            }
            else summaries.delete(session.sessionId)
          }
          cursor = page.nextCursor
          if (cursor === undefined) break
          if (cursors.has(cursor)) throw new Error('Sidecar cursor did not advance')
          cursors.add(cursor)
        }
      }
      await query()
      // Cold legacy sessions are not in the sidecar index.  Ask only rows the
      // native UI already identifies as Team rows; verifying every ordinary
      // conversation makes a large history delay the entire Team surface.
      if (mode !== 'legacy') {
        const nativeCatalog = sessions.list.getSnapshot()
        const ids = nativeCatalog.ids.filter(id => {
          if (events.has(id) || legacy.has(id) || unavailable.has(id)) return false
          const value = nativeCatalog.byId[id]?.projectionValues?.yuqiTeam
          return value !== undefined && value !== null
        }).map(String)
        for (let offset = 0; offset < ids.length; offset += 200) await query(ids.slice(offset, offset + 200))
      }
      if (request !== controller || controller.signal.aborted) return
      failures = 0
      replayCache = nextReplayCache
      publish({ status: 'ready', mode: mode!, events, summaries, legacy, unavailable })
    } catch (reason) {
      if (request !== controller || controller.signal.aborted) return
      failures++
      publish(emptyState('error', safeFailureMessage(reason)))
      // A Host restart can briefly accept the RPC connection before its
      // storage-domain service finishes initializing. Retrying here lets the
      // centered failure state heal itself once that dependency is ready.
      schedule()
    } finally {
      if (request === controller) { clearTimeout(deadline); request = undefined; if (state.status === 'ready') schedule() }
    }
  }
  rebuild()
  const unsubscribe = sessions.list.subscribe(rebuild)
  return {
    getSnapshot: () => state, subscribe, refresh,
    recoverTarget: async (teamId: string, controllerSessionId: string) => {
      const generation = recoveryRefreshGeneration
      const result = await rpc.call(TEAM_SIDECAR_CHANNEL, 'recover-target', { teamId, controllerSessionId }, AbortSignal.timeout(15_000))
      if (!result.ok) throw new Error(result.error.message)
      if (generation === recoveryRefreshGeneration && !disposed) await refresh(true)
    },
    resolveParent: async (teamId: string, controllerSessionId: string): Promise<string> => {
      const result = await rpc.call(TEAM_SIDECAR_CHANNEL, 'resolve-parent', { teamId, controllerSessionId }, AbortSignal.timeout(15_000))
      const parentSessionId = result.ok && typeof result.value === 'object' && result.value !== null
        ? (result.value as { parentSessionId?: unknown }).parentSessionId : undefined
      if (typeof parentSessionId !== 'string' || !parentSessionId.trim()) throw new Error('Team parent is unavailable')
      return parentSessionId
    },
    catalog: { getSnapshot: () => catalog, subscribe },
    summary: (id: string): TeamConsoleSummary | null | undefined => {
      if (state.status !== 'ready') return undefined
      if (state.unavailable?.has(id)) return undefined
      if (state.mode === 'sidecar' && !state.legacy.has(id)) return state.summaries.get(id)
      if (sessions.list.getSnapshot().byId[id as SessionId]?.projectionValues?.yuqiTeam == null) return undefined
      return (sessions.binding(id as SessionId)?.session.projections.faceOf('yuqiTeam').getSnapshot()
        ?? sessions.list.getSnapshot().byId[id as SessionId]?.projectionValues?.yuqiTeam) as TeamConsoleSummary | null | undefined
    },
    cancel: () => { recoveryRefreshGeneration++; stop(); publish(emptyState('cancelled')) },
    dispose: () => { disposed = true; recoveryRefreshGeneration++; stop(); unsubscribe(); listeners.clear(); replayCache.clear() },
  }
}
export type SidecarStore = ReturnType<typeof createSidecarStore>
