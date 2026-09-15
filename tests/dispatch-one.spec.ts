import { describe, expect, it } from 'vitest'
import { replayTeamEvents, YuqiOrchestratorError } from '../src/index.ts'
import { OneChildCoordinator } from '../src/application/dispatch-one.ts'
import type {
  ChildEnd,
  ChildStartRequest,
  ContinuableChildPort,
  TeamEvent,
  TeamEventJournal,
} from '../src/index.ts'
import { ATTEMPT_ID, completeTeamEvents, event, TASK_ID } from './fixtures.ts'

class FakeClock {
  #tick = 0

  nowIso(): string {
    this.#tick += 1
    return `2026-08-15T01:00:${String(this.#tick).padStart(2, '0')}Z`
  }
}

class FakeIds {
  #next = 0

  next(): string {
    this.#next += 1
    return `dispatch-event-${this.#next}`
  }
}

class FakeJournal implements TeamEventJournal {
  readonly key: string
  readonly events: unknown[]
  failOnCommit = Number.POSITIVE_INFINITY
  onAppend?: (event: TeamEvent) => void
  beforeCommit?: (events: readonly TeamEvent[]) => Promise<void> | void
  #commits = 0

  constructor(key = 'controller-1', seed: readonly unknown[] = completeTeamEvents().slice(0, 5)) {
    this.key = key
    this.events = [...seed]
  }

  read(): readonly unknown[] {
    return this.events
  }

  async commit(events: readonly TeamEvent[]): Promise<void> {
    this.#commits += 1
    await this.beforeCommit?.(events)
    if (this.#commits === this.failOnCommit) throw new Error(`commit ${this.#commits} failed`)
    this.events.push(...events)
    for (const event of events) this.onAppend?.(event)
  }
}

class FakeChildren implements ContinuableChildPort<readonly string[]> {
  readonly starts: ChildStartRequest<readonly string[]>[] = []
  readonly listeners = new Set<(event: ChildEnd) => void>()
  admission = { childSessionId: 'child-1', messageId: 'message-1' }
  startError: unknown
  beforeResolve?: () => void
  startGate?: Promise<void>
  respectAbort = false

  async start(request: ChildStartRequest<readonly string[]>) {
    this.starts.push(request)
    if (this.startError !== undefined) throw this.startError
    if (this.startGate !== undefined) {
      if (this.respectAbort) {
        await Promise.race([
          this.startGate,
          new Promise<never>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })),
        ])
      } else {
        await this.startGate
      }
    }
    this.beforeResolve?.()
    return this.admission
  }

  onEnd(listener: (event: ChildEnd) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  end(event: Partial<ChildEnd> = {}): void {
    const complete: ChildEnd = {
      runId: 'run-1',
      provider: 'in-process',
      childSessionId: 'child-1',
      stopReason: 'completed',
      hasAssistantOutput: true,
      ...event,
    }
    for (const listener of [...this.listeners]) listener(complete)
  }
}

function request(overrides: Partial<Parameters<OneChildCoordinator<readonly string[]>['dispatch']>[0]> = {}) {
  return {
    teamId: 'team-1',
    taskId: 'task-1',
    attemptId: 'attempt-new',
    subagentProvider: 'in-process',
    modelProvider: 'deepseek',
    modelId: 'deepseek-v4',
    label: 'implement slice',
    prompt: ['do work'] as const,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function coordinator(): OneChildCoordinator<readonly string[]> {
  return new OneChildCoordinator(new FakeClock(), new FakeIds())
}

describe('OneChildCoordinator', () => {
  it('keeps explicit blocked results out of verification on the compatibility entry', async () => {
    const service = coordinator(); const journal = new FakeJournal(); const children = new FakeChildren()
    const result = await service.dispatch(request({ taskOutcomeVersion: 1 }), journal, children)
    const taskOutcome = { status: 'reported' as const, outcome: { version: 1 as const, kind: 'blocked' as const, summary: 'missing input', nextAction: 'ask controller' } }
    children.end({ taskOutcome })
    await expect(result.settled).resolves.toMatchObject({ taskOutcome })
    const projection = replayTeamEvents(journal.events)
    expect(projection.tasks['task-1']?.status).toBe('blocked')
    expect(projection.attempts['attempt-new']?.evidence?.taskOutcome).toEqual(taskOutcome)
    await service.dispose()
  })
  it('persists intent, admission, running state, terminal state, and evidence in order', async () => {
    const service = coordinator()
    const journal = new FakeJournal()
    const children = new FakeChildren()

    const result = await service.dispatch(request(), journal, children)
    expect(result).toMatchObject({ attemptId: 'attempt-new', childSessionId: 'child-1', messageId: 'message-1' })
    expect(children.starts[0]).toEqual(expect.objectContaining({ subagentProvider: 'in-process', label: 'yuqi:v1:dispatch-event-1:implement slice', modelProvider: 'deepseek', modelId: 'deepseek-v4', maxDepth: 1 }))
    expect(journal.events.slice(-3).map(item => (item as TeamEvent).type)).toEqual([
      'yuqi/attempt-created',
      'yuqi/attempt-admitted',
      'yuqi/attempt-status-changed',
    ])

    children.end({ usage: { uncachedInputTokens: 10, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 } })
    await expect(result.settled).resolves.toMatchObject({ runId: 'run-1', stopReason: 'completed', hasAssistantOutput: true })
    const state = replayTeamEvents(journal.events)
    expect(state.attempts['attempt-new']).toMatchObject({
      status: 'settled',
      agentSessionId: 'child-1',
      messageId: 'message-1',
      evidence: {
        provider: 'in-process',
        stopReason: 'completed',
        usage: { uncachedInputTokens: 10, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 },
      },
    })
    expect(state.tasks['task-1']?.status).toBe('verifying')
    expect(children.listeners.size).toBe(0)
  })

  it('keeps structured durable route evidence identical to children.start arguments', async () => {
    const service = coordinator()
    const journal = new FakeJournal()
    const children = new FakeChildren()
    const catalogEvidence = [{ model: { modelProvider: 'external', modelId: 'model-x' }, metadataResolved: true, routable: true }]

    await service.dispatch(request({
      modelProvider: 'external', modelId: 'model-x',
      route: { modelProvider: 'external', modelId: 'model-x' }, routeBasis: 'task-exact', catalogEvidence,
    }), journal, children)

    expect(children.starts[0]).toMatchObject({ modelProvider: 'external', modelId: 'model-x' })
    expect(replayTeamEvents(journal.events).attempts['attempt-new']).toMatchObject({
      route: { modelProvider: 'external', modelId: 'model-x' }, routeBasis: 'task-exact', catalogEvidence,
    })
  })

  it('fails closed before side effects when its event-id source cannot provide a recovery token', async () => {
    const journal = new FakeJournal()
    const children = new FakeChildren()
    const service = new OneChildCoordinator(new FakeClock(), { next: () => 'unsafe:token' })
    await expect(service.dispatch(request(), journal, children)).rejects.toMatchObject({ code: 'INVALID_BATCH' })
    expect(children.starts).toEqual([])
    expect(journal.events).toHaveLength(5)
  })

  it('buffers a matching child end emitted before start returns and ignores unrelated ends', async () => {
    const service = coordinator()
    const journal = new FakeJournal()
    const children = new FakeChildren()
    children.beforeResolve = () => {
      children.end({ childSessionId: 'unrelated', runId: 'run-other' })
      children.end()
    }

    const result = await service.dispatch(request(), journal, children)
    await expect(result.settled).resolves.toMatchObject({ runId: 'run-1' })
    expect(replayTeamEvents(journal.events).attempts['attempt-new']?.evidence?.agentSessionId).toBe('child-1')
  })

  it('fails closed instead of returning a permanently pending settlement after early-end overflow', async () => {
    const service = coordinator()
    const journal = new FakeJournal()
    const children = new FakeChildren()
    children.beforeResolve = () => {
      for (let index = 0; index < 129; index += 1) children.end({ childSessionId: `other-${index}`, runId: `other-run-${index}` })
      children.end()
    }
    await expect(service.dispatch(request(), journal, children)).rejects.toMatchObject({ code: 'EARLY_END_OVERFLOW' })
    await expect(service.dispatch(request({ attemptId: 'attempt-2' }), journal, children)).rejects.toMatchObject({ code: 'CONTROLLER_BUSY' })
  })

  it('retains a matching early end even when later unrelated ends overflow the buffer', async () => {
    const service = coordinator()
    const journal = new FakeJournal()
    const children = new FakeChildren()
    children.beforeResolve = () => {
      children.end()
      for (let index = 0; index < 128; index += 1) children.end({ childSessionId: `other-${index}`, runId: `other-run-${index}` })
    }
    const result = await service.dispatch(request(), journal, children)
    await expect(result.settled).resolves.toMatchObject({ agentSessionId: 'child-1' })
  })

  it('defers a reentrant end until admission and running facts are both committed', async () => {
    const service = coordinator()
    const journal = new FakeJournal()
    const children = new FakeChildren()
    journal.onAppend = (item) => {
      if (item.type === 'yuqi/attempt-admitted') children.end()
    }
    const result = await service.dispatch(request(), journal, children)
    await expect(result.settled).resolves.toMatchObject({ runId: 'run-1' })
    expect(journal.events.slice(-6).map(item => (item as TeamEvent).type)).toEqual([
      'yuqi/attempt-created',
      'yuqi/attempt-admitted',
      'yuqi/attempt-status-changed',
      'yuqi/attempt-status-changed',
      'yuqi/attempt-evidence-recorded',
      'yuqi/task-status-changed',
    ])
  })

  it.each([
    ['aborted', 'cancelled'],
    ['error', 'failed'],
    ['max-tokens', 'failed'],
  ] as const)('maps %s settlement to %s', async (stopReason, expected) => {
    const service = coordinator()
    const journal = new FakeJournal()
    const children = new FakeChildren()
    const result = await service.dispatch(request(), journal, children)
    children.end({ stopReason, hasAssistantOutput: false })
    await result.settled
    expect(replayTeamEvents(journal.events).attempts['attempt-new']?.status).toBe(expected)
  })

  it('ignores unrelated and duplicate end events', async () => {
    const service = coordinator()
    const journal = new FakeJournal()
    const children = new FakeChildren()
    const result = await service.dispatch(request(), journal, children)
    children.end({ childSessionId: 'other' })
    expect(journal.events).toHaveLength(8)
    children.end()
    children.end({ runId: 'duplicate' })
    await result.settled
    expect(journal.events).toHaveLength(11)
  })

  it('rejects another dispatch while the controller has an active child and allows one after settlement', async () => {
    const service = coordinator()
    const journal = new FakeJournal()
    const children = new FakeChildren()
    const first = await service.dispatch(request(), journal, children)
    await expect(service.dispatch(request({ attemptId: 'attempt-2' }), journal, children)).rejects.toMatchObject({ code: 'CONTROLLER_BUSY' })
    children.end({ stopReason: 'error' })
    await first.settled

    children.admission = { childSessionId: 'child-2', messageId: 'message-2' }
    const second = await service.dispatch(request({ attemptId: 'attempt-2' }), journal, children)
    expect(second.childSessionId).toBe('child-2')
  })

  it('rejects a mismatched Team and a task that is not running without side effects', async () => {
    const service = coordinator()
    const children = new FakeChildren()
    await expect(service.dispatch(request({ teamId: 'other' }), new FakeJournal(), children)).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    await expect(service.dispatch(request({ taskId: 'missing' }), new FakeJournal(), children)).rejects.toMatchObject({ code: 'TASK_NOT_RUNNABLE' })
    await expect(service.dispatch(request(), new FakeJournal('draft', completeTeamEvents().slice(0, 4)), children)).rejects.toMatchObject({ code: 'TASK_NOT_RUNNABLE' })
    expect(children.starts).toHaveLength(0)
  })

  it('does not start the child until the intent durability barrier completes', async () => {
    const service = coordinator()
    const journal = new FakeJournal()
    const children = new FakeChildren()
    const barrier = Promise.withResolvers<void>()
    journal.beforeCommit = events => events[0]?.type === 'yuqi/attempt-created' ? barrier.promise : undefined

    const pending = service.dispatch(request(), journal, children)
    await Promise.resolve()
    expect(children.starts).toHaveLength(0)
    barrier.resolve()
    const result = await pending
    expect(children.starts).toHaveLength(1)
    await service.dispose()
    await expect(result.settled).rejects.toMatchObject({ code: 'SERVICE_DISPOSED' })
  })

  it('fails the durable intent without starting a child when dispose happens during its checkpoint', async () => {
    const service = coordinator()
    const journal = new FakeJournal()
    const children = new FakeChildren()
    const barrier = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    journal.beforeCommit = events => {
      if (events[0]?.type !== 'yuqi/attempt-created') return
      entered.resolve()
      return barrier.promise
    }

    const dispatch = service.dispatch(request(), journal, children)
    await entered.promise
    const disposal = service.dispose()
    barrier.resolve()
    await expect(dispatch).rejects.toMatchObject({ code: 'SERVICE_DISPOSED' })
    await disposal
    expect(children.starts).toHaveLength(0)
    expect(replayTeamEvents(journal.events).attempts['attempt-new']?.status).toBe('failed')
  })

  it('does not return admission until the admission durability barrier completes', async () => {
    const service = coordinator()
    const journal = new FakeJournal()
    const children = new FakeChildren()
    const barrier = Promise.withResolvers<void>()
    let returned = false
    journal.beforeCommit = events => events[0]?.type === 'yuqi/attempt-admitted' ? barrier.promise : undefined

    const pending = service.dispatch(request(), journal, children).then(result => { returned = true; return result })
    while (children.starts.length === 0) await Promise.resolve()
    expect(children.starts).toHaveLength(1)
    expect(returned).toBe(false)
    barrier.resolve()
    const result = await pending
    expect(returned).toBe(true)
    await service.dispose()
    await expect(result.settled).rejects.toMatchObject({ code: 'SERVICE_DISPOSED' })
  })

  it.each([
    ['intent-only', completeTeamEvents().slice(0, 6)],
    ['admitted-running', completeTeamEvents().slice(0, 8)],
    ['admitted-terminal-without-evidence', completeTeamEvents().slice(0, 9)],
    ['settled-with-evidence-before-task-verifying', completeTeamEvents().slice(0, 10)],
  ])('fails closed after restart for %s attempt state', async (_name, seed) => {
    const children = new FakeChildren()
    await expect(coordinator().dispatch(request({ attemptId: 'attempt-2' }), new FakeJournal('restart', seed), children)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(children.starts).toHaveLength(0)
  })

  it('rejects a Team requiring reconciliation after restart', async () => {
    const seed = [
      ...completeTeamEvents().slice(0, 5),
      event(90, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ]
    const children = new FakeChildren()
    await expect(coordinator().dispatch(request(), new FakeJournal('restart-team', seed), children)).rejects.toMatchObject({ code: 'TEAM_NOT_RUNNING' })
    expect(children.starts).toHaveLength(0)
  })

  it('rejects a duplicate attempt id before journal or child side effects', async () => {
    const seed = [
      ...completeTeamEvents().slice(0, 5),
      event(91, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId: ATTEMPT_ID, ordinal: 1, modelProvider: 'p', modelId: 'm' }),
      event(92, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'dispatching', to: 'failed' }),
    ]
    const journal = new FakeJournal('duplicate-attempt', seed)
    const children = new FakeChildren()
    await expect(coordinator().dispatch(request({ attemptId: 'attempt-1' }), journal, children)).rejects.toMatchObject({ code: 'ENTITY_ALREADY_EXISTS' })
    expect(journal.events).toEqual(seed)
    expect(children.starts).toHaveLength(0)
  })

  it('records a failed attempt when admission rejects', async () => {
    const service = coordinator()
    const journal = new FakeJournal()
    const children = new FakeChildren()
    children.startError = new Error('provider unavailable')
    await expect(service.dispatch(request(), journal, children)).rejects.toMatchObject({ code: 'CHILD_ADMISSION_FAILED' })
    expect(replayTeamEvents(journal.events).attempts['attempt-new']?.status).toBe('failed')
    expect(children.listeners.size).toBe(0)
  })

  it('returns both failures when admission and failure persistence reject', async () => {
    const journal = new FakeJournal()
    journal.failOnCommit = 2
    const children = new FakeChildren()
    children.startError = new Error('provider unavailable')
    await expect(coordinator().dispatch(request(), journal, children)).rejects.toBeInstanceOf(AggregateError)
    expect(children.listeners.size).toBe(0)
  })

  it('does not start a child when intent persistence fails', async () => {
    const journal = new FakeJournal()
    journal.failOnCommit = 1
    const children = new FakeChildren()
    await expect(coordinator().dispatch(request(), journal, children)).rejects.toMatchObject({ code: 'INTENT_PERSISTENCE_FAILED' })
    expect(children.starts).toHaveLength(0)
    expect(children.listeners.size).toBe(0)
  })

  it('locks the controller for reconciliation when admission persistence fails', async () => {
    const service = coordinator()
    const journal = new FakeJournal()
    journal.failOnCommit = 2
    const children = new FakeChildren()
    await expect(service.dispatch(request(), journal, children)).rejects.toMatchObject({ code: 'ADMISSION_PERSISTENCE_FAILED' })
    await expect(service.dispatch(request({ attemptId: 'attempt-2' }), journal, children)).rejects.toMatchObject({ code: 'CONTROLLER_BUSY' })
    expect(children.starts).toHaveLength(1)
  })

  it('rejects the settlement promise and locks the controller if terminal persistence fails', async () => {
    const service = coordinator()
    const journal = new FakeJournal()
    journal.failOnCommit = 3
    const children = new FakeChildren()
    const result = await service.dispatch(request(), journal, children)
    children.end()
    await expect(result.settled).rejects.toMatchObject({ code: 'SETTLEMENT_PERSISTENCE_FAILED' })
    await expect(service.dispatch(request({ attemptId: 'attempt-2' }), journal, children)).rejects.toMatchObject({ code: 'CONTROLLER_BUSY' })
  })

  it('disposes idempotently, rejects pending settlement, and blocks future dispatch', async () => {
    const service = coordinator()
    const journal = new FakeJournal()
    const children = new FakeChildren()
    const result = await service.dispatch(request(), journal, children)
    await service.dispose()
    await service.dispose()
    await expect(result.settled).rejects.toBeInstanceOf(YuqiOrchestratorError)
    expect(children.listeners.size).toBe(0)
    await expect(service.dispatch(request({ attemptId: 'attempt-2' }), journal, children)).rejects.toMatchObject({ code: 'SERVICE_DISPOSED' })
  })

  it('cancels an in-flight pre-admission start and durably records failure on dispose', async () => {
    const service = coordinator()
    const journal = new FakeJournal()
    const children = new FakeChildren()
    children.startGate = new Promise<void>(() => undefined)
    children.respectAbort = true
    const dispatch = service.dispatch(request(), journal, children)
    while (children.starts.length === 0) await Promise.resolve()
    const disposal = service.dispose()

    await expect(dispatch).rejects.toMatchObject({ code: 'SERVICE_DISPOSED' })
    await disposal
    const attempt = replayTeamEvents(journal.events).attempts['attempt-new']!
    expect(attempt.status).toBe('failed')
    expect(attempt.agentSessionId).toBeUndefined()
  })

  it('records an accepted child for reconciliation when admission wins the dispose race', async () => {
    const service = coordinator()
    const journal = new FakeJournal()
    const children = new FakeChildren()
    const gate = Promise.withResolvers<void>()
    children.startGate = gate.promise
    const dispatch = service.dispatch(request(), journal, children)
    while (children.starts.length === 0) await Promise.resolve()
    const disposal = service.dispose()
    gate.resolve()

    await expect(dispatch).rejects.toMatchObject({ code: 'SERVICE_DISPOSED' })
    await disposal
    expect(replayTeamEvents(journal.events).attempts['attempt-new']).toMatchObject({ status: 'running', agentSessionId: 'child-1' })
  })

  it('waits for an already-started settlement transaction during dispose', async () => {
    const service = coordinator()
    const journal = new FakeJournal()
    const children = new FakeChildren()
    const barrier = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    journal.beforeCommit = events => {
      if (events[0]?.type !== 'yuqi/attempt-status-changed' || events[0].from !== 'running') return
      entered.resolve()
      return barrier.promise
    }
    const result = await service.dispatch(request(), journal, children)
    children.end()
    await entered.promise
    let disposed = false
    const disposal = service.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    barrier.resolve()
    await expect(result.settled).resolves.toMatchObject({ agentSessionId: 'child-1' })
    await disposal
    expect(disposed).toBe(true)
  })

  it('drains a buffered settlement that starts after dispose begins', async () => {
    const service = coordinator()
    const journal = new FakeJournal()
    const children = new FakeChildren()
    const admissionBarrier = Promise.withResolvers<void>()
    const settlementBarrier = Promise.withResolvers<void>()
    const admissionEntered = Promise.withResolvers<void>()
    const settlementEntered = Promise.withResolvers<void>()
    children.beforeResolve = () => { children.end() }
    journal.beforeCommit = events => {
      if (events[0]?.type === 'yuqi/attempt-admitted') {
        admissionEntered.resolve()
        return admissionBarrier.promise
      }
      if (events[0]?.type === 'yuqi/attempt-status-changed' && events[0].from === 'running') {
        settlementEntered.resolve()
        return settlementBarrier.promise
      }
    }

    const dispatch = service.dispatch(request(), journal, children)
    await admissionEntered.promise
    let disposed = false
    const disposal = service.dispose().then(() => { disposed = true })
    admissionBarrier.resolve()
    await settlementEntered.promise
    await expect(dispatch).rejects.toMatchObject({ code: 'SERVICE_DISPOSED' })
    await Promise.resolve()
    expect(disposed).toBe(false)
    settlementBarrier.resolve()
    await disposal
    expect(disposed).toBe(true)
    const state = replayTeamEvents(journal.events)
    expect(state.attempts['attempt-new']?.evidence?.agentSessionId).toBe('child-1')
    expect(state.tasks['task-1']?.status).toBe('verifying')
  })
})
