import { describe, expect, it } from 'vitest'
import {
  ControlOperationId,
  DurableJournalCoordinator,
  FileLeaseId,
  planTeamSchedule,
  prepareTeamBatchIntent,
  replayTeamEvents,
  TaskId,
  TaskRetryCoordinator,
  TeamControlCoordinator,
  VerificationId,
  WorkspaceId,
} from '../src/index.ts'
import type { Clock, EventIdSource, TeamEvent, TeamEventJournal } from '../src/index.ts'
import { ATTEMPT_ID, completeTeamEvents, contract, event, TASK_ID, TEAM_ID, verificationOperationEvents } from './fixtures.ts'

class ClockStub implements Clock {
  #value = 0
  nowIso(): string { return `2026-08-15T15:00:${String(this.#value++).padStart(2, '0')}Z` }
}

class Ids implements EventIdSource {
  #value = 0
  readonly #prefix: string
  constructor(prefix = 'retry-event') { this.#prefix = prefix }
  next(): string { return `${this.#prefix}-${this.#value++}` }
}

class Journal implements TeamEventJournal {
  readonly key: string
  readonly events: unknown[]
  readonly transactions: TeamEvent[][] = []
  fail = false
  constructor(events: readonly unknown[], key = 'retry-controller') { this.events = [...events]; this.key = key }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> {
    if (this.fail) throw new Error('flush failed')
    this.transactions.push([...events]); this.events.push(...events)
  }
}

function failedEvents(): readonly TeamEvent[] {
  return [
    ...completeTeamEvents().slice(0, 8),
    event(200, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'failed' }),
    event(201, { type: 'yuqi/attempt-evidence-recorded', taskId: TASK_ID, attemptId: ATTEMPT_ID, runId: 'failed-run', agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'error', hasAssistantOutput: false, settledAt: '2026-08-15T00:03:21Z' }),
    event(202, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'failed' }),
  ]
}

function cancelledEvents(): readonly TeamEvent[] {
  return [
    ...completeTeamEvents().slice(0, 8),
    event(210, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'cancelled' }),
    event(211, { type: 'yuqi/attempt-evidence-recorded', taskId: TASK_ID, attemptId: ATTEMPT_ID, runId: 'cancelled-run', agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'aborted', hasAssistantOutput: false, settledAt: '2026-08-15T00:03:31Z' }),
    event(212, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'cancelled' }),
  ]
}

function verifyingWithLease(): readonly TeamEvent[] {
  const workspaceId = WorkspaceId('retry-workspace')
  const otherTaskId = TaskId('retry-other-task')
  return [
    ...completeTeamEvents().slice(0, 11),
    event(219, { type: 'yuqi/task-created', contract: { ...contract(otherTaskId), fileScope: ['docs/**'] } }),
    event(220, { type: 'yuqi/workspace-provisioning-started', workspace: {
      workspaceId,
      project: {
        projectRoot: 'F:\\repo', repositoryRoot: 'F:\\repo', gitCommonDirectory: 'F:\\repo\\.git',
        baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: [],
      },
      worktreePath: 'F:\\managed\\retry', branchName: 'yuqi/retry', status: 'provisioning',
    } }),
    event(221, { type: 'yuqi/workspace-provisioned', workspaceId }),
    event(222, { type: 'yuqi/file-lease-acquired', lease: {
      leaseId: FileLeaseId('retry-released-lease'), taskId: TASK_ID, mode: 'write', fileScope: ['src/**'], status: 'active',
    } }),
    event(223, { type: 'yuqi/file-lease-released', leaseId: FileLeaseId('retry-released-lease'), taskId: TASK_ID }),
    event(224, { type: 'yuqi/file-lease-acquired', lease: {
      leaseId: FileLeaseId('retry-old-lease'), taskId: TASK_ID, attemptId: ATTEMPT_ID, mode: 'write', fileScope: ['src/**'], status: 'active',
    } }),
    event(225, { type: 'yuqi/file-lease-acquired', lease: {
      leaseId: FileLeaseId('retry-other-lease'), taskId: otherTaskId, mode: 'write', fileScope: ['docs/**'], status: 'active',
    } }),
  ]
}

describe('TaskRetryCoordinator', () => {
  it.each([
    ['failed', failedEvents()],
    ['cancelled', cancelledEvents()],
    ['blocked-completed-report', [
      ...completeTeamEvents().slice(0, 10),
      event(213, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'blocked' }),
    ]],
  ])('retries a %s task once while preserving its prior attempt', async (_status, inputs) => {
    const journal = new Journal(inputs)
    const transactions = new DurableJournalCoordinator()
    const retries = new TaskRetryCoordinator(new ClockStub(), new Ids(), transactions)
    const retried = await retries.retry({ teamId: TEAM_ID, taskId: TASK_ID, operationId: `retry-${_status}` }, journal)
    expect(retried.tasks[TASK_ID]?.status).toBe('ready')
    expect(retried.tasks[TASK_ID]?.attemptIds).toEqual([ATTEMPT_ID])
    expect(retried.attempts[ATTEMPT_ID]).toEqual(replayTeamEvents(inputs).attempts[ATTEMPT_ID])
    expect(planTeamSchedule(retried, { maxConcurrency: 1 }).dispatchTaskIds).toEqual([TASK_ID])

    const plan = planTeamSchedule(retried, { maxConcurrency: 1 })
    const prepared = prepareTeamBatchIntent(retried, {
      teamId: TEAM_ID, plan, maxConcurrency: 1,
      attempts: [{ taskId: TASK_ID, attemptId: `attempt-${_status}-2`, modelProvider: 'deepseek', modelId: 'deepseek-v4' }],
    }, new ClockStub(), new Ids(`prepare-${_status}`))
    expect(prepared.projection.attempts[`attempt-${_status}-2`]?.ordinal).toBe(2)
    expect(prepared.projection.attempts[ATTEMPT_ID]).toEqual(retried.attempts[ATTEMPT_ID])
    expect(planTeamSchedule(prepared.projection, { maxConcurrency: 1 }).status).toBe('runnable')
    await transactions.dispose()
  })

  it('atomically releases prior ownership and preserves settlement evidence', async () => {
    const inputs = verifyingWithLease()
    const journal = new Journal(inputs)
    const transactions = new DurableJournalCoordinator()
    const retries = new TaskRetryCoordinator(new ClockStub(), new Ids(), transactions)
    const retried = await retries.retry({ teamId: TEAM_ID, taskId: TASK_ID, operationId: 'retry-verifying' }, journal)
    expect(retried.tasks[TASK_ID]?.status).toBe('ready')
    expect(retried.fileLeases['retry-old-lease']?.status).toBe('released')
    expect(retried.attempts[ATTEMPT_ID]?.evidence?.runId).toBe('run-1')
    expect(journal.transactions[0]?.map(item => item.type)).toEqual(['yuqi/file-lease-released', 'yuqi/task-retry-requested'])
    expect(() => replayTeamEvents([
      ...journal.read(),
      event(226, { type: 'yuqi/verification-created', taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VerificationId('late-old-verification'), verifierSessionId: 'late-verifier' }),
    ])).toThrowError(/cannot start verification while ready/)
    expect(() => replayTeamEvents([
      ...journal.read(),
      event(227, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'ready', to: 'running' }),
      event(228, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'verifying' }),
      event(229, { type: 'yuqi/verification-created', taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VerificationId('late-old-verification-after-state-bypass'), verifierSessionId: 'late-verifier' }),
    ])).toThrowError(/not the current settled attempt/)
    await transactions.dispose()
  })

  it('allows an explicit retry after inconclusive verification is handed to a human', async () => {
    const inputs = [
      ...verificationOperationEvents('manual-confirmation-verdict'),
      event(2293, { type: 'yuqi/verification-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VerificationId('verification-1'), from: 'running', to: 'waived' }),
      event(2294, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'verifying', to: 'blocked' }),
    ]
    const journal = new Journal(inputs)
    const transactions = new DurableJournalCoordinator()
    const retried = await new TaskRetryCoordinator(new ClockStub(), new Ids(), transactions)
      .retry({ teamId: TEAM_ID, taskId: TASK_ID, operationId: 'retry-manual-confirmation' }, journal)
    expect(retried.tasks[TASK_ID]?.status).toBe('ready')
    await transactions.dispose()
  })

  it('deduplicates an operation and rejects reuse for another task', async () => {
    const journal = new Journal(failedEvents())
    const transactions = new DurableJournalCoordinator()
    const retries = new TaskRetryCoordinator(new ClockStub(), new Ids(), transactions)
    await retries.retry({ teamId: TEAM_ID, taskId: TASK_ID, operationId: 'retry-once' }, journal)
    const count = journal.transactions.length
    await expect(retries.retry({ teamId: TEAM_ID, taskId: TASK_ID, operationId: 'retry-once' }, journal))
      .resolves.toMatchObject({ tasks: { [TASK_ID]: { status: 'ready' } } })
    expect(journal.transactions).toHaveLength(count)

    const collision = event(230, {
      type: 'yuqi/task-retry-requested', operationId: ControlOperationId('retry-collision'), taskId: TASK_ID,
    })
    const duplicate = event(231, {
      type: 'yuqi/task-retry-requested', operationId: ControlOperationId('retry-collision'), taskId: TASK_ID,
    })
    const replayed = replayTeamEvents([...failedEvents(), collision, duplicate])
    expect(replayed.taskRetryOperations['retry-collision']?.taskId).toBe(TASK_ID)
    expect(() => replayTeamEvents([
      ...failedEvents(), collision,
      event(232, { type: 'yuqi/task-retry-requested', operationId: ControlOperationId('retry-collision'), taskId: TaskId('other-task') }),
    ])).toThrowError(/already used/)
    expect(() => replayTeamEvents([
      ...completeTeamEvents().slice(0, 8),
      event(233, { type: 'yuqi/task-retry-requested', operationId: ControlOperationId('retry-running'), taskId: TASK_ID }),
    ])).toThrowError(/cannot retry while running/)
    await expect(retries.retry({ teamId: TEAM_ID, taskId: 'other-task', operationId: 'retry-once' }, journal))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await transactions.dispose()
  })

  it('uses one operation-id namespace across Team control and task retry', async () => {
    const controlFact = event(235, {
      type: 'yuqi/team-control-requested', operationId: ControlOperationId('shared-operation'), action: 'pause',
    })
    const transactions = new DurableJournalCoordinator()
    const retries = new TaskRetryCoordinator(new ClockStub(), new Ids(), transactions)
    await expect(retries.retry({ teamId: TEAM_ID, taskId: TASK_ID, operationId: 'shared-operation' }, new Journal([...failedEvents(), controlFact], 'control-first')))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await expect(retries.retry({
      teamId: TEAM_ID, taskId: TASK_ID, operationId: 'verdict-retry-conflict',
    }, new Journal(verificationOperationEvents('verdict-retry-conflict'), 'verdict-first')))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    expect(() => replayTeamEvents([
      ...failedEvents(), controlFact,
      event(236, { type: 'yuqi/task-retry-requested', operationId: ControlOperationId('shared-operation'), taskId: TASK_ID }),
    ])).toThrowError(/Team control/)

    const retryJournal = new Journal(failedEvents(), 'retry-first')
    await retries.retry({ teamId: TEAM_ID, taskId: TASK_ID, operationId: 'retry-first-operation' }, retryJournal)
    const controls = new TeamControlCoordinator(new ClockStub(), new Ids('control-after-retry'), transactions)
    await expect(controls.pause({ teamId: TEAM_ID, operationId: 'retry-first-operation' }, retryJournal))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    expect(() => replayTeamEvents([
      ...failedEvents(),
      event(237, { type: 'yuqi/task-retry-requested', operationId: ControlOperationId('retry-domain-first'), taskId: TASK_ID }),
      event(238, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('retry-domain-first'), action: 'pause' }),
    ])).toThrowError(/task retry/)
    await transactions.dispose()
  })

  it('rejects missing, non-retryable, active, wrong-Team, and inactive-Team requests', async () => {
    const transactions = new DurableJournalCoordinator()
    const retries = new TaskRetryCoordinator(new ClockStub(), new Ids(), transactions)
    await expect(retries.retry({ teamId: TEAM_ID, taskId: 'missing', operationId: 'missing' }, new Journal(failedEvents(), 'missing')))
      .rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' })
    await expect(retries.retry({ teamId: TEAM_ID, taskId: TASK_ID, operationId: 'running' }, new Journal(completeTeamEvents().slice(0, 8), 'running')))
      .rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' })
    await expect(retries.retry({ teamId: 'other-team', taskId: TASK_ID, operationId: 'wrong-team' }, new Journal(failedEvents(), 'wrong-team')))
      .rejects.toMatchObject({ code: 'TEAM_MISMATCH' })

    const activeButFailed = [
      ...completeTeamEvents().slice(0, 8),
      event(240, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'failed' }),
    ]
    await expect(retries.retry({ teamId: TEAM_ID, taskId: TASK_ID, operationId: 'active' }, new Journal(activeButFailed, 'active')))
      .rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' })
    const unresolvedButCancelled = [
      ...completeTeamEvents().slice(0, 8),
      event(2401, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'unknown' }),
      event(2402, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'cancelled' }),
      event(2403, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
      event(2404, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' }),
    ]
    await expect(retries.retry({ teamId: TEAM_ID, taskId: TASK_ID, operationId: 'unknown-attempt' }, new Journal(unresolvedButCancelled, 'unknown-attempt')))
      .rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' })
    expect(() => replayTeamEvents([
      ...unresolvedButCancelled,
      event(2405, { type: 'yuqi/task-retry-requested', operationId: ControlOperationId('unknown-attempt-domain'), taskId: TASK_ID }),
    ])).toThrowError(/active attempt/)
    await expect(retries.retry({ teamId: TEAM_ID, taskId: TASK_ID, operationId: 'active-verification' }, new Journal(completeTeamEvents().slice(0, 13), 'active-verification')))
      .rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' })
    expect(() => replayTeamEvents([
      ...verifyingWithLease(),
      event(243, { type: 'yuqi/task-retry-requested', operationId: ControlOperationId('lease-bypass'), taskId: TASK_ID }),
    ])).toThrowError(/active file lease/)
    expect(() => replayTeamEvents([
      ...completeTeamEvents().slice(0, 13),
      event(244, { type: 'yuqi/task-retry-requested', operationId: ControlOperationId('verification-bypass'), taskId: TASK_ID }),
    ])).toThrowError(/active verification/)
    const cancelledTeam = [...failedEvents(), event(241, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling' }), event(242, { type: 'yuqi/team-status-changed', from: 'cancelling', to: 'cancelled' })]
    await expect(retries.retry({ teamId: TEAM_ID, taskId: TASK_ID, operationId: 'inactive' }, new Journal(cancelledTeam, 'inactive')))
      .rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' })
    await transactions.dispose()
  })

  it('fails closed instead of releasing a legacy task-only active lease', async () => {
    const legacy = verifyingWithLease().filter(item => !(item.type === 'yuqi/file-lease-acquired' && item.lease.leaseId === FileLeaseId('retry-old-lease')))
    legacy.push(event(250, { type: 'yuqi/file-lease-acquired', lease: { leaseId: FileLeaseId('legacy-retry-lease'), taskId: TASK_ID, mode: 'write', fileScope: ['src/**'], status: 'active' } }))
    const journal = new Journal(legacy)
    const transactions = new DurableJournalCoordinator()
    await expect(new TaskRetryCoordinator(new ClockStub(), new Ids(), transactions).retry({ teamId: TEAM_ID, taskId: TASK_ID, operationId: 'legacy-retry' }, journal)).rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' })
    await transactions.dispose()
  })

  it('allows queueing while paused and poisons later retries after persistence failure', async () => {
    const paused = [...failedEvents(), event(250, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }), event(251, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' })]
    const pausedJournal = new Journal(paused, 'paused')
    const transactions = new DurableJournalCoordinator()
    const retries = new TaskRetryCoordinator(new ClockStub(), new Ids(), transactions)
    await expect(retries.retry({ teamId: TEAM_ID, taskId: TASK_ID, operationId: 'paused-retry' }, pausedJournal))
      .resolves.toMatchObject({ team: { status: 'paused' }, tasks: { [TASK_ID]: { status: 'ready' } } })

    const failedJournal = new Journal(failedEvents(), 'flush-failure'); failedJournal.fail = true
    await expect(retries.retry({ teamId: TEAM_ID, taskId: TASK_ID, operationId: 'flush-failure' }, failedJournal))
      .rejects.toMatchObject({ code: 'INTENT_PERSISTENCE_FAILED' })
    await expect(retries.retry({ teamId: TEAM_ID, taskId: TASK_ID, operationId: 'after-poison' }, failedJournal))
      .rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    await transactions.dispose()
  })
})
