/** Process-local admission guard for Teams that write to a direct workspace. */

import path from 'node:path'
import { SessionId, type Session, type SessionEvent, type SessionHeader, type SessionStore } from '@deepseek-ai/dsh-session'
import { restorePersistedSession, type PersistedSessionSnapshot } from './session-restore.ts'
import { replayTeamEvents } from '../../domain/projection.ts'
import type { DirectProjectIdentity } from '../../domain/workspace.ts'
import { YuqiOrchestratorError } from '../../application/errors.ts'
import { DirectWorkspacePort } from '../filesystem/direct-workspace.ts'
import { readTeamEventsFromSession } from './session-journal.ts'

const TERMINAL_TEAM_STATUSES = new Set(['cancelled', 'completed', 'failed'])
const COLD_SESSION_SCAN_CONCURRENCY = 12

export interface DirectWorkspaceOwnershipRequest {
  readonly projectRoot: string
  readonly protectedRoots?: readonly string[]
  readonly signal?: AbortSignal
}

export interface DirectWorkspaceAuthorityUpgradeRequest extends DirectWorkspaceOwnershipRequest {
  /** The controller whose task contract is being upgraded; it cannot conflict with itself. */
  readonly selfSessionId: string
}

export interface DirectWorkspaceSessionPersistence {
  list(signal?: AbortSignal): Promise<readonly SessionHeader[]>
  /** Current Host persistence API. */
  load?(id: SessionId): Promise<PersistedSessionSnapshot | undefined>
  /** Older/test adapters may expose an inspect helper. */
  inspect?(id: SessionId, signal?: AbortSignal): Promise<PersistedSessionSnapshot>
  /** Fallback available on Hosts that expose the journal incrementally. */
  readFrom?(id: SessionId, fromSeq: number): Promise<Omit<PersistedSessionSnapshot, 'meta'>>
}

export interface DirectWorkspaceOwnershipGuardOptions {
  readonly workspaces: Pick<DirectWorkspacePort, 'inspect'>
  readonly sessions: Pick<SessionStore, 'list'>
  readonly persistence: DirectWorkspaceSessionPersistence
  /** Enable the legacy persistence-only ownership audit. */
  readonly scanColdHistory?: boolean
  /** Injectable only so path-key semantics can be tested on either host family. */
  readonly platform?: NodeJS.Platform
}

/** Exact owner information surfaced to a controller that collides with a direct workspace. */
export class DirectWorkspaceConflictError extends YuqiOrchestratorError {
  readonly teamId: string
  readonly controllerSessionId: string

  constructor(projectRoot: string, teamTitle: string, teamId: string, controllerSessionId: string) {
    super(
      'WORKSPACE_CONFLICT',
      `项目 ${projectRoot} 已有一个可写 Team（${teamTitle}）正在使用当前工作区；`
        + `现有 Team 身份：teamId=${teamId}，controllerSessionId=${controllerSessionId}。`
        + '请继续或结束该 Team，或明确选择 Git 隔离工作区后再创建并行 Team',
    )
    this.name = 'DirectWorkspaceConflictError'
    this.teamId = teamId
    this.controllerSessionId = controllerSessionId
  }
}

/**
 * Serializes writer admission by canonical realpath, then checks both live and
 * persistence-only controller Sessions before allowing the caller's mutation.
 * The callback remains inside the keyed lock so the check and durable write do
 * not form a check-then-act race.
 */
export class DirectWorkspaceOwnershipGuard {
  readonly #workspaces: Pick<DirectWorkspacePort, 'inspect'>
  readonly #sessions: Pick<SessionStore, 'list'>
  readonly #persistence: DirectWorkspaceSessionPersistence
  readonly #platform: NodeJS.Platform
  readonly #scanColdHistory: boolean
  readonly #tails = new Map<string, Promise<void>>()

  constructor(options: DirectWorkspaceOwnershipGuardOptions) {
    this.#workspaces = options.workspaces
    this.#sessions = options.sessions
    this.#persistence = options.persistence
    this.#platform = options.platform ?? process.platform
    this.#scanColdHistory = options.scanColdHistory ?? true
  }

  /** Guard creation of a new Direct Team that contains at least one writer. */
  withWriterAdmission<T>(
    request: DirectWorkspaceOwnershipRequest,
    operation: (identity: DirectProjectIdentity) => Promise<T>,
  ): Promise<T> {
    return this.#withOwnership(request, undefined, operation)
  }

  /** Guard a read-only → write-authorized/full-access task authority upgrade. */
  withAuthorityUpgrade<T>(
    request: DirectWorkspaceAuthorityUpgradeRequest,
    operation: (identity: DirectProjectIdentity) => Promise<T>,
  ): Promise<T> {
    return this.#withOwnership(request, request.selfSessionId, operation)
  }

  async #withOwnership<T>(
    request: DirectWorkspaceOwnershipRequest,
    selfSessionId: string | undefined,
    operation: (identity: DirectProjectIdentity) => Promise<T>,
  ): Promise<T> {
    const identity = await this.#inspect(request.projectRoot, request.protectedRoots ?? [], request.signal)
    const key = canonicalDirectWorkspaceKey(identity.projectRoot, this.#platform)
    return this.#withKeyedLock(key, async () => {
      request.signal?.throwIfAborted()
      await this.#assertNoCompetingWriter(identity, selfSessionId, request.signal)
      request.signal?.throwIfAborted()
      return operation(identity)
    })
  }

  async #assertNoCompetingWriter(
    requested: DirectProjectIdentity,
    selfSessionId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const live = this.#sessions.list()
    const liveIds = new Set(live.map(session => String(session.id)))
    for (const session of live) {
      signal?.throwIfAborted()
      await this.#assertSessionDoesNotConflict(session, requested, selfSessionId, signal)
    }
    if (!this.#scanColdHistory) return

    let headers: readonly SessionHeader[]
    try {
      const rawHeaders = await this.#persistence.list(signal)
      headers = (rawHeaders as readonly unknown[]).map(item => (item && typeof item === 'object' && 'header' in item && (item as { header: SessionHeader }).header ? (item as { header: SessionHeader }).header : item as SessionHeader))
    } catch {
      // Live Sessions are the authoritative process-local ownership source.
      // Persistence is a cold-start supplement; an unavailable history index
      // must not permanently lock every direct workspace.
      return
    }
    const coldHeaders = headers.filter((header) => {
      const id = String(header.id)
      // Team controllers are created exclusively by controller-launcher with
      // this prefix. Ordinary parent/child Sessions cannot own a Team journal,
      // so loading their full histories only makes admission slower.
      if (!id.startsWith('yuqi-team-') || liveIds.has(id) || id === selfSessionId) return false
      // controller-launcher records the canonical Team project root as cwd and
      // rejects aliases. A controller for another cwd therefore cannot own the
      // requested direct workspace. Missing legacy cwd remains fail-closed.
      if (typeof header.cwd === 'string') {
        return canonicalDirectWorkspaceKey(path.resolve(header.cwd), this.#platform)
          === canonicalDirectWorkspaceKey(requested.projectRoot, this.#platform)
      }
      return true
    })
    await this.#scanColdSessions(coldHeaders, requested, selfSessionId, signal)
  }

  /**
   * Persistence providers can take hundreds of milliseconds per historical
   * Session. A bounded worker pool keeps admission responsive without skipping
   * any durable ownership fact or flooding the provider with unbounded reads.
   */
  async #scanColdSessions(
    headers: readonly SessionHeader[],
    requested: DirectProjectIdentity,
    selfSessionId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const requestedKey = canonicalDirectWorkspaceKey(requested.projectRoot, this.#platform)
    const exactWorkspaceHeaders = headers
      .filter(header => typeof header.cwd === 'string'
        && canonicalDirectWorkspaceKey(path.resolve(header.cwd), this.#platform) === requestedKey)
      .sort((left, right) => right.createdAt - left.createdAt)
    const legacyHeaders = headers.filter(header => typeof header.cwd !== 'string')

    // A successfully admitted direct writer is a durable boundary: at its
    // creation time every older writer for the same canonical workspace had
    // already ended. Walk newest-first and stop after the first terminal writer
    // instead of replaying years of superseded controller histories on every
    // Team start. Read-only controllers are not boundaries because they never
    // participate in writer admission.
    for (const header of exactWorkspaceHeaders) {
      signal?.throwIfAborted()
      const session = await this.#readColdSession(header, signal)
      if (session === undefined) continue
      if (await this.#assertSessionDoesNotConflict(session, requested, selfSessionId, signal)) return
    }

    // Legacy controllers did not persist cwd, so they cannot use the ordered
    // workspace boundary. Retain the bounded exhaustive fallback for them.
    let cursor = 0
    let conflict: unknown
    const worker = async (): Promise<void> => {
      while (conflict === undefined) {
        signal?.throwIfAborted()
        const index = cursor++
        const header = legacyHeaders[index]
        if (header === undefined) return
        const session = await this.#readColdSession(header, signal)
        if (session === undefined) continue
        try {
          await this.#assertSessionDoesNotConflict(session, requested, selfSessionId, signal)
        } catch (cause) {
          conflict ??= cause
        }
      }
    }
    const workerCount = Math.min(COLD_SESSION_SCAN_CONCURRENCY, legacyHeaders.length)
    await Promise.all(Array.from({ length: workerCount }, worker))
    if (conflict !== undefined) throw conflict
  }

  async #readColdSession(header: SessionHeader, signal: AbortSignal | undefined): Promise<Session | undefined> {
    const id = String(header.id)
    let stored: PersistedSessionSnapshot | undefined
    try {
      stored = await this.#loadStoredSession(header, signal)
    } catch {
      return undefined
    }
    if (stored === undefined || String(stored.meta.id) !== id) return undefined
    try {
      return restorePersistedSession(stored)
    } catch {
      return undefined
    }
  }

  async #loadStoredSession(
    header: SessionHeader,
    signal: AbortSignal | undefined,
  ): Promise<PersistedSessionSnapshot | undefined> {
    const id = SessionId(String(header.id))
    signal?.throwIfAborted()
    const persistence = this.#persistence as DirectWorkspaceSessionPersistence & {
      open?: (id: ReturnType<typeof SessionId>, access: 'read', options?: { signal?: AbortSignal }) => Promise<{
        header: SessionHeader
        inheritedEventCount?: number
        read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ events: readonly SessionEvent[] }>
        close(): Promise<void>
      }>
    }
    if (typeof persistence.open === 'function') {
      try {
        const handle = await persistence.open(id, 'read', ...(signal === undefined ? [] : [{ signal }]))
        try {
          const res = await handle.read(undefined, undefined, ...(signal === undefined ? [] : [{ signal }]))
          return {
            meta: handle.header,
            events: res.events,
            ...(handle.inheritedEventCount === undefined ? {} : { inheritedEventCount: handle.inheritedEventCount }),
          }
        } finally {
          await handle.close().catch(() => {})
        }
      } catch {
        return undefined
      }
    }
    if (typeof this.#persistence.load === 'function') return this.#persistence.load(id)
    if (typeof this.#persistence.inspect === 'function') return this.#persistence.inspect(id, signal)
    if (typeof this.#persistence.readFrom === 'function') {
      const journal = await this.#persistence.readFrom(id, 0)
      return { meta: header, events: journal.events,
        ...(journal.inheritedEventCount === undefined ? {} : { inheritedEventCount: journal.inheritedEventCount }) }
    }
    throw new Error('Session persistence exposes no readable event API')
  }

  async #assertSessionDoesNotConflict(
    session: Session,
    requested: DirectProjectIdentity,
    selfSessionId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (String(session.id) === selfSessionId) return false
    const events = readTeamEventsFromSession(session)
    if (events.length === 0) return false
    try {
      const projection = replayTeamEvents(events)
      const project = projection.workspace?.project as unknown as Partial<DirectProjectIdentity> | undefined
      if (project?.mode !== 'direct' || typeof project.projectRoot !== 'string') return false
      if (projection.team.manualOwnership?.state !== 'human-owned'
        && projection.taskIds.every(taskId => projection.tasks[taskId]?.contract.authorityMode === 'read-only')) return false

      const competing = await this.#inspect(project.projectRoot, project.protectedRoots ?? [], signal)
      if (canonicalDirectWorkspaceKey(competing.projectRoot, this.#platform)
        !== canonicalDirectWorkspaceKey(requested.projectRoot, this.#platform)) return false
      if (TERMINAL_TEAM_STATUSES.has(projection.team.status)) return true
      throw new DirectWorkspaceConflictError(
        requested.projectRoot,
        projection.team.title,
        String(projection.team.id),
        String(session.id),
      )
    } catch (cause) {
      if (cause instanceof YuqiOrchestratorError && cause.code === 'WORKSPACE_CONFLICT') throw cause
      // Malformed historical Team facts are owned by recovery. Only a complete,
      // replayable projection is strong enough to block an unrelated project.
      return false
    }
  }

  async #inspect(projectRoot: string, protectedRoots: readonly string[], signal: AbortSignal | undefined): Promise<DirectProjectIdentity> {
    const identity = await this.#workspaces.inspect({ projectRoot, protectedRoots, ...(signal === undefined ? {} : { signal }) })
    return identity as unknown as DirectProjectIdentity
  }

  async #withKeyedLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = predecessor.then(() => gate)
    this.#tails.set(key, tail)
    await predecessor
    try {
      return await operation()
    } finally {
      release()
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    }
  }
}

/** Canonical identities are already absolute realpaths; only Windows folds case. */
export function canonicalDirectWorkspaceKey(projectRoot: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? projectRoot.toLowerCase() : projectRoot
}
