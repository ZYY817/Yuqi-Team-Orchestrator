import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { YuqiOrchestratorError, replayTeamEvents, type ReviewOutcome, type TeamEvent } from '../src/index.ts'
import {
  createYuqiCommandDefinition,
  executeYuqiCommand,
  registerYuqiCommand,
  registerYuqiControllerCommand,
  type YuqiCommandService,
} from '../src/host/harness/commands.ts'
import { TEAM_PARENT_BINDING_EVENT, TEAM_PARENT_PROJECTION_EVENT, TEAM_SESSION_EVENT } from '../src/host/harness/session-journal.ts'
import { completeTeamEvents, contract, event, verificationOperationEvents } from './fixtures.ts'

type RecoverAndContinueTeam = NonNullable<YuqiCommandService['recoverAndContinueTeam']>
type RebindTeam = NonNullable<YuqiCommandService['rebindTeam']>

function agentWith(events: readonly TeamEvent[] = completeTeamEvents().slice(0, 8)): Agent {
  const id = SessionId(`command-agent-${Math.random()}`)
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd: process.cwd() })
  for (const fact of events) session.append(TEAM_SESSION_EVENT, { event: fact })
  return { id: session.id, session } as unknown as Agent
}

function agentWithBatch(events: readonly TeamEvent[]): Agent {
  const id = SessionId(`command-batch-agent-${Math.random()}`)
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd: process.cwd() })
  session.append(TEAM_SESSION_EVENT, { events: [...events] })
  return { id: session.id, session } as unknown as Agent
}

function agentWithCwd(cwd: string | undefined): Agent {
  const id = SessionId(`command-cwd-agent-${Math.random()}`)
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd: process.cwd() })
  for (const fact of completeTeamEvents().slice(0, 8)) session.append(TEAM_SESSION_EVENT, { event: fact })
  const header = { ...session.header }
  if (cwd === undefined) delete header.cwd
  else header.cwd = cwd
  return { id: session.id, session: { header, events: session.events } } as unknown as Agent
}

function invocation(agent: Agent, rawInput: string, commandId = 'cmd-test') {
  return {
    agent,
    rawInput,
    attachments: [],
    commandId: CommandId(commandId),
    signal: new AbortController().signal,
  }
}

function serviceFor(events: readonly TeamEvent[] = completeTeamEvents().slice(0, 8)) {
  const projection = replayTeamEvents(events)
  const project = {
    schemaVersion: 1 as const,
    overallProgress: '当前进度', architectureDecisions: [], pitfalls: [], conventions: [], documentLinks: [],
    updatedAt: '2026-08-16T00:00:00.000Z',
  }
  return {
    pauseTeam: vi.fn(async () => projection),
    resumeTeam: vi.fn(async () => projection),
    cancelTeam: vi.fn(async () => projection),
    retryTask: vi.fn(async () => projection),
    stopTask: vi.fn(async () => projection),
    setTaskModel: vi.fn(async () => projection),
    setTaskAuthority: vi.fn(async () => projection),
    sendTaskMessage: vi.fn(async (_request: unknown) => ({ childSessionId: 'session-worker-1', messageId: 'message-1' })),
    reconcileTeam: vi.fn(async () => projection),
    clearTeamRecovery: vi.fn(async () => projection),
    resolveAttempt: vi.fn(async () => projection),
    readProjectSummary: vi.fn(async () => project),
    updateProjectSummary: vi.fn(async (_root: string, patch: Record<string, unknown>) => ({ ...project, ...patch })),
    recordProjectSummary: vi.fn(async () => undefined),
    reviewTeam: vi.fn(async (): Promise<ReviewOutcome> => ({ status: 'completed' as const, result: {
      reviewId: 'review-command', trigger: 'user-request' as const, reviewerSessionId: 'reviewer', decision: 'pass' as const,
      findings: [], unverified: [],
    } })),
    decideReview: vi.fn(async () => projection),
  } satisfies YuqiCommandService
}

describe('Yuqi Host command bridge', () => {
  it('registers one private-input command only when the command registry exists', async () => {
    const ctx = new Context()
    const service = serviceFor()
    let definition: ReturnType<typeof createYuqiCommandDefinition> | undefined
    ctx.provide('commands', { register(value: typeof definition) { definition = value } } as never)
    registerYuqiCommand(ctx, service)
    await vi.waitFor(() => expect(definition).toMatchObject({
      name: 'yuqi', recordInput: false, input: { hint: expect.stringContaining('pause') },
    }))
    expect(await definition!.handler(invocation(agentWith(), ''))).toMatchObject({ kind: 'success' })
  })

  it('uses the optional Host agent registry to resolve identity-bound commands', async () => {
    const ctx = new Context()
    const service = serviceFor()
    const controller = agentWith()
    const parent = agentWith([])
    parent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(controller.id), sourceEventCount: 8, events: completeTeamEvents().slice(0, 8),
    })
    let definition: ReturnType<typeof createYuqiCommandDefinition> | undefined
    ctx.provide('commands', { register(value: typeof definition) { definition = value } } as never)
    ctx.provide('agents', { get: vi.fn((id: SessionId) => String(id) === String(controller.id) ? controller : undefined) } as never)
    registerYuqiCommand(ctx, service)
    await vi.waitFor(() => expect(definition).toBeDefined())

    await expect(definition!.handler(invocation(
      parent,
      `pause team-1 ${String(controller.id)} registry-route`,
    ))).resolves.toEqual({ kind: 'success', text: expect.stringContaining('暂停') })
    expect(service.pauseTeam).toHaveBeenCalledWith(expect.objectContaining({ controller, teamId: 'team-1' }))
  })

  it('registers the controller-local command only when the optional Host service exists', async () => {
    const service = serviceFor()
    const ctx = new Context()
    const controller = agentWith()
    const parent = agentWith([])
    parent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(controller.id), sourceEventCount: 8, events: completeTeamEvents().slice(0, 8),
    })
    let definition: ReturnType<typeof createYuqiCommandDefinition> | undefined
    ctx.provide('commands', { register(value: typeof definition) { definition = value } } as never)
    ctx.provide('yuqiTeamOrchestrator' as never, service as never)
    ctx.provide('agents', { get: (id: SessionId) => String(id) === String(controller.id) ? controller : undefined } as never)
    registerYuqiControllerCommand(ctx)
    await vi.waitFor(() => expect(definition).toMatchObject({ name: 'yuqi', recordInput: false }))
    await expect(definition!.handler(invocation(
      parent, `pause team-1 ${String(controller.id)} controller-registry-route`,
    ))).resolves.toEqual({ kind: 'success', text: expect.stringContaining('暂停') })

    const missing = new Context()
    let missingCalls = 0
    missing.provide('commands', { register: () => { missingCalls += 1 } } as never)
    missing.provide('yuqiTeamOrchestrator' as never, undefined as never)
    missing.provide('agents', { get: () => undefined } as never)
    registerYuqiControllerCommand(missing)
    await Promise.resolve()
    expect(missingCalls).toBe(0)
  })

  it('reports only real Team facts and rejects a Session without Team facts', async () => {
    const service = serviceFor()
    await expect(executeYuqiCommand(invocation(agentWith(), ''), service)).resolves.toEqual({
      kind: 'success', text: expect.stringMatching(/Yuqi Team：Yuqi Team[\s\S]*状态：running[\s\S]*0\/1 已完成，1 进行中/u),
    })
    await expect(executeYuqiCommand(invocation(agentWith([]), ''), service)).resolves.toEqual({
      kind: 'error', text: '当前会话没有可用的 Yuqi Team。',
    })
  })

  it('routes a task model change with exact task, model, and operation identity', async () => {
    const service = serviceFor()
    await expect(executeYuqiCommand(invocation(agentWith(), 'model task-1 deepseek deepseek-v4-pro model-op'), service))
      .resolves.toEqual({ kind: 'success', text: expect.stringContaining('新 attempt') })
    expect(service.setTaskModel).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-1', taskId: 'task-1', providerId: 'deepseek', modelId: 'deepseek-v4-pro', operationId: 'ui-v1:model-op',
    }))
    await expect(executeYuqiCommand(invocation(agentWith(), 'model task-1'), service))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('/yuqi model') })
  })

  it('routes a single-task stop with exact durable identity', async () => {
    const service = serviceFor()
    await expect(executeYuqiCommand(invocation(agentWith(), 'stop task-1 stop-op'), service))
      .resolves.toEqual({ kind: 'success', text: expect.stringContaining('其他独立任务不受影响') })
    expect(service.stopTask).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-1', taskId: 'task-1', operationId: 'ui-v1:stop-op',
    }))
    const { stopTask: _stopTask, ...olderHost } = serviceFor()
    await expect(executeYuqiCommand(invocation(agentWith(), 'stop task-1 stop-op'), olderHost))
      .resolves.toEqual({ kind: 'error', text: '当前 Host 未启用单个子代理停止。' })
  })

  it('routes a UTF-8 follow-up through the controller to all running children', async () => {
    const service = serviceFor()
    const payload = Buffer.from('完成后只向主控汇报。', 'utf8').toString('base64url')
    await expect(executeYuqiCommand(invocation(agentWith(), `message all ${payload} message-op`), service))
      .resolves.toEqual({ kind: 'success', text: expect.stringContaining('1 个运行中的子代理') })
    expect(service.sendTaskMessage).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-1', taskId: 'task-1', message: '完成后只向主控汇报。',
    }))
  })

  it('rejects an invalid or empty encoded follow-up without contacting a child', async () => {
    const service = serviceFor()
    await expect(executeYuqiCommand(invocation(agentWith(), 'message all %%% message-op'), service))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('INVALID_BATCH') })
    expect(service.sendTaskMessage).not.toHaveBeenCalled()
  })

  it('uses the durable instruction path and preserves partial receipts without a second delivery', async () => {
    const original = serviceFor()
    const sendTeamInstruction = vi.fn(async () => ({ operationId: 'ui-v1:message-op', teamId: 'team-1', controllerSessionId: 'controller',
      authorSessionId: 'parent', target: 'all', text: '保留修改', createdAt: new Date().toISOString(), recipients: [
        { taskId: 'task-1', goal: 'one', status: 'accepted' as const, childSessionId: 'child', messageId: 'host-id' },
        { taskId: 'task-2', goal: 'two', status: 'unknown' as const },
      ] }))
    const payload = Buffer.from('保留修改').toString('base64url')
    const result = await executeYuqiCommand(invocation(agentWith(), `message all ${payload} message-op`), { ...original, sendTeamInstruction })
    expect(result).toEqual({ kind: 'success', text: expect.stringContaining('接口受理 1/2') })
    expect(sendTeamInstruction).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'ui-v1:message-op', message: '保留修改', target: 'all' }))
    expect(original.sendTaskMessage).not.toHaveBeenCalled()
    sendTeamInstruction.mockRejectedValueOnce(new Error('receipt flush failed after Host admission'))
    await expect(executeYuqiCommand(invocation(agentWith(), `message all ${payload} message-op`), { ...original, sendTeamInstruction }))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('MESSAGE_DELIVERY_UNCERTAIN') })
  })

  it('routes a task permission change through the exact durable command target', async () => {
    const service = serviceFor()
    await expect(executeYuqiCommand(invocation(agentWith(), 'authority task-1 full-access permission-op'), service))
      .resolves.toEqual({ kind: 'success', text: expect.stringContaining('full-access') })
    expect(service.setTaskAuthority).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-1', taskId: 'task-1', authorityMode: 'full-access', operationId: 'ui-v1:permission-op',
    }))
    await expect(executeYuqiCommand(invocation(agentWith(), 'authority task-1 root permission-op'), service))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('/yuqi authority') })
  })

  it('validates model command shapes, supports the short and identity-bound forms, and fails closed on an older Host', async () => {
    const service = serviceFor()
    await expect(executeYuqiCommand(invocation(agentWith(), 'model task-1 deepseek-v4-pro'), service))
      .resolves.toMatchObject({ kind: 'success' })
    expect(service.setTaskModel).toHaveBeenLastCalledWith(expect.objectContaining({ providerId: 'deepseek', modelId: 'deepseek-v4-pro' }))

    await expect(executeYuqiCommand(invocation(agentWith(), 'model task-1 deepseek deepseek-v5 route-op'), service))
      .resolves.toMatchObject({ kind: 'success' })
    expect(service.setTaskModel).toHaveBeenLastCalledWith(expect.objectContaining({ providerId: 'deepseek', modelId: 'deepseek-v5', operationId: 'ui-v1:route-op' }))

    const controller = agentWith()
    const parent = agentWith([])
    parent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(controller.id), sourceEventCount: 8, events: completeTeamEvents().slice(0, 8),
    })
    await expect(executeYuqiCommand(
      invocation(parent, `model task-1 deepseek-v4-pro team-1 ${String(controller.id)} bound-model`),
      service,
      id => id === String(controller.id) ? controller : undefined,
    )).resolves.toMatchObject({ kind: 'success' })
    expect(service.setTaskModel).toHaveBeenLastCalledWith(expect.objectContaining({
      controller, teamId: 'team-1', taskId: 'task-1', modelId: 'deepseek-v4-pro', operationId: 'ui-v1:bound-model',
    }))

    const { setTaskModel: _setTaskModel, ...olderHost } = serviceFor()
    await expect(executeYuqiCommand(invocation(agentWith(), 'model task-1 deepseek-v4-pro'), olderHost))
      .resolves.toEqual({ kind: 'error', text: '当前 Host 未启用任务模型切换。' })
    for (const input of ['model', 'model task-1 model a b c d extra']) {
      await expect(executeYuqiCommand(invocation(agentWith(), input), service))
        .resolves.toEqual({ kind: 'error', text: expect.stringContaining('/yuqi model') })
    }
  })

  it('replays a batched Team envelope through the same command projection', async () => {
    await expect(executeYuqiCommand(invocation(agentWithBatch(completeTeamEvents().slice(0, 8)), ''), serviceFor()))
      .resolves.toEqual({ kind: 'success', text: expect.stringMatching(/Yuqi Team：Yuqi Team[\s\S]*状态：running/u) })
  })

  it('routes an identity-bound browser action to its exact live controller, not the latest bridge', async () => {
    const controller = agentWith()
    const parent = agentWith([])
    parent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(controller.id), sourceEventCount: 8, events: completeTeamEvents().slice(0, 8),
    })
    parent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'controller-stale', sourceEventCount: 8, events: completeTeamEvents().slice(0, 8),
    })
    const service = serviceFor()
    await expect(executeYuqiCommand(
      invocation(parent, `cancel team-1 ${String(controller.id)} ui-cancel`),
      service,
      id => id === String(controller.id) ? controller : undefined,
    )).resolves.toMatchObject({ kind: 'success', text: expect.stringContaining(`controller ${String(controller.id)}`) })
    expect(service.cancelTeam).toHaveBeenCalledWith(expect.objectContaining({ controller, teamId: 'team-1', operationId: 'ui-v1:ui-cancel' }))
    await expect(executeYuqiCommand(
      invocation(parent, 'cancel team-1 controller-missing ui-cancel'), service, () => undefined,
    )).resolves.toEqual({ kind: 'error', text: expect.stringContaining('TEAM_MISMATCH') })

    const unavailable = agentWith([])
    unavailable.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'controller-bound', sourceEventCount: 8, events: completeTeamEvents().slice(0, 8),
    })
    await expect(executeYuqiCommand(
      invocation(unavailable, 'cancel team-1 controller-bound unavailable'), service, () => undefined,
    )).resolves.toEqual({ kind: 'error', text: expect.stringContaining('当前不可用') })
  })

  it('turns an identity-bound stale-running probe into a visible recovery state without a live controller', async () => {
    const parent = agentWith([])
    const controllerSessionId = 'controller-persisted-stale'
    const running = completeTeamEvents().slice(0, 4)
    parent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId, sourceEventCount: running.length, events: running,
    })
    const recovered = replayTeamEvents([
      ...running,
      event(9900, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation', reason: 'stalled' }),
    ])
    const service = { ...serviceFor(running), recoverDormantProjection: vi.fn(async () => recovered) }
    await expect(executeYuqiCommand(
      invocation(parent, `reconcile team-1 ${controllerSessionId} stale-probe`), service, () => undefined,
    )).resolves.toEqual({ kind: 'success', text: expect.stringContaining('状态已转为需处理') })
    expect(service.recoverDormantProjection).toHaveBeenCalledWith({ controllerSessionId, teamId: 'team-1' })
    expect(service.reconcileTeam).not.toHaveBeenCalled()
  })

  it('routes only cancel and reconcile to the exact durable journal when the controller is unavailable', async () => {
    const parent = agentWith([])
    const controllerSessionId = 'controller-durable-only'
    const running = completeTeamEvents().slice(0, 4)
    parent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId, sourceEventCount: running.length, events: running,
    })
    const needsReconciliation = replayTeamEvents([
      ...running,
      event(9901, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation', reason: 'controller unavailable' }),
    ])
    const controlDormantTeam = vi.fn(async () => needsReconciliation)
    const service = { ...serviceFor(running), controlDormantTeam }

    await expect(executeYuqiCommand(
      invocation(parent, `cancel team-1 ${controllerSessionId} durable-cancel`), service, () => undefined,
    )).resolves.toEqual({ kind: 'success', text: expect.stringContaining('不要重复取消') })
    expect(controlDormantTeam).toHaveBeenCalledWith(expect.objectContaining({
      controllerSessionId, parentSessionId: String(parent.id), teamId: 'team-1',
      operationId: 'ui-v1:durable-cancel', action: 'cancel',
    }))
    expect(service.cancelTeam).not.toHaveBeenCalled()

    await expect(executeYuqiCommand(
      invocation(parent, `reconcile team-1 ${controllerSessionId} durable-reconcile`), service, () => undefined,
    )).resolves.toEqual({ kind: 'success', text: expect.stringContaining('未派发、未消息、未验证') })
    expect(service.reconcileTeam).not.toHaveBeenCalled()
  })

  it('renders every controllerless durable-control outcome without requiring a child conversation', async () => {
    const parent = agentWith([])
    const controllerSessionId = 'controller-durable-outcomes'
    const running = completeTeamEvents().slice(0, 4)
    parent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId, sourceEventCount: running.length, events: running,
    })
    const projectionAt = (status: 'running' | 'paused' | 'cancelled') => replayTeamEvents(status === 'running'
      ? running
      : status === 'paused'
        ? [
            ...running,
            event(9921, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
            event(9922, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' }),
          ]
        : [
            ...running,
            event(9923, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling' }),
            event(9924, { type: 'yuqi/team-status-changed', from: 'cancelling', to: 'cancelled' }),
          ])
    const controlDormantTeam = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(projectionAt('cancelled'))
      .mockResolvedValueOnce(projectionAt('paused'))
      .mockResolvedValueOnce(projectionAt('running'))
    const service = { ...serviceFor(running), controlDormantTeam }

    await expect(executeYuqiCommand(
      invocation(parent, `cancel team-1 ${controllerSessionId} unavailable-journal`), service, () => undefined,
    )).resolves.toEqual({ kind: 'error', text: expect.stringContaining('journal 当前不可用') })
    await expect(executeYuqiCommand(
      invocation(parent, `cancel team-1 ${controllerSessionId} cancelled-journal`), service, () => undefined,
    )).resolves.toEqual({ kind: 'success', text: expect.stringContaining('安全收敛为 cancelled') })
    await expect(executeYuqiCommand(
      invocation(parent, `reconcile team-1 ${controllerSessionId} paused-journal`), service, () => undefined,
    )).resolves.toEqual({ kind: 'success', text: expect.stringContaining('安全清理到 paused') })
    await expect(executeYuqiCommand(
      invocation(parent, `reconcile team-1 ${controllerSessionId} running-journal`), service, () => undefined,
    )).resolves.toEqual({ kind: 'success', text: expect.stringContaining('当前为 running') })
  })

  it('disambiguates model providers from controller and allowlisted durable routing facts', async () => {
    const routedEvents = completeTeamEvents().map(fact => fact.type === 'yuqi/team-created'
      ? {
          ...fact,
          controllerModel: { provider: 'deepseek', model: 'controller-model' },
          modelRouting: {
            providerScope: { kind: 'controller-plus-allowlist' as const, providerAllowlist: ['anthropic'] },
            teamPolicy: { kind: 'inherit' as const },
          },
        }
      : fact) as readonly TeamEvent[]
    const service = serviceFor(routedEvents)
    const controller = {
      ...agentWith(routedEvents),
      options: { provider: 'deepseek', model: 'controller-model' },
    } as unknown as Agent

    await executeYuqiCommand(invocation(controller, 'model task-1 deepseek worker-model controller-provider'), service)
    await executeYuqiCommand(invocation(controller, 'model task-1 anthropic claude-model allowlisted-provider'), service)
    await executeYuqiCommand(invocation(controller, 'model task-1 unlisted legacy-operation'), service)

    expect(service.setTaskModel).toHaveBeenNthCalledWith(1, expect.objectContaining({
      providerId: 'deepseek', modelId: 'worker-model', operationId: 'ui-v1:controller-provider',
    }))
    expect(service.setTaskModel).toHaveBeenNthCalledWith(2, expect.objectContaining({
      providerId: 'anthropic', modelId: 'claude-model', operationId: 'ui-v1:allowlisted-provider',
    }))
    expect(service.setTaskModel).toHaveBeenNthCalledWith(3, expect.objectContaining({
      providerId: 'deepseek', modelId: 'unlisted', operationId: 'ui-v1:legacy-operation',
    }))
  })

  it('attaches a Team from an ordinary conversation and rejects control from its former parent', async () => {
    const controller = agentWith()
    const oldParent = agentWith([])
    const newParent = agentWith([])
    const service = { ...serviceFor(), rebindTeam: vi.fn(async () => undefined) }
    await expect(executeYuqiCommand(
      invocation(newParent, `attach team-1 ${String(controller.id)} attach-new-parent`),
      service,
      id => id === String(controller.id) ? controller : undefined,
    )).resolves.toMatchObject({ kind: 'success', text: expect.stringContaining('当前主控对话') })
    expect(service.rebindTeam).toHaveBeenCalledWith(expect.objectContaining({
      controller, parent: newParent, teamId: 'team-1', operationId: 'ui-v1:attach-new-parent',
    }))

    controller.session.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: String(newParent.id), previousParentSessionId: String(oldParent.id), generation: 1,
      operationId: 'ui-v1:attach-new-parent', boundAt: '2026-08-29T00:00:00.000Z',
    })
    oldParent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(controller.id), sourceEventCount: 8, events: completeTeamEvents().slice(0, 8),
    })
    await expect(executeYuqiCommand(
      invocation(oldParent, `cancel team-1 ${String(controller.id)} stale-parent`),
      service,
      id => id === String(controller.id) ? controller : undefined,
    )).resolves.toEqual({ kind: 'error', text: expect.stringContaining('历史记录') })
  })

  it('routes every parent-panel mutation through its bound Team controller and rejects controller-short retry form', async () => {
    const reconciled = [
      ...completeTeamEvents().slice(0, 8),
      event(910, { type: 'yuqi/reconciliation-observed', operationId: 'scan-panel', observations: [
        { taskId: 'task-1', attemptId: 'attempt-1', childSessionId: 'session-worker-1', state: 'durable' },
      ] } as never),
      event(911, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ]
    const controller = agentWith(reconciled)
    const parent = agentWith([])
    parent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(controller.id), sourceEventCount: reconciled.length, events: reconciled,
    })
    const service = serviceFor(reconciled)
    const resolver = (id: string) => id === String(controller.id) ? controller : undefined

    await expect(executeYuqiCommand(invocation(parent, 'retry task-1 unsafe-short'), service, resolver))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('父会话必须携带') })
    expect(service.retryTask).not.toHaveBeenCalled()

    await expect(executeYuqiCommand(invocation(parent, `retry task-1 team-1 ${String(controller.id)} retry-panel`), service, resolver))
      .resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('重试意图已保留') })
    await expect(executeYuqiCommand(invocation(parent, `recover paused team-1 ${String(controller.id)} recover-panel`), service, resolver))
      .resolves.toMatchObject({ kind: 'success' })
    await expect(executeYuqiCommand(invocation(parent, `resolve task-1 attempt-1 failed team-1 ${String(controller.id)} resolve-panel`), service, resolver))
      .resolves.toMatchObject({ kind: 'success' })
    await expect(executeYuqiCommand(invocation(parent, `review user-request team-1 ${String(controller.id)} review-panel`), service, resolver))
      .resolves.toMatchObject({ kind: 'success' })
    await expect(executeYuqiCommand(invocation(parent, `recover team-1 ${String(controller.id)} recover-short`), service, resolver))
      .resolves.toMatchObject({ kind: 'success' })
    await expect(executeYuqiCommand(invocation(parent, `review user-request review-explicit team-1 ${String(controller.id)} review-explicit`), service, resolver))
      .resolves.toMatchObject({ kind: 'success' })

    expect(service.retryTask).toHaveBeenCalledWith(expect.objectContaining({ controller, teamId: 'team-1', operationId: 'ui-v1:retry-panel' }))
    expect(service.clearTeamRecovery).toHaveBeenCalledWith(expect.objectContaining({ controller, teamId: 'team-1', operationId: 'ui-v1:recover-panel' }))
    expect(service.resolveAttempt).toHaveBeenCalledWith(expect.objectContaining({ controller, teamId: 'team-1', operationId: 'ui-v1:resolve-panel', observationOperationId: 'scan-panel' }))
    expect(service.reviewTeam).toHaveBeenCalledWith(expect.objectContaining({ controller, teamId: 'team-1', reviewId: 'ui-v1:review-panel' }))
  })

  it('counts a verifying Task as active in the command summary', async () => {
    const service = serviceFor()
    await expect(executeYuqiCommand(invocation(agentWith(completeTeamEvents().slice(0, 13)), ''), service)).resolves.toEqual({
      kind: 'success', text: expect.stringMatching(/状态：running[\s\S]*0\/1 已完成，1 进行中/u),
    })
  })

  it('routes all five review decisions with durable facts and an optional decoded waive reason', async () => {
    const reason = Buffer.from('接受剩余风险', 'utf8').toString('base64url')
    for (const [decision, encodedReason, expectedReason] of [
      ['retry_review', '-', undefined],
      ['authorize_final_rework', '-', undefined],
      ['waive', reason, '接受剩余风险'],
      ['fail', '-', undefined],
      ['cancel', '-', undefined],
    ] as const) {
      const service = serviceFor()
      await expect(executeYuqiCommand(invocation(
        agentWith(), `review-decision ${decision} review-1 candidate-1 2 ${encodedReason} ${decision}-request`,
      ), service)).resolves.toEqual({ kind: 'success', text: expect.stringContaining(`Review decision ${decision}`) })
      expect(service.decideReview).toHaveBeenCalledWith({
        controller: expect.anything(), teamId: 'team-1', operationId: `ui-v1:${decision}-request`,
        reviewId: 'review-1', candidateEventId: 'candidate-1', round: 2, decision,
        ...(expectedReason === undefined ? {} : { reason: expectedReason }),
      })
    }
  })

  it('binds a parent review decision to the exact controller identity', async () => {
    const controller = agentWith()
    const parent = agentWith([])
    parent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(controller.id), sourceEventCount: 8, events: completeTeamEvents().slice(0, 8),
    })
    const service = serviceFor()
    await expect(executeYuqiCommand(
      invocation(parent, `review-decision retry_review review-1 candidate-1 0 - team-1 ${String(controller.id)} bound-decision`),
      service,
      id => id === String(controller.id) ? controller : undefined,
    )).resolves.toMatchObject({ kind: 'success' })
    expect(service.decideReview).toHaveBeenCalledWith(expect.objectContaining({
      controller, teamId: 'team-1', operationId: 'ui-v1:bound-decision', decision: 'retry_review',
    }))
    await expect(executeYuqiCommand(
      invocation(parent, 'review-decision retry_review review-1 candidate-1 0 - team-1 controller-stale stale-decision'),
      service,
      () => undefined,
    )).resolves.toEqual({ kind: 'error', text: expect.stringContaining('TEAM_MISMATCH') })
    expect(service.decideReview).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed review decisions before mutation and fails closed without Host capability', async () => {
    for (const rawInput of [
      'review-decision',
      'review-decision approve review-1 candidate-1 0 - request',
      'review-decision retry_review review-1 candidate-1 -1 - request',
      'review-decision retry_review review-1 candidate-1 4 - request',
      'review-decision waive review-1 candidate-1 0 - request',
    ]) {
      const service = serviceFor()
      await expect(executeYuqiCommand(invocation(agentWith(), rawInput), service))
        .resolves.toEqual({ kind: 'error', text: expect.stringContaining('用法') })
      expect(service.decideReview).not.toHaveBeenCalled()
    }

    const invalidEncoding = serviceFor()
    await expect(executeYuqiCommand(invocation(
      agentWith(), 'review-decision waive review-1 candidate-1 0 %%% request',
    ), invalidEncoding)).resolves.toEqual({ kind: 'error', text: expect.stringContaining('CONTROL_OPERATION_CONFLICT') })
    expect(invalidEncoding.decideReview).not.toHaveBeenCalled()

    const emptyReason = serviceFor()
    const whitespace = Buffer.from('   ', 'utf8').toString('base64url')
    await expect(executeYuqiCommand(invocation(
      agentWith(), `review-decision waive review-1 candidate-1 0 ${whitespace} request`,
    ), emptyReason)).resolves.toEqual({ kind: 'error', text: expect.stringContaining('CONTROL_OPERATION_CONFLICT') })
    expect(emptyReason.decideReview).not.toHaveBeenCalled()

    const unsupported = serviceFor() as YuqiCommandService
    delete unsupported.decideReview
    await expect(executeYuqiCommand(invocation(
      agentWith(), 'review-decision fail review-1 candidate-1 0 - request',
    ), unsupported)).resolves.toEqual({ kind: 'error', text: '当前 Host 未启用 review user decision。' })
  })

  it('reads and updates the short project summary through the same Host command', async () => {
    const service = serviceFor()
    await expect(executeYuqiCommand(invocation(agentWith(), 'summary'), service)).resolves.toMatchObject({ kind: 'success', text: expect.stringContaining('当前进度') })
    await executeYuqiCommand(invocation(agentWith(), 'summary progress 已完成架构整理'), service)
    await executeYuqiCommand(invocation(agentWith(), 'summary add architectureDecisions arch-1 Team event 是唯一事实源'), service)
    await executeYuqiCommand(invocation(agentWith(), 'summary link ./docs/architecture.md'), service)
    expect(service.updateProjectSummary).toHaveBeenCalledTimes(3)
    expect(service.recordProjectSummary).toHaveBeenCalledTimes(4)
    expect(service.updateProjectSummary).toHaveBeenNthCalledWith(1, process.cwd(), { overallProgress: '已完成架构整理' })
    expect(service.updateProjectSummary).toHaveBeenNthCalledWith(3, process.cwd(), { appendDocumentLink: './docs/architecture.md' })
    const legacy = serviceFor() as YuqiCommandService
    delete legacy.recordProjectSummary
    await expect(executeYuqiCommand(invocation(agentWith(), 'summary'), legacy)).resolves.toMatchObject({ kind: 'success' })
  })

  it('renders Host-authored command copy in the durable Team locale', async () => {
    const englishEvents = completeTeamEvents().map(fact => fact.type === 'yuqi/team-created'
      ? { ...fact, locale: 'en' as const }
      : fact) as readonly TeamEvent[]
    const service = serviceFor(englishEvents)
    const agent = agentWith(englishEvents)

    await expect(executeYuqiCommand(invocation(agent, ''), service)).resolves.toEqual({
      kind: 'success', text: expect.stringContaining('Status: completed'),
    })
    await expect(executeYuqiCommand(invocation(agent, 'pause english-pause'), service)).resolves.toEqual({
      kind: 'success', text: expect.stringContaining('The pause request was persisted'),
    })
    await expect(executeYuqiCommand(invocation(agent, 'unsupported'), service)).resolves.toEqual({
      kind: 'error', text: expect.stringContaining('Usage:'),
    })
    service.reviewTeam.mockResolvedValueOnce({
      status: 'skipped', reviewId: 'english-review', trigger: 'user-request',
      reason: '存在活动中的子 Agent；审查延迟到安全边界',
    })
    await expect(executeYuqiCommand(invocation(agent, 'review'), service)).resolves.toEqual({
      kind: 'success', text: expect.stringContaining('Active child agents are present'),
    })
  })

  it.each([
    ['简单单任务不强制消耗 reviewer Token', 'does not require reviewer token usage'],
    ['当前没有两次可核验的连续失败', 'not two verifiable consecutive failures'],
    ['Team 尚未形成可审查的 durable completion candidate', 'does not yet have a reviewable durable completion candidate'],
    ['Host supplied an already localized reason', 'Host supplied an already localized reason'],
  ])('localizes every public skipped-review reason: %s', async (reason, expected) => {
    const englishEvents = completeTeamEvents().map(fact => fact.type === 'yuqi/team-created'
      ? { ...fact, locale: 'en' as const }
      : fact) as readonly TeamEvent[]
    const service = serviceFor(englishEvents)
    service.reviewTeam.mockResolvedValueOnce({
      status: 'skipped', reviewId: 'english-review-branch', trigger: 'user-request', reason,
    })

    await expect(executeYuqiCommand(invocation(agentWith(englishEvents), 'review'), service)).resolves.toEqual({
      kind: 'success', text: expect.stringContaining(expected),
    })
  })

  it('does not acknowledge a replayed Continue when the returned Team is still paused', async () => {
    const service = serviceFor()
    const current = replayTeamEvents(completeTeamEvents().slice(0, 8))
    service.resumeTeam.mockResolvedValueOnce({ ...current, team: { ...current.team, status: 'paused' as const } })

    await expect(executeYuqiCommand(invocation(agentWith(), 'resume request.replayed'), service)).resolves.toEqual({
      kind: 'error', text: expect.stringContaining('继续未受理'),
    })
  })

  it('guards summary and review boundaries that are reachable from user input', async () => {
    const noCwd = serviceFor()
    await expect(executeYuqiCommand(invocation(agentWithCwd(undefined), 'summary'), noCwd)).resolves.toEqual({
      kind: 'error', text: '当前会话没有可用的项目工作目录。',
    })
    await expect(executeYuqiCommand(invocation(agentWithCwd('relative/project'), 'summary'), noCwd)).resolves.toEqual({
      kind: 'error', text: '当前会话没有可用的项目工作目录。',
    })

    const missingReader = serviceFor() as YuqiCommandService
    delete missingReader.readProjectSummary
    await expect(executeYuqiCommand(invocation(agentWith(), 'summary'), missingReader)).resolves.toEqual({
      kind: 'error', text: '当前 Host 未启用项目摘要文件能力。',
    })
    const missingWriter = serviceFor() as YuqiCommandService
    delete missingWriter.updateProjectSummary
    await expect(executeYuqiCommand(invocation(agentWith(), 'summary'), missingWriter)).resolves.toEqual({
      kind: 'error', text: '当前 Host 未启用项目摘要文件能力。',
    })

    const service = serviceFor()
    await expect(executeYuqiCommand(invocation(agentWithCwd('/'), 'summary read'), service)).resolves.toMatchObject({ kind: 'success' })
    for (const input of [
      'summary read extra', 'summary progress', 'summary link one two',
      'summary add unknown item text', 'review unknown', 'review user-request one two',
    ]) {
      await expect(executeYuqiCommand(invocation(agentWith(), input), service))
        .resolves.toEqual({ kind: 'error', text: expect.stringMatching(/用法|CONTROL_OPERATION_CONFLICT/u) })
    }
    await executeYuqiCommand(invocation(agentWith(), 'summary add pitfalls pit-1 记录踩坑'), service)
    await executeYuqiCommand(invocation(agentWith(), 'summary add conventions con-1 遵守约定'), service)
    await expect(executeYuqiCommand(invocation(agentWith(), 'review user-request review-1'), service))
      .resolves.toMatchObject({ kind: 'success' })
    expect(service.reviewTeam).toHaveBeenCalledWith(expect.objectContaining({ reviewId: 'review-1' }))

    const missingReviewer = serviceFor() as YuqiCommandService
    delete missingReviewer.reviewTeam
    await expect(executeYuqiCommand(invocation(agentWith(), 'review user-request'), missingReviewer)).resolves.toEqual({
      kind: 'error', text: '当前 Host 未启用 reviewer 能力。',
    })

    const summaryFailure = serviceFor()
    summaryFailure.readProjectSummary.mockRejectedValueOnce(new Error('Project summary is invalid'))
    await expect(executeYuqiCommand(invocation(agentWith(), 'summary read'), summaryFailure)).resolves.toEqual({
      kind: 'error', text: 'Yuqi UNEXPECTED_ERROR: 项目摘要操作失败；请检查摘要容量及是否包含疑似凭据。原始诊断：Project summary is invalid',
    })
  })

  it('dispatches reviewer only through an explicit trigger command', async () => {
    const service = serviceFor()
    await expect(executeYuqiCommand(invocation(agentWith(), 'review user-request'), service)).resolves.toMatchObject({ kind: 'success', text: expect.stringContaining('review-command') })
    expect(service.reviewTeam).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team-1', trigger: 'user-request' }))
  })

  it('defaults a controller-local review without arguments to user-request', async () => {
    const service = serviceFor()
    await expect(executeYuqiCommand(invocation(agentWith(), 'review'), service)).resolves.toMatchObject({ kind: 'success', text: expect.stringContaining('review-command') })
    expect(service.reviewTeam).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team-1', trigger: 'user-request' }))
  })

  it('rejects an unsupported summary subcommand without touching the file', async () => {
    const service = serviceFor()
    await expect(executeYuqiCommand(invocation(agentWith(), 'summary unsupported'), service)).resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('用法') })
    expect(service.updateProjectSummary).not.toHaveBeenCalled()
  })

  it.each([
    ['pause', 'pauseTeam', '暂停请求'],
    ['resume request.resume', 'resumeTeam', '已在运行'],
    ['cancel', 'cancelTeam', '取消请求'],
    ['reconcile request.reconcile', 'reconcileTeam', '恢复观察'],
    ['recover paused', 'clearTeamRecovery', '安全停在 paused'],
  ] as const)('routes %s through the durable Host service', async (rawInput, method, acknowledgement) => {
    const service = serviceFor()
    const result = await executeYuqiCommand(invocation(agentWith(), rawInput, 'cmd-fallback'), service)
    expect(result).toEqual({ kind: 'success', text: expect.stringContaining(acknowledgement) })
    expect(service[method]).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-1',
      operationId: rawInput.includes('request.') ? expect.stringContaining('request.') : 'ui-v1:cmd-fallback',
    }))
  })

  it('uses the safe default target and supports an explicit running recovery target', async () => {
    const defaultService = serviceFor()
    await expect(executeYuqiCommand(invocation(agentWith(), 'recover'), defaultService))
      .resolves.toEqual({ kind: 'success', text: expect.stringContaining('安全停在 paused') })
    expect(defaultService.clearTeamRecovery).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team-1', operationId: 'ui-v1:cmd-test' }))
    const defaultRecoveryCall = defaultService.clearTeamRecovery.mock.calls[0] as unknown as readonly [Record<string, unknown>] | undefined
    expect(defaultRecoveryCall?.[0]).not.toHaveProperty('target')

    const runningService = serviceFor()
    await expect(executeYuqiCommand(invocation(agentWith(), 'recover running recovery-run'), runningService))
      .resolves.toEqual({ kind: 'success', text: expect.stringContaining('显式恢复运行') })
    expect(runningService.clearTeamRecovery).toHaveBeenCalledWith(expect.objectContaining({ target: 'running', operationId: 'ui-v1:recovery-run' }))

    const replayedService = serviceFor()
    const runningProjection = replayTeamEvents(completeTeamEvents().slice(0, 8))
    replayedService.clearTeamRecovery.mockResolvedValueOnce({ ...runningProjection, team: { ...runningProjection.team, status: 'paused' as const } })
    await expect(executeYuqiCommand(invocation(agentWith(), 'recover running recovery-replayed'), replayedService))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('未继续调度') })
  })

  it('routes retry and explicit failure resolution without accepting evidence from the Client', async () => {
    const retryService = serviceFor()
    await expect(executeYuqiCommand(invocation(agentWith(), 'retry task-1'), retryService))
      .resolves.toEqual({ kind: 'success', text: expect.stringContaining('调度已恢复') })
    await expect(executeYuqiCommand(invocation(agentWith(), 'retry task-1 retry-id'), retryService))
      .resolves.toEqual({ kind: 'success', text: expect.stringContaining('调度已恢复') })
    expect(retryService.retryTask).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-1', taskId: 'task-1', operationId: 'ui-v1:retry-id',
    }))

    const reconciled = [
      ...completeTeamEvents().slice(0, 8),
      event(900, { type: 'yuqi/reconciliation-observed', operationId: 'scan-command', observations: [
        { taskId: 'task-1', attemptId: 'attempt-1', childSessionId: 'session-worker-1', state: 'durable' },
      ] } as never),
      event(901, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ]
    const resolveService = serviceFor(reconciled)
    const resolveAgent = agentWith(reconciled)
    await expect(executeYuqiCommand(invocation(resolveAgent, 'resolve task-1 attempt-1 failed resolve-id'), resolveService))
      .resolves.toEqual({ kind: 'success', text: expect.stringContaining('不会把它推断为成功') })
    expect(resolveService.resolveAttempt).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1', attemptId: 'attempt-1', decision: 'failed',
      operationId: 'ui-v1:resolve-id', observationOperationId: 'scan-command',
    }))
  })

  it('turns a paused task retry into one idempotent retry-and-resume operation', async () => {
    const failed = [
      ...completeTeamEvents().slice(0, 8),
      event(920, { type: 'yuqi/attempt-status-changed', taskId: 'task-1', attemptId: 'attempt-1', from: 'running', to: 'failed' } as never),
      event(921, { type: 'yuqi/task-status-changed', taskId: 'task-1', from: 'running', to: 'failed' } as never),
      event(922, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
      event(923, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' }),
    ]
    const parent = agentWith([])
    const controller = agentWith(failed)
    parent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(controller.id), sourceEventCount: failed.length, events: failed,
    })
    const service = serviceFor(failed)
    const ready = replayTeamEvents([
      ...failed,
      event(924, { type: 'yuqi/task-retry-requested', operationId: 'ui-v1:retry-paused', taskId: 'task-1' } as never),
    ])
    service.retryTask.mockResolvedValue(ready)
    service.resumeTeam.mockResolvedValue({ ...ready, team: { ...ready.team, status: 'running' as const } })

    await expect(executeYuqiCommand(invocation(
      parent,
      `retry task-1 team-1 ${String(controller.id)} retry-paused`,
    ), service, id => id === String(controller.id) ? controller : undefined)).resolves.toEqual({
      kind: 'success', text: expect.stringContaining('调度已恢复'),
    })
    expect(service.retryTask).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'ui-v1:retry-paused' }))
    expect(service.resumeTeam).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'ui-v1:retry-paused:resume' }))
  })

  it('does not claim that a persisted retry resumed when the Team remains non-running', async () => {
    const service = serviceFor()
    const current = replayTeamEvents(completeTeamEvents().slice(0, 8))
    service.retryTask.mockResolvedValueOnce({ ...current, team: { ...current.team, status: 'needs_reconciliation' as const } })

    await expect(executeYuqiCommand(invocation(agentWith(), 'retry task-1 retry-stalled'), service))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('重试意图已保留') })
    expect(service.resumeTeam).not.toHaveBeenCalled()
  })

  it('rejects malformed, excessive, unsafe, and stale command arguments before Host mutation', async () => {
    const service = serviceFor(verificationOperationEvents())
    const agent = agentWith(verificationOperationEvents())
    for (const input of [
      'unknown', 'pause one two', 'retry', 'retry one two three', 'recover invalid team controller request',
      'resolve task-1 attempt-1 completed', 'resolve task-1 attempt-1 failed id extra', 'recover invalid-target', 'x'.repeat(4097),
    ]) {
      await expect(executeYuqiCommand(invocation(agent, input), service))
        .resolves.toEqual({ kind: 'error', text: expect.stringMatching(/用法|CONTROL_OPERATION_CONFLICT/u) })
    }
    await expect(executeYuqiCommand(invocation(agent, 'pause bad$id'), service))
      .resolves.toEqual({ kind: 'error', text: 'Yuqi CONTROL_OPERATION_CONFLICT: requestId 格式无效' })
    await expect(executeYuqiCommand(invocation(agent, 'resolve task-1 attempt-1 failed'), service))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('没有可用于人工裁决') })
    expect(service.pauseTeam).not.toHaveBeenCalled()
    expect(service.resolveAttempt).not.toHaveBeenCalled()

    const parent = agentWith([])
    parent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'controller-identity', sourceEventCount: 8, events: completeTeamEvents().slice(0, 8),
    })
    await expect(executeYuqiCommand(invocation(parent, 'pause bad$id controller-identity request-id'), service, () => agentWith()))
      .resolves.toEqual({ kind: 'error', text: 'Yuqi CONTROL_OPERATION_CONFLICT: Team 或 controller 标识格式无效' })
    await expect(executeYuqiCommand(invocation(parent, 'pause wrong-team controller-identity request-id'), service, () => agentWith()))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('TEAM_MISMATCH') })

    const conflictingParent = agentWith([])
    conflictingParent.session.append(TEAM_SESSION_EVENT, {
      events: [
        event(1200, { type: 'yuqi/team-created', title: 'Other Team', objective: 'Conflicting direct facts' }, 'other-team' as never),
        event(1201, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }, 'other-team' as never),
      ],
    })
    conflictingParent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'controller-identity', sourceEventCount: 8, events: completeTeamEvents().slice(0, 8),
    })
    await expect(executeYuqiCommand(invocation(conflictingParent, 'pause'), service))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('当前 controller 属于 Team other-team') })

    await expect(executeYuqiCommand({
      ...invocation(agent, ''), rawInput: 42 as never,
    }, service)).resolves.toEqual({ kind: 'error', text: expect.stringContaining('用法') })

    const disabled = serviceFor() as YuqiCommandService
    delete disabled.clearTeamRecovery
    await expect(executeYuqiCommand(invocation(agentWith(), 'recover'), disabled))
      .resolves.toEqual({ kind: 'error', text: '当前 Host 未启用安全恢复校验。' })
  })

  it('renders known control errors safely and treats runtime cancellation as unknown', async () => {
    const service = serviceFor()
    service.pauseTeam.mockRejectedValueOnce(new YuqiOrchestratorError('CONTROL_NOT_ALLOWED', 'Team 当前不可暂停'))
    await expect(executeYuqiCommand(invocation(agentWith(), 'pause'), service))
      .resolves.toEqual({ kind: 'error', text: 'Yuqi CONTROL_NOT_ALLOWED: Team 当前不可暂停' })

    service.cancelTeam.mockRejectedValueOnce(new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', 'internal runtime detail'))
    await expect(executeYuqiCommand(invocation(agentWith(), 'cancel'), service))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('运行结果未知') })

    service.reconcileTeam.mockRejectedValueOnce(new Error('secret host failure'))
    await expect(executeYuqiCommand(invocation(agentWith(), 'reconcile'), service))
      .resolves.toEqual({ kind: 'error', text: 'Yuqi UNEXPECTED_ERROR: 操作未受理；请查看目标 Team/controller 后重试。' })
  })

  it('routes controller-owned automatic recovery and rejects continuation when Host facts remain unresolved', async () => {
    const running = {
      ...serviceFor(),
      recoverAndContinueTeam: vi.fn<RecoverAndContinueTeam>(async () => replayTeamEvents(completeTeamEvents().slice(0, 4))),
    }
    await expect(executeYuqiCommand(invocation(agentWith(), 'recover-continue recovery-op'), running))
      .resolves.toEqual({ kind: 'success', text: expect.stringContaining('继续团队调度') })
    expect(running.recoverAndContinueTeam).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-1', operationId: 'ui-v1:recovery-op',
    }))

    const unresolvedEvents = [
      ...completeTeamEvents().slice(0, 8),
      event(52, { type: 'yuqi/reconciliation-observed', operationId: 'recover-command-observation', observations: [
        { taskId: 'task-1', attemptId: 'attempt-1', childSessionId: 'session-worker-1', state: 'unavailable', reason: 'Host offline' },
      ] } as never),
      event(53, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ]
    const unresolved = {
      ...serviceFor(unresolvedEvents),
      recoverAndContinueTeam: vi.fn<RecoverAndContinueTeam>(async () => replayTeamEvents(unresolvedEvents)),
    }
    await expect(executeYuqiCommand(invocation(agentWith(unresolvedEvents), 'recover-continue'), unresolved))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('恢复尚未完成') })
    expect(unresolved.recoverAndContinueTeam).toHaveBeenCalledOnce()

    const older = serviceFor() as YuqiCommandService
    await expect(executeYuqiCommand(invocation(agentWith(), 'recover-continue'), older))
      .resolves.toEqual({ kind: 'error', text: '当前 Host 未启用主控自动恢复。' })
    await expect(executeYuqiCommand(invocation(agentWith(), 'recover-continue one two'), running))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('/yuqi recover-continue') })
  })

  it('keeps optional task controls fail-closed and explains empty or rejected message fan-out', async () => {
    const payload = Buffer.from('主控补充要求', 'utf8').toString('base64url')
    const older = serviceFor() as YuqiCommandService
    delete older.sendTaskMessage
    delete older.setTaskAuthority
    await expect(executeYuqiCommand(invocation(agentWith(), `message all ${payload}`), older))
      .resolves.toEqual({ kind: 'error', text: '当前 Host 未启用主控消息转发。' })
    await expect(executeYuqiCommand(invocation(agentWith(), 'authority task-1 read-only'), older))
      .resolves.toEqual({ kind: 'error', text: '当前 Host 未启用任务权限切换。' })

    const completed = serviceFor(completeTeamEvents())
    await expect(executeYuqiCommand(invocation(agentWith(completeTeamEvents()), `message all ${payload}`), completed))
      .resolves.toEqual({ kind: 'error', text: '当前没有运行中的子代理可接收补充要求。' })

    const rejected = serviceFor()
    rejected.sendTaskMessage.mockRejectedValue(new Error('child already ended'))
    await expect(executeYuqiCommand(invocation(agentWith(), `message all ${payload}`), rejected))
      .resolves.toEqual({ kind: 'error', text: '补充要求未送达；目标任务可能已经结束。' })
    await expect(executeYuqiCommand(invocation(agentWith(), 'message all AAAA extra too-many'), rejected))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('/yuqi message') })
  })

  it('validates attach routing and renders both expected and unexpected rebind failures', async () => {
    const controller = agentWith()
    const rebindTeam = vi.fn<RebindTeam>(async () => undefined)
    const service = { ...serviceFor(), rebindTeam }
    await expect(executeYuqiCommand(invocation(agentWith(), `attach team-1 ${String(controller.id)} attach-ok`), service, () => controller))
      .resolves.toEqual({ kind: 'success', text: expect.stringContaining('已切换到当前主控对话') })
    rebindTeam.mockRejectedValueOnce(new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'not top-level'))
    await expect(executeYuqiCommand(invocation(agentWith(), `attach team-1 ${String(controller.id)} attach-domain`), service, () => controller))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('EXECUTION_GATE_REJECTED') })
    rebindTeam.mockRejectedValueOnce('opaque failure')
    await expect(executeYuqiCommand(invocation(agentWith(), `attach team-1 ${String(controller.id)} attach-unknown`), service, () => controller))
      .resolves.toEqual({ kind: 'error', text: 'Yuqi UNEXPECTED_ERROR: 主控对话切换未完成。' })
    await expect(executeYuqiCommand(invocation(agentWith(), 'attach team-1 only-two'), service, () => controller))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('/yuqi attach') })
    await expect(executeYuqiCommand(invocation(agentWith(), 'attach team-1 controller-id bad$id'), service, () => controller))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('/yuqi attach') })
    await expect(executeYuqiCommand(invocation(agentWith(), 'attach team-1 controller-id missing'), service, () => undefined))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('当前不可用') })

    const otherController = agentWith(completeTeamEvents().map(fact => ({ ...fact, teamId: 'other-team' }) as TeamEvent))
    await expect(executeYuqiCommand(
      invocation(agentWith(), `attach team-1 ${String(otherController.id)} attach-mismatch`),
      service,
      () => otherController,
    )).resolves.toEqual({ kind: 'error', text: expect.stringContaining('不属于 Team team-1') })
  })

  it('covers identity-bound recovery, message, authority, and partial fan-out outcomes', async () => {
    const controller = agentWith()
    const parent = agentWith([])
    parent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(controller.id), sourceEventCount: 8, events: completeTeamEvents().slice(0, 8),
    })
    const payload = Buffer.from('身份绑定补充要求', 'utf8').toString('base64url')
    const service = {
      ...serviceFor(),
      recoverAndContinueTeam: vi.fn<RecoverAndContinueTeam>(async () => replayTeamEvents(completeTeamEvents().slice(0, 4))),
    }
    const resolver = (id: string) => id === String(controller.id) ? controller : undefined

    await expect(executeYuqiCommand(invocation(parent, `recover-continue team-1 ${String(controller.id)} recover-bound`), service, resolver))
      .resolves.toEqual({ kind: 'success', text: expect.stringContaining('继续团队调度') })
    await expect(executeYuqiCommand(invocation(parent, `message task-1 ${payload} team-1 ${String(controller.id)} message-bound`), service, resolver))
      .resolves.toEqual({ kind: 'success', text: expect.stringContaining('1 个运行中的子代理') })
    await expect(executeYuqiCommand(invocation(parent, `authority task-1 read-only team-1 ${String(controller.id)} authority-bound`), service, resolver))
      .resolves.toEqual({ kind: 'success', text: expect.stringContaining('read-only') })
    await expect(executeYuqiCommand(invocation(parent, 'authority task-1 read-only extra-token another-token'), service, resolver))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('/yuqi authority') })

    const task2 = 'task-2'
    const attempt2 = 'attempt-2'
    const parallel = [
      ...completeTeamEvents().slice(0, 8),
      event(41, { type: 'yuqi/task-created', contract: { ...contract(), taskId: task2, inputDigest: 'task-2-digest' } } as never),
      event(42, { type: 'yuqi/task-status-changed', taskId: task2, from: 'pending', to: 'ready' } as never),
      event(43, { type: 'yuqi/task-status-changed', taskId: task2, from: 'ready', to: 'running' } as never),
      event(44, { type: 'yuqi/attempt-created', taskId: task2, attemptId: attempt2, ordinal: 1, modelProvider: 'deepseek', modelId: 'deepseek-v4' } as never),
      event(45, { type: 'yuqi/attempt-admitted', taskId: task2, attemptId: attempt2, agentSessionId: 'session-worker-2', messageId: 'message-2' } as never),
      event(46, { type: 'yuqi/attempt-status-changed', taskId: task2, attemptId: attempt2, from: 'dispatching', to: 'running' } as never),
    ]
    const partial = serviceFor(parallel)
    partial.sendTaskMessage.mockImplementation(async request => {
      if ((request as { taskId: string }).taskId === task2) throw new Error('ended')
      return { childSessionId: 'session-worker-1', messageId: 'message-1' }
    })
    await expect(executeYuqiCommand(invocation(agentWith(parallel), `message all ${payload}`), partial))
      .resolves.toEqual({ kind: 'success', text: expect.stringContaining('1 个任务已结束') })

    await expect(executeYuqiCommand(invocation(agentWith(), 'stop'), service))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('/yuqi stop') })
    const emptyPayload = Buffer.from('   ', 'utf8').toString('base64url')
    await expect(executeYuqiCommand(invocation(agentWith(), `message task-1 ${emptyPayload}`), service))
      .resolves.toEqual({ kind: 'error', text: expect.stringContaining('INVALID_BATCH') })
    service.pauseTeam.mockRejectedValueOnce('opaque failure')
    await expect(executeYuqiCommand(invocation(agentWith(), 'pause'), service))
      .resolves.toEqual({ kind: 'error', text: 'Yuqi UNEXPECTED_ERROR: 操作未受理；请查看目标 Team/controller 后重试。' })
  })

  it('handles stale dormant reconciliation probes without hijacking normal control routing', async () => {
    const parent = agentWith([])
    const controllerSessionId = 'controller-dormant-resolved'
    parent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId, sourceEventCount: 4, events: completeTeamEvents().slice(0, 4),
    })
    const service = serviceFor()
    const recovered = vi.fn(async () => replayTeamEvents(completeTeamEvents().slice(0, 4)))
    const routed = { ...service, recoverDormantProjection: recovered }
    await expect(executeYuqiCommand(
      invocation(parent, `reconcile team-1 ${controllerSessionId} dormant-request`), routed, () => agentWith(),
    )).resolves.toEqual({ kind: 'success', text: expect.stringContaining('恢复观察已持久化') })
    expect(recovered).toHaveBeenCalledWith({ controllerSessionId, teamId: 'team-1' })
    expect(service.reconcileTeam).toHaveBeenCalledOnce()

    const mismatched = agentWith([])
    mismatched.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId, sourceEventCount: 4,
      events: [
        event(47, { type: 'yuqi/team-created', title: 'Other', objective: 'Other' }, 'other-team' as never),
        event(48, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }, 'other-team' as never),
        event(49, { type: 'yuqi/task-created', contract: contract() }, 'other-team' as never),
        event(50, { type: 'yuqi/task-status-changed', taskId: 'task-1', from: 'pending', to: 'ready' } as never, 'other-team' as never),
      ],
    })
    await expect(executeYuqiCommand(
      invocation(mismatched, `reconcile team-1 ${controllerSessionId} mismatch-request`), routed, () => agentWith(),
    )).resolves.toEqual({ kind: 'error', text: expect.stringContaining('TEAM_MISMATCH') })
  })
})
