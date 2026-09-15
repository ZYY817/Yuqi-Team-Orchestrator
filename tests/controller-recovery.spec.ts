import { describe, expect, it, vi } from 'vitest'
import { ControllerRecoveryCoordinator } from '../src/index.ts'
import type { TeamProjection } from '../src/index.ts'

function projection(
  teamStatus: string,
  taskStatus: string,
  attemptStatus: string,
  observation?: { operationId: string; state: string },
  attemptIds: readonly string[] = ['attempt-1'],
): TeamProjection {
  const attemptId = 'attempt-1'
  const taskId = 'task-1'
  return {
    team: { id: 'team-1', status: teamStatus },
    taskIds: [taskId],
    tasks: { [taskId]: { contract: { taskId, goal: 'recover' }, status: taskStatus, attemptIds } },
    attempts: { [attemptId]: { id: attemptId, taskId, status: attemptStatus } },
    latestReconciliationOperationIds: observation === undefined ? {} : { [attemptId]: observation.operationId },
    reconciliationOperations: observation === undefined ? {} : {
      [observation.operationId]: { id: observation.operationId, observations: [{ taskId, attemptId, state: observation.state }] },
    },
  } as unknown as TeamProjection
}

describe('ControllerRecoveryCoordinator', () => {
  it('resumes a cleared recovery with no unresolved attempts instead of leaving it stuck paused', async () => {
    const initial = projection('needs_reconciliation', 'ready', 'failed')
    const cleared = projection('paused', 'ready', 'failed')
    const resumed = projection('running', 'ready', 'failed')
    const resume = vi.fn(async () => resumed)
    const retryTask = vi.fn()
    const result = await new ControllerRecoveryCoordinator().recover({ teamId: 'team-1', operationId: 'clear-only' }, {
      projection: () => initial, reconcile: vi.fn(), resolveAttempt: vi.fn(),
      clearRecovery: async () => cleared, retryTask, resume,
    })
    expect(result).toBe(resumed)
    expect(retryTask).not.toHaveBeenCalled()
    expect(resume).toHaveBeenCalledOnce()
  })

  it.each(['failed', 'cancelled'])('leaves a cleared legacy %s task paused when there is no resumable work', async status => {
    const initial = projection('needs_reconciliation', status, status)
    const cleared = projection('paused', status, status)
    const resume = vi.fn()
    const retryTask = vi.fn()
    const result = await new ControllerRecoveryCoordinator().recover({ teamId: 'team-1', operationId: 'settled-only' }, {
      projection: () => initial, reconcile: vi.fn(), resolveAttempt: vi.fn(),
      clearRecovery: async () => cleared, retryTask, resume,
    })
    expect(result).toBe(cleared)
    expect(resume).not.toHaveBeenCalled()
    expect(retryTask).not.toHaveBeenCalled()
  })

  it('reconstructs a resolved attempt after interruption before retry', async () => {
    const initial = {
      ...projection('paused', 'failed', 'failed'),
      attemptResolutionOperations: {
        'replay:resolve:task-1': { decision: 'failed', taskId: 'task-1', attemptId: 'attempt-1' },
      },
    } as unknown as TeamProjection
    const retried = projection('paused', 'ready', 'failed')
    const resumed = projection('running', 'ready', 'failed')
    const retryTask = vi.fn(async () => retried)
    const result = await new ControllerRecoveryCoordinator().recover({ teamId: 'team-1', operationId: 'replay' }, {
      projection: () => initial, reconcile: vi.fn(), resolveAttempt: vi.fn(), clearRecovery: vi.fn(),
      retryTask, resume: async () => resumed,
    })
    expect(result).toBe(resumed)
    expect(retryTask).toHaveBeenCalledWith({ taskId: 'task-1', operationId: 'replay:retry:task-1' })
  })

  it('does not erase cancellation intent with recovery or resume', async () => {
    const initial = {
      ...projection('needs_reconciliation', 'running', 'unknown'),
      latestTeamControlOperationId: 'cancel-user',
      controlOperations: { 'cancel-user': { action: 'cancel' } },
    } as unknown as TeamProjection
    const reconcile = vi.fn()
    const result = await new ControllerRecoveryCoordinator().recover({ teamId: 'team-1', operationId: 'after-cancel' }, {
      projection: () => initial, reconcile, resolveAttempt: vi.fn(), clearRecovery: vi.fn(),
      retryTask: vi.fn(), resume: vi.fn(),
    })
    expect(result).toBe(initial)
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('stops when cancellation wins during reconciliation', async () => {
    const initial = projection('needs_reconciliation', 'running', 'unknown')
    const cancelled = projection('cancelled', 'cancelled', 'cancelled')
    const resolveAttempt = vi.fn()
    const result = await new ControllerRecoveryCoordinator().recover({ teamId: 'team-1', operationId: 'race' }, {
      projection: () => initial, reconcile: async () => cancelled, resolveAttempt, clearRecovery: vi.fn(),
      retryTask: vi.fn(), resume: vi.fn(),
    })
    expect(result).toBe(cancelled)
    expect(resolveAttempt).not.toHaveBeenCalled()
  })

  it('reconciles before resolving and resumes only the safely recovered task', async () => {
    const initial = projection('needs_reconciliation', 'running', 'unknown')
    const observed = projection('needs_reconciliation', 'running', 'unknown', { operationId: 'observe-1', state: 'missing' })
    const resolved = projection('needs_reconciliation', 'failed', 'failed')
    const cleared = projection('paused', 'failed', 'failed')
    const retried = projection('paused', 'ready', 'failed')
    const resumed = projection('running', 'ready', 'failed')
    const calls: string[] = []
    const signal = new AbortController().signal
    const result = await new ControllerRecoveryCoordinator().recover({ teamId: 'team-1', operationId: 'r'.repeat(120), signal }, {
      projection: () => initial,
      reconcile: vi.fn(async () => { calls.push('reconcile'); return observed }),
      resolveAttempt: vi.fn(async () => { calls.push('resolve'); return resolved }),
      clearRecovery: vi.fn(async () => { calls.push('clear'); return cleared }),
      retryTask: vi.fn(async () => { calls.push('retry'); return retried }),
      resume: vi.fn(async () => { calls.push('resume'); return resumed }),
    })

    expect(result).toBe(resumed)
    expect(calls).toEqual(['reconcile', 'resolve', 'clear', 'retry', 'resume'])
  })

  it('rechecks an unknown attempt after an earlier live observation and resolves it only after the new Host fact is quiescent', async () => {
    const oldLive = projection('needs_reconciliation', 'running', 'unknown', { operationId: 'previous-recovery:observe', state: 'live' })
    const newlyQuiescent = projection('needs_reconciliation', 'running', 'unknown', { operationId: 'new-recovery:observe', state: 'missing' })
    const resolved = projection('needs_reconciliation', 'failed', 'failed')
    const cleared = projection('paused', 'failed', 'failed')
    const reconcile = vi.fn(async () => newlyQuiescent)
    const resolveAttempt = vi.fn(async () => resolved)

    const result = await new ControllerRecoveryCoordinator().recover({ teamId: 'team-1', operationId: 'new-recovery' }, {
      projection: () => oldLive,
      reconcile,
      resolveAttempt,
      clearRecovery: vi.fn(async () => cleared),
    })

    expect(result).toBe(cleared)
    expect(reconcile).toHaveBeenCalledWith({ operationId: 'new-recovery:observe' })
    expect(resolveAttempt).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'new-recovery:resolve:task-1',
      observationOperationId: 'new-recovery:observe',
    }))
  })

  it('does not reobserve or resolve a still-live attempt when retrying the same recovery operation', async () => {
    const observedLive = projection('needs_reconciliation', 'running', 'unknown', { operationId: 'same-recovery:observe', state: 'live' })
    const reconcile = vi.fn()
    const resolveAttempt = vi.fn()
    const coordinator = new ControllerRecoveryCoordinator()
    const port = {
      projection: () => observedLive,
      reconcile,
      resolveAttempt,
      clearRecovery: vi.fn(),
    }

    await expect(coordinator.recover({ teamId: 'team-1', operationId: 'same-recovery' }, port)).resolves.toBe(observedLive)
    await expect(coordinator.recover({ teamId: 'team-1', operationId: 'same-recovery' }, port)).resolves.toBe(observedLive)
    expect(reconcile).not.toHaveBeenCalled()
    expect(resolveAttempt).not.toHaveBeenCalled()
  })

  it('leaves an unprovable attempt closed and does not create a replacement attempt', async () => {
    const initial = projection('needs_reconciliation', 'running', 'unknown')
    const unresolved = projection('needs_reconciliation', 'running', 'unknown', { operationId: 'observe-1', state: 'live' })
    const resolveAttempt = vi.fn()
    const clearRecovery = vi.fn()
    const retryTask = vi.fn()
    const result = await new ControllerRecoveryCoordinator().recover({ teamId: 'team-1', operationId: 'recovery-2' }, {
      projection: () => initial,
      reconcile: async () => unresolved,
      resolveAttempt,
      clearRecovery,
      retryTask,
    })

    expect(result).toBe(unresolved)
    expect(resolveAttempt).not.toHaveBeenCalled()
    expect(clearRecovery).not.toHaveBeenCalled()
    expect(retryTask).not.toHaveBeenCalled()
  })

  it('fails closed when reconciliation returns no observation for an unknown attempt', async () => {
    const initial = projection('needs_reconciliation', 'running', 'unknown')
    const noObservation = projection('needs_reconciliation', 'running', 'unknown')
    const resolveAttempt = vi.fn()
    const clearRecovery = vi.fn()
    const result = await new ControllerRecoveryCoordinator().recover({ teamId: 'team-1', operationId: 'recovery-no-observation' }, {
      projection: () => initial,
      reconcile: async () => noObservation,
      resolveAttempt,
      clearRecovery,
    })

    expect(result).toBe(noObservation)
    expect(resolveAttempt).not.toHaveBeenCalled()
    expect(clearRecovery).not.toHaveBeenCalled()
  })

  it('does not clear or resume a settled projection and skips tasks no longer retryable', async () => {
    const noAttempt = projection('paused', 'failed', 'failed', undefined, [])
    const noOpReconcile = vi.fn()
    await expect(new ControllerRecoveryCoordinator().recover({ teamId: 'team-1', operationId: 'recovery-noop' }, {
      projection: () => noAttempt,
      reconcile: noOpReconcile,
      resolveAttempt: vi.fn(),
      clearRecovery: vi.fn(),
    })).resolves.toBe(noAttempt)
    expect(noOpReconcile).not.toHaveBeenCalled()

    const initial = projection('needs_reconciliation', 'running', 'unknown', { operationId: 'observe-ready', state: 'durable' })
    const resolved = projection('needs_reconciliation', 'failed', 'failed')
    const alreadyRunning = projection('running', 'ready', 'failed')
    const retryTask = vi.fn()
    const resume = vi.fn()
    const result = await new ControllerRecoveryCoordinator().recover({ teamId: 'team-1', operationId: 'recovery-not-retryable' }, {
      projection: () => initial,
      reconcile: vi.fn(),
      resolveAttempt: async () => resolved,
      clearRecovery: async () => alreadyRunning,
      retryTask,
      resume,
    })

    expect(result).toBe(alreadyRunning)
    expect(retryTask).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it('keeps another unknown attempt untouched after resolving one safe attempt', async () => {
    const firstTask = 'task-1'
    const secondTask = 'task-2'
    const initial = {
      ...projection('needs_reconciliation', 'running', 'unknown', { operationId: 'observe-both', state: 'missing' }),
      taskIds: [firstTask],
      tasks: {
        'task-1': { contract: { taskId: firstTask, goal: 'recover first' }, status: 'running', attemptIds: ['attempt-1'] },
        'task-2': { contract: { taskId: secondTask, goal: 'recover second' }, status: 'running', attemptIds: ['attempt-2'] },
      },
      attempts: {
        'attempt-1': { id: 'attempt-1', taskId: firstTask, status: 'unknown' },
        'attempt-2': { id: 'attempt-2', taskId: secondTask, status: 'unknown' },
      },
      latestReconciliationOperationIds: { 'attempt-1': 'observe-both' },
      reconciliationOperations: {
        'observe-both': { id: 'observe-both', observations: [{ taskId: firstTask, attemptId: 'attempt-1', state: 'missing' }] },
      },
    } as unknown as TeamProjection
    const resolved = {
      ...initial,
      taskIds: [firstTask],
      tasks: { ...initial.tasks, [firstTask]: { ...initial.tasks[firstTask], status: 'failed' } },
      attempts: { ...initial.attempts, 'attempt-1': { ...initial.attempts['attempt-1'], status: 'failed' } },
    } as unknown as TeamProjection
    const result = await new ControllerRecoveryCoordinator().recover({ teamId: 'team-1', operationId: 'recovery-partial' }, {
      projection: () => initial,
      reconcile: async () => initial,
      resolveAttempt: async () => resolved,
      clearRecovery: vi.fn(),
    })

    expect(result).toBe(resolved)
  })

  it.each(['durable', 'not-admitted'] as const)('accepts a %s quiescence observation', async state => {
    const initial = projection('needs_reconciliation', 'running', 'unknown', { operationId: `observe-${state}`, state })
    const resolved = projection('needs_reconciliation', 'failed', 'failed')
    const cleared = projection('paused', 'failed', 'failed')
    const result = await new ControllerRecoveryCoordinator().recover({ teamId: 'team-1', operationId: `recovery-${state}` }, {
      projection: () => initial,
      reconcile: vi.fn(),
      resolveAttempt: async () => resolved,
      clearRecovery: async () => cleared,
    })

    expect(result.team.status).toBe('paused')
  })

  it('closes safe facts to paused even when controller ownership cannot be restored', async () => {
    const initial = projection('needs_reconciliation', 'running', 'unknown', { operationId: 'observe-1', state: 'missing' })
    const resolved = projection('needs_reconciliation', 'failed', 'failed')
    const cleared = projection('paused', 'failed', 'failed')
    const result = await new ControllerRecoveryCoordinator().recover({ teamId: 'team-1', operationId: 'recovery-3' }, {
      projection: () => initial,
      reconcile: vi.fn(),
      resolveAttempt: async () => resolved,
      clearRecovery: async request => {
        expect(request.target).toBe('paused')
        return cleared
      },
    })

    expect(result.team.status).toBe('paused')
    expect(result.tasks['task-1']?.status).toBe('failed')
  })
})
