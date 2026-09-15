/** Durable task retry intent that preserves all prior attempt and evidence facts. */

import { ControlOperationId, FileLeaseId, TaskId } from '../domain/ids.ts'
import type { TeamProjection } from '../domain/projection.ts'
import { replayTeamEvents } from '../domain/projection.ts'
import type { TeamEvent } from '../domain/events.ts'
import { DurableJournalCoordinator } from './durable-journal.ts'
import { YuqiOrchestratorError } from './errors.ts'
import type { Clock, EventIdSource, TeamEventJournal } from './ports.ts'
import { createTeamEvent, validateTeamEvents } from './team-events.ts'

export interface TaskRetryRequest {
  readonly teamId: string
  readonly taskId: string
  readonly operationId: string
}

/** Serializes retry intent with scheduling and releases prior task ownership atomically. */
export class TaskRetryCoordinator {
  readonly #clock: Clock
  readonly #eventIds: EventIdSource
  readonly #transactions: DurableJournalCoordinator

  constructor(clock: Clock, eventIds: EventIdSource, transactions: DurableJournalCoordinator) {
    this.#clock = clock
    this.#eventIds = eventIds
    this.#transactions = transactions
  }

  retry(request: TaskRetryRequest, journal: TeamEventJournal): Promise<TeamProjection> {
    return this.#transactions.run(journal, async transaction => {
      const current = replayTeamEvents(transaction.read())
      if (current.team.manualOwnership?.state === 'human-owned') throw new YuqiOrchestratorError('RETRY_NOT_ALLOWED', 'Return manual ownership before retrying a task')
      if (current.team.id !== request.teamId) {
        throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${request.teamId} does not own this controller journal`)
      }
      const operationId = ControlOperationId(request.operationId)
      if (current.reconciliationOperations[operationId] !== undefined || current.attemptResolutionOperations[operationId] !== undefined
        || current.attemptResolutionProofs[operationId] !== undefined || current.recoveryClearOperations[operationId] !== undefined
        || current.verificationVerdictOperations[operationId] !== undefined) {
        throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', `Retry operation ${operationId} was already used for reconciliation`)
      }
      if (current.controlOperations[operationId] !== undefined) {
        throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', `Retry operation ${operationId} was already used for Team control`)
      }
      const previous = current.taskRetryOperations[operationId]
      if (previous !== undefined) {
        if (previous.taskId !== request.taskId) {
          throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', `Retry operation ${operationId} was already used for task ${previous.taskId}`)
        }
        return current
      }
      if (current.team.status !== 'running' && current.team.status !== 'paused') {
        throw new YuqiOrchestratorError('RETRY_NOT_ALLOWED', `Task retry is not allowed while Team is ${current.team.status}`)
      }
      const taskId = TaskId(request.taskId)
      const task = current.tasks[taskId]
      if (task === undefined || (task.status !== 'failed' && task.status !== 'cancelled' && task.status !== 'verifying' && task.status !== 'blocked')) {
        throw new YuqiOrchestratorError('RETRY_NOT_ALLOWED', `Task ${request.taskId} is not retryable`)
      }

      const events: TeamEvent[] = current.fileLeaseIds.flatMap(leaseId => {
        const lease = current.fileLeases[leaseId]!
        if (lease.taskId === taskId && lease.status === 'active' && (lease.attemptId === undefined || lease.attemptId !== task.attemptIds.at(-1))) {
          throw new YuqiOrchestratorError('RETRY_NOT_ALLOWED', `Task ${request.taskId} has an unprovable active file lease`)
        }
        return lease.taskId === taskId && lease.status === 'active'
          ? [createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
              type: 'yuqi/file-lease-released', leaseId: FileLeaseId(leaseId), taskId, attemptId: lease.attemptId, reason: `retry operation ${operationId}`,
            })]
          : []
      })
      events.push(createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
        type: 'yuqi/task-retry-requested', operationId, taskId,
      }))
      let next: TeamProjection
      try {
        next = validateTeamEvents(transaction.read(), events)
      } catch (cause) {
        throw new YuqiOrchestratorError('RETRY_NOT_ALLOWED', `Task ${request.taskId} cannot safely retry`, { cause })
      }
      await transaction.commit(events, 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably persist the task retry')
      return next
    })
  }
}
