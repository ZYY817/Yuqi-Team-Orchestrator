import { describe, expect, it } from 'vitest'
import {
  DurableJournalCoordinator,
  ControlOperationId,
  hasCurrentCancellationIntent,
  TeamControlCoordinator,
  replayTeamEvents,
} from '../src/index.ts'
import type { Clock, EventIdSource, TeamEvent, TeamEventJournal } from '../src/index.ts'
import { ATTEMPT_ID, completeTeamEvents, event, TASK_ID, TEAM_ID, verificationOperationEvents } from './fixtures.ts'

class ClockStub implements Clock {
  #value = 0
  nowIso(): string { return `2026-08-15T14:00:${String(this.#value++).padStart(2, '0')}Z` }
}

class Ids implements EventIdSource {
  #value = 0
  next(): string { return `control-event-${this.#value++}` }
}

class Journal implements TeamEventJournal {
  readonly key = 'control-controller'
  readonly events: unknown[]
  readonly transactions: TeamEvent[][] = []
  fail = false
  constructor(events: readonly unknown[]) { this.events = [...events] }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> {
    if (this.fail) throw new Error('flush failed')
    this.transactions.push([...events])
    this.events.push(...events)
  }
}

function runningEvents(): readonly TeamEvent[] {
  return completeTeamEvents().slice(0, 2)
}

function activeEvents(): readonly TeamEvent[] {
  return completeTeamEvents().slice(0, 8)
}

describe('TeamControlCoordinator', () => {
  it('rejects a verification-verdict operation id before changing Team state', async () => {
    const journal = new Journal(verificationOperationEvents('verdict-control-conflict'))
    const transactions = new DurableJournalCoordinator()
    const controls = new TeamControlCoordinator(new ClockStub(), new Ids(), transactions)
    await expect(controls.pause({ teamId: TEAM_ID, operationId: 'verdict-control-conflict' }, journal))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    expect(journal.transactions).toHaveLength(0)
    await transactions.dispose()
  })

  it('pauses immediately when no attempt is active and resumes durably', async () => {
    const journal = new Journal(runningEvents())
    const transactions = new DurableJournalCoordinator()
    const controls = new TeamControlCoordinator(new ClockStub(), new Ids(), transactions)

    const paused = await controls.pause({ teamId: TEAM_ID, operationId: 'pause-1' }, journal)
    expect(paused.team.status).toBe('paused')
    expect(journal.transactions[0]?.map(item => item.type)).toEqual([
      'yuqi/team-control-requested', 'yuqi/team-status-changed', 'yuqi/team-status-changed',
    ])
    const resumed = await controls.resume({ teamId: TEAM_ID, operationId: 'resume-1' }, journal)
    expect(resumed.team.status).toBe('running')
    expect(resumed.controlOperations['pause-1']?.action).toBe('pause')
    expect(resumed.controlOperations['resume-1']?.action).toBe('resume')
    await transactions.dispose()
  })

  it('resuming after the final settlement race closes the completed graph atomically', async () => {
    const journal = new Journal(completeTeamEvents().slice(0, 16))
    const transactions = new DurableJournalCoordinator()
    const controls = new TeamControlCoordinator(new ClockStub(), new Ids(), transactions)

    await expect(controls.pause({ teamId: TEAM_ID, operationId: 'pause-after-complete' }, journal))
      .resolves.toMatchObject({ team: { status: 'paused' } })
    const resumed = await controls.resume({ teamId: TEAM_ID, operationId: 'resume-after-complete' }, journal)

    expect(resumed.team.status).toBe('completed')
    expect(journal.transactions.at(-1)?.map(item => item.type)).toEqual([
      'yuqi/team-control-requested',
      'yuqi/team-status-changed',
      'yuqi/team-status-changed',
    ])
    await transactions.dispose()
  })

  it('enters pausing while an attempt is active and blocks schedule progression', async () => {
    const journal = new Journal(activeEvents())
    const transactions = new DurableJournalCoordinator()
    const controls = new TeamControlCoordinator(new ClockStub(), new Ids(), transactions)
    const projection = await controls.pause({ teamId: TEAM_ID, operationId: 'pause-active' }, journal)
    expect(projection.team.status).toBe('pausing')
    await transactions.dispose()
  })

  it('allows resuming while in pausing status', async () => {
    const journal = new Journal(activeEvents())
    const transactions = new DurableJournalCoordinator()
    const controls = new TeamControlCoordinator(new ClockStub(), new Ids(), transactions)
    const pausing = await controls.pause({ teamId: TEAM_ID, operationId: 'pause-active' }, journal)
    expect(pausing.team.status).toBe('pausing')
    const resumed = await controls.resume({ teamId: TEAM_ID, operationId: 'resume-active' }, journal)
    expect(resumed.team.status).toBe('running')
    await transactions.dispose()
  })

  it('keeps pause and cancel non-terminal while verification is still active', async () => {
    const verifying = completeTeamEvents().slice(0, 13)
    const transactions = new DurableJournalCoordinator()
    const controls = new TeamControlCoordinator(new ClockStub(), new Ids(), transactions)

    await expect(controls.pause({ teamId: TEAM_ID, operationId: 'pause-verifying' }, new Journal(verifying)))
      .resolves.toMatchObject({ team: { status: 'pausing' } })
    await expect(controls.cancel({ teamId: TEAM_ID, operationId: 'cancel-verifying' }, new Journal(verifying)))
      .resolves.toMatchObject({ team: { status: 'cancelling' } })
    await transactions.dispose()
  })

  it('cancels immediately without active attempts and waits when attempts are active', async () => {
    const transactions = new DurableJournalCoordinator()
    const controls = new TeamControlCoordinator(new ClockStub(), new Ids(), transactions)
    const idleJournal = new Journal(runningEvents())
    await expect(controls.cancel({ teamId: TEAM_ID, operationId: 'cancel-idle' }, idleJournal))
      .resolves.toMatchObject({ team: { status: 'cancelled' } })

    const readyJournal = new Journal(completeTeamEvents().slice(0, 4))
    const cancelledReady = await controls.cancel({ teamId: TEAM_ID, operationId: 'cancel-ready' }, readyJournal)
    expect(cancelledReady).toMatchObject({ team: { status: 'cancelled' }, tasks: { [TASK_ID]: { status: 'cancelled' } } })
    expect(readyJournal.transactions[0]?.map(item => item.type)).toEqual([
      'yuqi/team-control-requested', 'yuqi/team-status-changed', 'yuqi/task-status-changed', 'yuqi/team-status-changed',
    ])

    const activeJournal = new Journal(activeEvents())
    await expect(controls.cancel({ teamId: TEAM_ID, operationId: 'cancel-active' }, activeJournal))
      .resolves.toMatchObject({ team: { status: 'cancelling' } })
    await expect(controls.cancel({ teamId: TEAM_ID, operationId: 'cancel-again' }, idleJournal))
      .rejects.toMatchObject({ code: 'CONTROL_NOT_ALLOWED' })

    const pausingJournal = new Journal(activeEvents())
    await controls.pause({ teamId: TEAM_ID, operationId: 'pause-before-cancel' }, pausingJournal)
    await expect(controls.cancel({ teamId: TEAM_ID, operationId: 'cancel-pausing' }, pausingJournal))
      .resolves.toMatchObject({ team: { status: 'cancelling' } })

    const pausedJournal = new Journal(runningEvents())
    await controls.pause({ teamId: TEAM_ID, operationId: 'pause-before-idle-cancel' }, pausedJournal)
    await expect(controls.cancel({ teamId: TEAM_ID, operationId: 'cancel-paused' }, pausedJournal))
      .resolves.toMatchObject({ team: { status: 'cancelled' } })
    await transactions.dispose()
  })

  it('records cancellation runtime uncertainty once and rejects invalid origins', async () => {
    const transactions = new DurableJournalCoordinator()
    const controls = new TeamControlCoordinator(new ClockStub(), new Ids(), transactions)
    const journal = new Journal(activeEvents())
    await controls.cancel({ teamId: TEAM_ID, operationId: 'cancel-uncertain' }, journal)
    const uncertain = await controls.markCancellationUncertain(TEAM_ID, journal, 'runtime binding missing')
    expect(uncertain.team.status).toBe('needs_reconciliation')
    await expect(controls.markCancellationUncertain(TEAM_ID, journal, 'duplicate')).resolves.toEqual(uncertain)

    const running = new Journal(runningEvents())
    await expect(controls.markCancellationUncertain(TEAM_ID, running, 'invalid'))
      .rejects.toMatchObject({ code: 'CONTROL_NOT_ALLOWED' })
    await expect(controls.markCancellationUncertain('other-team', running, 'wrong team'))
      .rejects.toMatchObject({ code: 'TEAM_MISMATCH' })

    const cancelled = new Journal([
      ...activeEvents(),
      event(299, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('cancel-race'), action: 'cancel' }),
      event(300, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling' }),
      event(301, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'cancelled' }),
      event(302, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'cancelled' }),
      event(303, { type: 'yuqi/team-status-changed', from: 'cancelling', to: 'cancelled' }),
    ])
    await expect(controls.markCancellationUncertain(TEAM_ID, cancelled, 'terminal won race'))
      .resolves.toMatchObject({ team: { status: 'cancelled' } })
    await transactions.dispose()
  })

  it('persists controller-less cancellation once and never retries an unknown runtime result', async () => {
    const journal = new Journal(activeEvents())
    const transactions = new DurableJournalCoordinator()
    const controls = new TeamControlCoordinator(new ClockStub(), new Ids(), transactions)

    const uncertain = await controls.cancelWithoutController({ teamId: TEAM_ID, operationId: 'dormant-cancel' }, journal)
    expect(uncertain.team.status).toBe('needs_reconciliation')
    expect(journal.transactions[0]?.map(item => item.type)).toEqual([
      'yuqi/team-control-requested', 'yuqi/team-status-changed', 'yuqi/team-status-changed',
    ])
    const transactionCount = journal.transactions.length
    await expect(controls.cancelWithoutController({ teamId: TEAM_ID, operationId: 'dormant-cancel' }, journal))
      .resolves.toEqual(uncertain)
    const freshIntent = await controls.cancelWithoutController({ teamId: TEAM_ID, operationId: 'fresh-blind-retry' }, journal)
    expect(freshIntent.team.status).toBe('needs_reconciliation')
    expect(journal.transactions).toHaveLength(transactionCount + 1)
    await transactions.dispose()
  })

  it('persists a cancellation intent in recovery without closing unknown runtime facts', async () => {
    const transactions = new DurableJournalCoordinator()
    const controls = new TeamControlCoordinator(new ClockStub(), new Ids(), transactions)
    const journal = new Journal(activeEvents())
    await controls.cancel({ teamId: TEAM_ID, operationId: 'cancel-before-recovery' }, journal)
    await controls.markCancellationUncertain(TEAM_ID, journal, 'runtime binding missing')

    const before = journal.transactions.length
    const retained = await controls.cancelWithDisposition({ teamId: TEAM_ID, operationId: 'review-cancel-recovery' }, journal)
    expect(retained.projection.team.status).toBe('needs_reconciliation')
    expect(journal.transactions.at(-1)?.map(item => item.type)).toEqual(['yuqi/team-control-requested'])
    expect(journal.transactions).toHaveLength(before + 1)
    await transactions.dispose()
  })

  it('closes a quiescent reconciliation graph from durable cancellation facts', async () => {
    const journal = new Journal([
      ...completeTeamEvents().slice(0, 4),
      event(290, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation', reason: 'controller lost' }),
    ])
    const transactions = new DurableJournalCoordinator()
    const controls = new TeamControlCoordinator(new ClockStub(), new Ids(), transactions)

    const cancelled = await controls.cancelWithoutController({ teamId: TEAM_ID, operationId: 'dormant-close' }, journal)
    expect(cancelled).toMatchObject({ team: { status: 'cancelled' }, tasks: { [TASK_ID]: { status: 'cancelled' } } })
    expect(journal.transactions[0]?.map(item => item.type)).toEqual([
      'yuqi/team-control-requested', 'yuqi/task-status-changed', 'yuqi/team-status-changed',
    ])
    await transactions.dispose()
  })

  it('repairs schedulable tasks while closing a legacy quiescent cancelling graph', async () => {
    const journal = new Journal([
      ...completeTeamEvents().slice(0, 4),
      event(291, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('legacy-cancel'), action: 'cancel' }),
      event(292, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling', reason: 'legacy partial cancel' }),
    ])
    const transactions = new DurableJournalCoordinator()
    const controls = new TeamControlCoordinator(new ClockStub(), new Ids(), transactions)

    const cancelled = await controls.cancelWithoutController({ teamId: TEAM_ID, operationId: 'close-legacy-cancel' }, journal)
    expect(cancelled).toMatchObject({ team: { status: 'cancelled' }, tasks: { [TASK_ID]: { status: 'cancelled' } } })
    expect(journal.transactions[0]?.map(item => item.type)).toEqual(['yuqi/task-status-changed', 'yuqi/team-status-changed'])
    await transactions.dispose()
  })

  it('returns the durable result without another commit for the same operation', async () => {
    const journal = new Journal(runningEvents())
    const transactions = new DurableJournalCoordinator()
    const controls = new TeamControlCoordinator(new ClockStub(), new Ids(), transactions)
    await controls.pause({ teamId: TEAM_ID, operationId: 'same-operation' }, journal)
    const transactionCount = journal.transactions.length
    const replayed = await controls.pause({ teamId: TEAM_ID, operationId: 'same-operation' }, journal)
    expect(replayed.team.status).toBe('paused')
    expect(journal.transactions).toHaveLength(transactionCount)
    await transactions.dispose()
  })

  it('rejects operation id reuse for another action and invalid lifecycle states', async () => {
    const journal = new Journal(runningEvents())
    const transactions = new DurableJournalCoordinator()
    const controls = new TeamControlCoordinator(new ClockStub(), new Ids(), transactions)
    await controls.pause({ teamId: TEAM_ID, operationId: 'collision' }, journal)
    await expect(controls.resume({ teamId: TEAM_ID, operationId: 'collision' }, journal))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await expect(controls.pause({ teamId: TEAM_ID, operationId: 'pause-again' }, journal))
      .rejects.toMatchObject({ code: 'CONTROL_NOT_ALLOWED' })
    await transactions.dispose()
  })

  it('does not record an operation when persistence fails and poisons later control', async () => {
    const journal = new Journal(runningEvents())
    journal.fail = true
    const transactions = new DurableJournalCoordinator()
    const controls = new TeamControlCoordinator(new ClockStub(), new Ids(), transactions)
    await expect(controls.pause({ teamId: TEAM_ID, operationId: 'failed' }, journal))
      .rejects.toMatchObject({ code: 'INTENT_PERSISTENCE_FAILED' })
    expect(replayTeamEvents(journal.read()).controlOperations['failed']).toBeUndefined()
    await expect(controls.pause({ teamId: TEAM_ID, operationId: 'after-failure' }, journal))
      .rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    await transactions.dispose()
  })

  it('rejects another Team identity before writing', async () => {
    const journal = new Journal(runningEvents())
    const transactions = new DurableJournalCoordinator()
    const controls = new TeamControlCoordinator(new ClockStub(), new Ids(), transactions)
    await expect(controls.pause({ teamId: 'other-team', operationId: 'wrong-team' }, journal))
      .rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    expect(journal.transactions).toHaveLength(0)
    await transactions.dispose()
  })
})

describe('Team control event replay', () => {
  it('deduplicates the same operation fact and rejects conflicting reuse', () => {
    const pause = event(30, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('op-1'), action: 'pause' })
    const duplicate = event(31, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('op-1'), action: 'pause' })
    expect(replayTeamEvents([...runningEvents(), pause, duplicate]).controlOperations['op-1']?.action).toBe('pause')
    expect(() => replayTeamEvents([
      ...runningEvents(), pause,
      event(32, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('op-1'), action: 'resume' }),
    ])).toThrowError(/already used/)
  })

  it('treats only the latest Team control action as a live cancellation intent', () => {
    const cancelledThenResumed = replayTeamEvents([
      ...runningEvents(),
      event(33, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('old-cancel'), action: 'cancel' }),
      event(34, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('later-resume'), action: 'resume' }),
    ])
    expect(hasCurrentCancellationIntent(cancelledThenResumed)).toBe(false)
  })
})
