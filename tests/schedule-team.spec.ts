import { describe, expect, it } from 'vitest'
import {
  AttemptId,
  classifyTeamResume,
  ControlOperationId,
  planTeamSchedule,
  replayTeamEvents,
  TaskId,
  VerificationId,
} from '../src/index.ts'
import type { TaskStatus, TeamEvent, TeamProjection } from '../src/index.ts'
import { completeTeamEvents, contract, event } from './fixtures.ts'

interface TaskSeed {
  readonly id: string
  readonly dependencies?: readonly string[]
  readonly status?: TaskStatus
  readonly fileScope?: readonly string[]
  readonly authorityMode?: 'read-only' | 'write-authorized' | 'full-access'
  readonly activeAttempts?: number
  readonly unknownAttempt?: boolean
}

function projectionFor(tasks: readonly TaskSeed[], teamRunning = true): TeamProjection {
  const events: TeamEvent[] = [event(200, { type: 'yuqi/team-created', title: 'Scheduler Team', objective: 'Plan deterministically' })]
  let index = 201
  if (teamRunning) events.push(event(index++, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }))
  for (const seed of tasks) {
    const taskId = TaskId(seed.id)
    events.push(event(index++, {
      type: 'yuqi/task-created',
      contract: {
        ...contract(taskId, 1, (seed.dependencies ?? []).map(TaskId)),
        fileScope: [...(seed.fileScope ?? [`${seed.id}/**`])],
        authorityMode: seed.authorityMode ?? 'write-authorized',
      },
    }))
    appendStatus(events, taskId, seed.status ?? 'pending', () => index++)
    for (let attemptIndex = 0; attemptIndex < (seed.activeAttempts ?? 0); attemptIndex += 1) {
      const attemptId = AttemptId(`${seed.id}-attempt-${attemptIndex + 1}`)
      events.push(event(index++, { type: 'yuqi/attempt-created', taskId, attemptId, ordinal: attemptIndex + 1, modelProvider: 'p', modelId: 'm' }))
      if (seed.unknownAttempt === true) {
        events.push(event(index++, { type: 'yuqi/attempt-status-changed', taskId, attemptId, from: 'dispatching', to: 'unknown' }))
      }
    }
  }
  return replayTeamEvents(events)
}

function appendStatus(events: TeamEvent[], taskId: TaskId, status: TaskStatus, nextIndex: () => number): void {
  if (status === 'pending') return
  if (status === 'cancelled') {
    events.push(event(nextIndex(), { type: 'yuqi/task-status-changed', taskId, from: 'pending', to: 'cancelled' }))
    return
  }
  if (status === 'blocked') {
    events.push(event(nextIndex(), { type: 'yuqi/task-status-changed', taskId, from: 'pending', to: 'blocked' }))
    return
  }
  if (status === 'completed') {
    events.push(event(nextIndex(), { type: 'yuqi/task-status-changed', taskId, from: 'pending', to: 'ready' }))
    events.push(event(nextIndex(), { type: 'yuqi/task-status-changed', taskId, from: 'ready', to: 'running' }))
    const attemptId = AttemptId(`${taskId}-completed-attempt`)
    const verificationId = VerificationId(`verification-${taskId}`)
    events.push(event(nextIndex(), { type: 'yuqi/attempt-created', taskId, attemptId, ordinal: 1, modelProvider: 'p', modelId: 'm' }))
    events.push(event(nextIndex(), { type: 'yuqi/attempt-admitted', taskId, attemptId, agentSessionId: `${taskId}-child`, messageId: `${taskId}-message` }))
    events.push(event(nextIndex(), { type: 'yuqi/attempt-status-changed', taskId, attemptId, from: 'dispatching', to: 'running' }))
    events.push(event(nextIndex(), { type: 'yuqi/attempt-status-changed', taskId, attemptId, from: 'running', to: 'settled' }))
    events.push(event(nextIndex(), {
      type: 'yuqi/attempt-evidence-recorded', taskId, attemptId, runId: `${taskId}-run`,
      agentSessionId: `${taskId}-child`, provider: 'p', stopReason: 'completed', hasAssistantOutput: true,
      settledAt: '2026-08-15T00:00:00Z',
    }))
    events.push(event(nextIndex(), { type: 'yuqi/task-status-changed', taskId, from: 'running', to: 'verifying' }))
    events.push(event(nextIndex(), { type: 'yuqi/verification-created', taskId, attemptId, verificationId, verifierSessionId: `${taskId}-verifier` }))
    events.push(event(nextIndex(), { type: 'yuqi/verification-status-changed', taskId, attemptId, verificationId, from: 'pending', to: 'running' }))
    events.push(event(nextIndex(), {
      type: 'yuqi/verification-verdict-recorded', operationId: ControlOperationId(`verdict-${taskId}`),
      taskId, attemptId, verificationId, disposition: 'passed',
      requirements: [{ checkId: 'build', kind: 'build' }],
      evidence: [{ checkId: 'build', capturedAt: '2026-08-15T00:00:00Z', kind: 'build', producer: 'build-runner', command: 'pnpm run build', exitCode: 0, artifactDigest: `${taskId}-build` }],
      reasons: [],
    }))
    events.push(event(nextIndex(), { type: 'yuqi/attempt-status-changed', taskId, attemptId, from: 'settled', to: 'completed' }))
    events.push(event(nextIndex(), { type: 'yuqi/task-status-changed', taskId, from: 'verifying', to: 'completed' }))
    return
  }
  events.push(event(nextIndex(), { type: 'yuqi/task-status-changed', taskId, from: 'pending', to: 'ready' }))
  if (status === 'ready') return
  events.push(event(nextIndex(), { type: 'yuqi/task-status-changed', taskId, from: 'ready', to: 'running' }))
  if (status === 'running' || status === 'failed') {
    if (status === 'failed') events.push(event(nextIndex(), { type: 'yuqi/task-status-changed', taskId, from: 'running', to: 'failed' }))
    return
  }
  events.push(event(nextIndex(), { type: 'yuqi/task-status-changed', taskId, from: 'running', to: 'verifying' }))
  if (status === 'verifying') return
  events.push(event(nextIndex(), { type: 'yuqi/task-status-changed', taskId, from: 'verifying', to: status }))
}

describe('planTeamSchedule', () => {
  it('classifies paused Continue from the scheduler graph instead of pending counts', () => {
    const paused = (projection: TeamProjection): TeamProjection => ({
      ...projection,
      team: { ...projection.team, status: 'paused' },
    })

    expect(classifyTeamResume(paused(projectionFor([{ id: 'ready' }])))).toBe('runnable')
    expect(classifyTeamResume(paused(projectionFor([{ id: 'done', status: 'completed' }])))).toBe('completion-ready')
    expect(classifyTeamResume(paused(projectionFor([
      { id: 'failed', status: 'failed' },
      { id: 'dependent', dependencies: ['failed'] },
    ])))).toBe('decision-required')
    expect(classifyTeamResume(paused(projectionFor([
      { id: 'done', status: 'completed' },
      { id: 'derived-block', status: 'blocked', dependencies: ['done'] },
    ])))).toBe('runnable')

    const base = projectionFor([{ id: 'paused-mid-flight', status: 'blocked' }])
    const pausedWithMissingOutcome: TeamProjection = {
      ...base,
      team: { ...base.team, status: 'paused' },
      tasks: {
        ...base.tasks,
        [TaskId('paused-mid-flight')]: {
          ...base.tasks[TaskId('paused-mid-flight')]!,
          status: 'blocked',
          attemptIds: [AttemptId('att-1')],
        },
      },
      attempts: {
        [AttemptId('att-1')]: {
          id: AttemptId('att-1'),
          taskId: TaskId('paused-mid-flight'),
          ordinal: 1,
          status: 'settled',
          modelProvider: 'p',
          modelId: 'm',
          evidence: {
            runId: 'r-1',
            agentSessionId: 's-1',
            provider: 'in-process',
            settledAt: '2026-08-15T00:00:10Z',
            stopReason: 'completed',
            hasAssistantOutput: true,
            taskOutcome: { status: 'missing' },
          },
        },
      },
    }
    expect(classifyTeamResume(pausedWithMissingOutcome)).toBe('runnable')
  })

  it('unlocks dependency-free tasks and fills slots in creation order', () => {
    const projection = projectionFor([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    const plan = planTeamSchedule(projection, { maxConcurrency: 2 })
    expect(plan).toMatchObject({
      status: 'runnable', availableSlots: 2,
      readyTaskIds: ['a', 'b', 'c'], dispatchTaskIds: ['a', 'b'], blockedTaskIds: [], activeTaskIds: [],
    })
  })

  it('unlocks only completed dependencies and propagates failed dependency blocking', () => {
    const unlocked = planTeamSchedule(projectionFor([
      { id: 'a', status: 'completed' },
      { id: 'b', dependencies: ['a'] },
      { id: 'c', dependencies: ['b'] },
    ]), { maxConcurrency: 4 })
    expect(unlocked.readyTaskIds).toEqual(['b'])
    expect(unlocked.dispatchTaskIds).toEqual(['b'])

    const blocked = planTeamSchedule(projectionFor([
      { id: 'failed', status: 'failed' },
      { id: 'downstream', dependencies: ['failed'] },
      { id: 'transitive', dependencies: ['downstream'] },
    ]), { maxConcurrency: 4 })
    expect(blocked.blockedTaskIds).toEqual(['downstream', 'transitive'])
    expect(blocked.newlyBlockedTaskIds).toEqual(['downstream', 'transitive'])
    expect(blocked.dispatchTaskIds).toEqual([])
  })

  it('emits deterministic durable block and unblock deltas', () => {
    const blocked = planTeamSchedule(projectionFor([
      { id: 'failed', status: 'failed' },
      { id: 'downstream', dependencies: ['failed'], status: 'blocked' },
    ]), { maxConcurrency: 2 })
    expect(blocked.blockedTaskIds).toEqual(['downstream'])
    expect(blocked.newlyBlockedTaskIds).toEqual([])
    expect(blocked.unblockedTaskIds).toEqual([])

    const cleared = planTeamSchedule(projectionFor([
      { id: 'completed', status: 'completed' },
      { id: 'downstream', dependencies: ['completed'], status: 'blocked' },
    ]), { maxConcurrency: 2 })
    expect(cleared.blockedTaskIds).toEqual([])
    expect(cleared.unblockedTaskIds).toEqual(['downstream'])
    expect(cleared.dispatchTaskIds).toEqual([])
  })

  it.each(['failed', 'cancelled', 'blocked'] as const)('blocks a dependent when its prerequisite is %s', (status) => {
    const plan = planTeamSchedule(projectionFor([
      { id: 'root', status },
      { id: 'child', dependencies: ['root'] },
    ]), { maxConcurrency: 2 })
    expect(plan.blockedTaskIds).toEqual(['child'])
  })

  it('respects active slots and write-scope conflicts while allowing disjoint work', () => {
    const plan = planTeamSchedule(projectionFor([
      { id: 'active', status: 'running', activeAttempts: 1, fileScope: ['src/**'] },
      { id: 'conflict', fileScope: ['src/a.ts'] },
      { id: 'disjoint', fileScope: ['tests/**'] },
    ]), { maxConcurrency: 2 })
    expect(plan.activeTaskIds).toEqual(['active'])
    expect(plan.availableSlots).toBe(1)
    expect(plan.dispatchTaskIds).toEqual(['disjoint'])
  })

  it('fails closed for mixed historical active authorities and keeps new work on the active authority', () => {
    const mixed = planTeamSchedule(projectionFor([
      { id: 'writer', status: 'running', activeAttempts: 1, authorityMode: 'write-authorized' },
      { id: 'reader', status: 'running', activeAttempts: 1, authorityMode: 'read-only' },
    ]), { maxConcurrency: 4 })
    expect(mixed.status).toBe('requires_reconciliation')

    const sameMode = planTeamSchedule(projectionFor([
      { id: 'active-reader', status: 'running', activeAttempts: 1, authorityMode: 'read-only' },
      { id: 'pending-writer', authorityMode: 'write-authorized' },
      { id: 'pending-reader', authorityMode: 'read-only' },
    ]), { maxConcurrency: 3 })
    expect(sameMode.dispatchTaskIds).toEqual(['pending-reader'])
  })

  it('keeps one authority mode per batch and skips write conflicts', () => {
    const plan = planTeamSchedule(projectionFor([
      { id: 'writer', fileScope: ['src/**'] },
      { id: 'overlap', fileScope: ['src/file.ts'] },
      { id: 'reader', authorityMode: 'read-only', fileScope: [] },
      { id: 'tests', fileScope: ['tests/**'] },
    ]), { maxConcurrency: 4 })
    expect(plan.dispatchTaskIds).toEqual(['writer', 'tests'])
  })

  it('serializes only writers in strict mode without collapsing read-only concurrency', () => {
    const writers = planTeamSchedule(projectionFor([
      { id: 'writer-a', fileScope: ['src/a/**'] },
      { id: 'writer-b', fileScope: ['src/b/**'] },
    ]), { maxConcurrency: 4, directWriteStrategy: 'strict-writer-serial' })
    expect(writers).toMatchObject({
      directWriteStrategy: 'strict-writer-serial', availableSlots: 4, dispatchTaskIds: ['writer-a'],
    })

    const readers = planTeamSchedule(projectionFor([
      { id: 'reader-a', authorityMode: 'read-only', fileScope: [] },
      { id: 'reader-b', authorityMode: 'read-only', fileScope: [] },
      { id: 'reader-c', authorityMode: 'read-only', fileScope: [] },
    ]), { maxConcurrency: 2, directWriteStrategy: 'strict-writer-serial' })
    expect(readers).toMatchObject({ availableSlots: 2, dispatchTaskIds: ['reader-a', 'reader-b'] })
  })

  it('uses the durable Team strategy by default and fails closed for multiple strict active writers', () => {
    const projection = projectionFor([
      { id: 'left', status: 'running', activeAttempts: 1, fileScope: ['src/a/**'] },
      { id: 'right', status: 'running', activeAttempts: 1, fileScope: ['src/b/**'] },
    ])
    const strictProjection: TeamProjection = {
      ...projection,
      team: { ...projection.team, directWriteStrategy: 'strict-writer-serial' },
    }
    expect(planTeamSchedule(strictProjection, { maxConcurrency: 4 }).status).toBe('requires_reconciliation')
  })

  it('prefers the largest low-conflict parallel wave over one broad first task', () => {
    const plan = planTeamSchedule(projectionFor([
      { id: 'global', fileScope: ['src/styles/**', 'src/**/Header*'] },
      { id: 'hero', fileScope: ['src/**/Hero*', 'src/**/hero*'] },
      { id: 'what', fileScope: ['src/**/What*', 'src/**/what*'] },
      { id: 'method', fileScope: ['src/**/Method*', 'src/**/method*'] },
      { id: 'safety', fileScope: ['src/**/Safety*', 'src/**/safety*'] },
      { id: 'capabilities', fileScope: ['src/**/Capabilities*', 'src/**/capabilities*'] },
      { id: 'download', fileScope: ['src/**/Download*', 'src/**/download*'] },
    ]), { maxConcurrency: 7 })

    expect(plan.dispatchTaskIds).toEqual(['hero', 'what', 'method', 'safety', 'capabilities', 'download'])
  })

  it('runs independent full-access tasks together but never mixes them with narrower permissions', () => {
    const plan = planTeamSchedule(projectionFor([
      { id: 'full-a', authorityMode: 'full-access', fileScope: ['src/a/**'] },
      { id: 'full-b', authorityMode: 'full-access', fileScope: ['src/b/**'] },
      { id: 'workspace-write', authorityMode: 'write-authorized', fileScope: ['tests/**'] },
    ]), { maxConcurrency: 3 })
    expect(plan.dispatchTaskIds).toEqual(['full-a', 'full-b'])
  })

  const unsafeWriteScopes: readonly (readonly [readonly string[]])[] = [
    [[]],
    [['C:/outside/**']],
    [['src/../outside']],
  ]

  it.each(unsafeWriteScopes)('fails closed for an unsafe write scope: %j', (fileScope) => {
    const plan = planTeamSchedule(projectionFor([{ id: 'unsafe', fileScope }]), { maxConcurrency: 2 })
    expect(plan.status).toBe('requires_reconciliation')
    expect(plan.dispatchTaskIds).toEqual([])
  })

  it('propagates blocking through a dependency revised to a later-created task', () => {
    const root = TaskId('root-late-order')
    const first = TaskId('first-created')
    const later = TaskId('later-created')
    const inputs: TeamEvent[] = [
      event(500, { type: 'yuqi/team-created', title: 'Revised order', objective: 'Propagate recursively' }),
      event(501, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(502, { type: 'yuqi/task-created', contract: contract(root) }),
      event(503, { type: 'yuqi/task-status-changed', taskId: root, from: 'pending', to: 'ready' }),
      event(504, { type: 'yuqi/task-status-changed', taskId: root, from: 'ready', to: 'running' }),
      event(505, { type: 'yuqi/task-status-changed', taskId: root, from: 'running', to: 'failed' }),
      event(506, { type: 'yuqi/task-created', contract: contract(first) }),
      event(507, { type: 'yuqi/task-created', contract: contract(later, 1, [root]) }),
      event(508, { type: 'yuqi/task-revised', contract: contract(first, 2, [later]) }),
    ]
    expect(planTeamSchedule(replayTeamEvents(inputs), { maxConcurrency: 2 }).blockedTaskIds).toEqual([first, later])
  })

  it('rechecks dependencies when a ready task contract is revised', () => {
    const dependency = TaskId('revision-dependency')
    const worker = TaskId('revision-worker')
    const inputs: TeamEvent[] = [
      event(520, { type: 'yuqi/team-created', title: 'Revision dependencies', objective: 'Do not dispatch early' }),
      event(521, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(522, { type: 'yuqi/task-created', contract: contract(dependency) }),
      event(523, { type: 'yuqi/task-created', contract: contract(worker) }),
      event(524, { type: 'yuqi/task-status-changed', taskId: worker, from: 'pending', to: 'ready' }),
      event(525, { type: 'yuqi/task-revised', contract: contract(worker, 2, [dependency]) }),
    ]
    const plan = planTeamSchedule(replayTeamEvents(inputs), { maxConcurrency: 2 })
    expect(plan.readyTaskIds).toEqual([dependency])
    expect(plan.dispatchTaskIds).toEqual([dependency])
  })

  it('fails closed for reconciliation gaps, duplicate active attempts, or conflicting active writers', () => {
    expect(planTeamSchedule(projectionFor([{ id: 'unknown', status: 'running', activeAttempts: 1, unknownAttempt: true }]), { maxConcurrency: 2 }).status).toBe('requires_reconciliation')
    expect(planTeamSchedule(projectionFor([{ id: 'duplicate', status: 'running', activeAttempts: 2 }]), { maxConcurrency: 2 }).status).toBe('requires_reconciliation')
    expect(planTeamSchedule(projectionFor([
      { id: 'left', status: 'running', activeAttempts: 1, fileScope: ['src/**'] },
      { id: 'right', status: 'running', activeAttempts: 1, fileScope: ['src/file.ts'] },
    ]), { maxConcurrency: 2 }).status).toBe('requires_reconciliation')
  })

  it('ignores terminal attempts and accepts multiple disjoint active writers', () => {
    const terminal = planTeamSchedule(replayTeamEvents(completeTeamEvents().slice(0, 16)), { maxConcurrency: 2 })
    expect(terminal).toMatchObject({ status: 'runnable', activeTaskIds: [], availableSlots: 2 })

    const disjoint = planTeamSchedule(projectionFor([
      { id: 'left', status: 'running', activeAttempts: 1, fileScope: ['src/**'] },
      { id: 'right', status: 'running', activeAttempts: 1, fileScope: ['tests/**'] },
    ]), { maxConcurrency: 2 })
    expect(disjoint).toMatchObject({ status: 'runnable', activeTaskIds: ['left', 'right'], availableSlots: 0 })
  })

  it('fails closed when an active attempt and its task lifecycle disagree', () => {
    const valid = projectionFor([
      { id: 'reader', status: 'running', activeAttempts: 1, authorityMode: 'read-only', fileScope: [] },
    ])
    const inconsistent: TeamProjection = {
      ...valid,
      tasks: { ...valid.tasks, reader: { ...valid.tasks.reader!, status: 'ready' } },
    }
    expect(planTeamSchedule(inconsistent, { maxConcurrency: 2 })).toMatchObject({
      status: 'requires_reconciliation', dispatchTaskIds: [],
    })
  })

  it('returns an inactive empty plan for a non-running Team', () => {
    expect(planTeamSchedule(projectionFor([{ id: 'a' }], false), { maxConcurrency: 2 })).toMatchObject({ status: 'inactive', availableSlots: 0, dispatchTaskIds: [] })
  })

  it.each([0, 1.5, 101, Number.NaN])('rejects invalid concurrency %s', (maxConcurrency) => {
    expect(() => planTeamSchedule(projectionFor([{ id: 'a' }]), { maxConcurrency })).toThrow(RangeError)
  })

  it('is repeatable, frozen, and does not mutate its projection', () => {
    const projection = projectionFor([{ id: 'a' }, { id: 'b' }])
    const before = structuredClone(projection)
    const first = planTeamSchedule(projection, { maxConcurrency: 2 })
    const second = planTeamSchedule(projection, { maxConcurrency: 2 })
    expect(first).toEqual(second)
    expect(projection).toEqual(before)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.dispatchTaskIds)).toBe(true)
  })
})
