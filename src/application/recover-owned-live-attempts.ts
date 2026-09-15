/** Restore only a cold-reconciliation cut that this exact Host can still prove it owns. */

import { hasCurrentCancellationIntent } from './control-team.ts'
import { DurableJournalCoordinator } from './durable-journal.ts'
import { createTeamEvent, validateTeamEvents } from './team-events.ts'
import { AttemptId, TaskId } from '../domain/ids.ts'
import { parseTeamEvent, replayTeamEvents } from '../domain/projection.ts'
import type { TeamEvent } from '../domain/events.ts'
import type { Clock, EventIdSource, TeamEventJournal } from './ports.ts'

export interface LocalAttemptOwnershipPort {
  hasActiveAttempt(journalKey: string, attemptId: string): boolean
}

export interface RecoverOwnedLiveAttemptsRequest {
  readonly teamId: string
  /** Stable identity of the exact cold-reconciliation cut being corrected. */
  readonly operationId: string
}

/**
 * A startup reconciliation can only be undone when every unresolved attempt
 * remains under this Host's in-memory batch ownership.  Durable child history
 * alone is deliberately insufficient: after a restart it cannot establish
 * who may continue or settle a live writer.
 */
export class OwnedLiveAttemptRecoveryCoordinator {
  readonly #clock: Clock
  readonly #eventIds: EventIdSource
  readonly #transactions: DurableJournalCoordinator

  constructor(clock: Clock, eventIds: EventIdSource, transactions: DurableJournalCoordinator) {
    this.#clock = clock
    this.#eventIds = eventIds
    this.#transactions = transactions
  }

  async recover(
    request: RecoverOwnedLiveAttemptsRequest,
    journal: TeamEventJournal,
    ownership: LocalAttemptOwnershipPort,
  ) {
    return this.#transactions.run(journal, async transaction => {
      const facts = transaction.read().map(parseTeamEvent)
      const current = replayTeamEvents(facts)
      const attempts = recoverableAttempts(facts, current, request.teamId, journal.key, ownership)
      if (attempts === undefined) return current
      // Ownership is an in-memory fact, so check it again immediately before
      // the sole durable write.  A lost callback leaves this cut closed.
      if (!attempts.every(attempt => ownership.hasActiveAttempt(journal.key, String(attempt.id)))) return current

      const reason = `cold-owner-recovery operation ${request.operationId}`
      const events: TeamEvent[] = [
        ...attempts.map(attempt => createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
          type: 'yuqi/attempt-status-changed' as const,
          taskId: TaskId(String(attempt.taskId)), attemptId: AttemptId(String(attempt.id)),
          from: 'unknown' as const, to: 'running' as const, reason,
        })),
        createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
          type: 'yuqi/team-status-changed' as const,
          from: 'needs_reconciliation' as const, to: 'running' as const, reason,
        }),
      ]
      const next = validateTeamEvents(transaction.read(), events)
      // Do not commit a partially proven recovery if the local executor lost
      // an attempt while the durable batch was being prepared.
      if (!attempts.every(attempt => ownership.hasActiveAttempt(journal.key, String(attempt.id)))) return current
      await transaction.commit(events, 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably confirm locally owned live attempts')
      return next
    })
  }
}

function recoverableAttempts(
  facts: readonly TeamEvent[],
  projection: ReturnType<typeof replayTeamEvents>,
  teamId: string,
  journalKey: string,
  ownership: LocalAttemptOwnershipPort,
) {
  if (projection.team.id !== teamId || projection.team.status !== 'needs_reconciliation') return undefined
  if (!openedByColdReconciliation(facts) || hasCurrentCancellationIntent(projection)) return undefined
  const latestControl = projection.latestTeamControlOperationId
  if (latestControl !== undefined && projection.controlOperations[latestControl]?.action === 'pause') return undefined
  if (projection.team.manualOwnership?.state === 'human-owned'
    || Object.values(projection.reviews).some(review => review.status === 'requested')
    || projection.workspace?.status === 'needs_reconciliation') return undefined

  const unresolved = Object.values(projection.attempts)
    .filter(attempt => attempt.status === 'dispatching' || attempt.status === 'running' || attempt.status === 'unknown')
  // Mixed cuts are intentionally not repaired.  The startup reconciler maps a
  // wholly unresolved cold cut to unknown; a remaining running/dispatching
  // member means a later or foreign writer may have changed the facts.
  if (unresolved.length === 0 || unresolved.some(attempt => attempt.status !== 'unknown')) return undefined
  if (!unresolved.every(attempt => {
    const task = projection.tasks[attempt.taskId]
    const operationId = projection.latestReconciliationOperationIds[attempt.id]
    const observation = operationId === undefined
      ? undefined
      : projection.reconciliationOperations[operationId]?.observations.find(item => item.attemptId === attempt.id)
    return task?.status === 'running'
      && attempt.agentSessionId !== undefined && attempt.messageId !== undefined
      && observation?.state === 'live' && observation.childSessionId === attempt.agentSessionId
      && ownership.hasActiveAttempt(journalKey, String(attempt.id))
  })) return undefined
  return unresolved
}

/** Only repair the specific gate produced by a startup cold scan. */
function openedByColdReconciliation(facts: readonly TeamEvent[]): boolean {
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    const event = facts[index]!
    if (event.type !== 'yuqi/team-status-changed') continue
    return event.to === 'needs_reconciliation'
      && event.reason?.startsWith('reconciliation operation startup-reconcile:') === true
  }
  return false
}
