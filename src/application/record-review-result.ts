/** Durable application core for reviewer requests, results, and rework intent. */

import { ControlOperationId, TeamEventId } from '../domain/ids.ts'
import type { TeamEvent } from '../domain/events.ts'
import type {
  ReviewAutomaticReworkBudget,
  ReviewCheckpointAnchor,
  ReviewCheckpointSubject,
  ReviewResult,
  ReviewTrigger,
  ReviewUserDecision,
} from '../domain/review-policy.ts'
import { reviewFindingFingerprint, reviewResultSchema } from '../domain/review-policy.ts'
import type { TeamProjection } from '../domain/projection.ts'
import { replayTeamEvents } from '../domain/projection.ts'
import type { TeamTaskContract } from '../domain/task-contract.ts'
import { DurableJournalCoordinator } from './durable-journal.ts'
import { YuqiOrchestratorError } from './errors.ts'
import type { Clock, EventIdSource, TeamEventJournal } from './ports.ts'
import { createTeamEvent, validateTeamEvents } from './team-events.ts'

export interface RequestReviewRequest {
  readonly teamId: string
  readonly reviewId: string
  readonly trigger: ReviewTrigger
  readonly candidateEventId: string
  readonly round: number
  readonly checkpointSubject?: ReviewCheckpointSubject
  readonly checkpointAnchor?: ReviewCheckpointAnchor
  readonly automaticReworkBudget?: ReviewAutomaticReworkBudget
  readonly independentReviewerRequired?: boolean
  readonly additionalCriteria?: string
}

export interface RecordReviewResultRequest {
  readonly teamId: string
  readonly candidateEventId: string
  readonly result: ReviewResult
  readonly reviewerIndependence?: 'model-diverse' | 'context-only'
}

export interface CreateReviewReworkRequest {
  readonly teamId: string
  readonly sourceReviewId: string
  readonly contract: TeamTaskContract
}

export interface RecordReviewUserDecisionRequest {
  readonly teamId: string
  readonly operationId: string
  readonly reviewId: string
  readonly candidateEventId: string
  readonly round: number
  readonly decision: ReviewUserDecision
  readonly reason?: string
}

/** Serializes reviewer cycle facts without dispatching a reviewer or worker. */
export class ReviewResultCoordinator {
  readonly #clock: Clock
  readonly #eventIds: EventIdSource
  readonly #transactions: DurableJournalCoordinator

  constructor(clock: Clock, eventIds: EventIdSource, transactions: DurableJournalCoordinator) {
    this.#clock = clock
    this.#eventIds = eventIds
    this.#transactions = transactions
  }

  request(request: RequestReviewRequest, journal: TeamEventJournal): Promise<TeamProjection> {
    return this.#transactions.run(journal, async transaction => {
      const current = ownedProjection(transaction.read(), request.teamId)
      const existing = current.reviews[request.reviewId]
      if (existing !== undefined) {
        const requestedSubject = request.checkpointSubject ?? 'team-completion'
        const requestedAnchor = request.checkpointAnchor ?? { eventId: request.candidateEventId }
        if (existing.trigger !== request.trigger || existing.candidateEventId !== request.candidateEventId || existing.round !== request.round
          || existing.checkpointSubject !== requestedSubject
          || JSON.stringify(existing.checkpointAnchor) !== JSON.stringify(requestedAnchor)
          || (request.automaticReworkBudget !== undefined
            && JSON.stringify(existing.automaticReworkBudget) !== JSON.stringify(request.automaticReworkBudget))
           || (request.independentReviewerRequired !== undefined
            && existing.independentReviewerRequired !== request.independentReviewerRequired)
          || existing.additionalCriteria !== request.additionalCriteria) {
          throw conflict(`Review ${request.reviewId} was reused with different request facts`)
        }
        return current
      }
      if (current.team.reviewPolicy?.mode === 'off') throw conflict('Reviewer policy is off')
      const event = createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
        type: 'yuqi/review-requested',
        reviewId: request.reviewId,
        trigger: request.trigger,
        candidateEventId: TeamEventId(request.candidateEventId),
        round: request.round,
        ...(request.checkpointSubject === undefined ? {} : { checkpointSubject: request.checkpointSubject }),
        ...(request.checkpointAnchor === undefined ? {} : { checkpointAnchor: request.checkpointAnchor }),
        ...(request.automaticReworkBudget === undefined ? {} : { automaticReworkBudget: request.automaticReworkBudget }),
        ...(request.independentReviewerRequired === undefined ? {} : { independentReviewerRequired: request.independentReviewerRequired }),
        ...(request.additionalCriteria === undefined ? {} : { additionalCriteria: request.additionalCriteria }),
      })
      const next = validateTeamEvents(transaction.read(), [event])
      await transaction.commit([event], 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably persist the reviewer request')
      return next
    })
  }

  record(request: RecordReviewResultRequest, journal: TeamEventJournal): Promise<TeamProjection> {
    return this.#transactions.run(journal, async transaction => {
      const current = ownedProjection(transaction.read(), request.teamId)
      const result = reviewResultSchema.parse(request.result)
      const review = current.reviews[result.reviewId]
      if (review === undefined || review.trigger !== result.trigger) throw conflict(`Review ${result.reviewId} is not the current durable request`)
      if (review.result !== undefined) {
        if (review.candidateEventId !== request.candidateEventId
          || review.reviewerIndependence !== request.reviewerIndependence
          || JSON.stringify(review.result) !== JSON.stringify(stripResultIdentity(result))) {
          throw conflict(`Review ${result.reviewId} was reused with different result facts`)
        }
        return current
      }
      if (review.candidateEventId !== request.candidateEventId
        || (review.checkpointSubject === 'team-completion' && current.completionCandidateEventId !== request.candidateEventId)) {
        throw conflict(`Review ${result.reviewId} targets a stale completion candidate`)
      }
      const event = createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
        type: 'yuqi/review-result-recorded',
        reviewId: result.reviewId,
        candidateEventId: TeamEventId(request.candidateEventId),
        reviewerSessionId: result.reviewerSessionId,
        decision: result.decision,
        findings: result.findings,
        findingFingerprints: result.findings.map(reviewFindingFingerprint),
        unverified: result.unverified,
        ...(review.independentReviewerRequired ? { reviewerIndependent: true } : {}),
        ...(request.reviewerIndependence === undefined ? {} : { reviewerIndependence: request.reviewerIndependence }),
      })
      const next = validateTeamEvents(transaction.read(), [event])
      await transaction.commit([event], 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably persist the reviewer result')
      return next
    })
  }

  createRework(request: CreateReviewReworkRequest, journal: TeamEventJournal): Promise<TeamProjection> {
    return this.#transactions.run(journal, async transaction => {
      const current = ownedProjection(transaction.read(), request.teamId)
      const contract: TeamTaskContract = request.contract.authorityMode === 'full-access'
        ? { ...request.contract, authorityMode: 'write-authorized' }
        : request.contract
      const existing = current.tasks[contract.taskId]
      if (existing !== undefined) {
        if (JSON.stringify(existing.contract) !== JSON.stringify(contract)) {
          throw conflict(`Review rework task ${contract.taskId} was reused with different content`)
        }
        return current
      }
      if (contract.kind !== 'review-rework' || contract.reviewRework?.sourceReviewId !== request.sourceReviewId) {
        throw conflict('Review rework contract does not match its source review')
      }
      const event = createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
        type: 'yuqi/task-created', contract,
      })
      const next = validateTeamEvents(transaction.read(), [event])
      await transaction.commit([event], 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably persist the reviewer rework task')
      return next
    })
  }

  decide(request: RecordReviewUserDecisionRequest, journal: TeamEventJournal): Promise<TeamProjection> {
    return this.#transactions.run(journal, async transaction => {
      const current = ownedProjection(transaction.read(), request.teamId)
      const existing = current.reviewUserDecisionOperations[request.operationId]
      if (existing !== undefined) {
        const same = existing.reviewId === request.reviewId
          && String(existing.candidateEventId) === request.candidateEventId
          && existing.round === request.round
          && existing.decision === request.decision
          && existing.reason === request.reason
        if (!same) throw conflict(`Review decision operation ${request.operationId} was reused with different facts`)
        const terminalEvents = terminalReviewDecisionEvents(current, request, this.#clock, this.#eventIds)
        if (terminalEvents.length === 0) return current
        const next = validateTeamEvents(transaction.read(), terminalEvents)
        await transaction.commit(terminalEvents, 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably finish the review terminal decision')
        return next
      }
      if (request.decision === 'waive' && (request.reason === undefined || request.reason.trim() === '')) {
        throw conflict('Review waive requires a durable reason')
      }
      const event = createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
        type: 'yuqi/review-user-decision-recorded',
        operationId: ControlOperationId(request.operationId),
        reviewId: request.reviewId,
        candidateEventId: TeamEventId(request.candidateEventId),
        round: request.round,
        decision: request.decision,
        ...(request.reason === undefined ? {} : { reason: request.reason.trim() }),
      })
      const events = [event, ...terminalReviewDecisionEvents(current, request, this.#clock, this.#eventIds)]
      const next = validateTeamEvents(transaction.read(), events)
      await transaction.commit(events, 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably persist the review user decision')
      return next
    })
  }
}

function terminalReviewDecisionEvents(
  projection: TeamProjection,
  request: RecordReviewUserDecisionRequest,
  clock: Clock,
  eventIds: EventIdSource,
): TeamEvent[] {
  if (request.decision === 'fail') {
    if (projection.team.status === 'failed') return []
    if (projection.team.status !== 'running') throw conflict(`Review fail decision cannot finish while Team is ${projection.team.status}`)
    return [createTeamEvent(clock, eventIds, request.teamId, {
      type: 'yuqi/team-status-changed', from: 'running', to: 'failed',
      reason: `user review decision fail for ${request.reviewId}`,
    })]
  }
  if (request.decision !== 'cancel') return []
  // Cancellation is completed by TeamControlCoordinator so review decisions
  // cannot bypass the normal durable cancellation lifecycle.
  return []
}

function ownedProjection(inputs: readonly unknown[], teamId: string): TeamProjection {
  const current = replayTeamEvents(inputs)
  if (current.team.id !== teamId) throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${teamId} does not own this controller journal`)
  return current
}

function stripResultIdentity(result: ReviewResult): NonNullable<TeamProjection['reviews'][string]>['result'] {
  return {
    reviewerSessionId: result.reviewerSessionId,
    decision: result.decision,
    findings: result.findings,
    unverified: result.unverified,
  }
}

function conflict(message: string): YuqiOrchestratorError {
  return new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', message)
}
