import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { snapshotSubagentDescriptor, SubagentRunId } from '@deepseek-ai/dsh-subagent'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { describe, expect, it, vi } from 'vitest'
import type { TeamEvent, TeamEventJournal } from '../src/index.ts'
import { AttemptId, parseTeamEvent, replayTeamEvents, TaskId } from '../src/index.ts'
import { YuqiOrchestratorError } from '../src/application/errors.ts'
import { HarnessTeamProgressAdapter, loadInactiveTerminalFact } from '../src/host/harness/progress-adapter.ts'
import type { HarnessObservedChildEnd, HarnessProgressSettlementRequest } from '../src/host/harness/progress-adapter.ts'
import { completeTeamEvents, contract, event } from './fixtures.ts'

class Journal implements TeamEventJournal {
  readonly key = 'progress-adapter-journal'
  readonly events: TeamEvent[]

  constructor(events: readonly TeamEvent[]) {
    this.events = [...events]
  }

  read(): readonly unknown[] {
    return this.events
  }

  async commit(events: readonly TeamEvent[]): Promise<void> {
    this.events.push(...events)
  }
}

function activeJournal(): Journal {
  return new Journal(completeTeamEvents().slice(0, 8))
}

function controller(ctx: Context): Agent {
  return { id: SessionId('controller-1'), ctx, options: {} } as unknown as Agent
}

function runningChildContext(): Context {
  const ctx = new Context()
  ctx.provide('subagents', {
    async listChildren() {
      return [{ kind: 'child' as const, id: SessionId('session-worker-1'), activity: 'running' as const, hasChildren: false, mode: 'continuable' as const }]
    },
  } as never)
  return ctx
}

function settle(request: HarnessProgressSettlementRequest): Promise<void> {
  const end = request.end
  return request.journal.commit([
    event(100, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'running', to: 'settled' }),
    event(101, {
      type: 'yuqi/attempt-evidence-recorded', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'),
      runId: end.runId, agentSessionId: end.childSessionId, provider: end.provider,
      stopReason: end.stopReason, hasAssistantOutput: end.hasAssistantOutput,
      ...(end.usage === undefined ? {} : { usage: end.usage }),
      settledAt: end.settledAt ?? '2026-08-16T00:00:00.000Z',
    }),
    event(102, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'verifying' }),
  ])
}

function emitEnd(ctx: Context, controllerAgent: Agent, lastAssistantMessage: boolean, childId = 'session-worker-1'): void {
  const emitScoped = ctx.emit as unknown as (target: object, name: string, payload: object) => void
  emitScoped(scopeTarget(ctx.subagents, controllerAgent), 'subagent/end', {
    runId: SubagentRunId('run-restarted'),
    provider: 'in-process',
    id: SessionId(childId),
    local: true,
    stopReason: 'completed',
    ...(lastAssistantMessage ? { lastAssistantMessage: [{ type: 'text', text: 'done' }] } : {}),
  })
}

function terminalChild(options: { readonly descriptor?: boolean; readonly messageId?: string; readonly assistant?: boolean; readonly reason?: string } = {}): Session {
  const child = Session.create(SessionId('session-worker-1'))
  if (options.descriptor !== false) {
    child.append('subagent/descriptor', snapshotSubagentDescriptor({ mode: 'continuable', provider: 'in-process', label: 'worker' }))
  }
  child.append('turn/start', { turn: 1 })
  if (options.messageId !== undefined) {
    child.append('user/message', freezeMessage({
      id: MessageId(options.messageId), role: 'user', content: [{ type: 'text', text: 'work' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  if (options.assistant !== false) {
    child.append('assistant/message', {
      turn: 1,
      step: 0,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: { provider: 'in-process', model: 'deepseek-v4' } }),
    }, { surfaceOp: 'append' })
  }
  child.append('turn/end', { turn: 1, reason: { kind: options.reason ?? 'completed' } } as never)
  return child
}

function inactiveContext(child: Session, mode: 'continuable' | 'one-shot' = 'continuable'): Context {
  const ctx = new Context()
  ctx.provide('subagents', {
    async listChildren() {
      return [{ kind: 'child' as const, id: child.id, activity: 'inactive' as const, hasChildren: false, mode }]
    },
  } as never)
  return ctx
}

describe('Harness Team progress adapter', () => {
  it('returns a persisted end without waiting for a stalled catalog and cancels that read', async () => {
    const ctx = new Context()
    const owner = controller(ctx)
    let readSignal: AbortSignal | undefined
    ctx.provide('subagents', {
      listChildren(_id: SessionId, signal: AbortSignal) {
        readSignal = signal
        return new Promise<never>(() => {})
      },
    } as never)
    const journal = activeJournal()
    const adapter = new HarnessTeamProgressAdapter(ctx, {
      controller: owner, waitForLocalAttempts: async () => {}, settleAttempt: settle,
    })
    const progress = adapter.waitForProgress({ teamId: 'team-1', journal, activeTaskIds: ['task-1'], signal: new AbortController().signal })
    emitEnd(ctx, owner, true)
    let timer!: ReturnType<typeof setTimeout>
    try {
      await expect(Promise.race([
        progress.then(() => 'settled'),
        new Promise<string>(resolve => { timer = setTimeout(() => resolve('still waiting for catalog'), 500) }),
      ])).resolves.toBe('settled')
    } finally { clearTimeout(timer) }
    expect(readSignal?.aborted).toBe(true)
    expect(replayTeamEvents(journal.read()).attempts['attempt-1']?.evidence).toBeDefined()
  })

  it('cancels a stalled catalog promptly without settling a later child event', async () => {
    const ctx = new Context()
    const owner = controller(ctx)
    let readSignal: AbortSignal | undefined
    ctx.provide('subagents', {
      listChildren(_id: SessionId, signal: AbortSignal) {
        readSignal = signal
        return new Promise<never>(() => {})
      },
    } as never)
    const journal = activeJournal()
    const adapter = new HarnessTeamProgressAdapter(ctx, {
      controller: owner, waitForLocalAttempts: async () => {}, settleAttempt: settle,
    })
    const abort = new AbortController()
    const progress = adapter.waitForProgress({ teamId: 'team-1', journal, activeTaskIds: ['task-1'], signal: abort.signal })
    abort.abort(new Error('user stopped waiting'))
    await expect(progress).rejects.toThrow('user stopped waiting')
    emitEnd(ctx, owner, true)
    expect(readSignal?.aborted).toBe(true)
    expect(replayTeamEvents(journal.read()).attempts['attempt-1']?.evidence).toBeUndefined()
  })

  it('defers a warm public end without usage to the owned direct settlement, even while the catalog stalls', async () => {
    const ctx = new Context()
    const owner = controller(ctx)
    let readSignal: AbortSignal | undefined
    let settlePublic = 0
    let settleDirect!: () => void
    const directSettled = new Promise<void>(resolve => { settleDirect = resolve })
    ctx.provide('subagents', {
      listChildren(_id: SessionId, signal: AbortSignal) {
        readSignal = signal
        return new Promise<never>(() => {})
      },
    } as never)
    const journal = activeJournal()
    const usage = { uncachedInputTokens: 9, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 0 }
    const adapter = new HarnessTeamProgressAdapter(ctx, {
      controller: owner,
      ownsLocalAttempt: () => true,
      waitForLocalAttempts: async () => {
        await directSettled
        await settle({ teamId: 'team-1', taskId: 'task-1', attemptId: 'attempt-1', journal, end: {
          runId: 'run-direct', provider: 'in-process', childSessionId: 'session-worker-1',
          stopReason: 'completed', hasAssistantOutput: true, usage,
        } })
      },
      settleAttempt: async () => { settlePublic += 1 },
    })
    const progress = adapter.waitForProgress({ teamId: 'team-1', journal, activeTaskIds: ['task-1'], signal: new AbortController().signal })
    emitEnd(ctx, owner, true)
    await Promise.resolve()
    expect(settlePublic).toBe(0)
    settleDirect()
    await progress
    expect(readSignal?.aborted).toBe(true)
    expect(settlePublic).toBe(0)
    expect(replayTeamEvents(journal.read()).attempts['attempt-1']?.evidence?.usage).toEqual(usage)
  })

  it('surfaces an owned direct-settlement persistence failure without public fallback', async () => {
    const ctx = new Context()
    const owner = controller(ctx)
    let rejectDirect!: (reason: unknown) => void
    const direct = new Promise<void>((_resolve, reject) => { rejectDirect = reject })
    let publicSettlements = 0
    ctx.provide('subagents', { listChildren: () => new Promise<never>(() => {}) } as never)
    const adapter = new HarnessTeamProgressAdapter(ctx, {
      controller: owner, ownsLocalAttempt: () => true,
      waitForLocalAttempts: () => direct,
      settleAttempt: async () => { publicSettlements += 1 },
    })
    const progress = adapter.waitForProgress({ teamId: 'team-1', journal: activeJournal(), activeTaskIds: ['task-1'], signal: new AbortController().signal })
    emitEnd(ctx, owner, true)
    rejectDirect(new Error('direct settlement persistence failed'))
    await expect(progress).rejects.toThrow('direct settlement persistence failed')
    emitEnd(ctx, owner, true)
    expect(publicSettlements).toBe(0)
  })

  it('cancels a warm-owned wait and removes its public end listener', async () => {
    const ctx = new Context()
    const owner = controller(ctx)
    let waits = 0
    let publicSettlements = 0
    ctx.provide('subagents', { listChildren: () => new Promise<never>(() => {}) } as never)
    const adapter = new HarnessTeamProgressAdapter(ctx, {
      controller: owner, ownsLocalAttempt: () => true,
      waitForLocalAttempts: (_journalKey, _attemptIds, signal) => {
        waits += 1
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      },
      settleAttempt: async () => { publicSettlements += 1 },
    })
    const abort = new AbortController()
    const progress = adapter.waitForProgress({ teamId: 'team-1', journal: activeJournal(), activeTaskIds: ['task-1'], signal: abort.signal })
    await Promise.resolve()
    abort.abort(new Error('owned progress cancelled'))
    await expect(progress).rejects.toThrow('owned progress cancelled')
    emitEnd(ctx, owner, true)
    expect(waits).toBe(1)
    expect(publicSettlements).toBe(0)
  })

  it('cancels an owned observation wait when a separate cold attempt advances progress', async () => {
    const ctx = new Context()
    const owner = controller(ctx)
    let ownedWaitSignal: AbortSignal | undefined
    const journal = new Journal([
      ...activeJournal().events,
      event(20, { type: 'yuqi/task-created', contract: contract(TaskId('task-2')) }),
      event(21, { type: 'yuqi/task-status-changed', taskId: TaskId('task-2'), from: 'pending', to: 'ready' }),
      event(22, { type: 'yuqi/task-status-changed', taskId: TaskId('task-2'), from: 'ready', to: 'running' }),
      event(23, { type: 'yuqi/attempt-created', taskId: TaskId('task-2'), attemptId: AttemptId('attempt-2'), ordinal: 1, modelProvider: 'deepseek', modelId: 'deepseek-v4' }),
      event(24, { type: 'yuqi/attempt-admitted', taskId: TaskId('task-2'), attemptId: AttemptId('attempt-2'), agentSessionId: 'session-worker-2', messageId: 'message-2' }),
      event(25, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-2'), attemptId: AttemptId('attempt-2'), from: 'dispatching', to: 'running' }),
    ])
    ctx.provide('subagents', { async listChildren() {
      return [{ kind: 'child' as const, id: SessionId('session-worker-1'), activity: 'running' as const, hasChildren: false, mode: 'continuable' as const }]
    } } as never)
    const adapter = new HarnessTeamProgressAdapter(ctx, {
      controller: owner,
      ownsLocalAttempt: (_key, attemptId) => attemptId === 'attempt-2',
      waitForLocalAttempts: async () => {},
      waitForAnyLocalAttempt: (_key, attemptIds, signal) => {
        if (attemptIds.includes('attempt-2')) {
          ownedWaitSignal = signal
          return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
        }
        return Promise.resolve()
      },
      settleAttempt: settle,
    })
    const progress = adapter.waitForProgress({ teamId: 'team-1', journal, activeTaskIds: ['task-1', 'task-2'], signal: new AbortController().signal })
    emitEnd(ctx, owner, true)
    await progress
    expect(ownedWaitSignal?.aborted).toBe(true)
  })

  it.each(['none', 'usage-only', 'whitespace'] as const)('reads the admitted turn with Host final-output semantics (%s), not earlier success or later follow-up', async tail => {
    const ctx = new Context()
    const child = Session.create(SessionId('session-worker-1'))
    child.append('subagent/descriptor', snapshotSubagentDescriptor({ mode: 'continuable', provider: 'in-process', label: 'worker' }))
    child.append('turn/start', { turn: 1 })
    child.append('user/message', freezeMessage({ id: MessageId('message-1'), role: 'user', content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const report = (turn: number, step: number, text: string) => child.append('assistant/message', {
      turn, step, message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'in-process', model: 'deepseek-v4' } }),
    }, { surfaceOp: 'append' })
    report(1, 0, 'YUQI_TASK_OUTCOME: {"version":1,"kind":"completed","summary":"premature"}')
    report(1, 1, 'YUQI_TASK_OUTCOME: {"version":1,"kind":"blocked","summary":"missing input","nextAction":"ask controller"}')
    if (tail === 'usage-only') child.append('assistant/message', {
      turn: 1, step: 2, message: createAssistantMessage({ content: [], source: { provider: 'in-process', model: 'deepseek-v4' } }),
      usage: { inputTokens: 1, outputTokens: 1 },
    }, { surfaceOp: 'append' })
    if (tail === 'whitespace') report(1, 2, '   ')
    child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    child.append('turn/start', { turn: 2 })
    report(2, 0, 'YUQI_TASK_OUTCOME: {"version":1,"kind":"completed","summary":"unrelated follow-up"}')
    child.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    ctx.provide('subagents', { async listChildren() { return [{ kind: 'child', id: child.id, activity: 'inactive', hasChildren: false, mode: 'continuable' }] } } as never)
    ctx.provide('sessionPersistence', { async load() { return { meta: child.header, events: child.events } } } as never)
    const journal = activeJournal()
    let recovered: HarnessObservedChildEnd | undefined
    const adapter = new HarnessTeamProgressAdapter(ctx, {
      controller: controller(ctx), waitForLocalAttempts: async () => {},
      settleAttempt: async request => { recovered = request.end; await settle(request) },
    })
    await adapter.waitForProgress({ teamId: 'team-1', journal, activeTaskIds: ['task-1'], signal: new AbortController().signal })
    expect(recovered?.runId).toBe('recovered:session-worker-1:1')
    expect(recovered?.taskOutcome).toMatchObject(tail === 'whitespace' ? { status: 'missing' } : { status: 'reported', outcome: { kind: 'blocked', summary: 'missing input' } })
    expect(recovered?.hasAssistantOutput).toBe(tail !== 'whitespace')
  })
  it('waits for the public child end signal and settles the same child only once', async () => {
    const ctx = runningChildContext()
    const journal = activeJournal()
    let settlements = 0
    const adapter = new HarnessTeamProgressAdapter(ctx, {
      controller: controller(ctx),
      waitForLocalAttempts: async () => {},
      settleAttempt: async request => {
        settlements += 1
        await settle(request)
      },
    })
    const progress = adapter.waitForProgress({
      teamId: 'team-1', journal, activeTaskIds: ['task-1'], signal: new AbortController().signal,
    })
    await Promise.resolve()
    emitEnd(ctx, controller(ctx), false, 'unrelated-child')
    emitEnd(ctx, controller(ctx), true)
    emitEnd(ctx, controller(ctx), true)
    await progress
    expect(settlements).toBe(1)
    expect(replayTeamEvents(journal.read()).attempts['attempt-1']?.evidence).toMatchObject({
      runId: 'run-restarted', provider: 'in-process', hasAssistantOutput: true,
    })
  })

  it('recovers a cold inactive continuable child from its exact terminal Session turn', async () => {
    const ctx = new Context()
    const child = Session.create(SessionId('session-worker-1'))
    child.append('subagent/descriptor', snapshotSubagentDescriptor({ mode: 'continuable', provider: 'in-process', label: 'worker' }))
    child.append('turn/start', { turn: 1 })
    child.append('user/message', freezeMessage({
      id: MessageId('message-1'), role: 'user', content: [{ type: 'text', text: 'work' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    child.append('assistant/message', {
      turn: 1,
      step: 0,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: { provider: 'in-process', model: 'deepseek-v4' } }),
      usage: { inputTokens: 4, outputTokens: 2 },
    }, { surfaceOp: 'append' })
    child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    ctx.provide('subagents', {
      async listChildren() {
        return [{ kind: 'child' as const, id: child.id, activity: 'inactive' as const, hasChildren: false, mode: 'continuable' as const }]
      },
    } as never)
    ctx.provide('sessionPersistence', {
      async load() { return { meta: child.header, events: child.events } },
    } as never)
    const journal = activeJournal()
    let recovered: HarnessObservedChildEnd | undefined
    const adapter = new HarnessTeamProgressAdapter(ctx, {
      controller: controller(ctx),
      waitForLocalAttempts: async () => {},
      settleAttempt: async request => { recovered = request.end; await settle(request) },
    })
    await adapter.waitForProgress({
      teamId: 'team-1', journal, activeTaskIds: ['task-1'], signal: new AbortController().signal,
    })
    expect(recovered).toMatchObject({
      runId: 'recovered:session-worker-1:1', provider: 'in-process', stopReason: 'completed', hasAssistantOutput: true,
      usage: { uncachedInputTokens: 4, outputTokens: 2 },
    })
  })

  it('recovers an exact inactive terminal fact through open-only persistence and closes the read handle', async () => {
    const child = terminalChild({ messageId: 'message-1' })
    const ctx = inactiveContext(child)
    let opens = 0
    let closes = 0
    ctx.provide('sessionPersistence', {
      async open() {
        opens += 1
        return {
          header: child.header,
          async read() { return { events: child.events } },
          async close() { closes += 1 },
        }
      },
    } as never)

    await expect(loadInactiveTerminalFact(ctx, {
      childSessionId: 'session-worker-1', messageId: 'message-1',
    }, new AbortController().signal)).resolves.toMatchObject({
      runId: 'recovered:session-worker-1:1', provider: 'in-process', stopReason: 'completed', hasAssistantOutput: true,
    })
    expect(opens).toBe(1)
    expect(closes).toBe(1)
  })

  it('recovers an exact inactive terminal fact through inspect-only persistence', async () => {
    const child = terminalChild({ messageId: 'message-1' })
    const ctx = inactiveContext(child)
    let inspections = 0
    ctx.provide('sessionPersistence', {
      async inspect() {
        inspections += 1
        return { meta: child.header, events: child.events }
      },
    } as never)

    await expect(loadInactiveTerminalFact(ctx, {
      childSessionId: 'session-worker-1', messageId: 'message-1',
    }, new AbortController().signal)).resolves.toMatchObject({
      runId: 'recovered:session-worker-1:1', provider: 'in-process', stopReason: 'completed', hasAssistantOutput: true,
    })
    expect(inspections).toBe(1)
  })

  it('does not fall through to another persistence API after the selected read fails', async () => {
    const child = terminalChild({ messageId: 'message-1' })
    const ctx = inactiveContext(child)
    const load = vi.fn(async () => ({ meta: child.header, events: child.events }))
    ctx.provide('sessionPersistence', {
      async inspect() { throw new Error('inspect unavailable') },
      load,
    } as never)

    await expect(loadInactiveTerminalFact(ctx, {
      childSessionId: 'session-worker-1', messageId: 'message-1',
    }, new AbortController().signal)).resolves.toBeUndefined()
    expect(load).not.toHaveBeenCalled()
  })

  it('rejects a malformed open-read result and still closes the handle exactly once', async () => {
    const child = terminalChild({ messageId: 'message-1' })
    const ctx = inactiveContext(child)
    let closes = 0
    ctx.provide('sessionPersistence', {
      async open() {
        return {
          header: child.header,
          async read() { return { events: 'not-an-event-array' } },
          async close() { closes += 1 },
        }
      },
    } as never)

    await expect(loadInactiveTerminalFact(ctx, {
      childSessionId: 'session-worker-1', messageId: 'message-1',
    }, new AbortController().signal)).resolves.toBeUndefined()
    expect(closes).toBe(1)
  })

  it('closes an open-only persistence handle when reading its terminal fact fails', async () => {
    const child = terminalChild({ messageId: 'message-1' })
    const ctx = inactiveContext(child)
    let closes = 0
    ctx.provide('sessionPersistence', {
      async open() {
        return {
          header: child.header,
          async read() { throw new Error('read failed') },
          async close() { closes += 1 },
        }
      },
    } as never)

    await expect(loadInactiveTerminalFact(ctx, {
      childSessionId: 'session-worker-1', messageId: 'message-1',
    }, new AbortController().signal)).resolves.toBeUndefined()
    expect(closes).toBe(1)
  })

  it('invokes a synchronously throwing read-handle close exactly once', async () => {
    const child = terminalChild({ messageId: 'message-1' })
    const ctx = inactiveContext(child)
    let closes = 0
    ctx.provide('sessionPersistence', {
      async open() {
        return {
          header: child.header,
          async read() { return { events: child.events } },
          close() { closes += 1; throw new Error('close failed') },
        }
      },
    } as never)

    await expect(loadInactiveTerminalFact(ctx, {
      childSessionId: 'session-worker-1', messageId: 'message-1',
    }, new AbortController().signal)).resolves.toBeUndefined()
    expect(closes).toBe(1)
  })

  it('closes an open-only persistence handle when its read exceeds the terminal-fact timeout', async () => {
    const child = terminalChild({ messageId: 'message-1' })
    const ctx = inactiveContext(child)
    let closes = 0
    ctx.provide('sessionPersistence', {
      async open() {
        return {
          header: child.header,
          read: () => new Promise<never>(() => {}),
          async close() { closes += 1 },
        }
      },
    } as never)

    await expect(loadInactiveTerminalFact(ctx, {
      childSessionId: 'session-worker-1', messageId: 'message-1',
    }, new AbortController().signal, 10)).resolves.toBeUndefined()
    expect(closes).toBe(1)
  })

  it('closes a read handle that arrives after the terminal-fact timeout exactly once', async () => {
    const child = terminalChild({ messageId: 'message-1' })
    const ctx = inactiveContext(child)
    const opening = Promise.withResolvers<unknown>()
    let closes = 0
    ctx.provide('sessionPersistence', { open: () => opening.promise } as never)

    await expect(loadInactiveTerminalFact(ctx, {
      childSessionId: 'session-worker-1', messageId: 'message-1',
    }, new AbortController().signal, 10)).resolves.toBeUndefined()
    opening.resolve({
      header: child.header,
      async read() { return { events: child.events } },
      async close() { closes += 1 },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(closes).toBe(1)
  })

  it.each([
    ['aborted', 'aborted'],
    ['interrupted', 'aborted'],
    ['max-tokens', 'max-tokens'],
    ['blocked', 'refusal'],
    ['error', 'error'],
    ['future-reason', 'error'],
  ])('maps a recovered %s turn to the stable stop reason %s', async (reason, expected) => {
    const child = terminalChild({ messageId: 'message-1', reason })
    const ctx = inactiveContext(child)
    ctx.provide('sessionPersistence', { async load() { return { meta: child.header, events: child.events } } } as never)
    let recovered: HarnessObservedChildEnd | undefined
    const adapter = new HarnessTeamProgressAdapter(ctx, {
      controller: controller(ctx), waitForLocalAttempts: async () => {},
      settleAttempt: async request => { recovered = request.end; throw new Error('captured stop reason') },
    })
    await expect(adapter.waitForProgress({
      teamId: 'team-1', journal: activeJournal(), activeTaskIds: ['task-1'], signal: new AbortController().signal,
    })).rejects.toThrow('captured stop reason')
    expect(recovered?.stopReason).toBe(expected)
  })

  it('reconciles missing children but keeps a silent active child alive across heartbeats', async () => {
    const missing = new Context()
    missing.provide('subagents', { async listChildren() { return [] } } as never)
    let missingReconciliations = 0
    const missingAdapter = new HarnessTeamProgressAdapter(missing, {
      controller: controller(missing), waitForLocalAttempts: async () => {}, settleAttempt: async () => {},
      reconcile: async () => { missingReconciliations += 1 },
    })
    await expect(missingAdapter.waitForProgress({
      teamId: 'team-1', journal: activeJournal(), activeTaskIds: ['task-1'], signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(missingReconciliations).toBe(1)

    const silent = runningChildContext()
    let timeoutReconciliations = 0
    const abort = new AbortController()
    const silentAdapter = new HarnessTeamProgressAdapter(silent, {
      controller: controller(silent), waitForLocalAttempts: async () => {}, settleAttempt: async () => {}, timeoutMs: 10,
      reconcile: async () => { timeoutReconciliations += 1 },
    })
    const waiting = silentAdapter.waitForProgress({
      teamId: 'team-1', journal: activeJournal(), activeTaskIds: ['task-1'], signal: abort.signal,
    })
    await new Promise(resolve => setTimeout(resolve, 35))
    expect(timeoutReconciliations).toBe(0)
    abort.abort(new Error('heartbeat test complete'))
    await expect(waiting).rejects.toThrow('heartbeat test complete')
  })

  it('propagates cancellation while the bounded wait is in flight', async () => {
    const ctx = runningChildContext()
    const abort = new AbortController()
    const adapter = new HarnessTeamProgressAdapter(ctx, {
      controller: controller(ctx), waitForLocalAttempts: async () => {}, settleAttempt: async () => {}, timeoutMs: 300_000,
    })
    const progress = adapter.waitForProgress({ teamId: 'team-1', journal: activeJournal(), activeTaskIds: ['task-1'], signal: abort.signal })
    await Promise.resolve()
    abort.abort(new Error('test cancellation'))
    await expect(progress).rejects.toThrow('test cancellation')
  })

  it('escalates a local reconciliation result immediately instead of waiting for the timeout', async () => {
    const ctx = runningChildContext()
    let reconciled = 0
    const adapter = new HarnessTeamProgressAdapter(ctx, {
      controller: controller(ctx),
      waitForLocalAttempts: async () => {
        throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', 'local runtime no longer owns the child')
      },
      settleAttempt: async () => {},
      reconcile: async () => { reconciled += 1 },
      timeoutMs: 30_000,
    })

    await expect(adapter.waitForProgress({
      teamId: 'team-1', journal: activeJournal(), activeTaskIds: ['task-1'], signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(reconciled).toBe(1)
  })

  it('propagates a non-reconciliation local wait failure without converting it to a Team fact', async () => {
    const ctx = runningChildContext()
    const adapter = new HarnessTeamProgressAdapter(ctx, {
      controller: controller(ctx),
      waitForLocalAttempts: async () => { throw new Error('local wait failed') },
      settleAttempt: async () => {},
    })
    await expect(adapter.waitForProgress({
      teamId: 'team-1', journal: activeJournal(), activeTaskIds: ['task-1'], signal: new AbortController().signal,
    })).rejects.toThrow('local wait failed')
  })

  it('rejects an active task without a durable attempt binding', async () => {
    const ctx = runningChildContext()
    const adapter = new HarnessTeamProgressAdapter(ctx, {
      controller: controller(ctx), waitForLocalAttempts: async () => {}, settleAttempt: async () => {},
    })
    await expect(adapter.waitForProgress({
      teamId: 'team-1', journal: activeJournal(), activeTaskIds: ['missing-task'], signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
  })

  it('settles an end observed during the initial child catalog read', async () => {
    const ctx = new Context()
    const owner = controller(ctx)
    ctx.provide('subagents', {
      async listChildren() {
        emitEnd(ctx, owner, true)
        return [{ kind: 'child' as const, id: SessionId('session-worker-1'), activity: 'running' as const, hasChildren: false, mode: 'continuable' as const }]
      },
    } as never)
    const journal = activeJournal()
    const adapter = new HarnessTeamProgressAdapter(ctx, {
      controller: owner, waitForLocalAttempts: async () => {}, settleAttempt: settle,
    })
    await adapter.waitForProgress({
      teamId: 'team-1', journal, activeTaskIds: ['task-1'], signal: new AbortController().signal,
    })
    expect(replayTeamEvents(journal.read()).attempts['attempt-1']?.evidence).toBeDefined()
  })

  it('fails closed for unproven inactive facts, invalid bindings, and invalid bounds', async () => {
    const cases: readonly [string, Context][] = [
      ['no persistence', inactiveContext(terminalChild())],
      ['undefined load', inactiveContext(terminalChild())],
      ['wrong session metadata', inactiveContext(terminalChild())],
      ['missing exact message', inactiveContext(terminalChild({ messageId: 'other-message' }))],
      ['missing descriptor', inactiveContext(terminalChild({ descriptor: false, messageId: 'message-1' }))],
      ['one-shot child', inactiveContext(terminalChild(), 'one-shot')],
    ]
    cases[1]![1].provide('sessionPersistence', { async load() { return undefined } } as never)
    const wrongSession = terminalChild()
    cases[2]![1].provide('sessionPersistence', { async load() { return { meta: { ...wrongSession.header, id: SessionId('other-session') }, events: wrongSession.events } } } as never)
    cases[3]![1].provide('sessionPersistence', { async load() { const child = terminalChild({ messageId: 'other-message' }); return { meta: child.header, events: child.events } } } as never)
    cases[4]![1].provide('sessionPersistence', { async load() { const child = terminalChild({ descriptor: false, messageId: 'message-1' }); return { meta: child.header, events: child.events } } } as never)
    for (const [label, ctx] of cases) {
      const adapter = new HarnessTeamProgressAdapter(ctx, {
        controller: controller(ctx), waitForLocalAttempts: async () => {}, settleAttempt: async () => {},
      })
      await expect(adapter.waitForProgress({
        teamId: 'team-1', journal: activeJournal(), activeTaskIds: ['task-1'], signal: new AbortController().signal,
      }), label).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    }

    const invalidBinding = new HarnessTeamProgressAdapter(runningChildContext(), {
      controller: controller(runningChildContext()), waitForLocalAttempts: async () => {}, settleAttempt: async () => {},
    })
    await expect(invalidBinding.waitForProgress({
      teamId: 'wrong-team', journal: activeJournal(), activeTaskIds: ['task-1'], signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })

    const invalidTimeout = new HarnessTeamProgressAdapter(runningChildContext(), {
      controller: controller(runningChildContext()), waitForLocalAttempts: async () => {}, settleAttempt: async () => {}, timeoutMs: 1,
    })
    await expect(invalidTimeout.waitForProgress({
      teamId: 'team-1', journal: activeJournal(), activeTaskIds: ['task-1'], signal: new AbortController().signal,
    })).rejects.toThrow(/timeoutMs/)
  })

  it('bounds cold Session loading and does not infer a terminal fact from malformed time', async () => {
    const stalled = inactiveContext(terminalChild())
    stalled.provide('sessionPersistence', { load: () => new Promise<never>(() => {}) } as never)
    const stalledReconciliations: string[] = []
    const stalledAdapter = new HarnessTeamProgressAdapter(stalled, {
      controller: controller(stalled), waitForLocalAttempts: async () => {}, settleAttempt: async () => {}, timeoutMs: 10,
      reconcile: async request => { stalledReconciliations.push(request.reason) },
    })
    await expect(stalledAdapter.waitForProgress({
      teamId: 'team-1', journal: activeJournal(), activeTaskIds: ['task-1'], signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(stalledReconciliations).toHaveLength(1)

    const malformedChild = terminalChild()
    const malformedEvents = malformedChild.events.map(item => item.type === 'turn/end' ? { ...item, time: Number.NaN } : item)
    const malformed = inactiveContext(malformedChild)
    malformed.provide('sessionPersistence', { async load() { return { meta: malformedChild.header, events: malformedEvents } } } as never)
    const malformedAdapter = new HarnessTeamProgressAdapter(malformed, {
      controller: controller(malformed), waitForLocalAttempts: async () => {}, settleAttempt: async () => {},
    })
    await expect(malformedAdapter.waitForProgress({
      teamId: 'team-1', journal: activeJournal(), activeTaskIds: ['task-1'], signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
  })
})
