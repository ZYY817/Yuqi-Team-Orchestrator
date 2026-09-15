import { describe, expect, it } from 'vitest'
import {
  AttemptId,
  planTeamSchedule,
  prepareTeamBatchIntent,
  replayTeamEvents,
  TaskId,
  TeamId,
  WorkspaceId,
} from '../src/index.ts'
import type {
  BatchAttemptIntent,
  Clock,
  EventIdSource,
  TeamEvent,
  TeamProjection,
  TeamSchedulePlan,
} from '../src/index.ts'
import { contract, event, TEAM_ID } from './fixtures.ts'

class FixedClock implements Clock {
  nowIso(): string { return '2026-08-15T10:00:00Z' }
}

class SequenceIds implements EventIdSource {
  #next = 1
  next(): string { return `batch-event-${this.#next++}` }
}

const clock = new FixedClock()

function schedulableProjection(): TeamProjection {
  const left = TaskId('batch-left')
  const right = TaskId('batch-right')
  const events: TeamEvent[] = [
    event(600, { type: 'yuqi/team-created', title: 'Batch', objective: 'Start multiple children' }),
    event(601, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
    event(602, { type: 'yuqi/task-created', contract: { ...contract(left), fileScope: ['src/**'] } }),
    event(603, { type: 'yuqi/task-created', contract: { ...contract(right), fileScope: ['tests/**'] } }),
    event(604, { type: 'yuqi/task-status-changed', taskId: right, from: 'pending', to: 'ready' }),
  ]
  return replayTeamEvents(events)
}

const BATCH_WORKSPACE_ID = WorkspaceId('batch-workspace')
const BATCH_WORKTREE = 'F:\\managed\\team'

function gatedProjection(workspaceStatus: 'ready' | 'needs_reconciliation' = 'ready'): TeamProjection {
  const events: TeamEvent[] = [
    event(610, { type: 'yuqi/team-created', title: 'Gated batch', objective: 'Run inside worktree' }),
    event(611, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
    event(612, { type: 'yuqi/task-created', contract: { ...contract(TaskId('batch-left')), fileScope: ['src/**'] } }),
    event(613, { type: 'yuqi/task-created', contract: { ...contract(TaskId('batch-right')), fileScope: ['tests/**'] } }),
    event(614, {
      type: 'yuqi/workspace-provisioning-started',
      workspace: {
        workspaceId: BATCH_WORKSPACE_ID,
        project: { projectRoot: 'F:\\project', repositoryRoot: 'F:\\project', gitCommonDirectory: 'F:\\project\\.git', baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: ['F:\\'] },
        worktreePath: BATCH_WORKTREE, branchName: 'yuqi/team', status: 'provisioning',
      },
    }),
    event(615, { type: 'yuqi/workspace-provisioned', workspaceId: BATCH_WORKSPACE_ID }),
  ]
  if (workspaceStatus === 'needs_reconciliation') events.push(event(616, {
    type: 'yuqi/workspace-reconciliation-required', workspaceId: BATCH_WORKSPACE_ID, reason: 'fixture',
  }))
  return replayTeamEvents(events)
}

function attempts(overrides: Partial<BatchAttemptIntent>[] = []): readonly BatchAttemptIntent[] {
  const base: readonly BatchAttemptIntent[] = [
    { taskId: 'batch-left', attemptId: 'batch-attempt-left', modelProvider: 'provider', modelId: 'deepseek-v4' },
    { taskId: 'batch-right', attemptId: 'batch-attempt-right', modelProvider: 'provider', modelId: 'deepseek-v4' },
  ]
  return base.map((intent, index) => ({ ...intent, ...overrides[index] }))
}

function gatedAttempts(overrides: Partial<BatchAttemptIntent>[] = []): readonly BatchAttemptIntent[] {
  const fixed = { subagentProvider: 'spawn', modelProvider: 'provider', modelId: 'deepseek-v4', role: 'worker' as const }
  return attempts([
    { subagentProvider: 'spawn', leaseId: 'lease-left', fixedModel: fixed, ...overrides[0] },
    { subagentProvider: 'spawn', leaseId: 'lease-right', fixedModel: fixed, ...overrides[1] },
  ])
}

function prepare(
  projection = schedulableProjection(),
  plan: TeamSchedulePlan = planTeamSchedule(projection, { maxConcurrency: 2 }),
  intents: readonly BatchAttemptIntent[] = attempts(),
  execution?: { workspaceId: string; worktreePath: string },
  eventIds: EventIdSource = new SequenceIds(),
) {
  return prepareTeamBatchIntent(projection, {
    teamId: TEAM_ID,
    plan,
    maxConcurrency: 2,
    attempts: intents,
    ...(execution === undefined ? {} : { execution }),
  }, clock, eventIds)
}

describe('prepareTeamBatchIntent', () => {
  it('persists the structured route decision that matches runtime model arguments', () => {
    const source = schedulableProjection()
    const catalogEvidence = [{ model: { modelProvider: 'external', modelId: 'critical' }, metadataResolved: true, routable: true }]
    const prepared = prepare(source, planTeamSchedule(source, { maxConcurrency: 2 }), attempts([
      {
        modelProvider: 'external', modelId: 'critical', route: { modelProvider: 'external', modelId: 'critical' },
        routeBasis: 'automatic', requestedTier: 'critical', catalogEvidence,
      },
      {
        route: { modelProvider: 'provider', modelId: 'deepseek-v4' }, routeBasis: 'controller-inherit',
        fallbackReason: 'task-default-controller-inherit', catalogEvidence: [],
      },
    ]))

    expect(prepared.projection.attempts['batch-attempt-left']).toMatchObject({
      modelProvider: 'external', modelId: 'critical', routeBasis: 'automatic', requestedTier: 'critical', catalogEvidence,
    })
    expect(prepared.projection.attempts['batch-attempt-right']).toMatchObject({
      routeBasis: 'controller-inherit', fallbackReason: 'task-default-controller-inherit', catalogEvidence: [],
    })
  })

  it('atomically acquires exact workspace/model/file grants before attempt intents', () => {
    const source = gatedProjection()
    const intents = gatedAttempts()
    const prepared = prepare(source, planTeamSchedule(source, { maxConcurrency: 2 }), intents, {
      workspaceId: BATCH_WORKSPACE_ID, worktreePath: BATCH_WORKTREE,
    })
    expect(prepared.events.map(item => item.type)).toEqual([
      'yuqi/file-lease-acquired', 'yuqi/task-status-changed', 'yuqi/task-status-changed', 'yuqi/attempt-created',
      'yuqi/file-lease-acquired', 'yuqi/task-status-changed', 'yuqi/task-status-changed', 'yuqi/attempt-created',
    ])
    expect(prepared.projection.fileLeases['lease-left']?.status).toBe('active')
    expect(prepared.projection.fileLeases['lease-right']?.status).toBe('active')
  })

  it('fails closed for missing, mismatched, or reconciling workspace/model/lease grants', () => {
    const noWorkspace = schedulableProjection()
    expect(() => prepare(noWorkspace, planTeamSchedule(noWorkspace, { maxConcurrency: 2 }), gatedAttempts(), {
      workspaceId: BATCH_WORKSPACE_ID, worktreePath: BATCH_WORKTREE,
    })).toThrow(expect.objectContaining({ code: 'EXECUTION_GATE_REJECTED' }))

    const reconciling = gatedProjection('needs_reconciliation')
    expect(() => prepare(reconciling, planTeamSchedule(reconciling, { maxConcurrency: 2 }), gatedAttempts(), {
      workspaceId: BATCH_WORKSPACE_ID, worktreePath: BATCH_WORKTREE,
    })).toThrow(expect.objectContaining({ code: 'EXECUTION_GATE_REJECTED' }))

    const source = gatedProjection()
    const plan = planTeamSchedule(source, { maxConcurrency: 2 })
    for (const execution of [
      { workspaceId: 'other-workspace', worktreePath: BATCH_WORKTREE },
      { workspaceId: BATCH_WORKSPACE_ID, worktreePath: 'F:\\other' },
    ]) expect(() => prepare(source, plan, gatedAttempts(), execution)).toThrow(expect.objectContaining({ code: 'EXECUTION_GATE_REJECTED' }))

    const firstWithoutLease = { ...gatedAttempts()[0] } as { leaseId?: string } & BatchAttemptIntent
    delete firstWithoutLease.leaseId
    expect(() => prepare(source, plan, [firstWithoutLease, gatedAttempts()[1]!], {
      workspaceId: BATCH_WORKSPACE_ID, worktreePath: BATCH_WORKTREE,
    })).toThrow(expect.objectContaining({ code: 'EXECUTION_GATE_REJECTED' }))
    expect(() => prepare(source, plan, gatedAttempts([{ subagentProvider: 'other' }]), {
      workspaceId: BATCH_WORKSPACE_ID, worktreePath: BATCH_WORKTREE,
    })).toThrow(expect.objectContaining({ code: 'EXECUTION_GATE_REJECTED' }))
    expect(() => prepare(source, plan, gatedAttempts([{}, { leaseId: 'lease-left' }]), {
      workspaceId: BATCH_WORKSPACE_ID, worktreePath: BATCH_WORKTREE,
    })).toThrow(expect.objectContaining({ code: 'FILE_LEASE_CONFLICT' }))

    const baselineMismatch: TeamProjection = {
      ...source,
      tasks: { ...source.tasks, 'batch-left': { ...source.tasks['batch-left']!, contract: { ...source.tasks['batch-left']!.contract, baselineRef: 'other-baseline' } } },
    }
    expect(() => prepare(baselineMismatch, planTeamSchedule(baselineMismatch, { maxConcurrency: 2 }), gatedAttempts(), {
      workspaceId: BATCH_WORKSPACE_ID, worktreePath: BATCH_WORKTREE,
    })).toThrow(expect.objectContaining({ code: 'EXECUTION_GATE_REJECTED' }))
  })

  it('issues read leases for a read-only batch and ignores already released ownership', () => {
    const source = gatedProjection()
    const readOnly: TeamProjection = {
      ...source,
      tasks: Object.fromEntries(Object.entries(source.tasks).map(([id, task]) => [id, {
        ...task, contract: { ...task.contract, authorityMode: 'read-only' as const },
      }])) as TeamProjection['tasks'],
      fileLeases: {
        released: {
          leaseId: 'released' as never,
          taskId: TaskId('batch-left'),
          mode: 'read',
          fileScope: ['src/**'],
          status: 'released',
        },
      },
      fileLeaseIds: ['released' as never],
    }
    const prepared = prepare(readOnly, planTeamSchedule(readOnly, { maxConcurrency: 2 }), gatedAttempts(), {
      workspaceId: BATCH_WORKSPACE_ID, worktreePath: BATCH_WORKTREE,
    })
    expect(prepared.projection.fileLeases['lease-left']?.mode).toBe('read')
    expect(prepared.projection.fileLeases.released?.status).toBe('released')
  })
  it('creates one durable event group for pending and ready tasks before side effects', () => {
    const source = schedulableProjection()
    const before = structuredClone(source)
    const prepared = prepare(source)

    expect(prepared.events.map(item => item.type)).toEqual([
      'yuqi/task-status-changed',
      'yuqi/task-status-changed',
      'yuqi/attempt-created',
      'yuqi/task-status-changed',
      'yuqi/attempt-created',
    ])
    expect(prepared.projection.tasks['batch-left']?.status).toBe('running')
    expect(prepared.projection.tasks['batch-right']?.status).toBe('running')
    expect(prepared.projection.attempts['batch-attempt-left']?.status).toBe('dispatching')
    expect(prepared.projection.attempts['batch-attempt-right']?.status).toBe('dispatching')
    expect(source).toEqual(before)
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(Object.isFrozen(prepared.events)).toBe(true)
  })

  it('rejects a Team mismatch before preparing events', () => {
    const projection = schedulableProjection()
    const plan = planTeamSchedule(projection, { maxConcurrency: 2 })
    expect(() => prepareTeamBatchIntent(projection, {
      teamId: TeamId('other-team'), plan, maxConcurrency: 2, attempts: attempts(),
    }, clock, new SequenceIds())).toThrow(expect.objectContaining({ code: 'TEAM_MISMATCH' }))
  })

  it('fails closed when a custom event-id source cannot provide a portable recovery token', () => {
    expect(() => prepare(undefined, undefined, undefined, undefined, { next: () => 'unsafe:token' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_BATCH' }))
  })

  it('rejects an inactive or empty schedule', () => {
    const inputs = schedulableProjection()
    const inactive: TeamProjection = { ...inputs, team: { ...inputs.team, status: 'paused' } }
    const inactivePlan = planTeamSchedule(inactive, { maxConcurrency: 2 })
    expect(() => prepare(inactive, inactivePlan)).toThrow(expect.objectContaining({ code: 'SCHEDULE_NOT_RUNNABLE' }))

    const active = schedulableProjection()
    const withCapacityConsumed: TeamProjection = {
      ...active,
      attempts: {
        occupied: {
          id: AttemptId('occupied'), taskId: TaskId('batch-left'), ordinal: 1,
          modelProvider: 'p', modelId: 'deepseek-v4', status: 'running',
        },
      },
      tasks: { ...active.tasks, 'batch-left': { ...active.tasks['batch-left']!, status: 'running' } },
    }
    expect(() => prepareTeamBatchIntent(withCapacityConsumed, {
      teamId: TEAM_ID,
      plan: planTeamSchedule(withCapacityConsumed, { maxConcurrency: 1 }),
      maxConcurrency: 1,
      attempts: [],
    }, clock, new SequenceIds())).toThrow(expect.objectContaining({ code: 'SCHEDULE_NOT_RUNNABLE' }))
  })

  it('rejects stale, incomplete, reordered, duplicate, existing, and wrong-model intents', () => {
    const projection = schedulableProjection()
    const plan = planTeamSchedule(projection, { maxConcurrency: 2 })
    expect(() => prepare(projection, { ...plan, sourceLastEventAt: 'stale' })).toThrow(expect.objectContaining({ code: 'STALE_SCHEDULE' }))
    expect(() => prepare({ ...projection, lastEventId: 'different-event' as never }, plan)).toThrow(expect.objectContaining({ code: 'STALE_SCHEDULE' }))
    expect(() => prepare(projection, plan, attempts().slice(0, 1))).toThrow(expect.objectContaining({ code: 'INVALID_BATCH' }))
    expect(() => prepare(projection, plan, [attempts()[1]!, attempts()[0]!])).toThrow(expect.objectContaining({ code: 'INVALID_BATCH' }))
    expect(() => prepare(projection, plan, attempts([{}, { attemptId: 'batch-attempt-left' }]))).toThrow(expect.objectContaining({ code: 'INVALID_BATCH' }))
    expect(() => prepare(projection, plan, attempts([{ modelId: 'wrong-model' }]))).toThrow(expect.objectContaining({ code: 'INVALID_BATCH' }))

    const withExistingAttempt: TeamProjection = {
      ...projection,
      attempts: {
        used: {
          id: AttemptId('used'), taskId: TaskId('batch-left'), ordinal: 1,
          modelProvider: 'p', modelId: 'deepseek-v4', status: 'failed',
        },
      },
    }
    const existingPlan = planTeamSchedule(withExistingAttempt, { maxConcurrency: 2 })
    expect(() => prepare(withExistingAttempt, existingPlan, attempts([{ attemptId: 'used' }]))).toThrow(expect.objectContaining({ code: 'INVALID_BATCH' }))
  })
})
