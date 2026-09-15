/** Durable, idempotent Team lifecycle control commands. */

import { ControlOperationId } from '../domain/ids.ts'
import type { TeamEvent } from '../domain/events.ts'
import type { TeamProjection } from '../domain/projection.ts'
import { projectionHasReconciliationGap, replayTeamEvents, teamCompletionReady } from '../domain/projection.ts'
import { isSchedulableTaskStatus } from '../domain/states.ts'
import { DurableJournalCoordinator } from './durable-journal.ts'
import { YuqiOrchestratorError } from './errors.ts'
import type { Clock, EventIdSource, TeamEventJournal } from './ports.ts'
import { createTeamEvent, validateTeamEvents } from './team-events.ts'

export interface TeamControlRequest {
  readonly teamId: string
  readonly operationId: string
}

export interface TeamControlCommandResult {
  readonly projection: TeamProjection
  readonly disposition: 'created' | 'replayed'
}

/** Serializes control requests with scheduling, admission, and settlement writes. */
export class TeamControlCoordinator {
  readonly #clock: Clock
  readonly #eventIds: EventIdSource
  readonly #transactions: DurableJournalCoordinator

  constructor(clock: Clock, eventIds: EventIdSource, transactions: DurableJournalCoordinator) {
    this.#clock = clock
    this.#eventIds = eventIds
    this.#transactions = transactions
  }

  async pause(request: TeamControlRequest, journal: TeamEventJournal): Promise<TeamProjection> {
    return (await this.#change(request, 'pause', journal)).projection
  }

  async resume(request: TeamControlRequest, journal: TeamEventJournal): Promise<TeamProjection> {
    return (await this.#change(request, 'resume', journal)).projection
  }

  async cancel(request: TeamControlRequest, journal: TeamEventJournal): Promise<TeamProjection> {
    return (await this.cancelWithDisposition(request, journal)).projection
  }

  cancelWithDisposition(request: TeamControlRequest, journal: TeamEventJournal): Promise<TeamControlCommandResult> {
    return this.#change(request, 'cancel', journal)
  }

  /**
   * Persist only cancellation facts that are safe without a live controller.
   * Existing uncertain runtime work is never interrupted or blindly retried.
   */
  cancelWithoutController(request: TeamControlRequest, journal: TeamEventJournal): Promise<TeamProjection> {
    return this.#transactions.run(journal, async transaction => {
      const current = replayTeamEvents(transaction.read())
      this.#assertTeamAndOperation(current, request, 'cancel')
      const previous = current.controlOperations[request.operationId]
      if (previous !== undefined) {
        if (previous.action !== 'cancel') {
          throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', `Control operation ${request.operationId} was already used for ${previous.action}`)
        }
        if (current.team.status !== 'needs_reconciliation' || hasUnresolvedCancellationRuntime(current)) return current
        const terminalEvents = terminalCancellationEvents(current, request.teamId, this.#clock, this.#eventIds, 'needs_reconciliation')
        const next = validateTeamEvents(transaction.read(), terminalEvents)
        await transaction.commit(terminalEvents, 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably close the Team cancellation')
        return next
      }
      if (current.team.status === 'cancelled') return current

      let events: TeamEvent[] = []
      if (current.team.status === 'running' || current.team.status === 'pausing' || current.team.status === 'paused') {
        const operationId = ControlOperationId(request.operationId)
        events = [
          createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
            type: 'yuqi/team-control-requested', operationId, action: 'cancel',
          }),
          ...cancelStatusEvents(current, request.teamId, operationId, this.#clock, this.#eventIds),
        ]
        const requested = validateTeamEvents(transaction.read(), events)
        if (requested.team.status === 'cancelling') {
          events.push(createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
            type: 'yuqi/team-status-changed', from: 'cancelling', to: 'needs_reconciliation',
            reason: 'controller unavailable after durable cancellation intent',
          }))
        }
      } else if (current.team.status === 'cancelling') {
        events = hasUnresolvedCancellationRuntime(current)
          ? [createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
              type: 'yuqi/team-status-changed', from: 'cancelling', to: 'needs_reconciliation',
              reason: 'controller unavailable; prior cancellation runtime result is unknown',
            })]
          : terminalCancellationEvents(current, request.teamId, this.#clock, this.#eventIds, 'cancelling')
      } else if (current.team.status === 'needs_reconciliation') {
        const operationId = ControlOperationId(request.operationId)
        events = [
          createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
            type: 'yuqi/team-control-requested', operationId, action: 'cancel',
          }),
        ]
        // Preserve the cancellation intent while the recovery gate still
        // owns unknown runtime facts. Only durable proof may close the Team.
        if (!hasUnresolvedCancellationRuntime(current)) {
          events.push(...terminalCancellationEvents(current, request.teamId, this.#clock, this.#eventIds, 'needs_reconciliation'))
        }
      } else {
        throw new YuqiOrchestratorError('CONTROL_NOT_ALLOWED', `Team cannot cancel while ${current.team.status}`)
      }
      const next = validateTeamEvents(transaction.read(), events)
      await transaction.commit(events, 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably persist controller-less Team cancellation')
      return next
    })
  }

  /** Persist a fail-closed result when a durable cancel cannot control its runtime children. */
  markCancellationUncertain(teamId: string, journal: TeamEventJournal, reason: string): Promise<TeamProjection> {
    return this.#transactions.run(journal, async transaction => {
      const current = replayTeamEvents(transaction.read())
      if (current.team.id !== teamId) throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${teamId} does not own this controller journal`)
      if (current.team.status === 'needs_reconciliation' || current.team.status === 'cancelled') return current
      if (current.team.status !== 'cancelling') {
        throw new YuqiOrchestratorError('CONTROL_NOT_ALLOWED', `Team cancellation cannot become uncertain while ${current.team.status}`)
      }
      const event = createTeamEvent(this.#clock, this.#eventIds, teamId, {
        type: 'yuqi/team-status-changed', from: 'cancelling', to: 'needs_reconciliation', reason,
      })
      const next = validateTeamEvents(transaction.read(), [event])
      await transaction.commit([event], 'SETTLEMENT_PERSISTENCE_FAILED', 'Yuqi could not durably record uncertain Team cancellation')
      return next
    })
  }

  async #change(
    request: TeamControlRequest,
    action: 'pause' | 'resume' | 'cancel',
    journal: TeamEventJournal,
  ): Promise<TeamControlCommandResult> {
    return this.#transactions.run(journal, async transaction => {
      const current = replayTeamEvents(transaction.read())
      this.#assertTeamAndOperation(current, request, action)
      if (action === 'resume' && current.team.manualOwnership?.state === 'human-owned') throw new YuqiOrchestratorError('CONTROL_NOT_ALLOWED', 'Return manual ownership before resuming the Team')
      const operationId = ControlOperationId(request.operationId)
      const previous = current.controlOperations[operationId]
      if (previous !== undefined) {
        if (previous.action !== action) {
          throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', `Control operation ${operationId} was already used for ${previous.action}`)
        }
        return { projection: current, disposition: 'replayed' }
      }

      if (!statusAllows(action, current.team.status)) {
        throw new YuqiOrchestratorError('CONTROL_NOT_ALLOWED', `Team cannot ${action} while ${current.team.status}`)
      }
      const requested = createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
        type: 'yuqi/team-control-requested', operationId, action,
      })
      const statusEvents = action === 'resume'
        ? resumeStatusEvents(current, request.teamId, operationId, this.#clock, this.#eventIds)
        : action === 'pause'
          ? pauseStatusEvents(current, request.teamId, operationId, this.#clock, this.#eventIds)
          : current.team.status === 'needs_reconciliation'
            ? hasUnresolvedCancellationRuntime(current)
              ? []
              : terminalCancellationEvents(current, request.teamId, this.#clock, this.#eventIds, 'needs_reconciliation')
            : cancelStatusEvents(current, request.teamId, operationId, this.#clock, this.#eventIds)
      const events = [requested, ...statusEvents]
      const next = validateTeamEvents(transaction.read(), events)
      await transaction.commit(events, 'INTENT_PERSISTENCE_FAILED', `Yuqi could not durably persist the Team ${action} request`)
      return { projection: next, disposition: 'created' }
    })
  }

  #assertTeamAndOperation(projection: TeamProjection, request: TeamControlRequest, action: 'pause' | 'resume' | 'cancel'): void {
    if (projection.team.id !== request.teamId) {
      throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${request.teamId} does not own this controller journal`)
    }
    const operationId = ControlOperationId(request.operationId)
    if (projection.reconciliationOperations[operationId] !== undefined || projection.attemptResolutionOperations[operationId] !== undefined
      || projection.attemptResolutionProofs[operationId] !== undefined || projection.recoveryClearOperations[operationId] !== undefined
      || projection.verificationVerdictOperations[operationId] !== undefined) {
      throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', `Control operation ${operationId} was already used for reconciliation`)
    }
    if (projection.taskRetryOperations[operationId] !== undefined) {
      throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', `Control operation ${operationId} was already used for a task retry`)
    }
    const previous = projection.controlOperations[operationId]
    if (previous !== undefined && previous.action !== action) {
      throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', `Control operation ${operationId} was already used for ${previous.action}`)
    }
  }
}

function resumeStatusEvents(
  projection: TeamProjection,
  teamId: string,
  operationId: ControlOperationId,
  clock: Clock,
  eventIds: EventIdSource,
) {
  const events: TeamEvent[] = [createTeamEvent(clock, eventIds, teamId, {
    type: 'yuqi/team-status-changed' as const,
    from: projection.team.status as 'paused' | 'pausing',
    to: 'running' as const,
    reason: `control operation ${operationId}`,
  })]
  if (projection.taskIds.length > 0 && teamCompletionReady(projection)) {
    events.push(createTeamEvent(clock, eventIds, teamId, {
      type: 'yuqi/team-status-changed', from: 'running', to: 'completed',
      reason: `control operation ${operationId} resumed a graph whose reviewer gate is satisfied`,
    }))
  }
  return events
}

function statusAllows(action: 'pause' | 'resume' | 'cancel', status: TeamProjection['team']['status']): boolean {
  if (action === 'pause') return status === 'running' || status === 'pausing'
  if (action === 'resume') return status === 'paused' || status === 'pausing'
  return status === 'running' || status === 'pausing' || status === 'paused' || status === 'needs_reconciliation'
}

function pauseStatusEvents(
  projection: TeamProjection,
  teamId: string,
  operationId: ControlOperationId,
  clock: Clock,
  eventIds: EventIdSource,
) {
  const events: TeamEvent[] = []
  if (projection.team.status === 'running') {
    events.push(createTeamEvent(clock, eventIds, teamId, {
      type: 'yuqi/team-status-changed' as const, from: 'running' as const, to: 'pausing' as const,
      reason: `control operation ${operationId}`,
    }))
  }
  if (!hasActiveAttempts(projection)) {
    events.push(createTeamEvent(clock, eventIds, teamId, {
      type: 'yuqi/team-status-changed' as const, from: 'pausing' as const, to: 'paused' as const,
      reason: 'no active attempts remain',
    }))
  }
  return events
}

function cancelStatusEvents(
  projection: TeamProjection,
  teamId: string,
  operationId: ControlOperationId,
  clock: Clock,
  eventIds: EventIdSource,
) {
  const events: TeamEvent[] = [createTeamEvent(clock, eventIds, teamId, {
    type: 'yuqi/team-status-changed' as const,
    from: projection.team.status as 'running' | 'pausing' | 'paused',
    to: 'cancelling' as const,
    reason: `control operation ${operationId}`,
  })]
  for (const taskId of projection.taskIds) {
    const task = projection.tasks[taskId]!
    if (!isSchedulableTaskStatus(task.status)) continue
    events.push(createTeamEvent(clock, eventIds, teamId, {
      type: 'yuqi/task-status-changed', taskId, from: task.status, to: 'cancelled',
      reason: `Team cancellation ${operationId}`,
    }))
  }
  if (!hasActiveAttempts(projection)) {
    events.push(createTeamEvent(clock, eventIds, teamId, {
      type: 'yuqi/team-status-changed' as const, from: 'cancelling' as const, to: 'cancelled' as const,
      reason: 'no active attempts remain',
    }))
  }
  return events
}

/** True while any admitted or not-yet-admitted child can still settle. */
export function hasActiveAttempts(projection: TeamProjection): boolean {
  return Object.values(projection.attempts).some(attempt => attempt.status === 'dispatching' || attempt.status === 'running')
    // A child may already be settled while its verification still owns the
    // task and file lease. Treat that as active control work so pause/cancel
    // cannot falsely become terminal in the middle of a verdict.
    || Object.values(projection.verifications).some(verification => verification.status === 'pending' || verification.status === 'running')
}

/**
 * True while recovery still owns any fact that the Host must account for.
 * Attempt status alone is insufficient: an old lease, verification, or token
 * reservation can otherwise leave `needs_reconciliation` with no safe clear.
 */
export function hasUnresolvedRecoveryFacts(projection: TeamProjection): boolean {
  return projectionHasReconciliationGap(projection)
    || Object.values(projection.attempts).some(attempt => attempt.status === 'dispatching' || attempt.status === 'running' || attempt.status === 'unknown')
    || Object.values(projection.verifications).some(verification => verification.status === 'pending' || verification.status === 'running')
    || Object.values(projection.fileLeases).some(lease => lease.status === 'active')
    || Object.values(projection.budgetReservations).some(reservation => reservation.status === 'active' || reservation.status === 'unknown')
}

/** The latest Team-level control action, unlike an arbitrary historical cancel, owns recovery closure. */
export function hasCurrentCancellationIntent(projection: TeamProjection): boolean {
  const operationId = projection.latestTeamControlOperationId
  return operationId !== undefined && projection.controlOperations[operationId]?.action === 'cancel'
}

function hasUnresolvedCancellationRuntime(projection: TeamProjection): boolean {
  return Object.values(projection.attempts).some(attempt => attempt.status === 'dispatching' || attempt.status === 'running' || attempt.status === 'unknown')
    || Object.values(projection.verifications).some(verification => verification.status === 'pending' || verification.status === 'running')
    || Object.values(projection.fileLeases).some(lease => lease.status === 'active')
    || Object.values(projection.budgetReservations).some(reservation => reservation.status === 'active' || reservation.status === 'unknown')
    || projectionHasReconciliationGap(projection)
}

function terminalCancellationEvents(
  projection: TeamProjection,
  teamId: string,
  clock: Clock,
  eventIds: EventIdSource,
  from: 'cancelling' | 'needs_reconciliation',
): TeamEvent[] {
  const taskEvents = projection.taskIds.flatMap(taskId => {
    const status = projection.tasks[taskId]!.status
    if (status === 'completed' || status === 'failed' || status === 'cancelled') return []
    return [createTeamEvent(clock, eventIds, teamId, {
      type: 'yuqi/task-status-changed' as const, taskId, from: status, to: 'cancelled' as const,
      reason: 'controller-less cancellation closed from durable journal facts',
    })]
  })
  return [...taskEvents, createTeamEvent(clock, eventIds, teamId, {
    type: 'yuqi/team-status-changed' as const, from, to: 'cancelled' as const,
    reason: 'durable journal proves no cancellation runtime remains',
  })]
}
