import { describe, expect, it } from 'vitest'
import {
  ControlOperationId,
  DurableJournalCoordinator,
  replayTeamEvents,
  TaskId,
  TeamControlCoordinator,
  TeamReconciliationCoordinator,
} from '../src/index.ts'
import type {
  AttemptRuntimeObservation,
  AttemptRuntimeObservationPort,
  AttemptRuntimeRef,
  Clock,
  EventIdSource,
  TeamEvent,
  TeamEventJournal,
} from '../src/index.ts'
import { ATTEMPT_ID, completeTeamEvents, event, TASK_ID, TEAM_ID, verificationOperationEvents } from './fixtures.ts'

class ClockStub implements Clock {
  #value = 0
  nowIso(): string { return `2026-08-15T16:00:${String(this.#value++).padStart(2, '0')}Z` }
}

class Ids implements EventIdSource {
  #value = 0
  readonly #prefix: string
  constructor(prefix = 'reconcile-event') { this.#prefix = prefix }
  next(): string { return `${this.#prefix}-${this.#value++}` }
}

class Journal implements TeamEventJournal {
  readonly key: string
  readonly events: unknown[]
  readonly transactions: TeamEvent[][] = []
  fail = false
  constructor(events: readonly unknown[], key = 'reconcile-controller') { this.events = [...events]; this.key = key }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> {
    if (this.fail) throw new Error('flush failed')
    this.transactions.push([...events]); this.events.push(...events)
  }
}

class Runtime implements AttemptRuntimeObservationPort {
  calls = 0
  barrier: Promise<void> | undefined
  transform: (attempt: AttemptRuntimeRef) => AttemptRuntimeObservation = attempt => ({
    ...attempt,
    state: attempt.childSessionId === undefined ? 'not-admitted' : 'live',
  })
  async observe(request: { readonly attempts: readonly AttemptRuntimeRef[] }): Promise<readonly AttemptRuntimeObservation[]> {
    this.calls += 1
    if (this.barrier !== undefined) await this.barrier
    return request.attempts.map(this.transform)
  }
}

function dispatchingEvents(): readonly TeamEvent[] { return completeTeamEvents().slice(0, 6) }
function recoverableDispatchingEvents(): readonly TeamEvent[] {
  return [
    ...completeTeamEvents().slice(0, 5),
    event(290, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId: ATTEMPT_ID, ordinal: 1, modelProvider: 'deepseek', modelId: 'deepseek-v4', recoveryToken: 'recoverable_token' }),
  ]
}
function runningEvents(): readonly TeamEvent[] { return completeTeamEvents().slice(0, 8) }
function unknownEvents(): readonly TeamEvent[] {
  return [
    ...runningEvents(),
    event(300, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'unknown' }),
    event(301, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
  ]
}

describe('TeamReconciliationCoordinator', () => {
  it('records an unadmitted dispatch as unknown and moves the Team to reconciliation', async () => {
    const journal = new Journal(dispatchingEvents())
    const runtime = new Runtime()
    const transactions = new DurableJournalCoordinator()
    const coordinator = new TeamReconciliationCoordinator(new ClockStub(), new Ids(), transactions)
    const projection = await coordinator.reconcile({
      teamId: TEAM_ID, parentSessionId: 'controller', operationId: 'scan-dispatching', signal: new AbortController().signal,
    }, journal, runtime)
    expect(projection.team.status).toBe('needs_reconciliation')
    expect(projection.attempts[ATTEMPT_ID]?.status).toBe('unknown')
    expect(projection.reconciliationOperations['scan-dispatching']?.observations)
      .toEqual([{ taskId: TASK_ID, attemptId: ATTEMPT_ID, state: 'not-admitted' }])
    expect(journal.transactions[0]?.map(item => item.type)).toEqual([
      'yuqi/reconciliation-observed', 'yuqi/team-status-changed',
    ])
    await transactions.dispose()
  })

  it('persists no-child diagnostic and unavailable observations instead of leaving a Team runnable', async () => {
    for (const state of ['diagnostic', 'unavailable'] as const) {
      const journal = new Journal(dispatchingEvents(), `unbound-${state}`)
      const runtime = new Runtime()
      runtime.transform = attempt => ({ ...attempt, state, reason: `host ${state}` })
      const transactions = new DurableJournalCoordinator()
      const coordinator = new TeamReconciliationCoordinator(new ClockStub(), new Ids(`unbound-${state}`), transactions)
      const projection = await coordinator.reconcile({
        teamId: TEAM_ID, parentSessionId: 'controller', operationId: `scan-${state}`,
      }, journal, runtime)
      expect(projection.team.status).toBe('needs_reconciliation')
      expect(projection.attempts[ATTEMPT_ID]?.status).toBe('unknown')
      expect(projection.reconciliationOperations[`scan-${state}`]?.observations[0])
        .toMatchObject({ state, reason: `host ${state}` })
      await transactions.dispose()
    }
  })

  it('records a live admitted child once and leaves an already reconciling Team unchanged', async () => {
    const journal = new Journal(unknownEvents())
    const runtime = new Runtime()
    const transactions = new DurableJournalCoordinator()
    const coordinator = new TeamReconciliationCoordinator(new ClockStub(), new Ids(), transactions)
    const first = await coordinator.reconcile({
      teamId: TEAM_ID, parentSessionId: 'controller', operationId: 'scan-live',
    }, journal, runtime)
    expect(first.reconciliationOperations['scan-live']?.observations[0]).toMatchObject({
      childSessionId: 'session-worker-1', state: 'live',
    })
    expect(journal.transactions[0]).toHaveLength(1)
    const count = journal.transactions.length
    await expect(coordinator.reconcile({
      teamId: TEAM_ID, parentSessionId: 'controller', operationId: 'scan-live',
    }, journal, runtime)).resolves.toEqual(first)
    expect(runtime.calls).toBe(1)
    expect(journal.transactions).toHaveLength(count)
    await transactions.dispose()
  })

  it('keeps a live child fail-closed when its Host ownership is not established locally', async () => {
    const journal = new Journal(runningEvents(), 'unowned-live-child')
    const runtime = new Runtime()
    const transactions = new DurableJournalCoordinator()
    const projection = await new TeamReconciliationCoordinator(new ClockStub(), new Ids(), transactions).reconcile({
      teamId: TEAM_ID, parentSessionId: 'controller', operationId: 'scan-unowned-live',
    }, journal, runtime)

    expect(projection.team.status).toBe('needs_reconciliation')
    expect(projection.attempts[ATTEMPT_ID]?.status).toBe('unknown')
    expect(journal.transactions[0]?.map(item => item.type)).toEqual([
      'yuqi/reconciliation-observed', 'yuqi/team-status-changed',
    ])
    await transactions.dispose()
  })

  it('persists a uniquely recovered child identity before recording its unresolved observation', async () => {
    const journal = new Journal(recoverableDispatchingEvents())
    const runtime = new Runtime()
    runtime.transform = attempt => ({
      ...attempt, childSessionId: 'recovered-child', state: 'live', recoveredChild: true,
    })
    const transactions = new DurableJournalCoordinator()
    const coordinator = new TeamReconciliationCoordinator(new ClockStub(), new Ids(), transactions)
    const projection = await coordinator.reconcile({
      teamId: TEAM_ID, parentSessionId: 'controller', operationId: 'recover-child',
    }, journal, runtime)
    expect(projection.attempts[ATTEMPT_ID]).toMatchObject({ agentSessionId: 'recovered-child', status: 'unknown' })
    expect(projection.attempts[ATTEMPT_ID]?.messageId).toBeUndefined()
    expect(journal.transactions[0]?.map(item => item.type)).toEqual([
      'yuqi/attempt-child-recovered', 'yuqi/reconciliation-observed', 'yuqi/team-status-changed',
    ])
    await transactions.dispose()
  })

  it('rejects stale and incomplete runtime observations before persistence', async () => {
    let release!: () => void
    const runtime = new Runtime()
    runtime.barrier = new Promise<void>(resolve => { release = resolve })
    const journal = new Journal(runningEvents())
    const transactions = new DurableJournalCoordinator()
    const coordinator = new TeamReconciliationCoordinator(new ClockStub(), new Ids(), transactions)
    const pending = coordinator.reconcile({
      teamId: TEAM_ID, parentSessionId: 'controller', operationId: 'scan-stale',
    }, journal, runtime)
    journal.events.push(event(310, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }))
    release()
    await expect(pending).rejects.toMatchObject({ code: 'RECONCILIATION_STALE' })
    expect(journal.transactions).toHaveLength(0)

    const incomplete = new Runtime(); incomplete.transform = attempt => ({ ...attempt, attemptId: 'wrong-attempt', state: 'live' })
    await expect(coordinator.reconcile({
      teamId: TEAM_ID, parentSessionId: 'controller', operationId: 'scan-incomplete',
    }, new Journal(runningEvents(), 'incomplete'), incomplete)).rejects.toMatchObject({ code: 'RECONCILIATION_NOT_ALLOWED' })
    const missing = new Runtime()
    missing.observe = async () => []
    await expect(coordinator.reconcile({
      teamId: TEAM_ID, parentSessionId: 'controller', operationId: 'scan-missing',
    }, new Journal(runningEvents(), 'missing'), missing)).rejects.toMatchObject({ code: 'RECONCILIATION_NOT_ALLOWED' })
    await transactions.dispose()
  })

  it('accepts a concurrent identical operation without a second commit', async () => {
    let release!: () => void
    const runtime = new Runtime(); runtime.barrier = new Promise<void>(resolve => { release = resolve })
    const journal = new Journal(runningEvents(), 'concurrent-same-operation')
    const transactions = new DurableJournalCoordinator()
    const coordinator = new TeamReconciliationCoordinator(new ClockStub(), new Ids(), transactions)
    const pending = coordinator.reconcile({
      teamId: TEAM_ID, parentSessionId: 'controller', operationId: 'same-operation',
    }, journal, runtime)
    journal.events.push(
      event(315, { type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('same-operation'), observations: [{ taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'session-worker-1', state: 'live' }] }),
      event(316, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    )
    release()
    await expect(pending).resolves.toMatchObject({ team: { status: 'needs_reconciliation' } })
    expect(journal.transactions).toHaveLength(0)
    await transactions.dispose()
  })

  it('rejects no-op, wrong-Team, conflicting-operation, and terminal-Team scans', async () => {
    const transactions = new DurableJournalCoordinator()
    const coordinator = new TeamReconciliationCoordinator(new ClockStub(), new Ids(), transactions)
    const runtime = new Runtime()
    await expect(coordinator.reconcile({
      teamId: TEAM_ID, parentSessionId: 'controller', operationId: 'none',
    }, new Journal(completeTeamEvents(), 'none'), runtime)).rejects.toMatchObject({ code: 'RECONCILIATION_NOT_REQUIRED' })
    await expect(coordinator.reconcile({
      teamId: 'other-team', parentSessionId: 'controller', operationId: 'wrong-team',
    }, new Journal(runningEvents(), 'wrong-team'), runtime)).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })

    const controlOperation = event(320, {
      type: 'yuqi/team-control-requested', operationId: ControlOperationId('shared-reconcile'), action: 'pause',
    })
    await expect(coordinator.reconcile({
      teamId: TEAM_ID, parentSessionId: 'controller', operationId: 'shared-reconcile',
    }, new Journal([...runningEvents(), controlOperation], 'conflict'), runtime)).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })

    const callsBeforeVerdictConflict = runtime.calls
    await expect(coordinator.reconcile({
      teamId: TEAM_ID, parentSessionId: 'controller', operationId: 'verdict-reconcile-conflict',
    }, new Journal(verificationOperationEvents('verdict-reconcile-conflict'), 'verdict-conflict'), runtime))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    expect(runtime.calls).toBe(callsBeforeVerdictConflict)

    const terminal = [
      ...unknownEvents().slice(0, -1),
      event(321, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling' }),
      event(322, { type: 'yuqi/team-status-changed', from: 'cancelling', to: 'cancelled' }),
    ]
    await expect(coordinator.reconcile({
      teamId: TEAM_ID, parentSessionId: 'controller', operationId: 'terminal',
    }, new Journal(terminal, 'terminal'), runtime)).rejects.toMatchObject({ code: 'RECONCILIATION_NOT_ALLOWED' })
    await transactions.dispose()
  })

  it('returns a quiescent reconciliation gate without calling runtime observation', async () => {
    const journal = new Journal([
      ...completeTeamEvents().slice(0, 4),
      event(323, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation', reason: 'stale gate' }),
    ], 'quiescent-gate')
    const transactions = new DurableJournalCoordinator()
    const runtime = new Runtime()
    const projection = await new TeamReconciliationCoordinator(new ClockStub(), new Ids(), transactions).reconcile({
      teamId: TEAM_ID, parentSessionId: 'controller', operationId: 'quiescent-scan',
    }, journal, runtime)

    expect(projection.team.status).toBe('needs_reconciliation')
    expect(runtime.calls).toBe(0)
    expect(journal.transactions).toHaveLength(0)
    await transactions.dispose()
  })

  it('poisons subsequent scans when the reconciliation facts cannot flush', async () => {
    const journal = new Journal(runningEvents()); journal.fail = true
    const transactions = new DurableJournalCoordinator()
    const coordinator = new TeamReconciliationCoordinator(new ClockStub(), new Ids(), transactions)
    const runtime = new Runtime()
    await expect(coordinator.reconcile({
      teamId: TEAM_ID, parentSessionId: 'controller', operationId: 'flush-failure',
    }, journal, runtime)).rejects.toMatchObject({ code: 'INTENT_PERSISTENCE_FAILED' })
    await expect(coordinator.reconcile({
      teamId: TEAM_ID, parentSessionId: 'controller', operationId: 'after-poison',
    }, journal, runtime)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    await transactions.dispose()
  })
})

describe('reconciliation event replay', () => {
  it('deduplicates exact observations and rejects identity, status, and operation collisions', () => {
    const observation = event(330, {
      type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('domain-scan'),
      observations: [{ taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'session-worker-1', state: 'durable' }],
    })
    const duplicate = event(331, {
      type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('domain-scan'),
      observations: [{ taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'session-worker-1', state: 'durable' }],
    })
    expect(replayTeamEvents([...runningEvents(), observation, duplicate]).attempts[ATTEMPT_ID]?.status).toBe('unknown')
    expect(() => replayTeamEvents([
      ...runningEvents(), observation,
      event(332, { type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('domain-scan'), observations: [{ taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'session-worker-1', state: 'missing' }] }),
    ])).toThrowError(/different observations/)
    expect(() => replayTeamEvents([
      ...runningEvents(),
      event(3321, { type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('duplicate-attempt'), observations: [
        { taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'session-worker-1', state: 'live' },
        { taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'session-worker-1', state: 'live' },
      ] }),
    ])).toThrowError(/repeats attempt/)
    expect(() => replayTeamEvents([
      ...runningEvents(),
      event(3322, { type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('wrong-task'), observations: [
        { taskId: TaskId('another-task'), attemptId: ATTEMPT_ID, childSessionId: 'session-worker-1', state: 'live' },
      ] }),
    ])).toThrowError(/does not belong to task/)
    expect(() => replayTeamEvents([
      ...dispatchingEvents(),
      event(333, { type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('bad-child'), observations: [{ taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'unexpected', state: 'live' }] }),
    ])).toThrowError(/child identity/)
    expect(() => replayTeamEvents([
      ...dispatchingEvents(),
      event(334, { type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('bad-state'), observations: [{ taskId: TASK_ID, attemptId: ATTEMPT_ID, state: 'missing' }] }),
    ])).toThrowError(/not-admitted observation/)
    expect(() => replayTeamEvents([
      ...runningEvents(),
      event(3341, { type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('admitted-not-admitted'), observations: [{ taskId: TASK_ID, attemptId: ATTEMPT_ID, state: 'not-admitted' }] }),
    ])).toThrowError(/cannot have a not-admitted observation/)
    expect(() => replayTeamEvents([
      ...completeTeamEvents(),
      event(335, { type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('terminal-attempt'), observations: [{ taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'session-worker-1', state: 'durable' }] }),
    ])).toThrowError(/cannot reconcile while completed/)
  })

  it('prevents reconciliation operation ids from crossing command namespaces', async () => {
    const reconciliation = event(340, {
      type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('reconcile-shared'),
      observations: [{ taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'session-worker-1', state: 'live' }],
    })
    expect(() => replayTeamEvents([
      ...runningEvents(), reconciliation,
      event(341, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('reconcile-shared'), action: 'pause' }),
    ])).toThrowError(/used for reconciliation/)
    expect(() => replayTeamEvents([
      ...runningEvents(), reconciliation,
      event(342, { type: 'yuqi/task-retry-requested', operationId: ControlOperationId('reconcile-shared'), taskId: TASK_ID }),
    ])).toThrowError(/used for reconciliation/)
    const control = event(343, {
      type: 'yuqi/team-control-requested', operationId: ControlOperationId('command-shared'), action: 'pause',
    })
    expect(() => replayTeamEvents([
      ...runningEvents(), control,
      event(344, { type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('command-shared'), observations: [{ taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'session-worker-1', state: 'live' }] }),
    ])).toThrowError(/another command/)

    const journal = new Journal([...runningEvents(), reconciliation], 'application-cross-namespace')
    const transactions = new DurableJournalCoordinator()
    const controls = new TeamControlCoordinator(new ClockStub(), new Ids('control-cross'), transactions)
    await expect(controls.pause({ teamId: TEAM_ID, operationId: 'reconcile-shared' }, journal))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    const { TaskRetryCoordinator } = await import('../src/index.ts')
    await expect(new TaskRetryCoordinator(new ClockStub(), new Ids('retry-cross'), transactions).retry({
      teamId: TEAM_ID, taskId: TASK_ID, operationId: 'reconcile-shared',
    }, journal)).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await transactions.dispose()
  })
})
