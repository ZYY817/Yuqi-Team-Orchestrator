import { describe, expect, it } from 'vitest'
import {
  AttemptId,
  AttemptResolutionCoordinator,
  ControlOperationId,
  DurableJournalCoordinator,
  replayTeamEvents,
  TaskId,
  WorkspaceId,
} from '../src/index.ts'
import type {
  AttemptResolutionSafetyPort,
  AttemptResolutionProof,
  AttemptRuntimeObservation,
  Clock,
  EventIdSource,
  TeamEvent,
  TeamEventJournal,
} from '../src/index.ts'
import { ATTEMPT_ID, completeTeamEvents, contract, event, TASK_ID, TEAM_ID, verificationOperationEvents } from './fixtures.ts'

class ClockStub implements Clock {
  #value = 0
  nowIso(): string { return `2026-08-15T18:00:${String(this.#value++).padStart(2, '0')}Z` }
}

class Ids implements EventIdSource {
  #value = 0
  next(): string { return `resolution-event-${this.#value++}` }
}

class Journal implements TeamEventJournal {
  readonly key: string
  readonly events: unknown[]
  readonly transactions: TeamEvent[][] = []
  fail = false
  constructor(events: readonly unknown[], key = 'resolution-controller') { this.events = [...events]; this.key = key }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> {
    if (this.fail) throw new Error('flush failed')
    this.transactions.push([...events]); this.events.push(...events)
  }
}

class Safety implements AttemptResolutionSafetyPort {
  calls: AttemptRuntimeObservation[] = []
  failure: Error | undefined
  barrier: Promise<void> | undefined
  async assertQuiescent(request: Parameters<AttemptResolutionSafetyPort['assertQuiescent']>[0]): Promise<AttemptResolutionProof | void> {
    this.calls.push(request.observation)
    if (this.barrier !== undefined) await this.barrier
    if (this.failure !== undefined) throw this.failure
    return {
      principal: { kind: 'controller-session', sessionId: 'controller' },
      observationState: request.observation.state as 'durable' | 'missing' | 'not-admitted',
      childQuiescent: true, localInFlight: false, gitVerified: true,
      leaseIds: [...request.leaseIds ?? []],
    }
  }
}

const RESOLUTION_WORKSPACE = {
  workspaceId: WorkspaceId('resolution-workspace'),
  project: {
    projectRoot: 'F:\\repo', repositoryRoot: 'F:\\repo', gitCommonDirectory: 'F:\\repo\\.git',
    baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: [],
  },
  worktreePath: 'F:\\managed\\resolution', branchName: 'yuqi/resolution', status: 'ready' as const,
}

const RESOLUTION_WORKSPACE_PROOF = {
  workspaceId: RESOLUTION_WORKSPACE.workspaceId,
  projectRoot: RESOLUTION_WORKSPACE.project.projectRoot,
  repositoryRoot: RESOLUTION_WORKSPACE.project.repositoryRoot,
  gitCommonDirectory: RESOLUTION_WORKSPACE.project.gitCommonDirectory,
  baselineRef: RESOLUTION_WORKSPACE.project.baselineRef,
  volumeRoot: RESOLUTION_WORKSPACE.project.volumeRoot,
  protectedRoots: [...RESOLUTION_WORKSPACE.project.protectedRoots],
  worktreePath: RESOLUTION_WORKSPACE.worktreePath,
  branchName: RESOLUTION_WORKSPACE.branchName,
}

class WorkspaceSafety extends Safety {
  async assertQuiescent(request: Parameters<AttemptResolutionSafetyPort['assertQuiescent']>[0]): Promise<AttemptResolutionProof> {
    const proof = await super.assertQuiescent(request)
    if (proof === undefined) throw new Error('test safety proof unexpectedly absent')
    return {
      principal: proof.principal,
      observationState: proof.observationState,
      childQuiescent: true,
      localInFlight: false,
      gitVerified: true,
      workspace: RESOLUTION_WORKSPACE_PROOF,
      leaseIds: [...proof.leaseIds],
    }
  }
}

function reconciledEvents(state: 'durable' | 'missing' | 'not-admitted' | 'live' = 'durable') {
  const observation = state === 'not-admitted'
    ? { taskId: TASK_ID, attemptId: ATTEMPT_ID, state }
    : { taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'session-worker-1', state }
  return [
    ...completeTeamEvents().slice(0, 8),
    event(700, { type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('scan-1'), observations: [observation] }),
    event(701, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
  ] as const
}

function workspaceGapReconciledEvents() {
  return [
    ...completeTeamEvents().slice(0, 5),
    event(760, { type: 'yuqi/workspace-provisioning-started', workspace: { ...RESOLUTION_WORKSPACE, status: 'provisioning' } }),
    event(761, { type: 'yuqi/workspace-provisioned', workspaceId: RESOLUTION_WORKSPACE.workspaceId }),
    event(762, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId: ATTEMPT_ID, ordinal: 1, modelProvider: 'deepseek', modelId: 'deepseek-v4' }),
    event(763, { type: 'yuqi/attempt-admitted', taskId: TASK_ID, attemptId: ATTEMPT_ID, agentSessionId: 'session-worker-1', messageId: 'message-1' }),
    event(764, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'dispatching', to: 'running' }),
    event(765, { type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('scan-workspace'), observations: [{ taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'session-worker-1', state: 'durable' }] }),
    event(766, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    event(767, { type: 'yuqi/workspace-reconciliation-required', workspaceId: RESOLUTION_WORKSPACE.workspaceId, reason: 'simulated workspace drift' }),
  ] as const
}

function cancellationReconciledEvents() {
  return [
    ...completeTeamEvents().slice(0, 8),
    event(690, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('cancel-before-restart'), action: 'cancel' }),
    event(691, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling' }),
    event(692, { type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('cancel-scan'), observations: [{ taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'session-worker-1', state: 'durable' }] }),
    event(693, { type: 'yuqi/team-status-changed', from: 'cancelling', to: 'needs_reconciliation' }),
  ] as const
}

function unadmittedReconciledEvents() {
  return [
    ...completeTeamEvents().slice(0, 6),
    event(704, { type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('scan-unadmitted'), observations: [{ taskId: TASK_ID, attemptId: ATTEMPT_ID, state: 'not-admitted' }] }),
    event(705, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
  ] as const
}

function budgetUnadmittedReconciledEvents(observationState: 'durable' | 'not-admitted' = 'not-admitted') {
  const attemptId = AttemptId('budget-resolution-attempt')
  return [
    event(720, { type: 'yuqi/team-created', title: 'Budget resolution', objective: 'Close only proven outcomes' }),
    event(721, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
    event(722, { type: 'yuqi/budget-policy-set', operationId: ControlOperationId('budget-resolution-policy'), revision: 1, tokenLimit: 100, alerts: [], stopBehavior: 'block-new' }),
    event(723, { type: 'yuqi/task-created', contract: contract(TASK_ID) }),
    event(724, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'pending', to: 'ready' }),
    event(725, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'ready', to: 'running' }),
    event(726, { type: 'yuqi/budget-reservation-acquired', reservationId: 'budget-resolution-reservation', taskId: TASK_ID, attemptId, tokenReserve: 10 }),
    event(727, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId, ordinal: 1, modelProvider: 'p', modelId: 'deepseek-v4' }),
    ...(observationState === 'not-admitted' ? [
      event(730, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId, from: 'dispatching', to: 'unknown' }),
      event(731, { type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('budget-scan'), observations: [{ taskId: TASK_ID, attemptId, state: observationState }] }),
    ] : [
      event(728, { type: 'yuqi/attempt-admitted', taskId: TASK_ID, attemptId, agentSessionId: 'budget-child', messageId: 'budget-message' }),
      event(729, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId, from: 'dispatching', to: 'running' }),
      event(730, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId, from: 'running', to: 'unknown' }),
      event(731, { type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('budget-scan'), observations: [{ taskId: TASK_ID, attemptId, childSessionId: 'budget-child', state: observationState }] }),
    ]),
    event(732, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
  ] as const
}

function request(overrides: Partial<Parameters<AttemptResolutionCoordinator['resolve']>[0]> = {}) {
  return {
    teamId: TEAM_ID,
    taskId: TASK_ID,
    attemptId: ATTEMPT_ID,
    operationId: 'resolve-1',
    observationOperationId: 'scan-1',
    decision: 'failed' as const,
    ...overrides,
  }
}

describe('AttemptResolutionCoordinator', () => {
  it('releases a budget hold only when reconciliation proves the child was not admitted', async () => {
    const journal = new Journal(budgetUnadmittedReconciledEvents(), 'budget-resolution-release')
    const transactions = new DurableJournalCoordinator()
    const coordinator = new AttemptResolutionCoordinator(new ClockStub(), new Ids(), transactions)
    const projection = await coordinator.resolve({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: 'budget-resolution-attempt', operationId: 'budget-resolve',
      observationOperationId: 'budget-scan', decision: 'failed',
    }, journal, new Safety())
    expect(projection.budgetReservations['budget-resolution-reservation']?.status).toBe('not-admitted')
    expect(journal.transactions[0]?.map(item => item.type)).toEqual([
      'yuqi/attempt-resolution-proof-recorded', 'yuqi/budget-reservation-settled', 'yuqi/attempt-resolution-requested',
    ])
    await transactions.dispose()
  })

  it('does not infer zero usage for a durable observation and settles the reservation as unknown', async () => {
    const transactions = new DurableJournalCoordinator()
    const coordinator = new AttemptResolutionCoordinator(new ClockStub(), new Ids(), transactions)
    const safety = new Safety()
    const projection = await coordinator.resolve({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: 'budget-resolution-attempt', operationId: 'budget-resolve-unknown',
      observationOperationId: 'budget-scan', decision: 'failed',
    }, new Journal(budgetUnadmittedReconciledEvents('durable'), 'budget-resolution-unknown'), safety)
    expect(projection.budgetReservations['budget-resolution-reservation']?.status).toBe('unknown')
    expect(safety.calls).toHaveLength(1)
    await transactions.dispose()
  })

  it('also refuses a durable observation when the reservation itself is unknown', async () => {
    const attemptId = AttemptId('budget-unknown-reservation-attempt')
    const events = [
      event(740, { type: 'yuqi/team-created', title: 'Unknown reservation', objective: 'Keep unresolved holds fail-closed' }),
      event(741, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(742, { type: 'yuqi/budget-policy-set', operationId: ControlOperationId('unknown-reservation-policy'), revision: 1, tokenLimit: 100, alerts: [], stopBehavior: 'block-new' }),
      event(743, { type: 'yuqi/task-created', contract: contract(TASK_ID) }),
      event(744, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'pending', to: 'ready' }),
      event(745, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'ready', to: 'running' }),
      event(746, { type: 'yuqi/budget-reservation-acquired', reservationId: 'unknown-reservation', taskId: TASK_ID, attemptId, tokenReserve: 10 }),
      event(747, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId, ordinal: 1, modelProvider: 'p', modelId: 'deepseek-v4' }),
      event(748, { type: 'yuqi/attempt-admitted', taskId: TASK_ID, attemptId, agentSessionId: 'unknown-child', messageId: 'unknown-message' }),
      event(749, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId, from: 'dispatching', to: 'running' }),
      event(750, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId, from: 'running', to: 'settled' }),
      event(751, { type: 'yuqi/attempt-evidence-recorded', taskId: TASK_ID, attemptId, runId: 'unknown-run', agentSessionId: 'unknown-child', provider: 'p', stopReason: 'completed', hasAssistantOutput: true, settledAt: '2026-08-15T18:00:00Z' }),
      event(752, { type: 'yuqi/budget-reservation-settled', reservationId: 'unknown-reservation', taskId: TASK_ID, attemptId, status: 'unknown' }),
      event(753, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId, from: 'settled', to: 'unknown' }),
      event(754, { type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('unknown-reservation-scan'), observations: [{ taskId: TASK_ID, attemptId, childSessionId: 'unknown-child', state: 'durable' }] }),
      event(755, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ] as const
    const transactions = new DurableJournalCoordinator()
    const coordinator = new AttemptResolutionCoordinator(new ClockStub(), new Ids(), transactions)
    await expect(coordinator.resolve({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId, operationId: 'unknown-reservation-resolution',
      observationOperationId: 'unknown-reservation-scan', decision: 'failed',
    }, new Journal(events), new Safety())).rejects.toMatchObject({ code: 'RESOLUTION_NOT_ALLOWED' })
    await transactions.dispose()
  })

  it('does not let replayed resolution bypass an unresolved active budget reservation', () => {
    const unresolved = budgetUnadmittedReconciledEvents('not-admitted')
    expect(() => replayTeamEvents([...unresolved, event(733, {
      type: 'yuqi/attempt-resolution-requested', operationId: ControlOperationId('unresolved-budget-resolution'),
      observationOperationId: ControlOperationId('budget-scan'), taskId: TASK_ID,
      attemptId: AttemptId('budget-resolution-attempt'), decision: 'failed',
    })])).toThrow(/requires a durable budget settlement/)
  })

  it.each(['failed', 'cancelled'] as const)('durably records only an explicit %s conclusion after quiescence proof', async decision => {
    const journal = new Journal(reconciledEvents())
    const transactions = new DurableJournalCoordinator()
    const safety = new Safety()
    const coordinator = new AttemptResolutionCoordinator(new ClockStub(), new Ids(), transactions)
    const projection = await coordinator.resolve(request({ decision }), journal, safety)
    expect(safety.calls).toEqual([expect.objectContaining({ state: 'durable', childSessionId: 'session-worker-1' })])
    expect(projection.team.status).toBe('needs_reconciliation')
    expect(projection.tasks[TASK_ID]?.status).toBe(decision)
    expect(projection.attempts[ATTEMPT_ID]?.status).toBe(decision)
    expect(projection.attemptResolutionOperations['resolve-1']).toMatchObject({
      observationOperationId: 'scan-1', taskId: TASK_ID, attemptId: ATTEMPT_ID, decision,
    })
    expect(journal.transactions[0]?.map(item => item.type)).toEqual(['yuqi/attempt-resolution-proof-recorded', 'yuqi/attempt-resolution-requested'])
    await transactions.dispose()
  })

  it('completes an original Team cancellation after its last unknown attempt is explicitly cancelled', async () => {
    const journal = new Journal(cancellationReconciledEvents())
    const transactions = new DurableJournalCoordinator()
    const projection = await new AttemptResolutionCoordinator(new ClockStub(), new Ids(), transactions).resolve(request({
      operationId: 'resolve-cancelled-runtime', observationOperationId: 'cancel-scan', decision: 'cancelled',
    }), journal, new Safety())

    expect(projection.team.status).toBe('cancelled')
    expect(projection.tasks[TASK_ID]?.status).toBe('cancelled')
    expect(journal.transactions[0]?.map(item => item.type)).toEqual([
      'yuqi/attempt-resolution-proof-recorded', 'yuqi/attempt-resolution-requested', 'yuqi/team-status-changed',
    ])
    await transactions.dispose()
  })

  it('replays the same operation without a second host check or durable write', async () => {
    const journal = new Journal(reconciledEvents())
    const transactions = new DurableJournalCoordinator()
    const safety = new Safety()
    const coordinator = new AttemptResolutionCoordinator(new ClockStub(), new Ids(), transactions)
    const first = await coordinator.resolve(request(), journal, safety)
    const replayed = await coordinator.resolve(request(), journal, safety)
    expect(replayed).toEqual(first)
    expect(safety.calls).toHaveLength(1)
    expect(journal.transactions).toHaveLength(1)
    await expect(coordinator.resolve(request({ decision: 'cancelled' }), journal, safety))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await transactions.dispose()
  })

  it('accepts a concurrent identical durable resolution without a second commit', async () => {
    let release!: () => void
    const journal = new Journal(reconciledEvents(), 'concurrent-resolution')
    const transactions = new DurableJournalCoordinator()
    const safety = new Safety(); safety.barrier = new Promise<void>(resolve => { release = resolve })
    const coordinator = new AttemptResolutionCoordinator(new ClockStub(), new Ids(), transactions)
    const pending = coordinator.resolve(request(), journal, safety)
    journal.events.push(event(708, {
      type: 'yuqi/attempt-resolution-requested', operationId: ControlOperationId('resolve-1'),
      observationOperationId: ControlOperationId('scan-1'), taskId: TASK_ID, attemptId: ATTEMPT_ID, decision: 'failed',
    }))
    release()
    await expect(pending).resolves.toMatchObject({ attempts: { [ATTEMPT_ID]: { status: 'failed' } } })
    expect(journal.transactions).toHaveLength(0)
    await transactions.dispose()
  })

  it('permits a durably unadmitted attempt only after an explicit host quiescence check', async () => {
    const journal = new Journal(unadmittedReconciledEvents(), 'unadmitted')
    const transactions = new DurableJournalCoordinator()
    const safety = new Safety()
    const coordinator = new AttemptResolutionCoordinator(new ClockStub(), new Ids(), transactions)
    const signal = new AbortController().signal
    const projection = await coordinator.resolve(request({ operationId: 'resolve-unadmitted', observationOperationId: 'scan-unadmitted', signal }), journal, safety)
    expect(projection.attempts[ATTEMPT_ID]?.status).toBe('failed')
    expect(safety.calls).toEqual([expect.objectContaining({ state: 'not-admitted' })])
    await transactions.dispose()
  })

  it('passes the latest observation reason through to the host proof without persisting it as a success claim', async () => {
    const withReason = [
      ...completeTeamEvents().slice(0, 8),
      event(709, { type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('scan-reason'), observations: [{ taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'session-worker-1', state: 'durable', reason: 'Harness child is idle' }] }),
      event(710, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ] as const
    const transactions = new DurableJournalCoordinator()
    const safety = new Safety()
    const coordinator = new AttemptResolutionCoordinator(new ClockStub(), new Ids(), transactions)
    await coordinator.resolve(request({ operationId: 'resolve-reason', observationOperationId: 'scan-reason' }), new Journal(withReason, 'reason'), safety)
    expect(safety.calls[0]).toMatchObject({ reason: 'Harness child is idle' })
    await transactions.dispose()
  })

  it('records workspace recovery only when the Host resolution proof includes the workspace', async () => {
    const transactions = new DurableJournalCoordinator()
    const coordinator = new AttemptResolutionCoordinator(new ClockStub(), new Ids(), transactions)
    const withWorkspace = new Journal(workspaceGapReconciledEvents(), 'resolution-workspace-proof')
    const recovered = await coordinator.resolve(request({ operationId: 'resolve-workspace-proof', observationOperationId: 'scan-workspace' }), withWorkspace, new WorkspaceSafety())
    expect(recovered.workspace?.status).toBe('ready')
    expect(withWorkspace.transactions[0]?.map(item => item.type)).toContain('yuqi/workspace-recovery-verified')

    const withoutWorkspace = new Journal(workspaceGapReconciledEvents(), 'resolution-workspace-absent')
    await expect(coordinator.resolve(request({ operationId: 'resolve-workspace-absent', observationOperationId: 'scan-workspace' }), withoutWorkspace, new Safety()))
      .rejects.toMatchObject({ code: 'RESOLUTION_UNSAFE' })
    expect(withoutWorkspace.transactions).toHaveLength(0)
    await transactions.dispose()
  })

  it('rejects live or diagnostic uncertainty before asking the host to make a decision', async () => {
    const transactions = new DurableJournalCoordinator()
    const coordinator = new AttemptResolutionCoordinator(new ClockStub(), new Ids(), transactions)
    const safety = new Safety()
    await expect(coordinator.resolve(request(), new Journal(reconciledEvents('live')), safety))
      .rejects.toMatchObject({ code: 'RESOLUTION_NOT_ALLOWED' })
    expect(safety.calls).toHaveLength(0)
    await transactions.dispose()
  })

  it('requires the latest exact observation and rejects changed Team facts after host proof', async () => {
    let release!: () => void
    const journal = new Journal(reconciledEvents())
    const transactions = new DurableJournalCoordinator()
    const coordinator = new AttemptResolutionCoordinator(new ClockStub(), new Ids(), transactions)
    const safety = new Safety(); safety.barrier = new Promise<void>(resolve => { release = resolve })
    const pending = coordinator.resolve(request(), journal, safety)
    journal.events.push(event(702, { type: 'yuqi/task-created', contract: contract(TaskId('unrelated-task')) }))
    release()
    await expect(pending).rejects.toMatchObject({ code: 'RESOLUTION_STALE' })
    expect(journal.transactions).toHaveLength(0)
    await expect(coordinator.resolve(request({ operationId: 'resolve-stale', observationOperationId: 'scan-1' }), journal, new Safety()))
      .resolves.toMatchObject({ attempts: { [ATTEMPT_ID]: { status: 'failed' } } })
    const superseded = new Journal([
      ...reconciledEvents(),
      event(707, {
        type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('scan-2'),
        observations: [{ taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'session-worker-1', state: 'durable' }],
      }),
    ], 'superseded')
    await expect(coordinator.resolve(request({ operationId: 'resolve-superseded' }), superseded, new Safety()))
      .rejects.toMatchObject({ code: 'RESOLUTION_STALE' })
    await transactions.dispose()
  })

  it('wraps safety failure, preserves durable facts, and poisons only a failed resolution commit', async () => {
    const transactions = new DurableJournalCoordinator()
    const coordinator = new AttemptResolutionCoordinator(new ClockStub(), new Ids(), transactions)
    const unsafe = new Safety(); unsafe.failure = new Error('child remains active')
    const noWrite = new Journal(reconciledEvents(), 'unsafe')
    await expect(coordinator.resolve(request(), noWrite, unsafe)).rejects.toMatchObject({ code: 'RESOLUTION_UNSAFE' })
    expect(noWrite.transactions).toHaveLength(0)

    const failing = new Journal(reconciledEvents(), 'persistence'); failing.fail = true
    await expect(coordinator.resolve(request(), failing, new Safety())).rejects.toMatchObject({ code: 'INTENT_PERSISTENCE_FAILED' })
    await expect(coordinator.resolve(request({ operationId: 'after-poison' }), failing, new Safety()))
      .rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    await transactions.dispose()
  })

  it('rejects mismatches, terminal task state, and operation collisions without external checks', async () => {
    const transactions = new DurableJournalCoordinator()
    const coordinator = new AttemptResolutionCoordinator(new ClockStub(), new Ids(), transactions)
    const safety = new Safety()
    await expect(coordinator.resolve(request({ teamId: 'other-team' }), new Journal(reconciledEvents()), safety))
      .rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    await expect(coordinator.resolve(request({ observationOperationId: 'unknown-scan' }), new Journal(reconciledEvents()), safety))
      .rejects.toMatchObject({ code: 'RESOLUTION_STALE' })
    await expect(coordinator.resolve(request(), new Journal(completeTeamEvents()), safety))
      .rejects.toMatchObject({ code: 'RESOLUTION_NOT_ALLOWED' })
    const terminalTask = [
      ...reconciledEvents(),
      event(706, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'failed' }),
    ]
    await expect(coordinator.resolve(request(), new Journal(terminalTask), safety))
      .rejects.toMatchObject({ code: 'RESOLUTION_NOT_ALLOWED' })
    const collision = [
      ...reconciledEvents(),
      event(703, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('shared'), action: 'pause' }),
    ]
    await expect(coordinator.resolve(request({ operationId: 'shared' }), new Journal(collision), safety))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await expect(coordinator.resolve(
      request({ operationId: 'verdict-resolution-conflict' }),
      new Journal(verificationOperationEvents('verdict-resolution-conflict')),
      safety,
    )).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    expect(safety.calls).toHaveLength(0)
    await transactions.dispose()
  })
})

describe('attempt resolution replay', () => {
  it('rejects success-shaped and stale-resolution events while preserving only explicit failure/cancellation', () => {
    const valid = event(710, {
      type: 'yuqi/attempt-resolution-requested', operationId: ControlOperationId('event-resolution'),
      observationOperationId: ControlOperationId('scan-1'), taskId: TASK_ID, attemptId: ATTEMPT_ID, decision: 'failed',
    })
    expect(replayTeamEvents([...reconciledEvents(), valid]).attempts[ATTEMPT_ID]?.status).toBe('failed')
    expect(replayTeamEvents([...reconciledEvents(), valid, event(7101, {
      type: 'yuqi/attempt-resolution-requested', operationId: ControlOperationId('event-resolution'),
      observationOperationId: ControlOperationId('scan-1'), taskId: TASK_ID, attemptId: ATTEMPT_ID, decision: 'failed',
    })]).attempts[ATTEMPT_ID]?.status).toBe('failed')
    expect(() => replayTeamEvents([...reconciledEvents(), valid, event(7102, {
      type: 'yuqi/attempt-resolution-requested', operationId: ControlOperationId('event-resolution'),
      observationOperationId: ControlOperationId('scan-1'), taskId: TASK_ID, attemptId: ATTEMPT_ID, decision: 'cancelled',
    })])).toThrowError(/reused with different content/)
    expect(() => replayTeamEvents([...completeTeamEvents().slice(0, 8), event(7103, {
      type: 'yuqi/attempt-resolution-requested', operationId: ControlOperationId('outside-reconciliation'),
      observationOperationId: ControlOperationId('scan-1'), taskId: TASK_ID, attemptId: ATTEMPT_ID, decision: 'failed',
    })])).toThrowError(/cannot resolve an attempt/)
    expect(() => replayTeamEvents([
      ...reconciledEvents(),
      event(7104, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('resolution-shared'), action: 'pause' }),
      event(7105, {
        type: 'yuqi/attempt-resolution-requested', operationId: ControlOperationId('resolution-shared'),
        observationOperationId: ControlOperationId('scan-1'), taskId: TASK_ID, attemptId: ATTEMPT_ID, decision: 'failed',
      }),
    ])).toThrowError(/already used for another command/)
    expect(() => replayTeamEvents([
      ...reconciledEvents(),
      event(7106, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'failed' }),
      event(7107, {
        type: 'yuqi/attempt-resolution-requested', operationId: ControlOperationId('terminal-task-resolution'),
        observationOperationId: ControlOperationId('scan-1'), taskId: TASK_ID, attemptId: ATTEMPT_ID, decision: 'failed',
      }),
    ])).toThrowError(/not safely resolvable/)
    const otherTask = TaskId('resolution-other-task')
    expect(() => replayTeamEvents([
      ...reconciledEvents(),
      event(7108, { type: 'yuqi/task-created', contract: contract(otherTask) }),
      event(7109, {
        type: 'yuqi/attempt-resolution-requested', operationId: ControlOperationId('wrong-task-resolution'),
        observationOperationId: ControlOperationId('scan-1'), taskId: otherTask, attemptId: ATTEMPT_ID, decision: 'failed',
      }),
    ])).toThrowError(/does not belong to task/)
    expect(() => replayTeamEvents([...reconciledEvents(), event(711, {
      type: 'yuqi/attempt-resolution-requested', operationId: ControlOperationId('bad-observation'),
      observationOperationId: ControlOperationId('nope'), taskId: TASK_ID, attemptId: ATTEMPT_ID, decision: 'failed',
    })])).toThrowError(/latest reconciliation/)
    expect(() => replayTeamEvents([...reconciledEvents('live'), event(712, {
      type: 'yuqi/attempt-resolution-requested', operationId: ControlOperationId('live-resolution'),
      observationOperationId: ControlOperationId('scan-1'), taskId: TASK_ID, attemptId: ATTEMPT_ID, decision: 'cancelled',
    })])).toThrowError(/cannot resolve from a live/)
    expect(() => replayTeamEvents([...reconciledEvents(), event(713, {
      type: 'yuqi/attempt-resolution-requested', operationId: ControlOperationId('invalid-decision'),
      observationOperationId: ControlOperationId('scan-1'), taskId: TaskId(TASK_ID), attemptId: ATTEMPT_ID, decision: 'completed',
    } as never)])).toThrowError(/invalid Team event/)
  })
})
