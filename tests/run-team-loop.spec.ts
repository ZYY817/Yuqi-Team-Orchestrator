import { describe, expect, it } from 'vitest'
import { AttemptId, ControlOperationId, parseTeamEvent, planTeamSchedule, replayTeamEvents, TaskId, TeamId, VerificationId } from '../src/index.ts'
import type { TeamEvent, TeamEventJournal } from '../src/index.ts'
import type { TeamEventBody } from '../src/application/team-events.ts'
import type { TeamRunCyclePort, TeamRunScheduleStateRequest, TeamRunVerificationRequest } from '../src/application/run-team-loop.ts'
import { TeamRunLoopCoordinator } from '../src/application/run-team-loop.ts'
import { contract } from './fixtures.ts'

const TEAM_ID = TeamId('loop-team')

class Journal implements TeamEventJournal {
  readonly key: string
  readonly events: TeamEvent[]
  constructor(events: readonly TeamEvent[], key = 'loop-journal') { this.events = [...events]; this.key = key }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> { this.events.push(...events) }
}

function event(index: number, body: TeamEventBody): TeamEvent {
  return parseTeamEvent({ schemaVersion: 1, eventId: `loop-event-${index}`, teamId: TEAM_ID, occurredAt: `2026-08-16T00:00:${String(index).padStart(2, '0')}Z`, ...body })
}

function base(tasks = [contract(TaskId('root')), contract(TaskId('child'), 1, [TaskId('root')])]): readonly TeamEvent[] {
  return [
    event(1, { type: 'yuqi/team-created', title: 'Loop', objective: 'Continue work' }),
    event(2, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
    ...tasks.map((task, index) => event(3 + index, { type: 'yuqi/task-created', contract: { ...task, fileScope: [`${String(task.taskId)}/**`] } })),
  ]
}

function stopEvents(status: 'paused' | 'needs_reconciliation'): readonly TeamEvent[] {
  return status === 'paused'
    ? [...base([contract(TaskId('root'))]), event(5, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }), event(6, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' })]
    : [...base([contract(TaskId('root'))]), event(5, { type: 'yuqi/team-status-changed', from: 'running', to: status })]
}

class FakeDriver implements TeamRunCyclePort {
  readonly calls: string[] = []
  readonly onExecute: (request: Parameters<TeamRunCyclePort['executeBatch']>[0]) => Promise<void>
  readonly onVerify: (request: TeamRunVerificationRequest) => Promise<void>
  readonly onPersist: ((request: TeamRunScheduleStateRequest) => Promise<void>) | undefined
  constructor(
    onExecute: (request: Parameters<TeamRunCyclePort['executeBatch']>[0]) => Promise<void> = async () => undefined,
    onVerify: (request: TeamRunVerificationRequest) => Promise<void> = async () => undefined,
    onPersist?: (request: TeamRunScheduleStateRequest) => Promise<void>,
  ) { this.onExecute = onExecute; this.onVerify = onVerify; this.onPersist = onPersist }
  executeBatch(request: Parameters<TeamRunCyclePort['executeBatch']>[0]): Promise<void> { this.calls.push(`execute:${request.plan.dispatchTaskIds.join(',')}`); return this.onExecute(request) }
  waitForProgress(): Promise<void> { this.calls.push('wait'); return Promise.resolve() }
  verify(request: TeamRunVerificationRequest): Promise<void> { this.calls.push(`verify:${request.tasks.map(task => task.taskId).join(',')}`); return this.onVerify(request) }
  persistScheduleState(request: TeamRunScheduleStateRequest): Promise<void> {
    this.calls.push(`persist:${request.requiresReconciliation ? 'reconciliation' : request.taskTransitions.map(transition => `${transition.taskId}:${transition.to}`).join(',')}`)
    return this.onPersist?.(request) ?? Promise.resolve()
  }
}

describe('continuous Team run loop', () => {
  it('keeps dispatching a two-layer DAG and verifies each settled task', async () => {
    const journal = new Journal(base())
    let nextEvent = 10
    const appendCompletion = async (request: Parameters<TeamRunCyclePort['executeBatch']>[0]) => {
      const taskId = request.plan.dispatchTaskIds[0]!
      const attemptId = `${String(taskId)}-attempt`
      await journal.commit([
        event(nextEvent++, { type: 'yuqi/task-status-changed', taskId, from: 'pending', to: 'ready' }),
        event(nextEvent++, { type: 'yuqi/task-status-changed', taskId, from: 'ready', to: 'running' }),
        event(nextEvent++, { type: 'yuqi/attempt-created', taskId, attemptId: AttemptId(attemptId), ordinal: 1, modelProvider: 'p', modelId: 'deepseek-v4' }),
        event(nextEvent++, { type: 'yuqi/attempt-admitted', taskId, attemptId: AttemptId(attemptId), agentSessionId: `${String(taskId)}-child`, messageId: `${String(taskId)}-message` }),
        event(nextEvent++, { type: 'yuqi/attempt-status-changed', taskId, attemptId: AttemptId(attemptId), from: 'dispatching', to: 'running' }),
        event(nextEvent++, { type: 'yuqi/attempt-status-changed', taskId, attemptId: AttemptId(attemptId), from: 'running', to: 'settled' }),
        event(nextEvent++, { type: 'yuqi/attempt-evidence-recorded', taskId, attemptId: AttemptId(attemptId), runId: `${String(taskId)}-run`, agentSessionId: `${String(taskId)}-child`, provider: 'p', stopReason: 'completed', hasAssistantOutput: true, settledAt: '2026-08-16T00:01:00Z' }),
        event(nextEvent++, { type: 'yuqi/task-status-changed', taskId, from: 'running', to: 'verifying' }),
      ])
    }
    const appendVerification = async (request: TeamRunVerificationRequest) => {
      const target = request.tasks[0]!
      const verificationId = `${target.taskId}-verification`
      await journal.commit([
        event(nextEvent++, { type: 'yuqi/verification-created', taskId: TaskId(target.taskId), attemptId: AttemptId(target.attemptId), verificationId: VerificationId(verificationId), verifierSessionId: 'verifier' }),
        event(nextEvent++, { type: 'yuqi/verification-status-changed', taskId: TaskId(target.taskId), attemptId: AttemptId(target.attemptId), verificationId: VerificationId(verificationId), from: 'pending', to: 'running' }),
        event(nextEvent++, { type: 'yuqi/verification-verdict-recorded', operationId: ControlOperationId(`verdict-${target.taskId}`), taskId: TaskId(target.taskId), attemptId: AttemptId(target.attemptId), verificationId: VerificationId(verificationId), disposition: 'passed', requirements: [{ checkId: 'build', kind: 'build' }], evidence: [{ checkId: 'build', capturedAt: '2026-08-16T00:01:00Z', kind: 'build', producer: 'build-runner', command: 'build', exitCode: 0, artifactDigest: 'digest' }], reasons: [] }),
        event(nextEvent++, { type: 'yuqi/attempt-status-changed', taskId: TaskId(target.taskId), attemptId: AttemptId(target.attemptId), from: 'settled', to: 'completed' }),
        event(nextEvent++, { type: 'yuqi/task-status-changed', taskId: TaskId(target.taskId), from: 'verifying', to: 'completed' }),
        ...(target.taskId === 'child' ? [event(nextEvent++, { type: 'yuqi/team-status-changed', from: 'running', to: 'completed' })] : []),
      ])
    }
    const driver = new FakeDriver(appendCompletion, appendVerification)
    const result = await new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal, maxConcurrency: 1, driver })
    expect(result.reason).toBe('completed')
    expect(driver.calls).toEqual(['execute:root', 'verify:root', 'execute:child', 'verify:child'])
    expect(result.projection.taskIds).toEqual([TaskId('root'), TaskId('child')])
  })

  it('fills a newly available parallel slot before waiting for a longer active sibling', async () => {
    const longTask = TaskId('long-running')
    const newlyReady = TaskId('newly-ready')
    const attemptId = AttemptId('long-attempt')
    const journal = new Journal([
      ...base([contract(longTask), contract(newlyReady)]),
      event(10, { type: 'yuqi/task-status-changed', taskId: longTask, from: 'pending', to: 'ready' }),
      event(11, { type: 'yuqi/task-status-changed', taskId: longTask, from: 'ready', to: 'running' }),
      event(12, { type: 'yuqi/attempt-created', taskId: longTask, attemptId, ordinal: 1, modelProvider: 'p', modelId: 'deepseek-v4' }),
      event(13, { type: 'yuqi/attempt-admitted', taskId: longTask, attemptId, agentSessionId: 'long-child', messageId: 'long-message' }),
      event(14, { type: 'yuqi/attempt-status-changed', taskId: longTask, attemptId, from: 'dispatching', to: 'running' }),
    ])
    const driver = new FakeDriver()

    await expect(new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal, maxConcurrency: 2, maxCycles: 1, driver }))
      .resolves.toMatchObject({ reason: 'no-progress' })
    expect(driver.calls).toEqual(['execute:newly-ready'])
  })

  it('rolls a newly freed slot forward while a slower sibling remains active', async () => {
    const taskIds = [TaskId('first'), TaskId('slow'), TaskId('refill')] as const
    const journal = new Journal(base(taskIds.map(taskId => contract(taskId))), 'rolling-refill')
    let nextEvent = 10
    const activePeaks: number[] = []
    const attemptFor = (taskId: TaskId) => AttemptId(`${String(taskId)}-attempt`)
    const driver = new FakeDriver(async request => {
      const dispatchEvents: TeamEvent[] = []
      for (const taskId of request.plan.dispatchTaskIds) {
        const attemptId = attemptFor(taskId)
        dispatchEvents.push(
          event(nextEvent++, { type: 'yuqi/task-status-changed', taskId, from: 'pending', to: 'ready' }),
          event(nextEvent++, { type: 'yuqi/task-status-changed', taskId, from: 'ready', to: 'running' }),
          event(nextEvent++, { type: 'yuqi/attempt-created', taskId, attemptId, ordinal: 1, modelProvider: 'p', modelId: 'deepseek-v4' }),
          event(nextEvent++, { type: 'yuqi/attempt-admitted', taskId, attemptId, agentSessionId: `${String(taskId)}-child`, messageId: `${String(taskId)}-message` }),
          event(nextEvent++, { type: 'yuqi/attempt-status-changed', taskId, attemptId, from: 'dispatching', to: 'running' }),
        )
      }
      await journal.commit(dispatchEvents)
      activePeaks.push(planTeamSchedule(replayTeamEvents(journal.read()), { maxConcurrency: 2 }).activeTaskIds.length)
    })
    driver.waitForProgress = async () => {
      driver.calls.push('wait')
      const taskId = taskIds[0]
      const attemptId = attemptFor(taskId)
      await journal.commit([
        event(nextEvent++, { type: 'yuqi/attempt-status-changed', taskId, attemptId, from: 'running', to: 'settled' }),
        event(nextEvent++, { type: 'yuqi/attempt-evidence-recorded', taskId, attemptId, runId: 'first-run', agentSessionId: 'first-child', provider: 'p', stopReason: 'completed', hasAssistantOutput: true, settledAt: '2026-08-16T00:01:00Z' }),
        event(nextEvent++, { type: 'yuqi/task-status-changed', taskId, from: 'running', to: 'completed' }),
      ])
    }

    const result = await new TeamRunLoopCoordinator().run({
      teamId: TEAM_ID, journal, maxConcurrency: 2, maxCycles: 3, driver,
    })
    expect(result.reason).toBe('max-cycles')
    expect(driver.calls).toEqual(['execute:first,slow', 'wait', 'execute:refill'])
    expect(activePeaks).toEqual([2, 2])
  })

  it('stops on pause/reconciliation, cancellation, and no progress', async () => {
    const driver = new FakeDriver()
    await expect(new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal: new Journal(stopEvents('paused')), maxConcurrency: 1, driver })).resolves.toMatchObject({ reason: 'paused', disposition: 'recoverable', cycles: 0 })
    await expect(new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal: new Journal(stopEvents('needs_reconciliation')), maxConcurrency: 1, driver })).resolves.toMatchObject({ reason: 'needs_reconciliation', disposition: 'needs_reconciliation', cycles: 0 })
    await expect(new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal: new Journal(base([contract(TaskId('root'))])), maxConcurrency: 1, driver })).resolves.toMatchObject({ reason: 'no-progress', disposition: 'recoverable', cycles: 1 })
    const abort = new AbortController()
    abort.abort()
    await expect(new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal: new Journal(base([contract(TaskId('root'))])), maxConcurrency: 1, driver, signal: abort.signal })).resolves.toMatchObject({ reason: 'aborted', disposition: 'needs_reconciliation', cycles: 0 })
  })

  it('persists dependency blocks and deterministically clears them after the prerequisite recovers', async () => {
    const root = TaskId('root')
    const child = TaskId('child')
    const journal = new Journal([
      ...base([contract(root), contract(child, 1, [root])]),
      event(10, { type: 'yuqi/task-status-changed', taskId: root, from: 'pending', to: 'ready' }),
      event(11, { type: 'yuqi/task-status-changed', taskId: root, from: 'ready', to: 'running' }),
      event(12, { type: 'yuqi/task-status-changed', taskId: root, from: 'running', to: 'failed' }),
    ], 'durable-block')
    let nextEvent = 20
    const persist = async (request: TeamRunScheduleStateRequest) => {
      await journal.commit(request.taskTransitions.map(transition => event(nextEvent++, {
        type: 'yuqi/task-status-changed', taskId: TaskId(transition.taskId), from: transition.from, to: transition.to, reason: transition.reason,
      })))
    }
    const firstDriver = new FakeDriver(undefined, undefined, persist)
    await expect(new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal, maxConcurrency: 1, driver: firstDriver }))
      .resolves.toMatchObject({ reason: 'no-progress', projection: { tasks: { child: { status: 'blocked' } } } })
    expect(firstDriver.calls[0]).toBe('persist:child:blocked')

    await journal.commit([event(nextEvent++, { type: 'yuqi/task-retry-requested', operationId: ControlOperationId('retry-root'), taskId: root })])
    const secondDriver = new FakeDriver(undefined, undefined, persist)
    await expect(new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal, maxConcurrency: 1, driver: secondDriver }))
      .resolves.toMatchObject({ reason: 'no-progress', projection: { tasks: { root: { status: 'ready' }, child: { status: 'pending' } } } })
    expect(secondDriver.calls.slice(0, 2)).toEqual(['persist:child:pending', 'execute:root'])
  })

  it('persists a scheduling reconciliation requirement before returning its projection', async () => {
    const root = TaskId('root')
    const attemptId = AttemptId('settled-without-task-terminal')
    const journal = new Journal([
      ...base([contract(root)]),
      event(10, { type: 'yuqi/task-status-changed', taskId: root, from: 'pending', to: 'ready' }),
      event(11, { type: 'yuqi/task-status-changed', taskId: root, from: 'ready', to: 'running' }),
      event(12, { type: 'yuqi/attempt-created', taskId: root, attemptId, ordinal: 1, modelProvider: 'p', modelId: 'm' }),
      event(13, { type: 'yuqi/attempt-admitted', taskId: root, attemptId, agentSessionId: 'child', messageId: 'message' }),
      event(14, { type: 'yuqi/attempt-status-changed', taskId: root, attemptId, from: 'dispatching', to: 'running' }),
      event(15, { type: 'yuqi/attempt-status-changed', taskId: root, attemptId, from: 'running', to: 'settled' }),
      event(16, { type: 'yuqi/attempt-evidence-recorded', taskId: root, attemptId, runId: 'run', agentSessionId: 'child', provider: 'p', stopReason: 'completed', hasAssistantOutput: true, settledAt: '2026-08-16T00:01:00Z' }),
    ], 'persist-reconciliation')
    const driver = new FakeDriver(undefined, undefined, async (request) => {
      expect(request.requiresReconciliation).toBe(true)
      await journal.commit([event(20, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation', reason: 'scheduler found inconsistent durable child facts' })])
    })

    const result = await new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal, maxConcurrency: 1, driver })
    expect(result).toMatchObject({ reason: 'needs_reconciliation', disposition: 'needs_reconciliation', projection: { team: { status: 'needs_reconciliation' } } })
    expect(replayTeamEvents(journal.read()).team.status).toBe(result.projection.team.status)
  })

  it('returns max-cycles as yielded while preserving the running durable projection', async () => {
    const journal = new Journal(base([contract(TaskId('root'))]))
    let calls = 0
    const driver = new FakeDriver(async () => {
      calls += 1
      if (calls === 1) {
        await journal.commit([event(10, { type: 'yuqi/task-status-changed', taskId: TaskId('root'), from: 'pending', to: 'ready' })])
        return
      }
      await journal.commit([
        event(11, { type: 'yuqi/task-status-changed', taskId: TaskId('root'), from: 'ready', to: 'running' }),
        event(12, { type: 'yuqi/attempt-created', taskId: TaskId('root'), attemptId: AttemptId('root-attempt'), ordinal: 1, modelProvider: 'p', modelId: 'deepseek-v4' }),
        event(13, { type: 'yuqi/attempt-admitted', taskId: TaskId('root'), attemptId: AttemptId('root-attempt'), agentSessionId: 'root-child', messageId: 'root-message' }),
        event(14, { type: 'yuqi/attempt-status-changed', taskId: TaskId('root'), attemptId: AttemptId('root-attempt'), from: 'dispatching', to: 'running' }),
      ])
    })

    await expect(new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal, maxConcurrency: 1, maxCycles: 2, driver })).resolves.toMatchObject({
      reason: 'max-cycles', disposition: 'yielded', cycles: 2, projection: { team: { status: 'running' } },
    })
  })

  it('maps a driver rejection caused by abort to an explicit reconciliation result', async () => {
    const abort = new AbortController()
    const driver = new FakeDriver(async () => {
      abort.abort()
      throw new Error('driver interrupted')
    })

    await expect(new TeamRunLoopCoordinator().run({
      teamId: TEAM_ID, journal: new Journal(base([contract(TaskId('root'))])), maxConcurrency: 1, driver, signal: abort.signal,
    })).resolves.toMatchObject({ reason: 'aborted', disposition: 'needs_reconciliation' })
  })

  it('single-flights concurrent runs for one journal while allowing a new run after completion', async () => {
    const journal = new Journal(base([contract(TaskId('root'))]))
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const driver = new FakeDriver(async () => waiting)
    const loop = new TeamRunLoopCoordinator()
    const first = loop.run({ teamId: TEAM_ID, journal, maxConcurrency: 1, driver })
    const second = loop.run({ teamId: TEAM_ID, journal, maxConcurrency: 1, driver })
    expect(first).toBe(second)
    expect(() => loop.run({ teamId: TEAM_ID, journal, maxConcurrency: 2, driver })).toThrow(/different run semantics/)
    expect(() => loop.run({ teamId: TEAM_ID, journal, maxConcurrency: 1, maxCycles: 2, driver })).toThrow(/different run semantics/)
    expect(() => loop.run({ teamId: TEAM_ID, journal, maxConcurrency: 1, driver: new FakeDriver() })).toThrow(/different run semantics/)
    release()
    await expect(first).resolves.toMatchObject({ reason: 'no-progress' })
    expect(driver.calls).toEqual(['execute:root'])
  })

  it('distinguishes durable Team cancellation from an external abort and reports Team mismatch', async () => {
    const cancelling = new Journal([...base([contract(TaskId('root'))]), event(5, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling' }), event(6, { type: 'yuqi/team-status-changed', from: 'cancelling', to: 'cancelled' })])
    await expect(new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal: cancelling, maxConcurrency: 1, driver: new FakeDriver() })).resolves.toMatchObject({ reason: 'cancelled' })
    await expect(new TeamRunLoopCoordinator().run({ teamId: 'wrong-team', journal: new Journal(base([contract(TaskId('root'))]), 'mismatch'), maxConcurrency: 1, driver: new FakeDriver() })).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
  })

  it('stops safely for failed and inactive durable Team states and validates maxCycles', async () => {
    const driver = new FakeDriver()
    const failed = new Journal([...base([contract(TaskId('root'))]), event(5, { type: 'yuqi/team-status-changed', from: 'running', to: 'failed', reason: 'controller failed' })])
    await expect(new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal: failed, maxConcurrency: 1, driver })).resolves.toMatchObject({ reason: 'failed', disposition: 'failed', cycles: 0 })
    await expect(new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal: new Journal([event(1, { type: 'yuqi/team-created', title: 'Draft', objective: 'Not started' })], 'draft'), maxConcurrency: 1, driver })).resolves.toMatchObject({ reason: 'inactive', disposition: 'recoverable', cycles: 0 })
    const pausing = new Journal([...base([contract(TaskId('root'))]), event(5, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' })], 'pausing')
    await expect(new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal: pausing, maxConcurrency: 1, driver })).resolves.toMatchObject({ reason: 'inactive', cycles: 0 })
    const cancelling = new Journal([...base([contract(TaskId('root'))]), event(5, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling' })], 'cancelling')
    await expect(new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal: cancelling, maxConcurrency: 1, driver })).resolves.toMatchObject({ reason: 'inactive', cycles: 0 })
    expect(() => new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal: new Journal(base([contract(TaskId('root'))]), 'bad-max'), maxConcurrency: 1, maxCycles: 0, driver })).toThrow('maxCycles must be a positive integer')
  })

  it('waits for active attempts, propagates non-abort driver failures, and honors abort after a cycle', async () => {
    const active = new Journal([
      ...base([contract(TaskId('root'))]),
      event(10, { type: 'yuqi/task-status-changed', taskId: TaskId('root'), from: 'pending', to: 'ready' }),
      event(11, { type: 'yuqi/task-status-changed', taskId: TaskId('root'), from: 'ready', to: 'running' }),
      event(12, { type: 'yuqi/attempt-created', taskId: TaskId('root'), attemptId: AttemptId('active-attempt'), ordinal: 1, modelProvider: 'p', modelId: 'm' }),
      event(13, { type: 'yuqi/attempt-admitted', taskId: TaskId('root'), attemptId: AttemptId('active-attempt'), agentSessionId: 'active-child', messageId: 'active-message' }),
      event(14, { type: 'yuqi/attempt-status-changed', taskId: TaskId('root'), attemptId: AttemptId('active-attempt'), from: 'dispatching', to: 'running' }),
    ], 'active')
    const waitingDriver = new FakeDriver()
    await expect(new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal: active, maxConcurrency: 1, driver: waitingDriver })).resolves.toMatchObject({ reason: 'no-progress', cycles: 1 })
    expect(waitingDriver.calls).toEqual(['wait'])

    const rejected = new FakeDriver(async () => { throw new Error('driver failure') })
    await expect(new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal: new Journal(base([contract(TaskId('root'))]), 'reject'), maxConcurrency: 1, driver: rejected })).rejects.toThrow('driver failure')

    const abort = new AbortController()
    const abortAfterCycle = new FakeDriver(async () => { abort.abort() })
    await expect(new TeamRunLoopCoordinator().run({ teamId: TEAM_ID, journal: new Journal(base([contract(TaskId('root'))]), 'abort-after-cycle'), maxConcurrency: 1, driver: abortAfterCycle, signal: abort.signal })).resolves.toMatchObject({ reason: 'aborted', disposition: 'needs_reconciliation', cycles: 1 })
  })
})
