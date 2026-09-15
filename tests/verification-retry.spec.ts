import { describe, expect, it } from 'vitest'
import {
  ControlOperationId,
  DurableJournalCoordinator,
  FileLeaseId,
  TaskRetryCoordinator,
  WorkspaceId,
  type Clock,
  type EventIdSource,
  type TeamEvent,
  type TeamEventJournal,
} from '../src/index.ts'
import { AutomaticTaskRetryCoordinator, automaticRetryOperationId } from '../src/application/verification-retry.ts'
import { ATTEMPT_ID, completeTeamEvents, event, TASK_ID, TEAM_ID, VERIFICATION_ID } from './fixtures.ts'

const buildRequirement = { checkId: 'build', kind: 'build' as const }
const buildFail = {
  checkId: 'build', capturedAt: '2026-08-15T00:01:00Z', kind: 'build' as const,
  producer: 'build-runner' as const, command: 'pnpm run build', exitCode: 1, artifactDigest: 'sha256-build',
}

class ClockStub implements Clock {
  nowIso(): string { return '2026-08-15T01:00:00Z' }
}

class Ids implements EventIdSource {
  #next = 1
  next(): string { return `automatic-retry-event-${this.#next++}` }
}

class Journal implements TeamEventJournal {
  readonly key = 'automatic-retry-journal'
  readonly events: unknown[]
  readonly transactions: TeamEvent[][] = []
  fail = false

  constructor(seed: readonly unknown[]) { this.events = [...seed] }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> {
    if (this.fail) throw new Error('append failed')
    this.transactions.push([...events])
    this.events.push(...events)
  }
}

function failedVerdictEvents(operationId = 'verdict-failed-retry', rework: Record<string, unknown> = {
  action: 'retry', currentAttempt: 1, maxAttempts: 3, nextAttempt: 2, instructions: ['Fix build'],
}): readonly TeamEvent[] {
  return [
    ...completeTeamEvents().slice(0, 13),
    event(300, {
      type: 'yuqi/verification-verdict-recorded', operationId: ControlOperationId(operationId),
      taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      disposition: 'failed', requirements: [buildRequirement], evidence: [buildFail],
      reasons: [{ checkId: 'build', code: 'build-failed', detail: 'Build exited with code 1' }], rework,
    } as never),
  ]
}

function request(verdictOperationId = 'verdict-failed-retry') {
  return { teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID, verdictOperationId }
}

function coordinator(transactions = new DurableJournalCoordinator()): AutomaticTaskRetryCoordinator {
  return new AutomaticTaskRetryCoordinator(new TaskRetryCoordinator(new ClockStub(), new Ids(), transactions))
}

describe('AutomaticTaskRetryCoordinator', () => {
  it('reuses TaskRetryCoordinator to queue one durable retry from a failed verdict', async () => {
    const journal = new Journal(failedVerdictEvents())
    const automatic = coordinator()
    const retried = await automatic.retry(request(), journal)

    expect(retried.tasks[TASK_ID]?.status).toBe('ready')
    expect(retried.tasks[TASK_ID]?.attemptIds).toEqual([ATTEMPT_ID])
    expect(journal.transactions[0]?.map(event => event.type)).toEqual(['yuqi/task-retry-requested'])
    expect(journal.events.filter(event => (event as TeamEvent).type === 'yuqi/task-retry-requested')).toHaveLength(1)
  })

  it('is idempotent by the verdict-derived retry operation', async () => {
    const journal = new Journal(failedVerdictEvents())
    const transactions = new DurableJournalCoordinator()
    const automatic = coordinator(transactions)
    await automatic.retry(request(), journal)
    await automatic.retry(request(), journal)

    expect(journal.transactions).toHaveLength(1)
    expect(journal.events.filter(event => (event as TeamEvent).type === 'yuqi/task-retry-requested')).toHaveLength(1)
    expect(automaticRetryOperationId('verdict-failed-retry')).toBe('automatic-retry:verdict-failed-retry')
    await transactions.dispose()
  })

  it('serializes concurrent triggers through the shared journal gate', async () => {
    const journal = new Journal(failedVerdictEvents())
    const transactions = new DurableJournalCoordinator()
    const automatic = coordinator(transactions)
    await Promise.all([automatic.retry(request(), journal), automatic.retry(request(), journal)])

    expect(journal.transactions).toHaveLength(1)
    await transactions.dispose()
  })

  it.each([
    ['missing verdict', completeTeamEvents().slice(0, 13), 'RETRY_NOT_ALLOWED'],
    ['inconclusive verdict', [
      ...completeTeamEvents().slice(0, 13),
      event(301, {
        type: 'yuqi/verification-verdict-recorded', operationId: ControlOperationId('verdict-inconclusive'),
        taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
        disposition: 'inconclusive', requirements: [buildRequirement], evidence: [],
        reasons: [{ checkId: 'build', code: 'missing-evidence', detail: 'No structured host evidence was supplied' }],
      }),
    ], 'RETRY_NOT_ALLOWED'],
    ['passed verdict', completeTeamEvents(), 'RETRY_NOT_ALLOWED'],
    ['retry at max', failedVerdictEvents('verdict-at-max', { action: 'stop', currentAttempt: 3, maxAttempts: 3, instructions: ['Stop'] }), 'RETRY_NOT_ALLOWED'],
  ] as const)('does not retry for %s', async (_label, seed, code) => {
    await expect(coordinator().retry(request(_label === 'missing verdict' ? 'missing' : _label === 'inconclusive verdict' ? 'verdict-inconclusive' : _label === 'passed verdict' ? 'fixture-verdict-passed' : 'verdict-at-max'), new Journal(seed)))
      .rejects.toMatchObject({ code })
  })

  it.each([
    ['paused', [event(302, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }), event(303, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' })]],
    ['cancelled', [event(304, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling' }), event(305, { type: 'yuqi/team-status-changed', from: 'cancelling', to: 'cancelled' })]],
    ['reconciliation', [event(306, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' })]],
  ] as const)('blocks retry while Team is %s', async (_label, statusEvents) => {
    const seed = [...failedVerdictEvents(), ...statusEvents]
    await expect(coordinator().retry(request(), new Journal(seed))).rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' })
  })

  it('atomically releases the failed latest attempt lease before queueing retry', async () => {
    const seed = [
      ...failedVerdictEvents(),
      event(307, { type: 'yuqi/workspace-provisioning-started', workspace: {
        workspaceId: WorkspaceId('automatic-retry-workspace'),
        project: {
          projectRoot: 'F:\\repo', repositoryRoot: 'F:\\repo', gitCommonDirectory: 'F:\\repo\\.git',
          baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: [],
        },
        worktreePath: 'F:\\managed\\automatic-retry', branchName: 'yuqi/automatic-retry', status: 'provisioning',
      } }),
      event(308, { type: 'yuqi/workspace-provisioned', workspaceId: WorkspaceId('automatic-retry-workspace') }),
      event(309, { type: 'yuqi/file-lease-acquired', lease: {
        leaseId: FileLeaseId('automatic-retry-lease'), taskId: TASK_ID, attemptId: ATTEMPT_ID,
        mode: 'write', fileScope: ['src/**'], status: 'active',
      } }),
    ]
    const journal = new Journal(seed)
    const retried = await coordinator().retry(request(), journal)
    expect(retried.fileLeases['automatic-retry-lease']?.status).toBe('released')
    expect(journal.transactions[0]?.map(item => item.type)).toEqual([
      'yuqi/file-lease-released', 'yuqi/task-retry-requested',
    ])
  })

  it('fails closed when append fails and leaves no retry event', async () => {
    const journal = new Journal(failedVerdictEvents())
    journal.fail = true
    await expect(coordinator().retry(request(), journal)).rejects.toMatchObject({ code: 'INTENT_PERSISTENCE_FAILED' })
    expect(journal.events.filter(event => (event as TeamEvent).type === 'yuqi/task-retry-requested')).toHaveLength(0)
  })
})
