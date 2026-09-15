import { describe, expect, it } from 'vitest'
import { DurableJournalCoordinator } from '../src/application/durable-journal.ts'
import { OwnedLiveAttemptRecoveryCoordinator } from '../src/application/recover-owned-live-attempts.ts'
import { TeamReconciliationCoordinator } from '../src/application/reconcile-team.ts'
import { replayTeamEvents } from '../src/domain/projection.ts'
import type { AttemptRuntimeObservation, AttemptRuntimeObservationPort, AttemptRuntimeRef, Clock, EventIdSource, TeamEventJournal } from '../src/application/ports.ts'
import type { TeamEvent } from '../src/domain/events.ts'
import { ATTEMPT_ID, completeTeamEvents, TASK_ID, TEAM_ID } from './fixtures.ts'

class ClockStub implements Clock {
  #value = 0
  nowIso(): string { return `2026-09-13T12:00:${String(this.#value++).padStart(2, '0')}Z` }
}

class Ids implements EventIdSource {
  #value = 0
  readonly #prefix: string
  constructor(prefix = 'owned-live') { this.#prefix = prefix }
  next(): string { return `${this.#prefix}-${this.#value++}` }
}

class Journal implements TeamEventJournal {
  readonly key = 'controller-owned-live'
  readonly events: unknown[]
  readonly transactions: TeamEvent[][] = []
  constructor(events: readonly unknown[]) { this.events = [...events] }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> { this.transactions.push([...events]); this.events.push(...events) }
}

class LiveRuntime implements AttemptRuntimeObservationPort {
  async observe(request: { readonly attempts: readonly AttemptRuntimeRef[] }): Promise<readonly AttemptRuntimeObservation[]> {
    return request.attempts.map(attempt => ({ ...attempt, state: 'live' }))
  }
}

describe('OwnedLiveAttemptRecoveryCoordinator', () => {
  async function coldGate() {
    const transactions = new DurableJournalCoordinator()
    const journal = new Journal(completeTeamEvents().slice(0, 8))
    await new TeamReconciliationCoordinator(new ClockStub(), new Ids(), transactions).reconcile({
      teamId: TEAM_ID, parentSessionId: 'controller', operationId: 'startup-reconcile:owned-live',
    }, journal, new LiveRuntime())
    return { transactions, journal }
  }

  it('atomically restores only every exact locally owned live attempt from a startup gate', async () => {
    const { transactions, journal } = await coldGate()
    const recovery = new OwnedLiveAttemptRecoveryCoordinator(new ClockStub(), new Ids('owned-live-recovery'), transactions)
    const ownership = { hasActiveAttempt: (_journalKey: string, attemptId: string) => attemptId === String(ATTEMPT_ID) }

    const restored = await recovery.recover({ teamId: TEAM_ID, operationId: 'cold-owner-recovery:event-1' }, journal, ownership)
    expect(restored.team.status).toBe('running')
    expect(restored.attempts[ATTEMPT_ID]?.status).toBe('running')
    expect(journal.transactions.at(-1)?.map(event => event.type)).toEqual([
      'yuqi/attempt-status-changed', 'yuqi/team-status-changed',
    ])
    const count = journal.transactions.length
    await expect(recovery.recover({ teamId: TEAM_ID, operationId: 'cold-owner-recovery:event-1' }, journal, ownership))
      .resolves.toEqual(restored)
    expect(journal.transactions).toHaveLength(count)
    await transactions.dispose()
  })

  it('retains the gate for an unowned live attempt and never emits a replacement dispatch', async () => {
    const { transactions, journal } = await coldGate()
    const recovery = new OwnedLiveAttemptRecoveryCoordinator(new ClockStub(), new Ids('owned-live-recovery'), transactions)

    const retained = await recovery.recover({ teamId: TEAM_ID, operationId: 'cold-owner-recovery:event-1' }, journal, {
      hasActiveAttempt: () => false,
    })
    expect(retained.team.status).toBe('needs_reconciliation')
    expect(retained.attempts[ATTEMPT_ID]?.status).toBe('unknown')
    expect(journal.transactions).toHaveLength(1)
    expect(replayTeamEvents(journal.read()).taskIds).toEqual([TASK_ID])
    await transactions.dispose()
  })
})
