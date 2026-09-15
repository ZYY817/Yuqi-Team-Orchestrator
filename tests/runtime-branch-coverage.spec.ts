import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  AttemptId,
  parseTeamEvent,
  TaskId,
  TeamEventId,
  TeamId,
} from '../src/index.ts'
import type { TeamEvent, TeamEventJournal } from '../src/index.ts'
import { decideQualityGate } from '../src/application/quality-gate.ts'
import { TeamRunLoopCoordinator } from '../src/application/run-team-loop.ts'
import type { TeamRunCyclePort, RunTeamLoopResult } from '../src/application/run-team-loop.ts'
import type { TeamProjection, TaskView } from '../src/domain/projection.ts'
import {
  archiveTerminalYuqiControllers,
  isYuqiController,
} from '../src/host/harness/controller-archive.ts'
import { HarnessTeamProgressAdapter } from '../src/host/harness/progress-adapter.ts'
import { HarnessTeamRunnerSupervisor } from '../src/host/harness/run-cycle.ts'
import type { HarnessTeamRunnerRegistration } from '../src/host/harness/run-cycle.ts'
import { completeTeamEvents, contract } from './fixtures.ts'

const TEAM_ID = TeamId('runtime-coverage-team')

class Journal implements TeamEventJournal {
  readonly events: TeamEvent[]
  constructor(readonly key: string, events: readonly TeamEvent[]) { this.events = [...events] }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> { this.events.push(...events) }
}

function event(index: number, body: Record<string, unknown>): TeamEvent {
  return parseTeamEvent({
    schemaVersion: 1,
    eventId: `runtime-coverage-${index}`,
    teamId: TEAM_ID,
    occurredAt: `2026-08-31T00:00:${String(index).padStart(2, '0')}Z`,
    ...body,
  })
}

function completedTask(taskId: string, kind: 'work' | 'review-rework' = 'work', sourceReviewId?: string): TaskView {
  return {
    contract: {
      ...contract(TaskId(taskId)),
      kind,
      ...(kind === 'review-rework' ? { reviewRework: { sourceReviewId: sourceReviewId!, round: 1 } } : {}),
    },
    status: 'completed',
    attemptIds: [],
    verificationIds: [],
    verificationAttemptFloor: 1,
  }
}

function qualityProjection(options: {
  latestCandidate?: string
  currentCandidate?: string
  round?: number
  maxReworkRounds?: number
  reworkStatus?: TaskView['status']
  userDecision?: 'authorize_final_rework'
  includeResult?: boolean
  taskCount?: number
} = {}): TeamProjection {
  const currentCandidate = TeamEventId(options.currentCandidate ?? 'candidate-current')
  const latestCandidate = TeamEventId(options.latestCandidate ?? String(currentCandidate))
  const taskCount = options.taskCount ?? 1
  const taskIds = Array.from({ length: taskCount }, (_, index) => TaskId(`task-${index}`))
  const tasks: Record<string, TaskView> = Object.fromEntries(taskIds.map(id => [id, completedTask(String(id))]))
  if (options.reworkStatus !== undefined) {
    const rework = completedTask('rework', 'review-rework', 'review-1')
    tasks.rework = { ...rework, status: options.reworkStatus }
    taskIds.push(TaskId('rework'))
  }
  return {
    schemaVersion: 1,
    team: {
      id: TEAM_ID,
      title: 'Runtime coverage',
      objective: 'Exercise public state machines',
      status: 'running',
      createdAt: '2026-08-31T00:00:00Z',
      updatedAt: '2026-08-31T00:00:00Z',
      reviewPolicy: { mode: 'quality-gate', maxReworkRounds: options.maxReworkRounds ?? 2, additionalPrompt: '' },
    },
    tasks,
    taskIds,
    attempts: {},
    verifications: {},
    reviews: {
      'review-1': {
        id: 'review-1', trigger: 'quality-gate', candidateEventId: latestCandidate,
        round: options.round ?? 0,
        checkpointSubject: 'team-completion', checkpointAnchor: { eventId: latestCandidate },
        phase: 'reworking', independentReviewerRequired: false, findingFingerprints: [],
        status: 'completed',
        ...(options.includeResult === false ? {} : {
          result: {
            reviewerSessionId: 'reviewer', decision: 'changes_required' as const,
            findings: [{ severity: 'high' as const, evidence: ['src/a.ts:1'], impact: 'broken', recommendation: 'fix' }],
            unverified: [],
          },
        }),
        ...(options.userDecision === undefined ? {} : {
          userDecision: {
            operationId: 'decision-1' as never, reviewId: 'review-1', candidateEventId: latestCandidate,
            round: options.round ?? 0, decision: options.userDecision,
          },
        }),
      },
    },
    reviewIds: ['review-1'],
    reviewUserDecisionOperations: {},
    completionCandidateEventId: currentCandidate,
    fileLeases: {}, fileLeaseIds: [], controlOperations: {}, taskRetryOperations: {},
    reconciliationOperations: {}, latestReconciliationOperationIds: {}, attemptResolutionOperations: {},
    attemptResolutionProofs: {}, recoveryClearOperations: {}, verificationVerdictOperations: {},
    budgetPolicyOperations: {}, budgetReservations: {}, budgetReservationIds: [],
    directWriteStrategy: 'file-scope-gated',
    lastEventId: currentCandidate,
    lastEventAt: '2026-08-31T00:00:00Z',
  } as unknown as TeamProjection
}

function loopBase(): readonly TeamEvent[] {
  const task = { ...contract(TaskId('root')), fileScope: ['src/**'] }
  return [
    event(1, { type: 'yuqi/team-created', title: 'Loop', objective: 'cover runtime branches' }),
    event(2, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
    event(3, { type: 'yuqi/task-created', contract: task }),
  ]
}

function supervisorResult(status: 'running' | 'paused' | 'completed', reason: RunTeamLoopResult['reason']): RunTeamLoopResult {
  return { projection: { team: { id: 'supervisor-team', status } }, reason, disposition: status === 'completed' ? 'completed' : 'recoverable', cycles: 1 } as RunTeamLoopResult
}

describe('second-pass runtime branch coverage', () => {
  it('covers every bounded rework branch through the public quality-gate decision', () => {
    expect(decideQualityGate(qualityProjection({ latestCandidate: 'stale', reworkStatus: 'completed' }))).toMatchObject({ kind: 'review', trigger: 'rework-verification' })
    expect(decideQualityGate(qualityProjection({ userDecision: 'authorize_final_rework', includeResult: false }))).toMatchObject({ kind: 'create-rework', findings: [] })
    expect(decideQualityGate(qualityProjection({ userDecision: 'authorize_final_rework', reworkStatus: 'completed' }))).toMatchObject({ kind: 'review' })
    expect(decideQualityGate(qualityProjection({ userDecision: 'authorize_final_rework', reworkStatus: 'running' }))).toMatchObject({ kind: 'verify' })
    expect(decideQualityGate(qualityProjection({ round: 2, maxReworkRounds: 2 }))).toMatchObject({ kind: 'await-user' })
    expect(decideQualityGate(qualityProjection())).toMatchObject({ kind: 'create-rework' })
    expect(decideQualityGate(qualityProjection({ taskCount: 100 }))).toMatchObject({ kind: 'await-user', reason: expect.stringContaining('task limit') })
    expect(decideQualityGate(qualityProjection({ reworkStatus: 'completed' }))).toMatchObject({ kind: 'review' })
    expect(decideQualityGate(qualityProjection({ reworkStatus: 'running' }))).toMatchObject({ kind: 'verify' })
  })

  it('archives terminal controllers from singular event envelopes and all terminal status operands', async () => {
    const completed = completeTeamEvents()
    const terminal = (status: 'completed' | 'failed' | 'cancelled') => {
      const prefix = completed.slice(0, -1)
      if (status === 'cancelled') {
        const final = completed.at(-1)!
        return [
          ...prefix,
          { ...final, eventId: `${String(final.eventId)}-intent`, from: 'running', to: 'cancelling' },
          { ...final, eventId: `${String(final.eventId)}-cancelled`, from: 'cancelling', to: 'cancelled' },
        ]
      }
      return completed.map((item, index) => index === completed.length - 1 ? { ...item, to: status } : item)
    }
    const streams = new Map([
      ['yuqi-team-completed', terminal('completed')],
      ['yuqi-team-failed', terminal('failed')],
      ['yuqi-team-cancelled', terminal('cancelled')],
    ])
    const archived: string[] = []
    await expect(archiveTerminalYuqiControllers(
      { archiveSession: async id => { archived.push(id) } },
      {
        list: async () => [...streams.keys()].map(id => ({ id, parentSession: 'parent', origin: 'subagent' as const })),
        inspect: async id => ({ events: (streams.get(id) ?? []).map(item => ({ type: 'yuqi/team-event', data: { event: item } })) }),
      },
      { get: () => undefined },
    )).resolves.toEqual([...streams.keys()])
    expect(archived).toHaveLength(3)
    expect(isYuqiController({ id: 'yuqi-team-invalid-origin', parentSession: 'parent', origin: 'user' as never })).toBe(false)
  })

  it('fails closed when schedule persistence and completion coordination seams are absent', async () => {
    const root = { ...contract(TaskId('root')), fileScope: ['root/**'] }
    const child = { ...contract(TaskId('child'), 1, [TaskId('root')]), fileScope: ['child/**'] }
    const pending = new Journal('missing-persist', [
      event(1, { type: 'yuqi/team-created', title: 'Loop', objective: 'cover runtime branches' }),
      event(2, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(3, { type: 'yuqi/task-created', contract: root }),
      event(4, { type: 'yuqi/task-created', contract: child }),
      event(10, { type: 'yuqi/task-status-changed', taskId: TaskId('root'), from: 'pending', to: 'ready' }),
      event(11, { type: 'yuqi/task-status-changed', taskId: TaskId('root'), from: 'ready', to: 'running' }),
      event(12, { type: 'yuqi/task-status-changed', taskId: TaskId('root'), from: 'running', to: 'failed' }),
    ])
    const driver: TeamRunCyclePort = {
      async executeBatch() {}, async waitForProgress() {}, async verify() {},
    }
    await expect(new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal: pending, maxConcurrency: 1, driver }))
      .rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })

    const completed = new Journal('missing-completion', [
      ...loopBase(),
      event(20, { type: 'yuqi/task-status-changed', taskId: TaskId('root'), from: 'pending', to: 'ready' }),
      event(21, { type: 'yuqi/task-status-changed', taskId: TaskId('root'), from: 'ready', to: 'running' }),
      event(22, { type: 'yuqi/task-status-changed', taskId: TaskId('root'), from: 'running', to: 'completed' }),
    ])
    await expect(new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal: completed, maxConcurrency: 1, driver }))
      .rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
  })

  it('returns the durable stop reached while an aborted driver call rejects', async () => {
    const journal = new Journal('abort-terminal', loopBase())
    const abort = new AbortController()
    const driver: TeamRunCyclePort = {
      async executeBatch() {
        await journal.commit([
          event(30, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
          event(31, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' }),
        ])
        abort.abort()
        throw new Error('interrupted after durable pause')
      },
      async waitForProgress() {}, async verify() {},
    }
    await expect(new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal, maxConcurrency: 1, driver, signal: abort.signal }))
      .resolves.toMatchObject({ reason: 'paused' })
  })

  it('exercises wake leases, running wakes, releasing bindings, and multi-runner shutdown', async () => {
    const supervisor = new HarnessTeamRunnerSupervisor()
    let finish!: (value: RunTeamLoopResult) => void
    const running = new Promise<RunTeamLoopResult>(resolve => { finish = resolve })
    const disposeController = vi.fn(() => new Promise<void>(() => {}))
    const registration: HarnessTeamRunnerRegistration = {
      journalKey: 'lease-branches', teamId: 'supervisor-team', controller: {} as Agent, maxConcurrency: 1,
      disposeController, run: () => running,
    }
    const operation = supervisor.run(registration)
    const left = supervisor.acquireWakeLease(registration.journalKey)!
    const right = supervisor.acquireWakeLease(registration.journalKey)!
    expect(left.wake()).toBe(operation)
    left.release()
    expect(right.wake()).toBe(operation)
    right.release()
    finish(supervisorResult('completed', 'completed'))
    await expect(operation).resolves.toMatchObject({ reason: 'completed' })
    expect(() => supervisor.run(registration)).toThrow(/releasing/u)

    const multiple = new HarnessTeamRunnerSupervisor()
    const one: HarnessTeamRunnerRegistration = {
      journalKey: 'multi-one', teamId: 'supervisor-team', controller: {} as Agent, maxConcurrency: 1,
      run: async () => supervisorResult('paused', 'paused'),
    }
    const two = { ...one, journalKey: 'multi-two' }
    await Promise.all([multiple.run(one), multiple.run(two)])
    await Promise.all(multiple.dispose())
  })

  it('recovers a missing public child through the reconciliation callback', async () => {
    const ctx = new Context()
    ctx.provide('subagents', { async listChildren() { return [] } } as never)
    const controller = { id: SessionId('controller-runtime'), ctx, options: {} } as unknown as Agent
    const journal = new Journal('progress-reconcile', completeTeamEvents().slice(0, 8))
    const reconcile = vi.fn(async () => true)
    const adapter = new HarnessTeamProgressAdapter(ctx, {
      controller,
      waitForLocalAttempts: async () => {},
      settleAttempt: async () => {},
      reconcile,
      timeoutMs: 10,
    })
    await expect(adapter.waitForProgress({ teamId: 'team-1', journal, activeTaskIds: ['task-1'], signal: new AbortController().signal })).resolves.toBeUndefined()
    expect(reconcile).toHaveBeenCalledOnce()
  })
})
