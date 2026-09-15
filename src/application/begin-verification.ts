/** Durable, idempotent start of the verification lifecycle for one settled attempt. */

import { AttemptId, TaskId, VerificationId } from '../domain/ids.ts'
import { replayTeamEvents } from '../domain/projection.ts'
import type { TeamProjection } from '../domain/projection.ts'
import { YuqiOrchestratorError } from './errors.ts'
import { DurableJournalCoordinator } from './durable-journal.ts'
import type { Clock, EventIdSource, TeamEventJournal } from './ports.ts'
import { createTeamEvent, validateTeamEvents } from './team-events.ts'

/** Request to durably create and start verification for the latest settled attempt. */
export interface BeginVerificationRequest {
  readonly teamId: string
  readonly taskId: string
  readonly attemptId: string
  readonly verificationId: string
  readonly verifierSessionId: string
}

/**
 * Starts verification without performing collection, judging, or external I/O.
 * The existing verification identity is the durable idempotency key for this
 * lifecycle command; no extra operation state is introduced.
 */
export class BeginVerificationCoordinator {
  readonly #clock: Clock
  readonly #eventIds: EventIdSource
  readonly #transactions: DurableJournalCoordinator

  constructor(clock: Clock, eventIds: EventIdSource, transactions: DurableJournalCoordinator) {
    this.#clock = clock
    this.#eventIds = eventIds
    this.#transactions = transactions
  }

  begin(request: BeginVerificationRequest, journal: TeamEventJournal): Promise<TeamProjection> {
    return this.#transactions.run(journal, async transaction => {
      const current = replayTeamEvents(transaction.read())
      if (current.team.id !== request.teamId) {
        throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${request.teamId} does not own this controller journal`)
      }
      const verificationId = VerificationId(request.verificationId)
      const existing = current.verifications[verificationId]
      if (existing !== undefined) {
        if (existing.taskId === request.taskId && existing.attemptId === request.attemptId
          && existing.verifierSessionId === request.verifierSessionId && existing.status === 'running') {
          return current
        }
        throw new YuqiOrchestratorError('VERIFICATION_OPERATION_CONFLICT', `Verification ${verificationId} was reused with different content`)
      }

      assertBeginAllowed(current, request, verificationId)
      const created = createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
        type: 'yuqi/verification-created',
        taskId: TaskId(request.taskId),
        attemptId: AttemptId(request.attemptId),
        verificationId,
        verifierSessionId: request.verifierSessionId,
      })
      const started = createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
        type: 'yuqi/verification-status-changed',
        taskId: TaskId(request.taskId),
        attemptId: AttemptId(request.attemptId),
        verificationId,
        from: 'pending',
        to: 'running',
        reason: 'verification started',
      })
      const events = [created, started]
      const next = validateTeamEvents(transaction.read(), events)
      await transaction.commit(events, 'VERIFICATION_PERSISTENCE_FAILED', 'Yuqi could not durably start verification')
      return next
    })
  }
}

function assertBeginAllowed(
  projection: TeamProjection,
  request: BeginVerificationRequest,
  verificationId: VerificationId,
): void {
  if (projection.team.id !== request.teamId) {
    throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${request.teamId} does not own this controller journal`)
  }
  const task = projection.tasks[request.taskId]
  const attempt = projection.attempts[request.attemptId]
  if (task === undefined || attempt === undefined || attempt.taskId !== request.taskId) {
    throw new YuqiOrchestratorError('VERIFICATION_NOT_ALLOWED', `Verification ${verificationId} does not match the requested task attempt`)
  }
  if (task.status !== 'verifying' || task.attemptIds.at(-1) !== request.attemptId) {
    throw new YuqiOrchestratorError('VERIFICATION_NOT_ALLOWED', `Task ${request.taskId} is not waiting for verification of its latest attempt`)
  }
  if (attempt.status !== 'settled' || attempt.evidence === undefined || attempt.evidence.stopReason !== 'completed') {
    throw new YuqiOrchestratorError('VERIFICATION_NOT_ALLOWED', `Attempt ${request.attemptId} is not a settled successful attempt`)
  }
  if (projection.verifications[verificationId] !== undefined
    || task.verificationIds.some(id => projection.verifications[id]?.attemptId === request.attemptId)) {
    throw new YuqiOrchestratorError('VERIFICATION_OPERATION_CONFLICT', `Attempt ${request.attemptId} already has a verification`)
  }
  if (request.verifierSessionId.trim().length === 0) {
    throw new YuqiOrchestratorError('VERIFICATION_NOT_ALLOWED', 'Verifier session identity must be non-empty')
  }
}
