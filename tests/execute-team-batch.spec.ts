import { describe, expect, it, vi } from 'vitest'
import { AttemptId, ControlOperationId, DurableJournalCoordinator, planTeamSchedule, replayTeamEvents, TaskId, TeamControlCoordinator, WorkspaceId } from '../src/index.ts'
import { OneChildCoordinator } from '../src/application/dispatch-one.ts'
import { TaskRetryCoordinator } from '../src/application/retry-task.ts'
import { summarizeTeamForConsole } from '../src/application/team-console-summary.ts'
import { requiredRecoveryToken, TeamBatchExecutor } from '../src/application/execute-team-batch.ts'
import type { ChildEnd, ChildStartRequest, ChildUsage, Clock, ContinuableChildPort, EventIdSource, TeamEvent, TeamEventJournal } from '../src/index.ts'
import { contract, event, TEAM_ID } from './fixtures.ts'

class ClockStub implements Clock { #n = 0; nowIso(): string { return `2026-08-15T12:00:${String(this.#n++).padStart(2, '0')}Z` } }
class Ids implements EventIdSource { #n = 0; next(): string { return `execute-event-${this.#n++}` } }
class Journal implements TeamEventJournal {
  readonly key: string
  readonly events: unknown[]
  readonly transactions: TeamEvent[][] = []
  failAt = -1
  barrier: Promise<void> | undefined
  constructor(events: readonly unknown[], key = 'controller') { this.events = [...events]; this.key = key }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> {
    if (this.barrier !== undefined) await this.barrier
    this.transactions.push([...events]); this.events.push(...events)
    if (this.transactions.length === this.failAt) throw new Error('flush failed')
  }
}
class Children implements ContinuableChildPort<string> {
  listener: ((end: ChildEnd) => void) | undefined
  readonly usageListeners = new Set<(usage: ChildUsage) => void>()
  readonly starts: ChildStartRequest<string>[] = []
  readonly failures = new Set<string>()
  readonly interrupts: string[] = []
  interruptFailure: Error | undefined
  ignoreAbort = false
  overflowOnStart = false
  startBarrier: Promise<void> | undefined
  onEnd(listener: (end: ChildEnd) => void): () => void { this.listener = listener; return vi.fn() }
  onUsage(listener: (usage: ChildUsage) => void): () => void {
    this.usageListeners.add(listener)
    return () => void this.usageListeners.delete(listener)
  }
  interrupt(childSessionId: string): void {
    this.interrupts.push(childSessionId)
    if (this.interruptFailure !== undefined) throw this.interruptFailure
  }
  async start(request: ChildStartRequest<string>) {
    this.starts.push(request)
    if (this.overflowOnStart) for (let index = 0; index < 129; index += 1) this.end(`unknown-${index}`)
    if (this.startBarrier !== undefined) await this.startBarrier
    if (!this.ignoreAbort) request.signal.throwIfAborted()
    if (this.failures.has(request.label) || this.failures.has(request.label.split(':').at(-1)!)) throw new Error('start failed')
    const suffix = request.label.includes('left')
      ? 'left'
      : request.label.includes('right')
        ? 'right'
        : request.label.split(':').at(-1)!
    return { childSessionId: `child-${suffix}`, messageId: `message-${suffix}` }
  }
  end(suffix: string, stopReason = 'completed', usage?: ChildEnd['usage']): void {
    this.listener?.({ runId: `run-${suffix}`, childSessionId: `child-${suffix}`, provider: 'p', stopReason, hasAssistantOutput: true, ...(usage === undefined ? {} : { usage }) })
  }
  endWithoutOutput(suffix: string): void {
    this.listener?.({ runId: `run-${suffix}`, childSessionId: `child-${suffix}`, provider: 'p', stopReason: 'completed', hasAssistantOutput: false })
  }
  usage(suffix: string, usage: ChildUsage['usage']): void {
    for (const listener of this.usageListeners) listener({ childSessionId: `child-${suffix}`, usage })
  }
}

function initialEvents(): readonly TeamEvent[] {
  const left = TaskId('execute-left'); const right = TaskId('execute-right')
  return [
    event(800, { type: 'yuqi/team-created', title: 'Execute', objective: 'Run two children' }),
    event(801, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
    event(802, { type: 'yuqi/task-created', contract: { ...contract(left), fileScope: ['src/**'] } }),
    event(803, { type: 'yuqi/task-created', contract: { ...contract(right), fileScope: ['tests/**'] } }),
  ]
}

function mixedEntryEvents(): readonly TeamEvent[] {
  const legacy = TaskId('execute-legacy')
  return [
    ...initialEvents(),
    event(804, { type: 'yuqi/task-created', contract: { ...contract(legacy), fileScope: ['legacy/**'] } }),
    event(805, { type: 'yuqi/task-status-changed', taskId: legacy, from: 'pending', to: 'ready' }),
    event(806, { type: 'yuqi/task-status-changed', taskId: legacy, from: 'ready', to: 'running' }),
  ]
}

function budgetEntryEvents(): readonly TeamEvent[] {
  return [...initialEvents(), event(804, {
    type: 'yuqi/budget-policy-set', operationId: ControlOperationId('execute-budget-policy'), revision: 1, tokenLimit: 100, alerts: [50], stopBehavior: 'block-new',
  })]
}

function budgetRequest(events: readonly unknown[]) {
  const base = request(events)
  return { ...base, children: base.children.map(child => ({ ...child, tokenReserve: 20 })) }
}

function request(events: readonly unknown[]) {
  const plan = planTeamSchedule(replayTeamEvents(events), { maxConcurrency: 2 })
  const signal = new AbortController().signal
  return {
    teamId: TEAM_ID, plan, maxConcurrency: 2,
    children: [
      { taskId: 'execute-left', attemptId: 'attempt-left', modelProvider: 'p', modelId: 'deepseek-v4', subagentProvider: 'default', label: 'left', prompt: 'left', signal },
      { taskId: 'execute-right', attemptId: 'attempt-right', modelProvider: 'p', modelId: 'deepseek-v4', subagentProvider: 'default', label: 'right', prompt: 'right', signal },
    ],
  }
}

function gatedEvents(): readonly TeamEvent[] {
  return [
    ...initialEvents(),
    event(807, { type: 'yuqi/workspace-provisioning-started', workspace: {
      workspaceId: WorkspaceId('workspace-execute'),
      project: { projectRoot: 'F:\\repo', repositoryRoot: 'F:\\repo', gitCommonDirectory: 'F:\\repo\\.git', baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: [] },
      worktreePath: 'F:\\managed\\execute', branchName: 'yuqi/execute', status: 'provisioning',
    } }),
    event(808, { type: 'yuqi/workspace-provisioned', workspaceId: WorkspaceId('workspace-execute') }),
  ]
}

function gatedRequest(events: readonly unknown[]) {
  const base = request(events)
  return {
    ...base,
    execution: { workspaceId: 'workspace-execute', worktreePath: 'F:\\managed\\execute' },
    children: base.children.map((child, index) => ({
      ...child,
      leaseId: `lease-${index}`,
      fixedModel: { subagentProvider: 'default', modelProvider: 'p', modelId: 'deepseek-v4', role: 'worker' as const },
    })),
  }
}

function capacityEvents(count: number): readonly TeamEvent[] {
  const events: TeamEvent[] = [
    event(900, { type: 'yuqi/team-created', title: 'Capacity', objective: `Run ${count} children` }),
    event(901, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
  ]
  for (let index = 0; index < count; index += 1) {
    const taskId = TaskId(`capacity-${index}`)
    events.push(event(902 + index, {
      type: 'yuqi/task-created',
      contract: { ...contract(taskId), authorityMode: 'read-only', fileScope: [] },
    }))
  }
  return events
}

function capacityRequest(events: readonly unknown[], count: number) {
  const plan = planTeamSchedule(replayTeamEvents(events), { maxConcurrency: count })
  const signal = new AbortController().signal
  return {
    teamId: TEAM_ID,
    plan,
    maxConcurrency: count,
    children: Array.from({ length: count }, (_, index) => ({
      taskId: `capacity-${index}`,
      attemptId: `capacity-attempt-${index}`,
      modelProvider: 'p',
      modelId: 'deepseek-v4',
      subagentProvider: 'default',
      label: `capacity-${index}`,
      prompt: `capacity-${index}`,
      signal,
    })),
  }
}

describe('TeamBatchExecutor', () => {
  it('persists worker blockers, releases leases, holds dependents, and requires explicit retry after reload', async () => {
    const journal = new Journal([...gatedEvents(), event(809, {
      type: 'yuqi/task-created', contract: contract(TaskId('after'), 1, [TaskId('execute-left')]),
    })], 'semantic-blocker')
    const children = new Children()
    const clock = new ClockStub(); const ids = new Ids()
    const transactions = new DurableJournalCoordinator()
    const executor = new TeamBatchExecutor<string>(clock, ids, transactions)
    const base = gatedRequest(journal.read())
    const result = await executor.execute({ ...base, children: base.children.map(child => ({ ...child, taskOutcomeVersion: 1 })) }, journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))
    children.listener?.({ runId: 'run-left', childSessionId: 'child-left', provider: 'p', stopReason: 'completed', hasAssistantOutput: true,
      taskOutcome: { status: 'reported', outcome: { version: 1, kind: 'blocked', summary: 'missing specification', nextAction: 'ask controller', question: 'Which color?' } },
    })
    children.listener?.({ runId: 'run-right', childSessionId: 'child-right', provider: 'p', stopReason: 'completed', hasAssistantOutput: true,
      taskOutcome: { status: 'reported', outcome: { version: 1, kind: 'completed', summary: 'done' } },
    })
    await Promise.all(result.handles.map(handle => handle.settled))
    const projection = replayTeamEvents(JSON.parse(JSON.stringify(journal.read())))
    expect(projection.tasks['execute-left']?.status).toBe('blocked')
    expect(projection.tasks['execute-right']?.status).toBe('completed')
    expect(projection.tasks.after?.status).not.toBe('running')
    expect(projection.attempts['attempt-left']?.taskOutcomeVersion).toBe(1)
    expect(projection.attempts['attempt-left']?.evidence?.taskOutcome).toMatchObject({ status: 'reported', outcome: { kind: 'blocked' } })
    expect(Object.values(projection.fileLeases).every(lease => lease.status === 'released')).toBe(true)
    // Even after a controller resumes the Team, scheduler-derived unblock cannot clear this result.
    const resumed = { ...projection, team: { ...projection.team, status: 'running' as const } }
    const plan = planTeamSchedule(resumed, { maxConcurrency: 2 })
    expect(plan.dispatchTaskIds).not.toContain('after')
    expect(plan.unblockedTaskIds).not.toContain('execute-left')
    expect(() => replayTeamEvents([...journal.read(), event(9000, { type: 'yuqi/task-status-changed', taskId: TaskId('execute-left'), from: 'blocked', to: 'ready' })])).toThrow(/explicit retry/u)
    const summary = summarizeTeamForConsole(projection)
    expect(summary.attention).toContainEqual(expect.objectContaining({ code: 'task-blocked', owner: 'controller', message: expect.stringContaining('Which color?') }))
    const retry = new TaskRetryCoordinator(clock, ids, transactions)
    const retried = await retry.retry({ teamId: TEAM_ID, taskId: 'execute-left', operationId: 'retry-blocked' }, journal)
    expect(retried.tasks['execute-left']?.status).toBe('ready')
    expect(retried.attempts['attempt-left']?.evidence?.taskOutcome).toBeDefined()
    await executor.dispose()
  })
  it('persists cumulative provider usage while independent children are still running', async () => {
    const journal = new Journal(initialEvents(), 'live-usage')
    const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))

    expect(children.starts).toHaveLength(2)
    expect(result.handles).toHaveLength(2)
    children.usage('left', { uncachedInputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 })
    await vi.waitFor(() => {
      expect(replayTeamEvents(journal.read()).attempts['attempt-left']?.observedUsage).toEqual({
        uncachedInputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1,
      })
    })

    children.end('left', 'completed', { uncachedInputTokens: 11, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 })
    children.end('right')
    await Promise.all(result.handles.map(handle => handle.settled))
    await executor.dispose()
  })

  it('keeps the latest live usage after a blocked write without replaying intermediate samples', async () => {
    const journal = new Journal(initialEvents(), 'usage-live-coalescing')
    const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const batch = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(batch.handles.map(handle => handle.admission))
    const barrier = Promise.withResolvers<void>()
    journal.barrier = barrier.promise
    const before = journal.transactions.length
    children.usage('left', { uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })
    await Promise.resolve(); await Promise.resolve()
    for (let index = 2; index <= 1000; index++) {
      children.usage('left', { uncachedInputTokens: index, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })
    }
    barrier.resolve()
    await vi.waitFor(() => expect(replayTeamEvents(journal.read()).attempts['attempt-left']?.observedUsage?.uncachedInputTokens).toBe(1000))
    expect(journal.transactions.length - before).toBeLessThanOrEqual(2)
    children.end('left'); children.end('right')
    await Promise.all(batch.handles.map(handle => handle.settled))
    await executor.dispose()
  })

  it('stops telemetry on disposal and drains at most the write already in progress', async () => {
    const journal = new Journal(initialEvents(), 'usage-disposal')
    const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const batch = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(batch.handles.map(handle => handle.admission))
    const barrier = Promise.withResolvers<void>()
    journal.barrier = barrier.promise
    const before = journal.transactions.length
    children.usage('left', { uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })
    await Promise.resolve(); await Promise.resolve()
    for (let index = 2; index <= 1000; index++) {
      children.usage('left', { uncachedInputTokens: index, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })
    }
    const disposal = executor.dispose()
    expect(children.usageListeners.size).toBe(0)
    barrier.resolve()
    await disposal
    expect(journal.transactions.length - before).toBeLessThanOrEqual(1)
    expect(await Promise.allSettled(batch.handles.map(handle => handle.settled))).toEqual([
      expect.objectContaining({ status: 'rejected' }), expect.objectContaining({ status: 'rejected' }),
    ])
  })

  it('coalesces 1000 queued usage samples and settles both children without a telemetry backlog', async () => {
    const journal = new Journal(initialEvents(), 'usage-backpressure')
    const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const batch = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(batch.handles.map(handle => handle.admission))
    const barrier = Promise.withResolvers<void>()
    journal.barrier = barrier.promise
    const before = journal.transactions.length
    children.usage('left', { uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })
    // Allow one telemetry transaction to own the gate, then accumulate behind it.
    await Promise.resolve(); await Promise.resolve()
    for (let index = 2; index <= 1000; index++) {
      children.usage('left', { uncachedInputTokens: index, outputTokens: index, cacheReadTokens: 0, cacheWriteTokens: 0 })
      children.usage('right', { uncachedInputTokens: index * 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })
    }
    const finalUsage = { uncachedInputTokens: 1001, outputTokens: 1001, cacheReadTokens: 0, cacheWriteTokens: 0 }
    children.end('left', 'completed', finalUsage)
    children.end('right', 'aborted')
    expect(children.usageListeners.size).toBe(0)
    barrier.resolve()
    await Promise.all(batch.handles.map(handle => handle.settled))
    const writes = journal.transactions.slice(before)
    expect(writes.length).toBeLessThanOrEqual(3) // One in-flight usage + two terminal transactions.
    const projection = replayTeamEvents(journal.read())
    expect(projection.attempts['attempt-left']?.evidence?.usage).toEqual(finalUsage)
    expect(projection.attempts['attempt-left']?.observedUsage?.uncachedInputTokens).toBe(1000)
    expect(projection.attempts['attempt-right']?.observedUsage?.uncachedInputTokens).toBe(2000)
    expect(projection.attempts['attempt-right']?.evidence?.usage).toBeUndefined()
    expect(projection.tasks['execute-right']?.status).not.toBe('completed')
    await executor.dispose()
  })

  it('settles known usage in the same terminal transaction as attempt evidence', async () => {
    const journal = new Journal(budgetEntryEvents(), 'budget-known-settlement')
    const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(budgetRequest(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))
    const usage = { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 }
    children.end('left', 'completed', usage); children.end('right', 'completed', usage)
    await Promise.all(result.handles.map(handle => handle.settled))
    const projection = replayTeamEvents(journal.read())
    expect(projection.budgetReservations['budget:attempt-left']).toMatchObject({ status: 'known', usage: { totalTokens: 18 } })
    expect(projection.budgetReservations['budget:attempt-right']).toMatchObject({ status: 'known', usage: { totalTokens: 18 } })
    expect(journal.transactions.at(-1)?.map(item => item.type)).toContain('yuqi/budget-reservation-settled')
    await executor.dispose()
  })

  it('treats the same terminal fact as idempotent when the progress observer settles first', async () => {
    const journal = new Journal(initialEvents(), 'duplicate-terminal-observation')
    const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))

    journal.events.push(
      event(850, { type: 'yuqi/attempt-status-changed', taskId: TaskId('execute-left'), attemptId: AttemptId('attempt-left'), from: 'running', to: 'settled' }),
      event(851, {
        type: 'yuqi/attempt-evidence-recorded', taskId: TaskId('execute-left'), attemptId: AttemptId('attempt-left'),
        runId: 'run-left', agentSessionId: 'child-left', provider: 'p', stopReason: 'completed',
        hasAssistantOutput: true, settledAt: '2026-08-15T12:00:50Z',
      }),
      event(852, { type: 'yuqi/attempt-status-changed', taskId: TaskId('execute-left'), attemptId: AttemptId('attempt-left'), from: 'settled', to: 'completed' }),
      event(853, { type: 'yuqi/task-status-changed', taskId: TaskId('execute-left'), from: 'running', to: 'completed' }),
    )

    children.end('left')
    children.end('right')
    await expect(Promise.all(result.handles.map(handle => handle.settled))).resolves.toHaveLength(2)
    expect(replayTeamEvents(journal.read()).tasks['execute-left']?.status).toBe('completed')
    expect(journal.transactions.flat().filter(item => item.type === 'yuqi/attempt-evidence-recorded'
      && String(item.attemptId) === 'attempt-left')).toHaveLength(0)
    await executor.dispose()
  })

  it('serializes concurrent budget batches on one Controller journal before either can bypass reservations', async () => {
    const journal = new Journal(budgetEntryEvents(), 'budget-concurrent-controller')
    const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const firstRequest = budgetRequest(journal.read())
    const secondRequest = budgetRequest(journal.read())
    const [first, second] = await Promise.allSettled([
      executor.execute(firstRequest, journal, children),
      executor.execute(secondRequest, journal, children),
    ])
    expect(first.status).toBe('fulfilled')
    expect(second.status).toBe('rejected')
    if (first.status === 'rejected') throw first.reason
    if (second.status === 'fulfilled') throw new Error('concurrent batch unexpectedly committed')
    expect(second.reason).toMatchObject({ code: 'SCHEDULE_NOT_RUNNABLE' })
    expect(journal.transactions.filter(transaction => transaction.some(item => item.type === 'yuqi/budget-reservation-acquired'))).toHaveLength(1)
    await Promise.all(first.value.handles.map(handle => handle.admission))
    children.end('left'); children.end('right')
    await Promise.all(first.value.handles.map(handle => handle.settled))
    await executor.dispose()
  })

  it('settles admitted missing usage as unknown and blocks further scheduling', async () => {
    const journal = new Journal(budgetEntryEvents(), 'budget-unknown-settlement')
    const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(budgetRequest(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))
    children.end('left'); children.end('right')
    await Promise.all(result.handles.map(handle => handle.settled))
    const projection = replayTeamEvents(journal.read())
    expect(Object.values(projection.budgetReservations).every(reservation => reservation.status === 'unknown')).toBe(true)
    expect(planTeamSchedule(projection, { maxConcurrency: 2 }).status).toBe('requires_reconciliation')
    await executor.dispose()
  })

  it('releases only a pre-admission reservation after child start fails', async () => {
    const journal = new Journal(budgetEntryEvents(), 'budget-not-admitted')
    const children = new Children()
    children.failures.add('left')
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(budgetRequest(journal.read()), journal, children)
    await expect(result.handles[0]!.admission).rejects.toMatchObject({ code: 'CHILD_ADMISSION_FAILED' })
    await result.handles[1]!.admission
    children.end('right', 'completed', { uncachedInputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })
    await result.handles[1]!.settled
    const projection = replayTeamEvents(journal.read())
    expect(projection.budgetReservations['budget:attempt-left']?.status).toBe('not-admitted')
    expect(projection.budgetReservations['budget:attempt-right']?.status).toBe('known')
    await executor.dispose()
  })

  it('rejects a launch whose durable recovery identity is absent', () => {
    expect(() => requiredRecoveryToken('attempt-missing-token', undefined))
      .toThrow(expect.objectContaining({ code: 'INTENT_PERSISTENCE_FAILED' }))
    expect(requiredRecoveryToken('attempt-token', 'safe_token')).toBe('safe_token')
  })
  it('persists a late terminal event after reconciliation marked active attempts unknown', async () => {
    const journal = new Journal(initialEvents(), 'late-end-after-reconciliation')
    const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))
    expect(executor.hasActiveAttempt(journal.key, 'attempt-left')).toBe(true)
    expect(executor.hasActiveAttempt(journal.key, 'attempt-missing')).toBe(false)
    journal.events.push(
      event(790, { type: 'yuqi/attempt-status-changed', taskId: TaskId('execute-left'), attemptId: AttemptId('attempt-left'), from: 'running', to: 'unknown' }),
      event(791, { type: 'yuqi/attempt-status-changed', taskId: TaskId('execute-right'), attemptId: AttemptId('attempt-right'), from: 'running', to: 'unknown' }),
      event(792, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    )
    children.end('left'); children.end('right')
    await Promise.all(result.handles.map(handle => handle.settled))
    expect(executor.hasActiveAttempt(journal.key, 'attempt-left')).toBe(false)
    const projection = replayTeamEvents(journal.read())
    expect(projection.team.status).toBe('needs_reconciliation')
    expect(projection.attempts['attempt-left']?.status).toBe('completed')
    expect(projection.attempts['attempt-right']?.status).toBe('completed')
    await executor.dispose()
  })

  it('rejects a late terminal event after its task has already reached a terminal state', async () => {
    const journal = new Journal(initialEvents(), 'late-end-after-terminal-task')
    const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))
    journal.events.push(event(793, {
      type: 'yuqi/task-status-changed', taskId: TaskId('execute-left'), from: 'running', to: 'cancelled', reason: 'manually resolved before delayed child event',
    }))
    children.end('left')
    await expect(result.handles[0]!.settled).rejects.toMatchObject({ code: 'SETTLEMENT_PERSISTENCE_FAILED' })
    children.end('right')
    await expect(result.handles[1]!.settled).resolves.toMatchObject({ runId: 'run-right' })
    await executor.dispose()
  })

  it('waits for durable terminal accounting and reports missing or timed-out runtime bindings', async () => {
    const journal = new Journal(initialEvents(), 'cancel-wait')
    const children = new Children()
    const transactions = new DurableJournalCoordinator()
    const clock = new ClockStub(); const ids = new Ids()
    const executor = new TeamBatchExecutor<string>(clock, ids, transactions)
    const controls = new TeamControlCoordinator(clock, ids, transactions)
    expect(await executor.cancelActiveAndWait('missing-controller', 10)).toEqual({ activeCount: 0, outcome: 'failed' })
    const result = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))
    await controls.cancel({ teamId: TEAM_ID, operationId: 'cancel-wait-operation' }, journal)

    const timedOut = await executor.cancelActiveAndWait(journal.key, 10)
    expect(timedOut).toEqual({ activeCount: 2, outcome: 'timeout' })
    expect(children.interrupts).toEqual(['child-left', 'child-right'])

    const settled = executor.cancelActiveAndWait(journal.key, 1_000)
    children.end('left', 'aborted'); children.end('right', 'aborted')
    await expect(settled).resolves.toEqual({ activeCount: 2, outcome: 'settled' })
    await Promise.all(result.handles.map(handle => handle.settled))
    await executor.dispose(); await transactions.dispose()
  })

  it('cancels and waits for one exact attempt without interrupting its sibling', async () => {
    const journal = new Journal(initialEvents(), 'cancel-one')
    const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    expect(await executor.cancelAttemptAndWait('missing-controller', 'missing-attempt', 1)).toEqual({ activeCount: 0, outcome: 'failed' })
    const result = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))
    const left = result.handles.find(handle => handle.taskId === 'execute-left')!
    const timedOut = await executor.cancelAttemptAndWait(journal.key, left.attemptId, 5)
    expect(timedOut).toEqual({ activeCount: 1, outcome: 'timeout' })
    expect(children.interrupts).toEqual(['child-left'])
    const settled = executor.cancelAttemptAndWait(journal.key, left.attemptId, 1_000)
    children.end('left', 'aborted')
    await expect(settled).resolves.toEqual({ activeCount: 1, outcome: 'settled' })
    children.end('right')
    await Promise.allSettled(result.handles.map(handle => handle.settled))
    await executor.dispose()
  })

  it('uses exact-child queue cancellation and still waits for native terminal evidence', async () => {
    const journal = new Journal(initialEvents(), 'cancel-queued')
    const children = new Children()
    const cancel = vi.fn(async (_id: string) => {})
    Object.assign(children, { cancel })
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))
    const left = result.handles.find(handle => handle.taskId === 'execute-left')!
    await expect(executor.cancelAttemptAndWait(journal.key, left.attemptId, 5))
      .resolves.toEqual({ activeCount: 1, outcome: 'timeout' })
    expect(cancel).toHaveBeenCalledWith('child-left')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(children.interrupts).toEqual([])
    cancel.mockRejectedValueOnce(new Error('native cancel rejected'))
    await expect(executor.cancelAttemptAndWait(journal.key, left.attemptId, 100))
      .rejects.toThrow('native cancel rejected')
    children.end('left', 'aborted'); children.end('right')
    await Promise.allSettled(result.handles.map(handle => handle.settled))
    await executor.dispose()
  })

  it('starts queue cancellation on native abort without waiting and reports its failure', async () => {
    const journal = new Journal(initialEvents(), 'abort-queued')
    const children = new Children()
    const failure = new Error('queue cancellation failed')
    const cancel = vi.fn(async () => { throw failure })
    Object.assign(children, { cancel })
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))
    const onFailure = vi.fn()
    expect(executor.cancelActiveInBackground(journal.key, onFailure)).toBe(2)
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith(failure))
    expect(cancel.mock.calls).toEqual([['child-left'], ['child-right']])
    children.end('left', 'aborted'); children.end('right', 'aborted')
    await Promise.allSettled(result.handles.map(handle => handle.settled))
    await executor.dispose()
  })

  it('cancels admitted children and completes Team cancellation after their terminal events', async () => {
    const initial = gatedEvents()
    const journal = new Journal(initial)
    const children = new Children()
    const transactions = new DurableJournalCoordinator()
    const clock = new ClockStub(); const ids = new Ids()
    const executor = new TeamBatchExecutor<string>(clock, ids, transactions)
    const controls = new TeamControlCoordinator(clock, ids, transactions)
    const result = await executor.execute(gatedRequest(initial), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))

    await controls.cancel({ teamId: TEAM_ID, operationId: 'cancel-running' }, journal)
    expect(executor.cancelActive(journal.key)).toBe(2)
    expect(children.interrupts).toEqual(['child-left', 'child-right'])
    children.end('left', 'aborted'); children.end('right', 'aborted')
    await Promise.all(result.handles.map(handle => handle.settled))
    const cancelled = replayTeamEvents(journal.read())
    expect(cancelled.team.status).toBe('cancelled')
    expect(Object.values(cancelled.tasks).every(task => task.status === 'cancelled')).toBe(true)
    await executor.dispose(); await transactions.dispose()
  })

  it('preserves a durable cancel intent after reconciliation and cancels a late completed child', async () => {
    const initial = gatedEvents()
    const journal = new Journal(initial, 'cancel-reconciliation-late-end')
    const children = new Children()
    const ids = new Ids()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), ids)
    const controls = new TeamControlCoordinator(new ClockStub(), ids, new DurableJournalCoordinator())
    const result = await executor.execute(gatedRequest(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))
    await controls.cancel({ teamId: TEAM_ID, operationId: 'cancel-then-reconcile' }, journal)
    journal.events.push(
      event(740, { type: 'yuqi/attempt-status-changed', taskId: TaskId('execute-left'), attemptId: AttemptId('attempt-left'), from: 'running', to: 'unknown' }),
      event(741, { type: 'yuqi/attempt-status-changed', taskId: TaskId('execute-right'), attemptId: AttemptId('attempt-right'), from: 'running', to: 'unknown' }),
      event(742, { type: 'yuqi/team-status-changed', from: 'cancelling', to: 'needs_reconciliation', reason: 'restart scan while cancellation is pending' }),
    )
    children.end('left'); children.end('right')
    await Promise.all(result.handles.map(handle => handle.settled))
    const projection = replayTeamEvents(journal.read())
    expect(projection.team.status).toBe('needs_reconciliation')
    expect(Object.values(projection.tasks).every(task => task.status === 'cancelled')).toBe(true)
    expect(Object.values(projection.fileLeases).every(lease => lease.status === 'released')).toBe(true)
    await executor.dispose()
  })

  it('keeps a durable single-task stop authoritative when the child wins the interrupt race with completed', async () => {
    const initial = gatedEvents()
    const journal = new Journal(initial, 'single-stop-late-completed')
    const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(gatedRequest(initial), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))
    journal.events.push(event(743, {
      type: 'yuqi/task-stop-requested', operationId: ControlOperationId('stop-left'),
      taskId: TaskId('execute-left'), attemptId: AttemptId('attempt-left'),
    }))

    children.end('left', 'completed')
    children.end('right', 'completed')
    await Promise.all(result.handles.map(handle => handle.settled))
    const projection = replayTeamEvents(journal.read())
    expect(projection.tasks[TaskId('execute-left')]?.status).toBe('cancelled')
    expect(projection.tasks[TaskId('execute-right')]?.status).toBe('completed')
    expect(projection.attempts[AttemptId('attempt-left')]?.evidence?.stopReason).toBe('completed')
    await executor.dispose()
  })

  it('waits only for locally owned attempts and removes its abort listener', async () => {
    const journal = new Journal(initialEvents(), 'wait-for-attempts')
    const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))

    const waiting = executor.waitForAttempts(journal.key, ['attempt-left'], new AbortController().signal)
    children.end('left')
    await expect(waiting).resolves.toBeUndefined()
    await expect(executor.waitForAttempts(journal.key, ['missing-attempt'], new AbortController().signal))
      .rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })

    const signal = new AbortController()
    const aborted = executor.waitForAttempts(journal.key, ['attempt-right'], signal.signal)
    const reason = new Error('progress wait cancelled')
    signal.abort(reason)
    await expect(aborted).rejects.toBe(reason)
    children.end('right')
    await result.handles[1]!.settled
    await executor.dispose()
  })

  it('releases a rolling progress wait after the first durable terminal attempt', async () => {
    const journal = new Journal(initialEvents(), 'wait-for-any-attempt')
    const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))

    let completed = false
    const waiting = executor.waitForAnyAttempt(
      journal.key,
      ['attempt-left', 'attempt-right'],
      new AbortController().signal,
    ).then(() => { completed = true })
    children.end('left')
    await waiting
    expect(completed).toBe(true)
    expect(replayTeamEvents(journal.read()).attempts['attempt-left']?.evidence).toBeDefined()
    expect(replayTeamEvents(journal.read()).attempts['attempt-right']?.evidence).toBeUndefined()

    children.end('right')
    await Promise.all(result.handles.map(handle => handle.settled))
    await executor.dispose()
  })

  it('uses a safe default reason when a progress wait is aborted without one', async () => {
    const journal = new Journal(initialEvents(), 'wait-for-attempts-default-abort')
    const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))
    let onAbort!: () => void
    const signal = {
      aborted: false,
      reason: undefined,
      throwIfAborted() {},
      addEventListener(_name: string, listener: () => void) { onAbort = listener },
      removeEventListener() {},
    } as unknown as AbortSignal
    const waiting = executor.waitForAttempts(journal.key, ['attempt-left'], signal)
    onAbort()
    await expect(waiting).rejects.toThrow('Team progress wait aborted')
    children.end('left'); children.end('right')
    await Promise.all(result.handles.map(handle => handle.settled))
    await executor.dispose()
  })

  it('aborts a pre-admission start and records cancellation instead of an admission failure', async () => {
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const initial = gatedEvents()
    const journal = new Journal(initial)
    const children = new Children(); children.startBarrier = barrier
    const transactions = new DurableJournalCoordinator()
    const clock = new ClockStub(); const ids = new Ids()
    const executor = new TeamBatchExecutor<string>(clock, ids, transactions)
    const controls = new TeamControlCoordinator(clock, ids, transactions)
    const result = await executor.execute(gatedRequest(initial), journal, children)

    await controls.cancel({ teamId: TEAM_ID, operationId: 'cancel-before-admission' }, journal)
    expect(executor.cancelActive(journal.key)).toBe(2)
    release()
    await Promise.all(result.handles.map(handle => expect(handle.admission).rejects.toMatchObject({ code: 'CHILD_ADMISSION_FAILED' })))
    const cancelled = replayTeamEvents(journal.read())
    expect(cancelled.team.status).toBe('cancelled')
    expect(Object.values(cancelled.attempts).every(attempt => attempt.status === 'cancelled')).toBe(true)
    expect(Object.values(cancelled.fileLeases).every(lease => lease.status === 'released')).toBe(true)
    expect(executor.cancelActive(journal.key)).toBe(0)
    await executor.dispose(); await transactions.dispose()
  })

  it('interrupts children when admission wins the pre-admission cancellation race', async () => {
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const journal = new Journal(initialEvents())
    const children = new Children(); children.startBarrier = barrier; children.ignoreAbort = true
    const transactions = new DurableJournalCoordinator()
    const clock = new ClockStub(); const ids = new Ids()
    const executor = new TeamBatchExecutor<string>(clock, ids, transactions)
    const controls = new TeamControlCoordinator(clock, ids, transactions)
    const result = await executor.execute(request(journal.read()), journal, children)
    await controls.cancel({ teamId: TEAM_ID, operationId: 'cancel-admission-race' }, journal)
    executor.cancelActive(journal.key)
    release()
    await Promise.all(result.handles.map(handle => handle.admission))
    expect([...children.interrupts].sort()).toEqual(['child-left', 'child-right'])
    children.end('left', 'aborted'); children.end('right', 'aborted')
    await Promise.all(result.handles.map(handle => handle.settled))
    expect(replayTeamEvents(journal.read()).team.status).toBe('cancelled')
    await executor.dispose(); await transactions.dispose()
  })

  it('records reconciliation if an admission-race interrupt is rejected', async () => {
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const journal = new Journal(initialEvents())
    const children = new Children()
    children.startBarrier = barrier; children.ignoreAbort = true; children.interruptFailure = new Error('interrupt rejected')
    const transactions = new DurableJournalCoordinator()
    const clock = new ClockStub(); const ids = new Ids()
    const executor = new TeamBatchExecutor<string>(clock, ids, transactions)
    const controls = new TeamControlCoordinator(clock, ids, transactions)
    const result = await executor.execute(request(journal.read()), journal, children)
    await controls.cancel({ teamId: TEAM_ID, operationId: 'cancel-admission-race-error' }, journal)
    executor.cancelActive(journal.key)
    release()
    await Promise.all(result.handles.map(handle => handle.admission))
    expect(replayTeamEvents(journal.read()).team.status).toBe('needs_reconciliation')
    children.end('left', 'aborted'); children.end('right', 'aborted')
    await Promise.all(result.handles.map(handle => handle.settled))
    await executor.dispose(); await transactions.dispose()
  })

  it('records a disposal-time admission interrupt failure without hiding the runtime error', async () => {
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const journal = new Journal(initialEvents(), 'dispose-admission-interrupt-error')
    const children = new Children()
    children.startBarrier = barrier
    children.ignoreAbort = true
    children.interruptFailure = new Error('dispose interrupt rejected')
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(request(journal.read()), journal, children)
    const disposing = executor.dispose()
    release()
    await expect(result.handles[0]!.admission).resolves.toMatchObject({ childSessionId: 'child-left' })
    await expect(disposing).rejects.toBeInstanceOf(AggregateError)
  })

  it('attempts every interrupt and remains fail-closed when the runtime rejects them', async () => {
    const journal = new Journal(initialEvents())
    const children = new Children()
    const transactions = new DurableJournalCoordinator()
    const clock = new ClockStub(); const ids = new Ids()
    const executor = new TeamBatchExecutor<string>(clock, ids, transactions)
    const controls = new TeamControlCoordinator(clock, ids, transactions)
    const result = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))
    await controls.cancel({ teamId: TEAM_ID, operationId: 'cancel-interrupt-error' }, journal)
    children.interruptFailure = new Error('not authorized')
    expect(() => executor.cancelActive(journal.key)).toThrow(AggregateError)
    expect(children.interrupts).toEqual(['child-left', 'child-right'])
    await controls.markCancellationUncertain(TEAM_ID, journal, 'interrupt rejected')
    children.end('left', 'aborted'); children.end('right', 'aborted')
    await Promise.all(result.handles.map(handle => handle.settled))
    expect(replayTeamEvents(journal.read()).team.status).toBe('needs_reconciliation')
    await executor.dispose(); await transactions.dispose()
  })

  it('treats a completion racing with Team cancellation as cancelled work and releases leases', async () => {
    const initial = gatedEvents()
    const journal = new Journal(initial)
    const children = new Children()
    const transactions = new DurableJournalCoordinator()
    const clock = new ClockStub(); const ids = new Ids()
    const executor = new TeamBatchExecutor<string>(clock, ids, transactions)
    const controls = new TeamControlCoordinator(clock, ids, transactions)
    const result = await executor.execute(gatedRequest(initial), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))
    await controls.cancel({ teamId: TEAM_ID, operationId: 'cancel-completion-race' }, journal)
    executor.cancelActive(journal.key)
    children.end('left', 'completed'); children.end('right', 'completed')
    await Promise.all(result.handles.map(handle => handle.settled))
    const projection = replayTeamEvents(journal.read())
    expect(projection.team.status).toBe('cancelled')
    expect(Object.values(projection.tasks).every(task => task.status === 'cancelled')).toBe(true)
    expect(Object.values(projection.attempts).every(attempt => attempt.status === 'settled')).toBe(true)
    expect(Object.values(projection.fileLeases).every(lease => lease.status === 'released')).toBe(true)
    await executor.dispose(); await transactions.dispose()
  })

  it('completes a pending pause only after the last active child settles', async () => {
    const journal = new Journal(initialEvents())
    const children = new Children()
    const transactions = new DurableJournalCoordinator()
    const clock = new ClockStub()
    const ids = new Ids()
    const executor = new TeamBatchExecutor<string>(clock, ids, transactions)
    const controls = new TeamControlCoordinator(clock, ids, transactions)
    const result = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))

    await controls.pause({ teamId: TEAM_ID, operationId: 'pause-batch' }, journal)
    expect(replayTeamEvents(journal.read()).team.status).toBe('pausing')
    expect(planTeamSchedule(replayTeamEvents(journal.read()), { maxConcurrency: 2 }).status).toBe('inactive')

    children.end('left')
    await result.handles[0]!.settled
    expect(replayTeamEvents(journal.read()).team.status).toBe('pausing')
    children.end('right')
    await result.handles[1]!.settled
    expect(replayTeamEvents(journal.read()).team.status).toBe('paused')
    await executor.dispose()
    await transactions.dispose()
  })

  it.each([3, 4])('durably admits and independently settles %i concurrent children', async count => {
    const initial = capacityEvents(count)
    const journal = new Journal(initial)
    const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())

    const result = await executor.execute(capacityRequest(initial, count), journal, children)
    const admissions = await Promise.all(result.handles.map(handle => handle.admission))
    expect(admissions).toHaveLength(count)
    expect(children.starts).toHaveLength(count)

    for (let index = count - 1; index >= 0; index -= 1) children.end(`capacity-${index}`)
    const settlements = await Promise.all(result.handles.map(handle => handle.settled))
    expect(settlements).toHaveLength(count)
    expect(Object.values(replayTeamEvents(journal.read()).tasks).every(task => task.status === 'completed')).toBe(true)
  })

  it('isolates identical attempt ids owned by different controllers', async () => {
    const leftJournal = new Journal(initialEvents())
    const rightJournal = new Journal(initialEvents(), 'other-controller')
    const leftChildren = new Children()
    const rightChildren = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())

    const [left, right] = await Promise.all([
      executor.execute(request(leftJournal.read()), leftJournal, leftChildren),
      executor.execute(request(rightJournal.read()), rightJournal, rightChildren),
    ])
    await Promise.all([...left.handles, ...right.handles].map(handle => handle.admission))
    leftChildren.end('left'); leftChildren.end('right')
    rightChildren.end('left'); rightChildren.end('right')
    await expect(Promise.all([...left.handles, ...right.handles].map(handle => handle.settled))).resolves.toHaveLength(4)
  })

  it('binds one child runtime before a same-journal concurrent intent can commit', async () => {
    let release!: () => void
    const journal = new Journal(initialEvents(), 'same-journal-runtime')
    journal.barrier = new Promise<void>(resolve => { release = resolve })
    const firstChildren = new Children()
    const secondChildren = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const first = executor.execute(request(journal.read()), journal, firstChildren)
    await expect(executor.execute(request(journal.read()), journal, secondChildren)).rejects.toMatchObject({ code: 'INVALID_BATCH' })
    release()
    const result = await first
    expect(secondChildren.starts).toHaveLength(0)
    await Promise.all(result.handles.map(handle => handle.admission))
    firstChildren.end('left'); firstChildren.end('right')
    await Promise.all(result.handles.map(handle => handle.settled))
    await executor.dispose()
  })

  it('keeps active executions isolated when controller and attempt ids contain delimiter characters', async () => {
    const leftJournal = new Journal(initialEvents(), 'a\u0000b')
    const rightJournal = new Journal(initialEvents(), 'a')
    const leftChildren = new Children(); const rightChildren = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const leftRequest = request(leftJournal.read())
    const rightRequest = request(rightJournal.read())
    const left = await executor.execute({ ...leftRequest, children: leftRequest.children.map((child, index) => index === 0 ? { ...child, attemptId: 'c' } : child) }, leftJournal, leftChildren)
    const right = await executor.execute({ ...rightRequest, children: rightRequest.children.map((child, index) => index === 0 ? { ...child, attemptId: 'b\u0000c' } : child) }, rightJournal, rightChildren)
    await Promise.all([...left.handles, ...right.handles].map(handle => handle.admission))

    leftChildren.end('left')
    await left.handles[0]!.settled
    await executor.dispose()
    await expect(right.handles[0]!.settled).rejects.toMatchObject({ code: 'SERVICE_DISPOSED' })
  })

  it('shares fail-closed durability from batch to legacy single-child dispatch', async () => {
    const transactions = new DurableJournalCoordinator()
    const journal = new Journal(mixedEntryEvents())
    const batchChildren = new Children(); const singleChildren = new Children()
    const batch = new TeamBatchExecutor<string>(new ClockStub(), new Ids(), transactions)
    const single = new OneChildCoordinator<string>(new ClockStub(), new Ids(), transactions)
    const result = await batch.execute(request(journal.read()), journal, batchChildren)
    await Promise.all(result.handles.map(handle => handle.admission))
    journal.failAt = journal.transactions.length + 1
    batchChildren.end('left')
    await expect(result.handles[0]!.settled).rejects.toMatchObject({ code: 'SETTLEMENT_PERSISTENCE_FAILED' })

    await expect(single.dispatch({
      teamId: TEAM_ID, taskId: 'execute-legacy', attemptId: 'legacy-after-poison',
      subagentProvider: 'default', modelProvider: 'p', modelId: 'deepseek-v4',
      label: 'legacy', prompt: 'legacy', signal: new AbortController().signal,
    }, journal, singleChildren)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(singleChildren.starts).toHaveLength(0)
    await Promise.all([batch.dispose(), single.dispose()]); await transactions.dispose()
  })

  it('shares fail-closed durability from legacy single-child dispatch to batch', async () => {
    const transactions = new DurableJournalCoordinator()
    const journal = new Journal(mixedEntryEvents())
    const singleChildren = new Children(); const batchChildren = new Children()
    const single = new OneChildCoordinator<string>(new ClockStub(), new Ids(), transactions)
    const batch = new TeamBatchExecutor<string>(new ClockStub(), new Ids(), transactions)
    const dispatched = await single.dispatch({
      teamId: TEAM_ID, taskId: 'execute-legacy', attemptId: 'legacy-poison',
      subagentProvider: 'default', modelProvider: 'p', modelId: 'deepseek-v4',
      label: 'legacy', prompt: 'legacy', signal: new AbortController().signal,
    }, journal, singleChildren)
    journal.failAt = journal.transactions.length + 1
    singleChildren.end('legacy')
    await expect(dispatched.settled).rejects.toMatchObject({ code: 'SETTLEMENT_PERSISTENCE_FAILED' })

    const plan = planTeamSchedule(replayTeamEvents(journal.read()), { maxConcurrency: 2 })
    await expect(batch.execute({ ...request(journal.read()), plan }, journal, batchChildren)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(batchChildren.starts).toHaveLength(0)
    await Promise.all([batch.dispose(), single.dispose()]); await transactions.dispose()
  })

  it('durably admits two children and settles them independently in reverse order', async () => {
    const journal = new Journal(initialEvents()); const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(request(journal.read()), journal, children)
    expect(children.starts).toHaveLength(2)
    expect(journal.transactions[0]?.every(item => item.type !== 'yuqi/attempt-admitted')).toBe(true)
    await expect(Promise.all(result.handles.map(handle => handle.admission))).resolves.toHaveLength(2)
    children.end('right'); children.end('left', 'completed', { uncachedInputTokens: 20, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 1 })
    const evidence = await Promise.all(result.handles.map(handle => handle.settled))
    expect(evidence.map(item => item.agentSessionId)).toEqual(['child-left', 'child-right'])
    const projection = replayTeamEvents(journal.read())
    expect(projection.tasks['execute-left']?.status).toBe('completed')
    expect(projection.tasks['execute-right']?.status).toBe('completed')
    expect(projection.attempts['attempt-left']?.evidence?.runId).toBe('run-left')
    expect(projection.attempts['attempt-left']?.evidence?.usage).toEqual({ uncachedInputTokens: 20, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 1 })
    expect(projection.attempts['attempt-right']?.evidence?.runId).toBe('run-right')
    expect(projection.team.status).toBe('completed')
    expect(journal.transactions.at(-1)?.at(-1)).toMatchObject({
      type: 'yuqi/team-status-changed', from: 'running', to: 'completed',
    })
  })

  it('isolates one start failure while its sibling completes', async () => {
    const journal = new Journal(initialEvents()); const children = new Children()
    children.failures.add('left')
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(request(journal.read()), journal, children)
    await expect(result.handles[0]!.admission).rejects.toMatchObject({ code: 'CHILD_ADMISSION_FAILED' })
    await expect(result.handles[0]!.settled).rejects.toMatchObject({ code: 'CHILD_ADMISSION_FAILED' })
    await expect(result.handles[1]!.admission).resolves.toMatchObject({ childSessionId: 'child-right' })
    children.end('right')
    await expect(result.handles[1]!.settled).resolves.toMatchObject({ runId: 'run-right' })
    const projection = replayTeamEvents(journal.read())
    expect(projection.tasks['execute-left']?.status).toBe('failed')
    expect(projection.tasks['execute-right']?.status).toBe('completed')
    expect(projection.team.status).toBe('paused')
  })

  it('maps aborted and error settlements to cancelled and failed tasks', async () => {
    const journal = new Journal(initialEvents()); const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))
    children.end('left', 'aborted'); children.end('right', 'error')
    await Promise.all(result.handles.map(handle => handle.settled))
    const projection = replayTeamEvents(journal.read())
    expect(projection.tasks['execute-left']?.status).toBe('cancelled')
    expect(projection.tasks['execute-right']?.status).toBe('failed')
    expect(projection.team.status).toBe('paused')
  })

  it('does not complete a task or Team when a completed child has no assistant output', async () => {
    const journal = new Journal(initialEvents()); const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))
    children.endWithoutOutput('left'); children.end('right')
    await Promise.all(result.handles.map(handle => handle.settled))

    const projection = replayTeamEvents(journal.read())
    expect(projection.attempts['attempt-left']?.evidence).toMatchObject({ stopReason: 'completed', hasAssistantOutput: false })
    expect(projection.tasks['execute-left']?.status).toBe('failed')
    expect(projection.tasks['execute-right']?.status).toBe('completed')
    expect(projection.team.status).toBe('paused')
  })

  it('releases gated file leases on admission failure and non-completed settlement', async () => {
    const admissionJournal = new Journal(gatedEvents()); const admissionChildren = new Children()
    admissionChildren.failures.add('left')
    const admissionExecutor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const admissionResult = await admissionExecutor.execute(gatedRequest(admissionJournal.read()), admissionJournal, admissionChildren)
    await expect(admissionResult.handles[0]!.admission).rejects.toMatchObject({ code: 'CHILD_ADMISSION_FAILED' })
    await admissionResult.handles[1]!.admission
    admissionChildren.end('right', 'aborted')
    await admissionResult.handles[1]!.settled

    const projection = replayTeamEvents(admissionJournal.read())
    expect(projection.fileLeases['lease-0']?.status).toBe('released')
    expect(projection.fileLeases['lease-1']?.status).toBe('released')
  })

  it('rejects settlement when its durability barrier fails', async () => {
    const journal = new Journal(initialEvents()); const children = new Children()
    const clock = new ClockStub(); const ids = new Ids()
    const transactions = new DurableJournalCoordinator()
    const executor = new TeamBatchExecutor<string>(clock, ids, transactions)
    const controls = new TeamControlCoordinator(clock, ids, transactions)
    const result = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))
    await controls.cancel({ teamId: TEAM_ID, operationId: 'settlement-failure-cancel' }, journal)
    journal.failAt = journal.transactions.length + 1
    const terminal = executor.cancelActiveAndWait(journal.key, 1_000)
    children.end('left')
    await expect(result.handles[0]!.settled).rejects.toMatchObject({ code: 'SETTLEMENT_PERSISTENCE_FAILED' })
    await expect(terminal).resolves.toEqual({ activeCount: 2, outcome: 'failed' })
    await executor.dispose(); await transactions.dispose()
  })

  it('fails closed when admission or failure persistence cannot flush', async () => {
    const admissionJournal = new Journal(initialEvents()); const admissionChildren = new Children()
    admissionJournal.failAt = 2
    const admissionExecutor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const admissionResult = await admissionExecutor.execute(request(admissionJournal.read()), admissionJournal, admissionChildren)
    await expect(admissionResult.handles[0]!.admission).rejects.toMatchObject({ code: 'ADMISSION_PERSISTENCE_FAILED' })

    const failureJournal = new Journal(initialEvents()); const failureChildren = new Children()
    failureChildren.failures.add('left'); failureJournal.failAt = 2
    const failureExecutor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const failureResult = await failureExecutor.execute(request(failureJournal.read()), failureJournal, failureChildren)
    await expect(failureResult.handles[0]!.admission).rejects.toBeInstanceOf(AggregateError)
  })

  it('rejects non-runnable follow-up batches and disposes idempotently', async () => {
    const journal = new Journal(initialEvents()); const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))
    await expect(executor.execute(request(initialEvents()), journal, children)).rejects.toMatchObject({ code: 'SCHEDULE_NOT_RUNNABLE' })
    await expect(executor.execute(request(initialEvents()), journal, new Children())).rejects.toMatchObject({ code: 'INVALID_BATCH' })
    const disposal = executor.dispose()
    expect(executor.dispose()).toBe(disposal)
    await disposal
    expect(children.interrupts).toEqual(['child-left', 'child-right'])
    await expect(executor.execute(request(initialEvents()), new Journal(initialEvents()), new Children())).rejects.toMatchObject({ code: 'SERVICE_DISPOSED' })
    await expect(Promise.all(result.handles.map(handle => handle.settled))).rejects.toMatchObject({ code: 'SERVICE_DISPOSED' })
  })

  it('keeps the admitted runtime binding when disposal cannot interrupt a child', async () => {
    const journal = new Journal(initialEvents(), 'dispose-interrupt-failure')
    const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(request(journal.read()), journal, children)
    await Promise.all(result.handles.map(handle => handle.admission))

    children.interruptFailure = new Error('runtime rejected dispose interrupt')
    await expect(executor.dispose()).rejects.toBeInstanceOf(AggregateError)
    expect(children.interrupts).toEqual(['child-left', 'child-right'])
    expect(executor.hasActiveAttempt(journal.key, 'attempt-left')).toBe(true)
    expect(executor.hasActiveAttempt(journal.key, 'attempt-right')).toBe(true)

    children.interruptFailure = undefined
    await executor.dispose()
    await expect(Promise.all(result.handles.map(handle => handle.settled))).rejects.toMatchObject({ code: 'SERVICE_DISPOSED' })
    expect(executor.hasActiveAttempt(journal.key, 'attempt-left')).toBe(false)
    expect(executor.hasActiveAttempt(journal.key, 'attempt-right')).toBe(false)
  })

  it('does not retain a child source when intent validation rejects before launch', async () => {
    const journal = new Journal(initialEvents())
    const rejectedChildren = new Children(); const acceptedChildren = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const invalid = request(journal.read())
    const stale = { ...invalid, plan: { ...invalid.plan, sourceLastEventId: 'stale-event' as never } }

    await expect(executor.execute(stale, journal, rejectedChildren)).rejects.toMatchObject({ code: 'STALE_SCHEDULE' })
    expect(rejectedChildren.starts).toHaveLength(0)
    const result = await executor.execute(request(journal.read()), journal, acceptedChildren)
    await Promise.all(result.handles.map(handle => handle.admission))
    acceptedChildren.end('left'); acceptedChildren.end('right')
    await expect(Promise.all(result.handles.map(handle => handle.settled))).resolves.toHaveLength(2)
  })

  it('reuses one active Controller router across multiple scheduling waves', async () => {
    const initial = capacityEvents(3)
    const journal = new Journal(initial)
    const children = new Children()
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const signal = new AbortController().signal
    const childFor = (taskId: string, ordinal: number) => ({
      taskId, attemptId: `wave-attempt-${ordinal}`, modelProvider: 'p', modelId: 'deepseek-v4',
      subagentProvider: 'default', label: taskId, prompt: taskId, signal,
    })

    const firstPlan = planTeamSchedule(replayTeamEvents(journal.read()), { maxConcurrency: 2 })
    const first = await executor.execute({
      teamId: TEAM_ID, plan: firstPlan, maxConcurrency: 2,
      children: firstPlan.dispatchTaskIds.map((taskId, index) => childFor(taskId, index)),
    }, journal, children)
    await Promise.all(first.handles.map(handle => handle.admission))
    children.end('capacity-0')
    await first.handles[0]!.settled

    const secondPlan = planTeamSchedule(replayTeamEvents(journal.read()), { maxConcurrency: 2 })
    const second = await executor.execute({
      teamId: TEAM_ID, plan: secondPlan, maxConcurrency: 2,
      children: secondPlan.dispatchTaskIds.map((taskId, index) => childFor(taskId, index + 2)),
    }, journal, children)
    await Promise.all(second.handles.map(handle => handle.admission))
    children.end('capacity-2'); children.end('capacity-1')
    await Promise.all([second.handles[0]!.settled, first.handles[1]!.settled])
    expect(Object.values(replayTeamEvents(journal.read()).tasks).every(task => task.status === 'completed')).toBe(true)
  })

  it('fails closed when early ends overflow before admission', async () => {
    const journal = new Journal(initialEvents()); const children = new Children(); children.overflowOnStart = true
    const executor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await executor.execute(request(journal.read()), journal, children)
    await expect(result.handles[0]!.admission).rejects.toMatchObject({ code: 'EARLY_END_OVERFLOW' })
  })

  it('handles disposal during intent persistence and while starts are in flight', async () => {
    let releaseIntent!: () => void
    const intentBarrier = new Promise<void>(resolve => { releaseIntent = resolve })
    const intentJournal = new Journal(initialEvents()); intentJournal.barrier = intentBarrier
    const intentExecutor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const executing = intentExecutor.execute(request(intentJournal.read()), intentJournal, new Children())
    const disposal = intentExecutor.dispose(); releaseIntent()
    await expect(executing).rejects.toMatchObject({ code: 'SERVICE_DISPOSED' })
    await disposal

    let releaseStart!: () => void
    const startBarrier = new Promise<void>(resolve => { releaseStart = resolve })
    const startJournal = new Journal(initialEvents()); const children = new Children(); children.startBarrier = startBarrier
    const startExecutor = new TeamBatchExecutor<string>(new ClockStub(), new Ids())
    const result = await startExecutor.execute(request(startJournal.read()), startJournal, children)
    const draining = startExecutor.dispose(); releaseStart()
    await draining
    await expect(Promise.all(result.handles.map(handle => handle.admission))).rejects.toMatchObject({ code: 'SERVICE_DISPOSED' })
  })
})
