import { describe, expect, it } from 'vitest'
import {
  ControlOperationId,
  DurableJournalCoordinator,
  AttemptId,
  applyTeamEvent,
  FileLeaseId,
  replayTeamEvents,
  TaskId,
  TeamControlCoordinator,
  VerificationId,
  WorkspaceId,
  type Clock,
  type EventIdSource,
  type HostEvidenceCollectionRequest,
  type HostEvidenceCollectionResult,
  type HostEvidenceCollectorPort,
  type TeamEvent,
  type TeamEventJournal,
} from '../src/index.ts'
import { VerificationVerdictCoordinator } from '../src/application/record-verification-verdict.ts'
import { completeTeamEvents, contract, event, ATTEMPT_ID, TASK_ID, TEAM_ID, VERIFICATION_ID } from './fixtures.ts'

const buildRequirement = { checkId: 'build', kind: 'build' as const }
const buildPass = { checkId: 'build', capturedAt: '2026-08-15T00:01:00Z', kind: 'build' as const, producer: 'build-runner' as const, command: 'pnpm run build', exitCode: 0, artifactDigest: 'sha256-build' }
const buildFail = { ...buildPass, exitCode: 1 }
const completionWorkspace = {
  workspaceId: WorkspaceId('verdict-completion-workspace'),
  project: {
    projectRoot: 'F:\\repo', repositoryRoot: 'F:\\repo', gitCommonDirectory: 'F:\\repo\\.git',
    baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: [],
  },
  worktreePath: 'F:\\managed\\verdict-completion', branchName: 'yuqi/verdict-completion', status: 'provisioning' as const,
}

function activeVerificationEvents() {
  return completeTeamEvents().slice(0, 13)
}

function verdictEvent(index: number, overrides: Record<string, unknown> = {}): TeamEvent {
  return event(index, {
    type: 'yuqi/verification-verdict-recorded',
    operationId: ControlOperationId(`verdict-${index}`),
    taskId: TASK_ID,
    attemptId: ATTEMPT_ID,
    verificationId: VERIFICATION_ID,
    disposition: 'passed',
    requirements: [buildRequirement],
    evidence: [buildPass],
    reasons: [],
    ...overrides,
  } as never)
}

class ClockStub implements Clock {
  nowIso(): string { return '2026-08-15T00:02:00Z' }
}

class Ids implements EventIdSource {
  #next = 1000
  next(): string { return `verdict-event-${this.#next++}` }
}

class CollisionIds implements EventIdSource {
  next(): string { return 'event-1' }
}

class Journal implements TeamEventJournal {
  readonly key = 'verification-journal'
  readonly events: unknown[]
  readonly transactions: TeamEvent[][] = []
  constructor(seed: readonly unknown[]) { this.events = [...seed] }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> {
    this.transactions.push([...events]); this.events.push(...events)
  }
}

class EvidenceCollectorStub implements HostEvidenceCollectorPort {
  readonly requests: HostEvidenceCollectionRequest[] = []
  readonly result: HostEvidenceCollectionResult
  delay = false

  constructor(result: HostEvidenceCollectionResult = { kind: 'unavailable', reason: 'collector unavailable' }) {
    this.result = result
  }

  async collect(request: HostEvidenceCollectionRequest): Promise<HostEvidenceCollectionResult> {
    this.requests.push(request)
    if (this.delay) await Promise.resolve()
    return this.result
  }
}

describe('durable verification verdict', () => {
  it('advances only a host-structured passing verdict to verification passed', () => {
    const projection = replayTeamEvents([...activeVerificationEvents(), verdictEvent(140)])
    expect(projection.verifications[VERIFICATION_ID]?.status).toBe('passed')
    expect(projection.verifications[VERIFICATION_ID]?.verdict?.disposition).toBe('passed')
    expect(projection.verificationVerdictOperations['verdict-140']?.evidence[0]).toMatchObject({ producer: 'build-runner' })
  })

  it('redacts credential-shaped command text before storing replayed evidence', () => {
    const projection = replayTeamEvents([...activeVerificationEvents(), verdictEvent(1401, {
      operationId: ControlOperationId('verdict-redacted-command'),
      evidence: [{ ...buildPass, command: 'pnpm test --token=secret-value' }],
    })])
    expect(projection.verificationVerdictOperations['verdict-redacted-command']?.evidence[0]).toMatchObject({ command: 'pnpm test --token=[REDACTED]' })
  })

  it('keeps inconclusive evidence pending and records no success', () => {
    const projection = replayTeamEvents([...activeVerificationEvents(), verdictEvent(141, {
      operationId: ControlOperationId('verdict-inconclusive'), disposition: 'inconclusive', evidence: [],
      reasons: [{ checkId: 'build', code: 'missing-evidence', detail: 'No structured host evidence was supplied' }],
    })])
    expect(projection.verifications[VERIFICATION_ID]?.status).toBe('running')
    expect(projection.verifications[VERIFICATION_ID]?.verdict?.disposition).toBe('inconclusive')
  })

  it('keeps an all-optional no-evidence verdict fail-closed during replay', () => {
    const projection = replayTeamEvents([...activeVerificationEvents(), verdictEvent(1410, {
      operationId: ControlOperationId('verdict-optional-inconclusive'),
      disposition: 'inconclusive',
      requirements: [{ checkId: 'optional-build', kind: 'build', required: false }],
      evidence: [],
      reasons: [{ checkId: 'optional-build', code: 'missing-evidence', detail: 'No structured host evidence was supplied' }],
    })])
    expect(projection.verifications[VERIFICATION_ID]?.status).toBe('running')
    expect(projection.verifications[VERIFICATION_ID]?.verdict?.disposition).toBe('inconclusive')
  })

  it('rejects an optional verdict satisfied only by unrelated evidence during replay', () => {
    expect(() => replayTeamEvents([...activeVerificationEvents(), verdictEvent(1413, {
      operationId: ControlOperationId('verdict-optional-unrelated'),
      requirements: [{ checkId: 'optional-build', kind: 'build', required: false }],
      evidence: [buildPass],
      disposition: 'passed',
      reasons: [],
    })])).toThrow(/not derived/)
  })

  it('rejects collector failure events that carry fabricated evidence', () => {
    expect(() => replayTeamEvents([...activeVerificationEvents(), verdictEvent(1414, {
      operationId: ControlOperationId('verdict-failed-with-evidence'),
      collectionStatus: 'failed',
      evidence: [buildPass],
      disposition: 'inconclusive',
      reasons: [{ checkId: 'build', code: 'collector-failed', detail: 'Host evidence collector status: failed' }],
    })])).toThrow(/cannot carry evidence/)
  })

  it('rejects an invalid durable rework budget during replay', () => {
    expect(() => replayTeamEvents([...activeVerificationEvents(), verdictEvent(1415, {
      operationId: ControlOperationId('verdict-invalid-budget'),
      reworkBudget: { currentAttempt: 1, maxAttempts: 6 },
    })])).toThrow(/invalid rework budget/)
  })

  it('rejects duplicate evidence records instead of selecting one implicitly', () => {
    expect(() => replayTeamEvents([...activeVerificationEvents(), verdictEvent(1411, {
      disposition: 'inconclusive',
      evidence: [buildPass, buildPass],
      reasons: [{
        checkId: 'build',
        code: 'invalid-evidence',
        detail: 'More than one evidence record was supplied for the same check',
      }],
    })])).not.toThrow()

    const projection = replayTeamEvents([...activeVerificationEvents(), verdictEvent(1412, {
      disposition: 'inconclusive',
      evidence: [buildPass, buildPass],
      reasons: [{
        checkId: 'build',
        code: 'invalid-evidence',
        detail: 'More than one evidence record was supplied for the same check',
      }],
    })])
    expect(projection.verifications[VERIFICATION_ID]?.status).toBe('running')
  })

  it('records failed verdict and bounded rework without creating an attempt', () => {
    const projection = replayTeamEvents([...activeVerificationEvents(), verdictEvent(142, {
      operationId: ControlOperationId('verdict-failed'), disposition: 'failed', evidence: [buildFail],
      reasons: [{ checkId: 'build', code: 'build-failed', detail: 'Build exited with code 1' }],
      rework: { action: 'retry', currentAttempt: 1, maxAttempts: 3, nextAttempt: 2, instructions: ['Fix build'] },
    })])
    expect(projection.verifications[VERIFICATION_ID]?.status).toBe('failed')
    expect(projection.verifications[VERIFICATION_ID]?.verdict?.rework?.maxAttempts).toBe(3)
    expect(projection.attempts[ATTEMPT_ID]?.ordinal).toBe(1)
    expect(projection.taskIds).toHaveLength(1)
  })

  it('is idempotent by operation id and rejects changed content', () => {
    const first = verdictEvent(143, { operationId: ControlOperationId('verdict-idempotent') })
    const duplicate = verdictEvent(144, { operationId: ControlOperationId('verdict-idempotent') })
    expect(replayTeamEvents([...activeVerificationEvents(), first, duplicate]).verifications[VERIFICATION_ID]?.status).toBe('passed')
    expect(() => replayTeamEvents([...activeVerificationEvents(), first, verdictEvent(145, { operationId: ControlOperationId('verdict-idempotent'), disposition: 'inconclusive', evidence: [], reasons: [{ checkId: 'build', code: 'missing-evidence', detail: 'missing' }] })])).toThrow(/reused for different content/)
  })

  it('shares the operation-id collision gate with Team controls', () => {
    const verdict = verdictEvent(148, { operationId: ControlOperationId('shared-operation') })
    expect(() => replayTeamEvents([
      ...activeVerificationEvents(), verdict,
      event(149, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('shared-operation'), action: 'pause' }),
    ])).toThrow(/already used/)
    expect(() => replayTeamEvents([
      ...activeVerificationEvents(),
      event(159, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('shared-operation-reverse'), action: 'pause' }),
      verdictEvent(160, { operationId: ControlOperationId('shared-operation-reverse') }),
    ])).toThrow(/already used/)
  })

  it('rejects a verdict for an old or terminal verification identity', () => {
    const failed = verdictEvent(146, {
      operationId: ControlOperationId('verdict-terminal'), disposition: 'failed', evidence: [buildFail],
      reasons: [{ checkId: 'build', code: 'build-failed', detail: 'Build exited with code 1' }],
      rework: { action: 'stop', currentAttempt: 1, maxAttempts: 1, instructions: ['Fix build'] },
    })
    expect(() => replayTeamEvents([...activeVerificationEvents(), failed, verdictEvent(147, { operationId: ControlOperationId('verdict-late') })])).toThrow(/not actively verifying/)
  })

  it('rejects cross-task, stale-attempt, fabricated, and invalid rework verdict facts', () => {
    const otherTask = TaskId('verification-other-task')
    expect(() => replayTeamEvents([
      ...activeVerificationEvents(),
      event(152, { type: 'yuqi/task-created', contract: contract(otherTask) }),
      verdictEvent(153, { taskId: otherTask }),
    ])).toThrow(/references another task or attempt/)

    const active = replayTeamEvents(activeVerificationEvents())
    const task = active.tasks[TASK_ID]!
    const stale = { ...active, tasks: { ...active.tasks, [TASK_ID]: { ...task, attemptIds: [] } } }
    expect(() => applyTeamEvent(stale, verdictEvent(154))).toThrow(/does not target the current attempt/)

    expect(() => replayTeamEvents([...activeVerificationEvents(), verdictEvent(155, {
      disposition: 'passed', evidence: [buildFail],
      reasons: [{ checkId: 'build', code: 'build-failed', detail: 'Build exited with code 1' }],
    })])).toThrow(/not derived/)

    const failed = {
      disposition: 'failed', evidence: [buildFail],
      reasons: [{ checkId: 'build', code: 'build-failed', detail: 'Build exited with code 1' }],
    }
    expect(() => replayTeamEvents([...activeVerificationEvents(), verdictEvent(156, failed)])).toThrow(/must carry bounded rework/)
    expect(() => replayTeamEvents([...activeVerificationEvents(), verdictEvent(157, {
      ...failed, rework: { action: 'retry', currentAttempt: 1, maxAttempts: 3, nextAttempt: 3, instructions: ['Fix build'] },
    })])).toThrow(/invalid rework/)
    expect(() => replayTeamEvents([...activeVerificationEvents(), verdictEvent(158, {
      rework: { action: 'stop', currentAttempt: 1, maxAttempts: 1, instructions: ['Not applicable'] },
    })])).toThrow(/invalid rework/)
  })
})

describe('VerificationVerdictCoordinator', () => {
  it('persists a verdict through the journal and replays the same operation without another write', async () => {
    const journal = new Journal(activeVerificationEvents())
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const request = {
      teamId: TEAM_ID,
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      verificationId: VERIFICATION_ID,
      operationId: 'coordinator-verdict',
      requirements: [buildRequirement],
      evidence: [buildPass],
      rework: { currentAttempt: 1, maxAttempts: 3 },
    }
    const first = await coordinator.record(request, journal)
    const second = await coordinator.record(request, journal)
    expect(first.verifications[VERIFICATION_ID]?.status).toBe('passed')
    expect(first.attempts[ATTEMPT_ID]?.status).toBe('completed')
    expect(first.tasks[TASK_ID]?.status).toBe('completed')
    expect(first.team.status).toBe('running')
    expect(journal.transactions[0]?.map(item => item.type)).toEqual([
      'yuqi/verification-verdict-recorded',
      'yuqi/attempt-status-changed',
      'yuqi/task-status-changed',
    ])
    expect(second).toEqual(first)
    expect(journal.transactions).toHaveLength(1)
    await expect(coordinator.record({ ...request, rework: { currentAttempt: 1, maxAttempts: 2 } }, journal))
      .rejects.toMatchObject({ code: 'VERIFICATION_OPERATION_CONFLICT' })
    await transactions.dispose()
  })

  it('completes a verifying task when settlement was already marked completed before the verdict', async () => {
    const journal = new Journal([
      ...activeVerificationEvents(),
      event(152, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'settled', to: 'completed' }),
    ])
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const result = await coordinator.record({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'late-verdict-after-attempt-completed', requirements: [buildRequirement], evidence: [buildPass], rework: { currentAttempt: 1, maxAttempts: 2 },
    }, journal)
    expect(result.attempts[ATTEMPT_ID]?.status).toBe('completed')
    expect(result.tasks[TASK_ID]?.status).toBe('completed')
    expect(result.team.status).toBe('running')
    expect(journal.transactions[0]?.map(item => item.type)).toEqual([
      'yuqi/verification-verdict-recorded',
      'yuqi/task-status-changed',
    ])
    await transactions.dispose()
  })

  it('keeps a passed verdict from completing an attempt that entered verification_failed', async () => {
    const journal = new Journal([
      ...activeVerificationEvents(),
      event(152, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'settled', to: 'verification_failed' }),
    ])
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const result = await coordinator.record({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'verdict-after-verification-failed-attempt', requirements: [buildRequirement], evidence: [buildPass], rework: { currentAttempt: 1, maxAttempts: 2 },
    }, journal)
    expect(result.verifications[VERIFICATION_ID]?.status).toBe('passed')
    expect(result.attempts[ATTEMPT_ID]?.status).toBe('verification_failed')
    expect(result.tasks[TASK_ID]?.status).toBe('verifying')
    expect(result.team.status).toBe('running')
    expect(journal.transactions[0]?.map(item => item.type)).toEqual(['yuqi/verification-verdict-recorded'])
    await transactions.dispose()
  })

  it('keeps Team running when a prior admitted terminal attempt still requires reconciliation', async () => {
    const retryAttempt = AttemptId('verdict-gap-attempt-2')
    const retryVerification = VerificationId('verdict-gap-verification-2')
    const journal = new Journal([
      ...completeTeamEvents().slice(0, 8),
      event(160, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'failed' }),
      event(161, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'failed' }),
      event(162, { type: 'yuqi/task-retry-requested', operationId: ControlOperationId('verdict-gap-retry'), taskId: TASK_ID }),
      event(163, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'ready', to: 'running' }),
      event(164, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId: retryAttempt, ordinal: 2, modelProvider: 'deepseek', modelId: 'deepseek-v4' }),
      event(165, { type: 'yuqi/attempt-admitted', taskId: TASK_ID, attemptId: retryAttempt, agentSessionId: 'session-worker-2', messageId: 'message-2' }),
      event(166, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: retryAttempt, from: 'dispatching', to: 'running' }),
      event(167, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: retryAttempt, from: 'running', to: 'settled' }),
      event(168, { type: 'yuqi/attempt-evidence-recorded', taskId: TASK_ID, attemptId: retryAttempt, runId: 'run-2', agentSessionId: 'session-worker-2', provider: 'in-process', stopReason: 'completed', hasAssistantOutput: true, settledAt: '2026-08-15T00:01:08Z' }),
      event(169, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'verifying' }),
      event(170, { type: 'yuqi/verification-created', taskId: TASK_ID, attemptId: retryAttempt, verificationId: retryVerification, verifierSessionId: 'session-verifier-2' }),
      event(171, { type: 'yuqi/verification-status-changed', taskId: TASK_ID, attemptId: retryAttempt, verificationId: retryVerification, from: 'pending', to: 'running' }),
    ])
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const result = await coordinator.record({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: retryAttempt, verificationId: retryVerification,
      operationId: 'verdict-gap-completion', requirements: [buildRequirement], evidence: [buildPass], rework: { currentAttempt: 2, maxAttempts: 2 },
    }, journal)
    expect(result.tasks[TASK_ID]?.status).toBe('completed')
    expect(result.team.status).toBe('running')
    expect(journal.transactions[0]?.map(item => item.type)).toEqual([
      'yuqi/verification-verdict-recorded', 'yuqi/attempt-status-changed', 'yuqi/task-status-changed',
    ])
    await transactions.dispose()
  })

  it('keeps Team running when completion has an active file lease', async () => {
    const journal = new Journal([
      ...activeVerificationEvents(),
      event(172, { type: 'yuqi/workspace-provisioning-started', workspace: { ...completionWorkspace, status: 'provisioning' } }),
      event(173, { type: 'yuqi/workspace-provisioned', workspaceId: completionWorkspace.workspaceId }),
      event(174, { type: 'yuqi/file-lease-acquired', lease: {
        leaseId: FileLeaseId('verdict-active-lease'), taskId: TASK_ID, mode: 'write', fileScope: ['src/**'], status: 'active',
      } }),
    ])
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const result = await coordinator.record({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'verdict-active-lease', requirements: [buildRequirement], evidence: [buildPass], rework: { currentAttempt: 1, maxAttempts: 2 },
    }, journal)
    expect(result.tasks[TASK_ID]?.status).toBe('completed')
    expect(result.team.status).toBe('running')
    await transactions.dispose()
  })

  it('finishes a pending cancellation only after the active verification releases its lease', async () => {
    const journal = new Journal([
      ...activeVerificationEvents(),
      event(1741, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('cancel-during-verification'), action: 'cancel' }),
      event(1742, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling' }),
    ])
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const result = await coordinator.record({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'verdict-after-cancel', requirements: [buildRequirement], evidence: [buildPass], rework: { currentAttempt: 1, maxAttempts: 2 },
    }, journal)
    expect(result.tasks[TASK_ID]?.status).toBe('completed')
    expect(result.team.status).toBe('cancelled')
    expect(result.verifications[VERIFICATION_ID]?.status).toBe('passed')
    await transactions.dispose()
  })

  it('finishes a pending pause after a failed verification without forcing Team failure', async () => {
    const journal = new Journal([
      ...activeVerificationEvents(),
      event(1745, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('pause-during-verification'), action: 'pause' }),
      event(1746, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
    ])
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const result = await coordinator.record({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'verdict-after-pause', requirements: [buildRequirement], evidence: [buildFail],
      rework: { currentAttempt: 1, maxAttempts: 1 },
    }, journal)
    expect(result.team.status).toBe('paused')
    expect(result.tasks[TASK_ID]?.status).toBe('failed')
    await transactions.dispose()
  })

  it.each([
    ['failed', [buildFail], { action: 'stop', currentAttempt: 1, maxAttempts: 1, instructions: ['stop'] }],
    ['inconclusive', [], { currentAttempt: 1, maxAttempts: 2 }],
  ] as const)('finishes cancellation when verification is %s', async (disposition, evidence, rework) => {
    const journal = new Journal([
      ...activeVerificationEvents(),
      event(1743, { type: 'yuqi/team-control-requested', operationId: ControlOperationId(`cancel-${disposition}`), action: 'cancel' }),
      event(1744, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling' }),
    ])
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const result = await coordinator.record({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: `verdict-${disposition}-after-cancel`, requirements: [buildRequirement], evidence, rework,
    }, journal)
    expect(result.team.status).toBe('cancelled')
    expect(Object.values(result.fileLeases).some(lease => lease.status === 'active')).toBe(false)
    await transactions.dispose()
  })

  it('keeps Team running while the workspace is not ready', async () => {
    const journal = new Journal([
      ...activeVerificationEvents(),
      event(175, { type: 'yuqi/workspace-provisioning-started', workspace: completionWorkspace }),
    ])
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const result = await coordinator.record({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'verdict-workspace-not-ready', requirements: [buildRequirement], evidence: [buildPass], rework: { currentAttempt: 1, maxAttempts: 2 },
    }, journal)
    expect(result.tasks[TASK_ID]?.status).toBe('completed')
    expect(result.team.status).toBe('running')
    await transactions.dispose()
  })

  it('releases an active verification lease when evidence is inconclusive', async () => {
    const journal = new Journal([
      ...activeVerificationEvents(),
      event(176, { type: 'yuqi/workspace-provisioning-started', workspace: completionWorkspace }),
      event(177, { type: 'yuqi/workspace-provisioned', workspaceId: completionWorkspace.workspaceId }),
      event(178, { type: 'yuqi/file-lease-acquired', lease: {
        leaseId: FileLeaseId('verification-inconclusive-lease'), taskId: TASK_ID, attemptId: ATTEMPT_ID,
        mode: 'write', fileScope: ['src/**'], status: 'active',
      } }),
    ])
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const result = await coordinator.record({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'inconclusive-with-lease', requirements: [{ checkId: 'interface', kind: 'interface' }],
      evidence: [{ checkId: 'interface', kind: 'interface', statusCode: 200 }], rework: { currentAttempt: 1, maxAttempts: 2 },
    }, journal)
    expect(result.fileLeases['verification-inconclusive-lease']?.status).toBe('released')
    expect(result.tasks[TASK_ID]?.status).toBe('blocked')
    await transactions.dispose()
  })

  it('does not complete the Team from a passed verdict while another task is incomplete', async () => {
    const otherTask = TaskId('other-incomplete-task')
    const journal = new Journal([
      ...activeVerificationEvents(),
      event(153, { type: 'yuqi/task-created', contract: contract(otherTask) }),
    ])
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const result = await coordinator.record({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'passed-with-incomplete-sibling', requirements: [buildRequirement], evidence: [buildPass], rework: { currentAttempt: 1, maxAttempts: 2 },
    }, journal)
    expect(result.tasks[TASK_ID]?.status).toBe('completed')
    expect(result.tasks[otherTask]?.status).toBe('pending')
    expect(result.team.status).toBe('running')
    expect(journal.transactions[0]?.map(item => item.type)).toEqual([
      'yuqi/verification-verdict-recorded',
      'yuqi/attempt-status-changed',
      'yuqi/task-status-changed',
    ])
    await transactions.dispose()
  })

  it('validates the full completion append before commit and leaves the journal untouched on conflict', async () => {
    const journal = new Journal(activeVerificationEvents())
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new CollisionIds(), transactions)
    await expect(coordinator.record({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'completion-event-id-collision', requirements: [buildRequirement], evidence: [buildPass], rework: { currentAttempt: 1, maxAttempts: 2 },
    }, journal)).rejects.toMatchObject({ code: 'EVENT_ID_COLLISION' })
    expect(journal.transactions).toHaveLength(0)
    expect(journal.events).toHaveLength(activeVerificationEvents().length)
    await transactions.dispose()
  })

  it('does not start a child for failed or inconclusive evidence', async () => {
    const journal = new Journal(activeVerificationEvents())
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const result = await coordinator.record({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'coordinator-failed', requirements: [buildRequirement], evidence: [buildFail], rework: { currentAttempt: 1, maxAttempts: 2 },
    }, journal)
    expect(result.verifications[VERIFICATION_ID]?.status).toBe('failed')
    expect(result.attempts).toEqual(expect.objectContaining({ [ATTEMPT_ID]: expect.objectContaining({ ordinal: 1 }) }))
    expect(journal.transactions[0]).toHaveLength(1)
    await transactions.dispose()
  })

  it('fails the Team and releases the exact attempt lease when verification stops without retry', async () => {
    const journal = new Journal([
      ...activeVerificationEvents(),
      event(4391, { type: 'yuqi/workspace-provisioning-started', workspace: completionWorkspace }),
      event(4392, { type: 'yuqi/workspace-provisioned', workspaceId: completionWorkspace.workspaceId }),
      event(4393, { type: 'yuqi/file-lease-acquired', lease: {
        leaseId: FileLeaseId('verification-stop-lease'), taskId: TASK_ID, attemptId: ATTEMPT_ID,
        mode: 'write', fileScope: ['src/**'], status: 'active',
      } }),
    ])
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const result = await coordinator.record({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'coordinator-failed-stop', requirements: [buildRequirement], evidence: [buildFail],
      rework: { currentAttempt: 1, maxAttempts: 1 },
    }, journal)

    expect(result.verifications[VERIFICATION_ID]?.status).toBe('failed')
    expect(result.attempts[ATTEMPT_ID]?.status).toBe('verification_failed')
    expect(result.tasks[TASK_ID]?.status).toBe('failed')
    expect(result.team.status).toBe('failed')
    expect(result.fileLeases['verification-stop-lease']?.status).toBe('released')
    expect(journal.transactions[0]?.map(item => item.type)).toEqual([
      'yuqi/verification-verdict-recorded',
      'yuqi/file-lease-released',
      'yuqi/attempt-status-changed',
      'yuqi/task-status-changed',
      'yuqi/team-status-changed',
    ])
    await transactions.dispose()
  })

  it('persists malformed input as inconclusive and exercises optional event fields', async () => {
    const journal = new Journal(activeVerificationEvents())
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const result = await coordinator.record({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'coordinator-inconclusive',
      requirements: [{ checkId: 'api', kind: 'interface' as const, required: true, expectedStatusCodes: [200] }],
      evidence: [{ checkId: 'api', kind: 'interface', statusCode: 200 }],
      rework: { currentAttempt: 1, maxAttempts: 2 },
    }, journal)
    expect(result.verifications[VERIFICATION_ID]?.status).toBe('waived')
    expect(result.tasks[TASK_ID]?.status).toBe('blocked')
    expect(result.verifications[VERIFICATION_ID]?.verdict?.disposition).toBe('inconclusive')
    await transactions.dispose()
  })

  it('rejects team mismatch, operation collisions, changed replays, and inactive verification', async () => {
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    await expect(coordinator.record({
      teamId: 'wrong-team', taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'wrong-team-operation', requirements: [buildRequirement], evidence: [buildPass], rework: { currentAttempt: 1, maxAttempts: 2 },
    }, new Journal(activeVerificationEvents()))).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    await expect(coordinator.record({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: 'missing-attempt', verificationId: VERIFICATION_ID,
      operationId: 'missing-attempt-operation', requirements: [buildRequirement], evidence: [buildPass], rework: { currentAttempt: 1, maxAttempts: 2 },
    }, new Journal(activeVerificationEvents()))).rejects.toMatchObject({ code: 'VERIFICATION_NOT_ALLOWED' })

    const collisionJournal = new Journal([
      ...activeVerificationEvents(),
      event(150, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('collision'), action: 'pause' }),
    ])
    await expect(coordinator.record({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'collision', requirements: [buildRequirement], evidence: [buildPass], rework: { currentAttempt: 1, maxAttempts: 2 },
    }, collisionJournal)).rejects.toMatchObject({ code: 'VERIFICATION_OPERATION_CONFLICT' })

    const replayJournal = new Journal(activeVerificationEvents())
    const request = {
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'changed-replay', requirements: [buildRequirement], evidence: [buildPass], rework: { currentAttempt: 1, maxAttempts: 2 },
    }
    await coordinator.record(request, replayJournal)
    await expect(coordinator.record({ ...request, evidence: [buildFail] }, replayJournal)).rejects.toMatchObject({ code: 'VERIFICATION_OPERATION_CONFLICT' })

    const inactive = new Journal([...activeVerificationEvents(), verdictEvent(151)])
    await expect(coordinator.record({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'inactive-verification', requirements: [buildRequirement], evidence: [buildPass], rework: { currentAttempt: 1, maxAttempts: 2 },
    }, inactive)).rejects.toMatchObject({ code: 'VERIFICATION_NOT_ALLOWED' })
    await transactions.dispose()
  })

  it('collects outside the durable gate, persists unavailable as inconclusive, and does not recollect an idempotent operation', async () => {
    const journal = new Journal(activeVerificationEvents())
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const collector = new EvidenceCollectorStub()
    const request = {
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'collector-unavailable', requirements: [buildRequirement], rework: { currentAttempt: 1, maxAttempts: 2 },
      signal: new AbortController().signal,
    }
    const first = await coordinator.recordFromCollector(request, journal, collector)
    const second = await coordinator.recordFromCollector(request, journal, collector)
    expect(first.verifications[VERIFICATION_ID]?.verdict?.disposition).toBe('inconclusive')
    expect(first.verifications[VERIFICATION_ID]?.verdict?.collectionStatus).toBe('unavailable')
    expect(first.verifications[VERIFICATION_ID]?.verdict?.reasons[0]?.code).toBe('collector-unavailable')
    expect(second).toEqual(first)
    expect(collector.requests).toHaveLength(1)
    expect(collector.requests[0]).toMatchObject({ teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID, requirementIds: ['build'], signal: request.signal })
    expect(journal.transactions).toHaveLength(1)
    await expect(coordinator.recordFromCollector({ ...request, rework: { currentAttempt: 2, maxAttempts: 2 } }, journal, collector))
      .rejects.toMatchObject({ code: 'VERIFICATION_OPERATION_CONFLICT' })
    expect(collector.requests).toHaveLength(1)
    await transactions.dispose()
  })

  it('does not let a pending collector block a durable pause and aborts the verification without waiting for collector settlement', async () => {
    const journal = new Journal(activeVerificationEvents())
    const transactions = new DurableJournalCoordinator()
    const ids = new Ids()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), ids, transactions)
    const controls = new TeamControlCoordinator(new ClockStub(), ids, transactions)
    const signal = new AbortController()
    let entered!: () => void
    const collecting = new Promise<void>(resolve => { entered = resolve })
    let releaseCollector!: (result: HostEvidenceCollectionResult) => void
    const collectorResult = new Promise<HostEvidenceCollectionResult>(resolve => { releaseCollector = resolve })
    const collector: HostEvidenceCollectorPort = {
      collect() {
        entered()
        return collectorResult
      },
    }
    const verdict = coordinator.recordFromCollector({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'collector-pause-boundary', requirements: [buildRequirement], rework: { currentAttempt: 1, maxAttempts: 2 },
      signal: signal.signal,
    }, journal, collector)
    await collecting

    let pauseSettled = false
    const pause = controls.pause({ teamId: TEAM_ID, operationId: 'pause-during-collector' }, journal)
      .then(projection => { pauseSettled = true; return projection })
    for (let index = 0; index < 10 && !pauseSettled; index += 1) await Promise.resolve()
    const settledBeforeCollector = pauseSettled

    signal.abort()
    releaseCollector({ kind: 'unavailable', reason: 'late collector result' })
    const [pausing, paused] = await Promise.all([pause, verdict])
    expect(settledBeforeCollector).toBe(true)
    expect(pausing.team.status).toBe('pausing')
    expect(paused.team.status).toBe('paused')
    expect(paused.verifications[VERIFICATION_ID]?.verdict?.collectionStatus).toBe('aborted')
    await transactions.dispose()
  })

  it('persists unavailable, failed, and aborted collector outcomes distinctly and fail-closed', async () => {
    const cases = [
      [{ kind: 'unavailable', reason: 'no collector' } as const, 'collector-unavailable'],
      [{ kind: 'failed', code: 'HOST_FAILED', reason: 'host failure' } as const, 'collector-failed'],
      [{ kind: 'aborted', reason: 'cancelled' } as const, 'collector-aborted'],
    ] as const
    for (const [outcome, reasonCode] of cases) {
      const journal = new Journal(activeVerificationEvents())
      const transactions = new DurableJournalCoordinator()
      const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
      const result = await coordinator.recordFromCollector({
        teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
        operationId: `collector-${outcome.kind}`, requirements: [buildRequirement], rework: { currentAttempt: 1, maxAttempts: 2 },
      }, journal, new EvidenceCollectorStub(outcome))
      expect(result.verifications[VERIFICATION_ID]?.verdict).toMatchObject({ disposition: 'inconclusive', collectionStatus: outcome.kind })
      expect(result.verifications[VERIFICATION_ID]?.verdict?.reasons).toEqual([expect.objectContaining({ code: reasonCode })])
      expect(replayTeamEvents(journal.events).verifications[VERIFICATION_ID]?.verdict?.collectionStatus).toBe(outcome.kind)
      expect(result.tasks[TASK_ID]?.status).toBe('blocked')
      expect(result.verifications[VERIFICATION_ID]?.status).toBe('waived')
      await transactions.dispose()
    }
  })

  it('serializes concurrent collection and accepts only independently supplied structured evidence', async () => {
    const journal = new Journal(activeVerificationEvents())
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const collector = new EvidenceCollectorStub({ kind: 'collected', evidence: [buildPass] })
    collector.delay = true
    const request = {
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'collector-concurrent', requirements: [buildRequirement], rework: { currentAttempt: 1, maxAttempts: 2 },
    }
    const [left, right] = await Promise.all([
      coordinator.recordFromCollector(request, journal, collector),
      coordinator.recordFromCollector(request, journal, collector),
    ])
    expect(left).toEqual(right)
    expect(left.verifications[VERIFICATION_ID]?.status).toBe('passed')
    expect(left.attempts[ATTEMPT_ID]?.status).toBe('completed')
    expect(left.tasks[TASK_ID]?.status).toBe('completed')
    expect(left.team.status).toBe('running')
    expect(collector.requests).toHaveLength(1)
    await transactions.dispose()
  })

  it('rejects a changed request during an in-flight collection and handles the abort-listener race', async () => {
    const journal = new Journal(activeVerificationEvents())
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const collector = new EvidenceCollectorStub({ kind: 'collected', evidence: [buildPass] })
    collector.delay = true
    const request = {
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'collector-pending-content-conflict', requirements: [buildRequirement], rework: { currentAttempt: 1, maxAttempts: 2 },
    }
    const first = coordinator.recordFromCollector(request, journal, collector)
    await expect(Promise.resolve().then(() => coordinator.recordFromCollector({ ...request, requirements: [{ checkId: 'other', kind: 'test' as const }] }, journal, collector)))
      .rejects.toMatchObject({ code: 'VERIFICATION_OPERATION_CONFLICT' })
    await first

    let reads = 0
    const racedSignal = {
      get aborted() { reads += 1; return reads > 1 },
      reason: undefined,
      addEventListener() {}, removeEventListener() {},
    } as unknown as AbortSignal
    const raced = await coordinator.recordFromCollector({ ...request, operationId: 'collector-listener-race', signal: racedSignal }, new Journal(activeVerificationEvents()), collector)
    expect(raced.verifications[VERIFICATION_ID]?.verdict?.collectionStatus).toBe('aborted')
    await transactions.dispose()
  })

  it('rejects an idempotency replay that changes the requested requirement content without recollecting', async () => {
    const journal = new Journal(activeVerificationEvents())
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const collector = new EvidenceCollectorStub()
    const request = {
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'collector-content-conflict', requirements: [buildRequirement], rework: { currentAttempt: 1, maxAttempts: 2 },
    }
    await coordinator.recordFromCollector(request, journal, collector)
    await expect(coordinator.recordFromCollector({ ...request, requirements: [{ checkId: 'test', kind: 'test' as const }] }, journal, collector))
      .rejects.toMatchObject({ code: 'VERIFICATION_OPERATION_CONFLICT' })
    expect(collector.requests).toHaveLength(1)
    await transactions.dispose()
  })

  it('rejects stale or malformed collection requests before invoking the Host collector', async () => {
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const staleJournal = new Journal(activeVerificationEvents())
    const stale = new EvidenceCollectorStub()
    await expect(coordinator.recordFromCollector({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: 'old-attempt', verificationId: VERIFICATION_ID,
      operationId: 'collector-stale', requirements: [buildRequirement], rework: { currentAttempt: 1, maxAttempts: 2 },
    }, staleJournal, stale)).rejects.toMatchObject({ code: 'VERIFICATION_NOT_ALLOWED' })
    expect(stale.requests).toHaveLength(0)

    const malformed = new EvidenceCollectorStub()
    await expect(coordinator.recordFromCollector({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'collector-malformed', requirements: [buildRequirement, buildRequirement], rework: { currentAttempt: 1, maxAttempts: 2 },
    }, new Journal(activeVerificationEvents()), malformed)).rejects.toThrow(/Duplicate evidence requirement/)
    expect(malformed.requests).toHaveLength(0)
    await transactions.dispose()
  })

  it('records an already-aborted collection without invoking the Host collector', async () => {
    const transactions = new DurableJournalCoordinator()
    const coordinator = new VerificationVerdictCoordinator(new ClockStub(), new Ids(), transactions)
    const collector = new EvidenceCollectorStub({ kind: 'collected', evidence: [buildPass] })
    const signal = new AbortController()
    signal.abort(new Error('cancel before collection'))
    const result = await coordinator.recordFromCollector({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      operationId: 'collector-already-aborted', requirements: [buildRequirement], rework: { currentAttempt: 1, maxAttempts: 2 },
      signal: signal.signal,
    }, new Journal(activeVerificationEvents()), collector)
    expect(result.verifications[VERIFICATION_ID]?.verdict?.collectionStatus).toBe('aborted')
    expect(collector.requests).toHaveLength(0)
    await transactions.dispose()
  })
})
