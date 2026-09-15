/** Host-derived, negative-only recovery gate for a needs_reconciliation Team. */

import { ControlOperationId, WorkspaceId } from '../domain/ids.ts'
import { operationIdUsed, projectionHasReconciliationGap, replayTeamEvents } from '../domain/projection.ts'
import type { TeamProjection } from '../domain/projection.ts'
import { DurableJournalCoordinator } from './durable-journal.ts'
import { YuqiOrchestratorError } from './errors.ts'
import type { Clock, EventIdSource, RecoveryClearProof, RecoveryClearSafetyPort, TeamEventJournal } from './ports.ts'
import { createTeamEvent, validateTeamEvents } from './team-events.ts'
import { workspaceProofMatches } from '../domain/workspace.ts'
import type { DirectProjectIdentity, ProjectIdentity } from '../domain/workspace.ts'

export interface ClearRecoveryRequest {
  readonly teamId: string
  readonly operationId: string
  readonly target?: 'paused' | 'running'
  /** Internal recovery-saga opt-in after Host quiescence proof. */
  readonly releaseOrphanedLeases?: boolean
  readonly signal?: AbortSignal
}

export class RecoveryClearCoordinator {
  readonly #clock: Clock
  readonly #eventIds: EventIdSource
  readonly #transactions: DurableJournalCoordinator

  constructor(clock: Clock, eventIds: EventIdSource, transactions: DurableJournalCoordinator) {
    this.#clock = clock
    this.#eventIds = eventIds
    this.#transactions = transactions
  }

  async clear(request: ClearRecoveryRequest, journal: TeamEventJournal, safety: RecoveryClearSafetyPort): Promise<TeamProjection> {
    const before = replayTeamEvents(journal.read())
    const target = request.target ?? 'paused'
    assertCandidate(before, request, target)
    if (before.recoveryClearOperations[request.operationId] !== undefined) return before
    const durableWorkspace = before.workspace
    if (durableWorkspace === undefined || durableWorkspace.status === 'provisioning') {
      throw new YuqiOrchestratorError('RECONCILIATION_NOT_ALLOWED', 'Workspace recovery requires a durable workspace identity')
    }
    const verificationWorkspace = { ...durableWorkspace, status: 'ready' as const }
    let proof: RecoveryClearProof
    try {
      proof = await safety.assertRecoveryClear({
        journalKey: journal.key,
        teamId: request.teamId,
        workspace: verificationWorkspace,
        attemptIds: Object.values(before.attempts).map(attempt => attempt.id),
        attempts: Object.values(before.attempts).map(attempt => ({
          attemptId: attempt.id,
          ...(attempt.agentSessionId === undefined ? {} : { childSessionId: attempt.agentSessionId }),
        })),
        retainDirtyWorkspace: target === 'paused',
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
    } catch (cause) {
      throw new YuqiOrchestratorError('RECONCILIATION_NOT_ALLOWED', 'Host could not prove Team recovery is safe', { cause })
    }
    validateClearProof(proof, durableWorkspace)
    request.signal?.throwIfAborted()

    return this.#transactions.run(journal, async transaction => {
      request.signal?.throwIfAborted()
      const current = replayTeamEvents(transaction.read())
      assertCandidate(current, request, target)
      if (current.recoveryClearOperations[request.operationId] !== undefined) return current
      if (current.lastEventId !== before.lastEventId) throw new YuqiOrchestratorError('RECONCILIATION_STALE', 'Team facts changed during recovery verification')
      const events = [] as ReturnType<typeof createTeamEvent>[]
      if (current.workspace?.status === 'needs_reconciliation') {
        events.push(createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
          type: 'yuqi/workspace-recovery-verified',
          workspace: { ...current.workspace, status: 'ready' },
        }))
      }
      // A Host proof covers local quiescence, so stale leases from a lost
      // controller can be released in the same durable recovery transaction.
      // This keeps an orphaned lease from making an otherwise safe gate
      // impossible to clear.
      if (request.releaseOrphanedLeases === true) {
        for (const lease of Object.values(current.fileLeases)) {
          if (lease.status !== 'active') continue
          events.push(createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
            type: 'yuqi/file-lease-released', leaseId: lease.leaseId,
            taskId: lease.taskId, ...(lease.attemptId === undefined ? {} : { attemptId: lease.attemptId }),
            reason: 'host-derived recovery proof released an orphaned lease',
          }))
        }
      }
      const operationId = ControlOperationId(request.operationId)
      events.push(createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
        type: 'yuqi/team-recovery-cleared', operationId, target,
        proof: {
          principal: proof.principal,
          childQuiescent: true,
          localInFlight: false,
          gitVerified: true,
          workspace: { ...proof.workspace, workspaceId: WorkspaceId(proof.workspace.workspaceId), protectedRoots: [...proof.workspace.protectedRoots] },
        },
      }))
      const next = validateTeamEvents(transaction.read(), events)
      request.signal?.throwIfAborted()
      await transaction.commit(events, 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably persist recovery clearance')
      return next
    })
  }

  /**
   * Clear a quiescent recovery gate from durable facts only. This deliberately
   * cannot resume scheduling and does not claim Host/controller verification.
   */
  clearFromDurableJournal(
    request: Omit<ClearRecoveryRequest, 'target' | 'signal'>,
    journal: TeamEventJournal,
    controllerSessionId: string,
  ): Promise<TeamProjection> {
    return this.#transactions.run(journal, async transaction => {
      const current = replayTeamEvents(transaction.read())
      assertCandidate(current, request, 'paused')
      const previous = current.recoveryClearOperations[request.operationId]
      if (previous !== undefined) {
        if (previous.target !== 'paused' || previous.basis !== 'durable-journal'
          || previous.principal.sessionId !== controllerSessionId) {
          throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Recovery operation was reused with another durable journal identity')
        }
        return current
      }
      const workspace = current.workspace
      if (workspace === undefined || workspace.status !== 'ready') {
        throw new YuqiOrchestratorError('RECONCILIATION_NOT_ALLOWED', 'Durable-only recovery requires an already-ready workspace identity')
      }
      const event = createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
        type: 'yuqi/team-recovery-cleared-from-journal',
        operationId: ControlOperationId(request.operationId),
        target: 'paused',
        controllerSessionId,
        workspace: durableWorkspaceProof(workspace),
      })
      const next = validateTeamEvents(transaction.read(), [event])
      await transaction.commit([event], 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably clear the quiescent recovery gate')
      return next
    })
  }
}

function assertCandidate(projection: TeamProjection, request: ClearRecoveryRequest, target: 'paused' | 'running'): void {
  if (projection.team.id !== request.teamId) throw new YuqiOrchestratorError('TEAM_MISMATCH', 'Recovery operation belongs to another Team')
  const operationId = ControlOperationId(request.operationId)
  if (operationIdUsed(projection, operationId, 'recovery-clear')) {
    throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', `Recovery operation ${request.operationId} was already used for another command`)
  }
  if (projection.recoveryClearOperations[operationId] !== undefined) {
    if (projection.recoveryClearOperations[operationId]!.target !== target) throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Recovery operation was reused for another target')
    return
  }
  if (projection.team.status !== 'needs_reconciliation') throw new YuqiOrchestratorError('RECONCILIATION_NOT_ALLOWED', `Team cannot clear recovery while ${projection.team.status}`)
  if (projection.team.manualOwnership?.state === 'human-owned') throw new YuqiOrchestratorError('RECONCILIATION_NOT_ALLOWED', 'Team recovery cannot clear while manual ownership is held')
  if (Object.values(projection.reviews).some(review => review.status === 'requested')) throw new YuqiOrchestratorError('RECONCILIATION_NOT_ALLOWED', 'Team recovery cannot clear while a reviewer is pending')
  const latestControl = projection.latestTeamControlOperationId
  if (latestControl !== undefined && projection.controlOperations[latestControl]?.action === 'cancel') throw new YuqiOrchestratorError('RECONCILIATION_NOT_ALLOWED', 'Team cannot clear an active cancellation intent')
  if (Object.values(projection.attempts).some(attempt => ['dispatching', 'running', 'unknown'].includes(attempt.status))) throw new YuqiOrchestratorError('RECONCILIATION_NOT_ALLOWED', 'Team still has an unresolved attempt')
  if (Object.values(projection.verifications).some(verification => verification.status === 'pending' || verification.status === 'running')) throw new YuqiOrchestratorError('RECONCILIATION_NOT_ALLOWED', 'Team still has an active verification')
  if (Object.values(projection.fileLeases).some(lease => lease.status === 'active')
    && request.releaseOrphanedLeases !== true) throw new YuqiOrchestratorError('RECONCILIATION_NOT_ALLOWED', 'Team still has an active lease')
  if (Object.values(projection.budgetReservations).some(reservation => reservation.status === 'active' || reservation.status === 'unknown')) throw new YuqiOrchestratorError('RECONCILIATION_NOT_ALLOWED', 'Team still has an unresolved token reservation')
  if (projectionHasReconciliationGap(projection)) throw new YuqiOrchestratorError('RECONCILIATION_NOT_ALLOWED', 'Team still has a durable reconciliation gap')
}

function validateClearProof(proof: RecoveryClearProof, workspace: NonNullable<TeamProjection['workspace']>): void {
  if (proof.principal.kind !== 'controller-session' || proof.principal.sessionId.trim() === ''
    || proof.childQuiescent !== true || proof.localInFlight !== false || proof.gitVerified !== true
    || !workspaceProofMatches(proof.workspace, workspace)) {
    throw new YuqiOrchestratorError('RECONCILIATION_NOT_ALLOWED', 'Host recovery proof did not match the durable workspace')
  }
}

function durableWorkspaceProof(workspace: NonNullable<TeamProjection['workspace']>) {
  const project = workspace.project as unknown as ProjectIdentity | DirectProjectIdentity
  if ('mode' in project && project.mode === 'direct') {
    return {
      mode: 'direct' as const, workspaceId: WorkspaceId(workspace.workspaceId), projectRoot: project.projectRoot,
      volumeRoot: project.volumeRoot, protectedRoots: [...project.protectedRoots],
      worktreePath: workspace.worktreePath, branchName: workspace.branchName,
    }
  }
  const git = project as ProjectIdentity
  return {
    workspaceId: WorkspaceId(workspace.workspaceId), projectRoot: git.projectRoot,
    repositoryRoot: git.repositoryRoot, gitCommonDirectory: git.gitCommonDirectory,
    baselineRef: git.baselineRef, volumeRoot: git.volumeRoot,
    protectedRoots: [...git.protectedRoots], worktreePath: workspace.worktreePath,
    branchName: workspace.branchName,
  }
}
