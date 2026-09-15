/** Explicit, fail-closed operator resolution for one cold-reconciled attempt. */

import { AttemptId, ControlOperationId, FileLeaseId, TaskId, WorkspaceId } from '../domain/ids.ts'
import type { AttemptResolutionProof, AttemptRuntimeObservation, AttemptResolutionSafetyPort, Clock, EventIdSource, TeamEventJournal } from './ports.ts'
import type { TeamProjection } from '../domain/projection.ts'
import type { TeamEvent } from '../domain/events.ts'
import { replayTeamEvents } from '../domain/projection.ts'
import { DurableJournalCoordinator } from './durable-journal.ts'
import { YuqiOrchestratorError } from './errors.ts'
import { createTeamEvent, validateTeamEvents } from './team-events.ts'
import { workspaceProofMatches } from '../domain/workspace.ts'
import { hasCurrentCancellationIntent } from './control-team.ts'

export interface ResolveAttemptRequest {
  readonly teamId: string
  readonly taskId: string
  readonly attemptId: string
  /** Unique idempotency key for this explicit operator decision. */
  readonly operationId: string
  /** The newest durable reconciliation observation for this attempt. */
  readonly observationOperationId: string
  /** Success is deliberately not a supported manual conclusion. */
  readonly decision: 'failed' | 'cancelled'
  readonly signal?: AbortSignal
}

/**
 * Closes one unknown attempt only after the host independently proves it is quiescent.
 *
 * Every side effect is validated as one journal transaction: proof, budget settlement,
 * exact lease release, and terminal attempt/task facts are either all durable or none are.
 */
export class AttemptResolutionCoordinator {
  readonly #clock: Clock
  readonly #eventIds: EventIdSource
  readonly #transactions: DurableJournalCoordinator

  constructor(clock: Clock, eventIds: EventIdSource, transactions: DurableJournalCoordinator) {
    this.#clock = clock
    this.#eventIds = eventIds
    this.#transactions = transactions
  }

  async resolve(
    request: ResolveAttemptRequest,
    journal: TeamEventJournal,
    safety: AttemptResolutionSafetyPort,
  ): Promise<TeamProjection> {
    const before = replayTeamEvents(journal.read())
    const existing = this.#assertCandidate(before, request)
    if (existing) return before
    const observation = observationFor(before, request)
    const leaseIds = exactLeaseIds(before, request.taskId, request.attemptId)
    const workspace = before.workspace
    try {
      const proof = await safety.assertQuiescent({
        journalKey: journal.key,
        teamId: request.teamId,
        taskId: request.taskId,
        attemptId: request.attemptId,
        ...(observation.childSessionId === undefined ? {} : { childSessionId: observation.childSessionId }),
        observation,
        ...(workspace === undefined ? {} : { workspace }),
        leaseIds,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      if (proof === undefined) throw new YuqiOrchestratorError('RESOLUTION_UNSAFE', 'Host did not return a durable resolution proof')
      validateProof(proof, observation, leaseIds, workspace)
      return this.#commitResolved(request, journal, before, proof, observation, leaseIds)
    } catch (cause) {
      if (cause instanceof YuqiOrchestratorError && cause.code !== 'RESOLUTION_UNSAFE') throw cause
      throw new YuqiOrchestratorError('RESOLUTION_UNSAFE', 'Yuqi could not prove this attempt is quiescent', { cause })
    }
  }

  async #commitResolved(
    request: ResolveAttemptRequest,
    journal: TeamEventJournal,
    before: TeamProjection,
    proof: AttemptResolutionProof,
    observation: AttemptRuntimeObservation,
    leaseIds: readonly string[],
  ): Promise<TeamProjection> {
    return this.#transactions.run(journal, async transaction => {
      const current = replayTeamEvents(transaction.read())
      const replayed = this.#assertCandidate(current, request)
      if (replayed) return current
      if (current.lastEventId !== before.lastEventId) {
        throw new YuqiOrchestratorError('RESOLUTION_STALE', 'Team facts changed while the host checked attempt quiescence')
      }
      const operationId = ControlOperationId(request.operationId)
      const proofEvent = createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
        type: 'yuqi/attempt-resolution-proof-recorded',
        operationId,
        observationOperationId: ControlOperationId(request.observationOperationId),
        taskId: TaskId(request.taskId),
        attemptId: AttemptId(request.attemptId),
        decision: request.decision,
        proof: {
          principal: proof.principal,
          observationState: proof.observationState,
          childQuiescent: true,
          localInFlight: false,
          gitVerified: true,
          ...(proof.workspace === undefined ? {} : { workspace: { ...proof.workspace, workspaceId: WorkspaceId(proof.workspace.workspaceId), protectedRoots: [...proof.workspace.protectedRoots] } }),
          leaseIds: leaseIds.map(FileLeaseId),
        },
      })
      const resolution = createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
        type: 'yuqi/attempt-resolution-requested',
        operationId,
        observationOperationId: ControlOperationId(request.observationOperationId),
        taskId: TaskId(request.taskId),
        attemptId: AttemptId(request.attemptId),
        decision: request.decision,
        proofOperationId: operationId,
      })
      const reservation = Object.values(current.budgetReservations).find(candidate => candidate.taskId === request.taskId && candidate.attemptId === request.attemptId)
      const release = reservation?.status === 'active'
        ? createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
            type: 'yuqi/budget-reservation-settled', reservationId: reservation.reservationId,
            taskId: TaskId(request.taskId), attemptId: AttemptId(request.attemptId),
            status: observation.state === 'not-admitted' ? 'not-admitted' : 'unknown',
            reason: observation.state === 'not-admitted' ? 'reconciliation proved the child was never admitted' : 'manual resolution cannot infer provider usage',
          })
        : undefined
      const leaseEvents = leaseIds.map(leaseId => createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
        type: 'yuqi/file-lease-released', leaseId: FileLeaseId(leaseId), taskId: TaskId(request.taskId), attemptId: AttemptId(request.attemptId),
        reason: 'host-derived negative resolution',
      }))
      const workspaceRecovery = current.workspace?.status === 'needs_reconciliation' && proof.workspace !== undefined
        ? createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
            type: 'yuqi/workspace-recovery-verified',
            workspace: { ...current.workspace, status: 'ready' },
          })
        : undefined
      const resolutionEvents = [
        ...(workspaceRecovery === undefined ? [] : [workspaceRecovery]),
        proofEvent, ...(release === undefined ? [] : [release]), ...leaseEvents, resolution,
      ]
      const resolved = validateTeamEvents(transaction.read(), resolutionEvents)
      const cancellationEvents = cancellationClosureEvents(resolved, request.teamId, this.#clock, this.#eventIds)
      const events = [...resolutionEvents, ...cancellationEvents]
      const next = validateTeamEvents(transaction.read(), events)
      await transaction.commit(events, 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably persist the explicit attempt resolution')
      return next
    })
  }

  #assertCandidate(projection: TeamProjection, request: ResolveAttemptRequest): boolean {
    if (projection.team.id !== request.teamId) {
      throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${request.teamId} does not own this controller journal`)
    }
    const operationId = ControlOperationId(request.operationId)
    if (projection.controlOperations[operationId] !== undefined || projection.taskRetryOperations[operationId] !== undefined
      || projection.reconciliationOperations[operationId] !== undefined
      || projection.recoveryClearOperations[operationId] !== undefined
      || projection.verificationVerdictOperations[operationId] !== undefined) {
      throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', `Resolution operation ${operationId} was already used for another command`)
    }
    const previous = projection.attemptResolutionOperations[operationId]
    if (previous !== undefined) {
      if (previous.observationOperationId !== request.observationOperationId || previous.taskId !== request.taskId
        || previous.attemptId !== request.attemptId || previous.decision !== request.decision) {
        throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', `Resolution operation ${operationId} was already used with different content`)
      }
      return true
    }
    if (projection.team.status !== 'needs_reconciliation') {
      throw new YuqiOrchestratorError('RESOLUTION_NOT_ALLOWED', `Team cannot resolve an attempt while ${projection.team.status}`)
    }
    const task = projection.tasks[request.taskId]
    const attempt = projection.attempts[request.attemptId]
    if (task === undefined || attempt === undefined || attempt.taskId !== request.taskId
      || task.status !== 'running' || attempt.status !== 'unknown') {
      throw new YuqiOrchestratorError('RESOLUTION_NOT_ALLOWED', `Attempt ${request.attemptId} is not an unknown running task attempt`)
    }
    const observation = observationFor(projection, request)
    if (projection.latestReconciliationOperationIds[request.attemptId] !== request.observationOperationId) {
      throw new YuqiOrchestratorError('RESOLUTION_STALE', `Attempt ${request.attemptId} must use its latest reconciliation observation`)
    }
    if (!isQuiescentObservation(observation)) {
      throw new YuqiOrchestratorError('RESOLUTION_NOT_ALLOWED', `Attempt ${request.attemptId} has a non-quiescent ${observation.state} observation`)
    }
    const reservation = Object.values(projection.budgetReservations)
      .find(candidate => candidate.taskId === request.taskId && candidate.attemptId === request.attemptId)
    if (reservation?.status === 'unknown') {
      throw new YuqiOrchestratorError('RESOLUTION_NOT_ALLOWED', `Attempt ${request.attemptId} has an unresolved unknown token reservation`)
    }
    return false
  }
}

function cancellationClosureEvents(
  projection: TeamProjection,
  teamId: string,
  clock: Clock,
  eventIds: EventIdSource,
): TeamEvent[] {
  if (!hasCurrentCancellationIntent(projection) || projection.team.status !== 'needs_reconciliation') return []
  const hasUnresolvedRuntime = Object.values(projection.attempts).some(attempt => attempt.status === 'dispatching' || attempt.status === 'running' || attempt.status === 'unknown')
    || Object.values(projection.verifications).some(verification => verification.status === 'pending' || verification.status === 'running')
    || Object.values(projection.fileLeases).some(lease => lease.status === 'active')
    || Object.values(projection.budgetReservations).some(reservation => reservation.status === 'active' || reservation.status === 'unknown')
  if (hasUnresolvedRuntime) return []
  const taskEvents = projection.taskIds.flatMap(taskId => {
    const status = projection.tasks[taskId]!.status
    if (status === 'completed' || status === 'failed' || status === 'cancelled') return []
    return [createTeamEvent(clock, eventIds, teamId, {
      type: 'yuqi/task-status-changed' as const,
      taskId: TaskId(taskId),
      from: status,
      to: 'cancelled' as const,
      reason: 'original Team cancellation completed after explicit reconciliation',
    })]
  })
  return [...taskEvents, createTeamEvent(clock, eventIds, teamId, {
    type: 'yuqi/team-status-changed' as const,
    from: 'needs_reconciliation' as const,
    to: 'cancelled' as const,
    reason: 'original Team cancellation completed after all unknown attempts were explicitly resolved',
  })]
}

function observationFor(projection: TeamProjection, request: ResolveAttemptRequest): AttemptRuntimeObservation {
  const operation = projection.reconciliationOperations[request.observationOperationId]
  const observation = operation?.observations.find(candidate => candidate.attemptId === request.attemptId)
  if (observation === undefined || observation.taskId !== request.taskId) {
    throw new YuqiOrchestratorError('RESOLUTION_STALE', `Observation ${request.observationOperationId} does not match attempt ${request.attemptId}`)
  }
  return {
    taskId: observation.taskId,
    attemptId: observation.attemptId,
    ...(observation.childSessionId === undefined ? {} : { childSessionId: observation.childSessionId }),
    state: observation.state,
    ...(observation.reason === undefined ? {} : { reason: observation.reason }),
  }
}

function isQuiescentObservation(observation: AttemptRuntimeObservation): boolean {
  return observation.state === 'durable' || observation.state === 'missing' || observation.state === 'not-admitted'
}

function exactLeaseIds(projection: TeamProjection, taskId: string, attemptId: string): readonly string[] {
  const active = Object.values(projection.fileLeases)
    .filter(lease => lease.status === 'active' && lease.taskId === taskId)
  if (active.some(lease => lease.attemptId === undefined || lease.attemptId !== attemptId)) {
    throw new YuqiOrchestratorError('RESOLUTION_NOT_ALLOWED', `Attempt ${attemptId} has an unprovable or foreign active lease`)
  }
  return active.map(lease => lease.leaseId)
}

function validateProof(
  proof: AttemptResolutionProof,
  observation: AttemptRuntimeObservation,
  leaseIds: readonly string[],
  workspace: TeamProjection['workspace'],
): void {
  if (proof.principal.kind !== 'controller-session' || proof.principal.sessionId.trim().length === 0
    || proof.observationState !== observation.state || proof.childQuiescent !== true
    || proof.localInFlight !== false || proof.gitVerified !== true) {
    throw new YuqiOrchestratorError('RESOLUTION_UNSAFE', 'Host proof did not establish the required resolution facts')
  }
  const actual = [...proof.leaseIds]
  if (actual.length !== leaseIds.length || actual.some(id => !leaseIds.includes(id))) {
    throw new YuqiOrchestratorError('RESOLUTION_UNSAFE', 'Host proof did not name the exact releasable leases')
  }
  if (workspace === undefined) {
    if (proof.workspace !== undefined) throw new YuqiOrchestratorError('RESOLUTION_UNSAFE', 'Host proof supplied an unverifiable workspace identity')
    return
  }
  const identity = proof.workspace
  if (identity === undefined || !workspaceProofMatches(identity, workspace)) {
    throw new YuqiOrchestratorError('RESOLUTION_UNSAFE', 'Host proof did not match the durable workspace identity')
  }
}
