/** Fail-closed recovery scan for attempts whose original runtime binding was lost. */

import { AttemptId, ControlOperationId, TaskId } from '../domain/ids.ts'
import type { TeamProjection } from '../domain/projection.ts'
import { replayTeamEvents } from '../domain/projection.ts'
import type { TeamEvent } from '../domain/events.ts'
import { DurableJournalCoordinator } from './durable-journal.ts'
import { YuqiOrchestratorError } from './errors.ts'
import type { AttemptRuntimeObservationPort, AttemptRuntimeRef, Clock, EventIdSource, TeamEventJournal } from './ports.ts'
import { createTeamEvent, validateTeamEvents } from './team-events.ts'

export interface ReconcileTeamRequest {
  readonly teamId: string
  readonly parentSessionId: string
  readonly operationId: string
  readonly signal?: AbortSignal
}

/** Observes public host facts, then atomically records unknown attempts and Team reconciliation. */
export class TeamReconciliationCoordinator {
  readonly #clock: Clock
  readonly #eventIds: EventIdSource
  readonly #transactions: DurableJournalCoordinator

  constructor(clock: Clock, eventIds: EventIdSource, transactions: DurableJournalCoordinator) {
    this.#clock = clock
    this.#eventIds = eventIds
    this.#transactions = transactions
  }

  async reconcile(
    request: ReconcileTeamRequest,
    journal: TeamEventJournal,
    runtime: AttemptRuntimeObservationPort,
  ): Promise<TeamProjection> {
    const before = replayTeamEvents(journal.read())
    this.#assertTeamAndOperation(before, request)
    const previous = before.reconciliationOperations[request.operationId]
    if (previous !== undefined) return before
    const unresolved = unresolvedAttemptRefs(before)
    // A recovery gate may outlive the runtime facts that originally opened it.
    // Let the caller clear that quiescent gate instead of deadlocking on a scan
    // that has nothing left to observe.
    if (unresolved.length === 0 && before.team.status === 'needs_reconciliation') return before
    if (unresolved.length === 0) throw new YuqiOrchestratorError('RECONCILIATION_NOT_REQUIRED', 'This Team has no unresolved attempts')
    const observations = await runtime.observe({
      parentSessionId: request.parentSessionId,
      attempts: unresolved,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    assertCompleteObservations(unresolved, observations)

    return this.#transactions.run(journal, async transaction => {
      const current = replayTeamEvents(transaction.read())
      this.#assertTeamAndOperation(current, request)
      if (current.reconciliationOperations[request.operationId] !== undefined) return current
      if (current.lastEventId !== before.lastEventId) {
        throw new YuqiOrchestratorError('RECONCILIATION_STALE', 'Team facts changed during runtime reconciliation')
      }
      if (current.team.status !== 'running' && current.team.status !== 'pausing'
        && current.team.status !== 'cancelling' && current.team.status !== 'needs_reconciliation') {
        throw new YuqiOrchestratorError('RECONCILIATION_NOT_ALLOWED', `Team cannot reconcile while ${current.team.status}`)
      }
      const operationId = ControlOperationId(request.operationId)
      const recovered = observations.filter(observation => observation.recoveredChild)
      const events: TeamEvent[] = [
        ...recovered.map(observation => createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
          type: 'yuqi/attempt-child-recovered' as const,
          taskId: TaskId(observation.taskId),
          attemptId: AttemptId(observation.attemptId),
          childSessionId: observation.childSessionId!,
          recoveryToken: observation.recoveryToken!,
        })),
        createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
        type: 'yuqi/reconciliation-observed',
        operationId,
        observations: observations.map(observation => ({
          taskId: TaskId(observation.taskId),
          attemptId: AttemptId(observation.attemptId),
          ...(observation.childSessionId === undefined ? {} : { childSessionId: observation.childSessionId }),
          state: observation.state,
          ...(observation.reason === undefined ? {} : { reason: observation.reason }),
        })),
      }),
      ]
      if (current.team.status !== 'needs_reconciliation') {
        events.push(createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
          type: 'yuqi/team-status-changed', from: current.team.status, to: 'needs_reconciliation',
          reason: `reconciliation operation ${operationId}`,
        }))
      }
      const next = validateTeamEvents(transaction.read(), events)
      await transaction.commit(events, 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably persist runtime reconciliation')
      return next
    })
  }

  #assertTeamAndOperation(projection: TeamProjection, request: ReconcileTeamRequest): void {
    if (projection.team.id !== request.teamId) throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${request.teamId} does not own this controller journal`)
    if (projection.controlOperations[request.operationId] !== undefined || projection.taskRetryOperations[request.operationId] !== undefined
      || projection.attemptResolutionOperations[request.operationId] !== undefined
      || projection.attemptResolutionProofs[request.operationId] !== undefined || projection.recoveryClearOperations[request.operationId] !== undefined
      || projection.verificationVerdictOperations[request.operationId] !== undefined) {
      throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', `Reconciliation operation ${request.operationId} was already used for another command`)
    }
  }
}

function unresolvedAttemptRefs(projection: TeamProjection): AttemptRuntimeRef[] {
  return Object.values(projection.attempts)
    .filter(attempt => attempt.status === 'dispatching' || attempt.status === 'running' || attempt.status === 'unknown')
    .map(attempt => ({
      taskId: attempt.taskId,
      attemptId: attempt.id,
      ...(attempt.agentSessionId === undefined ? {} : { childSessionId: attempt.agentSessionId }),
      ...(attempt.recoveryToken === undefined ? {} : { recoveryToken: attempt.recoveryToken }),
    }))
}

function assertCompleteObservations(
  attempts: readonly AttemptRuntimeRef[],
  observations: readonly Awaited<ReturnType<AttemptRuntimeObservationPort['observe']>>[number][],
): void {
  if (observations.length !== attempts.length) throw invalidObservation()
  const expected = new Map(attempts.map(attempt => [attempt.attemptId, attempt]))
  const seen = new Set<string>()
  for (const observation of observations) {
    const attempt = expected.get(observation.attemptId)
    const recovered = observation.recoveredChild === true
    if (attempt === undefined || seen.has(observation.attemptId)
      || attempt.taskId !== observation.taskId
      || (recovered
        ? attempt.childSessionId !== undefined || attempt.recoveryToken === undefined || observation.recoveryToken !== attempt.recoveryToken || observation.childSessionId === undefined
        : attempt.childSessionId !== observation.childSessionId)) throw invalidObservation()
    seen.add(observation.attemptId)
  }
}

function invalidObservation(): YuqiOrchestratorError {
  return new YuqiOrchestratorError('RECONCILIATION_NOT_ALLOWED', 'Host runtime observations do not exactly match unresolved attempts')
}
