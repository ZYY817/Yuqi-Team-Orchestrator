/** Durable two-phase provisioning for one Team-owned Git worktree. */

import type { ProjectIdentity, TeamWorkspace } from '../domain/workspace.ts'
import { projectIdentitySchema, teamWorkspaceSchema } from '../domain/workspace.ts'
import { TeamId } from '../domain/ids.ts'
import { replayTeamEvents } from '../domain/projection.ts'
import type { GitWorkspacePort } from './workspace-ports.ts'
import { DurableJournalCoordinator } from './durable-journal.ts'
import { YuqiOrchestratorError } from './errors.ts'
import type { Clock, EventIdSource, TeamEventJournal } from './ports.ts'
import { createTeamEvent, validateTeamEvents } from './team-events.ts'

export interface ProvisionWorkspaceRequest {
  readonly teamId: string
  readonly workspaceId: string
  readonly identity: ProjectIdentity
  readonly managedRoot: string
  readonly worktreePath: string
  readonly branchName: string
  readonly signal?: AbortSignal
}

export interface VerifyReadyWorkspaceRequest {
  readonly teamId: string
  readonly workspaceId: string
  readonly worktreePath: string
  readonly signal?: AbortSignal
}

interface ActiveProvision {
  readonly fingerprint: string
  readonly promise: Promise<TeamWorkspace>
}

type ProvisionDecision =
  | { readonly kind: 'ready'; readonly workspace: TeamWorkspace; readonly allowedDirtyScopes: readonly string[] }
  | { readonly kind: 'create'; readonly workspace: TeamWorkspace }

/** Serializes durable intent, the Git side effect, and durable confirmation. */
export class TeamWorkspaceCoordinator {
  readonly #clock: Clock
  readonly #eventIds: EventIdSource
  readonly #git: GitWorkspacePort
  readonly #transactions: DurableJournalCoordinator
  readonly #ownsTransactions: boolean
  readonly #active = new Map<string, ActiveProvision>()
  #disposed = false
  #disposal: Promise<void> | undefined

  constructor(
    clock: Clock,
    eventIds: EventIdSource,
    git: GitWorkspacePort,
    transactions?: DurableJournalCoordinator,
  ) {
    this.#clock = clock
    this.#eventIds = eventIds
    this.#git = git
    this.#transactions = transactions ?? new DurableJournalCoordinator()
    this.#ownsTransactions = transactions === undefined
  }

  provision(request: ProvisionWorkspaceRequest, journal: TeamEventJournal): Promise<TeamWorkspace> {
    if (this.#disposed) return Promise.reject(new YuqiOrchestratorError('SERVICE_DISPOSED', 'The Team workspace coordinator is disposed'))
    const fingerprint = requestFingerprint(request)
    const active = this.#active.get(journal.key)
    if (active !== undefined) {
      if (active.fingerprint !== fingerprint) {
        return Promise.reject(new YuqiOrchestratorError('WORKSPACE_CONFLICT', 'Another workspace request is active for this controller'))
      }
      return active.promise
    }
    const promise = this.#provision(request, journal).finally(() => {
      /* v8 ignore else -- A controller key is never replaced during its active provisioning promise. */
      if (this.#active.get(journal.key)?.promise === promise) this.#active.delete(journal.key)
    })
    this.#active.set(journal.key, { fingerprint, promise })
    return promise
  }

  /** Re-prove live Git facts for the exact durable ready workspace before execution. */
  async verifyReady(request: VerifyReadyWorkspaceRequest, journal: TeamEventJournal): Promise<TeamWorkspace> {
    if (this.#disposed) throw new YuqiOrchestratorError('SERVICE_DISPOSED', 'The Team workspace coordinator is disposed')
    if (this.#active.has(journal.key)) {
      throw new YuqiOrchestratorError('WORKSPACE_CONFLICT', 'The Team workspace is still being provisioned')
    }
    const durable = await this.#transactions.run(journal, transaction => {
      const projection = replayTeamEvents(transaction.read())
      if (projection.team.id !== TeamId(request.teamId)) {
        throw new YuqiOrchestratorError('TEAM_MISMATCH', 'The workspace verification belongs to another Team')
      }
      const workspace = projection.workspace
      if (workspace?.status !== 'ready'
        || workspace.workspaceId !== request.workspaceId
        || workspace.worktreePath !== request.worktreePath) {
        throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'Execution requires the exact durable ready Team workspace')
      }
      return Promise.resolve({ workspace, allowedDirtyScopes: teamOwnedDirtyScopes(projection) })
    })
    return this.#verifyLive(request.teamId, durable.workspace, durable.allowedDirtyScopes, journal, request.signal)
  }

  dispose(): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal
    this.#disposed = true
    this.#disposal = this.#drain()
    return this.#disposal
  }

  async #drain(): Promise<void> {
    await Promise.allSettled([...this.#active.values()].map(active => active.promise))
    this.#active.clear()
    if (this.#ownsTransactions) await this.#transactions.dispose()
  }

  async #provision(request: ProvisionWorkspaceRequest, journal: TeamEventJournal): Promise<TeamWorkspace> {
    const identity = projectIdentitySchema.parse(request.identity)
    const provisional = Object.freeze(teamWorkspaceSchema.parse({
      workspaceId: request.workspaceId,
      project: identity,
      worktreePath: request.worktreePath,
      branchName: request.branchName,
      status: 'provisioning',
    }))
    const decision = await this.#transactions.run(journal, async transaction => {
      const projection = replayTeamEvents(transaction.read())
      if (projection.team.id !== TeamId(request.teamId)) {
        throw new YuqiOrchestratorError('TEAM_MISMATCH', 'The workspace request belongs to another Team')
      }
      if (projection.workspace !== undefined) {
        if (projection.workspace.status === 'ready' && workspaceMatches(projection.workspace, provisional)) {
          return { kind: 'ready', workspace: projection.workspace, allowedDirtyScopes: teamOwnedDirtyScopes(projection) } as const
        }
        throw new YuqiOrchestratorError(
          projection.workspace.status === 'ready' ? 'WORKSPACE_CONFLICT' : 'CONTROLLER_REQUIRES_RECONCILIATION',
          'The Team already has a different or unfinished workspace fact',
        )
      }
      const started = createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
        type: 'yuqi/workspace-provisioning-started', workspace: { ...provisional, status: 'provisioning' },
      })
      validateTeamEvents(transaction.read(), [started])
      await transaction.commit([started], 'WORKSPACE_PERSISTENCE_FAILED', 'Yuqi could not durably persist the workspace provisioning intent')
      return { kind: 'create', workspace: provisional } as const
    }) satisfies ProvisionDecision
    if (decision.kind === 'ready') {
      return this.#verifyLive(request.teamId, decision.workspace, decision.allowedDirtyScopes, journal, request.signal)
    }

    let created: TeamWorkspace
    try {
      created = await this.#git.provision({
        identity,
        workspaceId: request.workspaceId,
        managedRoot: request.managedRoot,
        worktreePath: request.worktreePath,
        branchName: request.branchName,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      if (!workspaceMatches(created, provisional) || created.status !== 'ready') {
        throw new YuqiOrchestratorError('WORKSPACE_REQUIRES_RECONCILIATION', isDirectProject(identity)
          ? 'The direct workspace adapter returned a workspace that does not match the durable intent'
          : 'The Git adapter returned a workspace that does not match the durable intent')
      }
    } catch (cause) {
      await this.#recordReconciliation(request.teamId, provisional.workspaceId, journal,
        isDirectProject(identity) ? 'Direct workspace provisioning did not reach a proven ready state' : 'Git provisioning did not reach a proven ready state')
      throw new YuqiOrchestratorError('WORKSPACE_REQUIRES_RECONCILIATION', isDirectProject(identity)
        ? 'The direct Team workspace requires reconciliation before execution'
        : 'The Team Git workspace requires reconciliation before execution', { cause })
    }

    await this.#transactions.run(journal, async transaction => {
      const confirmed = createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
        type: 'yuqi/workspace-provisioned', workspaceId: created.workspaceId,
      })
      validateTeamEvents(transaction.read(), [confirmed])
      await transaction.commit([confirmed], 'WORKSPACE_PERSISTENCE_FAILED', 'Git created the Team workspace, but Yuqi could not durably confirm it')
    })
    return created
  }

  async #recordReconciliation(
    teamId: string,
    workspaceId: TeamWorkspace['workspaceId'],
    journal: TeamEventJournal,
    reason: string,
  ): Promise<void> {
    await this.#transactions.run(journal, async transaction => {
      const event = createTeamEvent(this.#clock, this.#eventIds, teamId, {
        type: 'yuqi/workspace-reconciliation-required', workspaceId, reason,
      })
      validateTeamEvents(transaction.read(), [event])
      await transaction.commit([event], 'WORKSPACE_PERSISTENCE_FAILED', 'Yuqi could not durably persist workspace reconciliation')
    })
  }

  async #verifyLive(
    teamId: string,
    durable: TeamWorkspace,
    allowedDirtyScopes: readonly string[],
    journal: TeamEventJournal,
    signal?: AbortSignal,
  ): Promise<TeamWorkspace> {
    try {
      const verified = await this.#git.verify({
        workspace: durable,
        allowedDirtyScopes,
        ...(signal === undefined ? {} : { signal }),
      })
      if (!workspaceMatches(verified, durable) || verified.status !== 'ready') throw new Error('workspace verification mismatch')
      return verified
    } catch (cause) {
      await this.#recordReconciliation(teamId, durable.workspaceId, journal,
        isDirectProject(durable.project) ? 'Live direct workspace verification failed before execution' : 'Live Git workspace verification failed before execution')
      throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', 'The live Team workspace no longer matches its durable facts', { cause })
    }
  }
}

/**
 * Workspace dirtiness that may have been produced after a durable writer admission.
 *
 * fileScope is only a planning contract and reportedChangedFiles is child-owned
 * metadata, so neither can prove actual write ownership. Without a child-scoped
 * Host audit, the only honest post-admission preservation boundary is the whole
 * exact Team workspace. Tasks that never admitted a writer remain fail-closed.
 */
export function teamOwnedDirtyScopes(projection: ReturnType<typeof replayTeamEvents>): readonly string[] {
  const hasAdmittedWriter = Object.values(projection.tasks)
    .filter(task => task.contract.authorityMode !== 'read-only')
    .some(task => task.attemptIds.some(attemptId => projection.attempts[attemptId]?.agentSessionId !== undefined))
  return hasAdmittedWriter ? Object.freeze(['**']) : Object.freeze([])
}

function requestFingerprint(request: ProvisionWorkspaceRequest): string {
  return JSON.stringify([
    request.teamId,
    request.workspaceId,
    request.identity,
    request.managedRoot,
    request.worktreePath,
    request.branchName,
  ])
}

function workspaceMatches(left: TeamWorkspace, right: TeamWorkspace): boolean {
  return JSON.stringify({ ...left, status: undefined }) === JSON.stringify({ ...right, status: undefined })
}

function isDirectProject(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && (value as { readonly mode?: unknown }).mode === 'direct'
}
