/** Atomically queue bounded automatic rework from one durable failed verdict. */

import { replayTeamEvents, projectionHasReconciliationGap, teamAutomaticReworkCount } from '../domain/projection.ts'
import type { TeamProjection } from '../domain/projection.ts'
import { DEFAULT_MAX_TEAM_AUTOMATIC_REWORKS } from '../domain/review-policy.ts'
import { YuqiOrchestratorError } from './errors.ts'
import { TaskRetryCoordinator } from './retry-task.ts'
import type { TeamEventJournal } from './ports.ts'

export interface AutomaticTaskRetryRequest {
  readonly teamId: string
  readonly taskId: string
  readonly attemptId: string
  readonly verificationId: string
  /** Operation id of the durable verification-verdict-recorded event. */
  readonly verdictOperationId: string
}

/** Stable retry idempotency key derived from the durable verdict operation. */
export function automaticRetryOperationId(verdictOperationId: string): string {
  if (verdictOperationId.trim().length === 0) throw new YuqiOrchestratorError('RETRY_NOT_ALLOWED', 'Verification verdict operation id must be non-empty')
  return `automatic-retry:${verdictOperationId}`
}

/**
 * Queues retry only for the exact current verification failure, while leaving
 * release and retry event construction to TaskRetryCoordinator.
 */
export class AutomaticTaskRetryCoordinator {
  readonly #retries: TaskRetryCoordinator

  constructor(retries: TaskRetryCoordinator) {
    this.#retries = retries
  }

  retry(request: AutomaticTaskRetryRequest, journal: TeamEventJournal): Promise<TeamProjection> {
    const operationId = automaticRetryOperationId(request.verdictOperationId)
    const guardedJournal: TeamEventJournal = {
      key: journal.key,
      read: () => {
        const inputs = journal.read()
        assertAutomaticRetryAllowed(replayTeamEvents(inputs), request, operationId)
        return inputs
      },
      commit: events => journal.commit(events),
    }
    return this.#retries.retry({ teamId: request.teamId, taskId: request.taskId, operationId }, guardedJournal)
  }
}

function assertAutomaticRetryAllowed(
  projection: TeamProjection,
  request: AutomaticTaskRetryRequest,
  retryOperationId: string,
): void {
  if (projection.team.id !== request.teamId) {
    throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${request.teamId} does not own this controller journal`)
  }

  const existingRetry = projection.taskRetryOperations[retryOperationId]
  const verdict = projection.verificationVerdictOperations[request.verdictOperationId]
  if (existingRetry !== undefined) {
    if (existingRetry.taskId !== request.taskId || !matchingVerdict(verdict, request)) {
      throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', `Automatic retry operation ${retryOperationId} was reused with different content`)
    }
    return
  }

  if (!matchingVerdict(verdict, request)) {
    throw new YuqiOrchestratorError('RETRY_NOT_ALLOWED', `Verification verdict ${request.verdictOperationId} does not match the requested task attempt`)
  }
  if (verdict.disposition !== 'failed' || verdict.rework?.action !== 'retry'
    || verdict.rework.nextAttempt !== verdict.rework.currentAttempt + 1
    || verdict.rework.currentAttempt >= verdict.rework.maxAttempts) {
    throw new YuqiOrchestratorError('RETRY_NOT_ALLOWED', 'Automatic retry requires a bounded failed verification verdict with retry advice')
  }
  if (teamAutomaticReworkCount(projection) >= DEFAULT_MAX_TEAM_AUTOMATIC_REWORKS) {
    throw new YuqiOrchestratorError('RETRY_NOT_ALLOWED', 'Team automatic correction budget is exhausted; awaiting controller')
  }
  if (projection.team.status !== 'running' || projection.workspace?.status === 'needs_reconciliation' || projectionHasReconciliationGap(projection)) {
    throw new YuqiOrchestratorError('RETRY_NOT_ALLOWED', 'Automatic retry is blocked while Team execution is paused, cancelled, or requires reconciliation')
  }
  const task = projection.tasks[request.taskId]
  if (task?.status !== 'verifying' || task.attemptIds.at(-1) !== request.attemptId) {
    throw new YuqiOrchestratorError('RETRY_NOT_ALLOWED', `Task ${request.taskId} is not waiting for the failed current attempt`)
  }
  // TaskRetryCoordinator is the single owner of exact latest-attempt lease
  // validation and atomic release. Do not pre-empt that safe release path.
}

function matchingVerdict(
  verdict: TeamProjection['verificationVerdictOperations'][string] | undefined,
  request: AutomaticTaskRetryRequest,
): verdict is TeamProjection['verificationVerdictOperations'][string] {
  return verdict !== undefined
    && verdict.taskId === request.taskId
    && verdict.attemptId === request.attemptId
    && verdict.verificationId === request.verificationId
}
