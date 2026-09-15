import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  HarnessSessionJournal,
  replayTeamEvents,
  TEAM_SESSION_EVENT,
  TeamEventId,
  TaskId,
  YuqiTeamOrchestratorService,
} from '../src/index.ts'
import {
  buildBoundedParentReport,
  deliverParentReport,
  PARENT_REPORT_MAX_CHARS,
  parentReportMessageId,
} from '../src/host/harness/parent-report-delivery.ts'
import {
  readLatestTeamParentReportCheckpoint,
  parseTeamProjectionBridgeData,
  TEAM_PARENT_BINDING_EVENT,
  TEAM_PARENT_PROJECTION_EVENT,
  syncTeamProjectionToParent,
} from '../src/host/harness/session-journal.ts'
import { completeTeamEvents, contract, event } from './fixtures.ts'

interface Harness {
  readonly agent: Agent
  readonly sessions: Map<string, Session>
}

function harness(
  session = Session.create(SessionId(`branch-controller-${Math.random().toString(36).slice(2)}`)),
  ctx = new Context(),
  options: Record<string, unknown> = {},
): Harness {
  const sessions = new Map<string, Session>([[String(session.id), session]])
  ctx.provide('subagents', {
    startContinuable: vi.fn(async () => ({ childId: 'branch-child', messageId: 'branch-message' })),
    interrupt: vi.fn(),
    sendMessage: vi.fn(async () => MessageId('branch-send-message')),
    listChildren: vi.fn(async () => []),
  } as never)
  if (ctx.get('sessions') === undefined) ctx.provide('sessions', {
      get: (id: SessionId) => sessions.get(String(id)),
      list: () => [...sessions.values()],
      flush: async () => true,
    } as never)
  if (ctx.get('sessionPersistence') === undefined) ctx.provide('sessionPersistence', { load: async () => undefined } as never)
  ctx.provide('llm', {
    listModels: async (provider: string) => [{ provider, id: 'controller-model', name: 'Controller model' }],
    resolveModelInfo: async (provider: string, model: string, signal?: AbortSignal) => {
      signal?.throwIfAborted()
      return { provider, id: model, name: `${provider}/${model}` }
    },
  } as never)
  ctx.provide('sandboxPolicy', {
    resolve: ({ session: current }: { session?: Session } = {}) => ({ mode: 'read-only', workspaceRoot: current?.header.cwd ?? process.cwd() }),
  } as never)
  return {
    sessions,
    agent: {
      id: session.id,
      session,
      options,
      status: 'idle',
      ctx,
      inject: vi.fn(),
    } as unknown as Agent,
  }
}

function append(session: Session, facts: readonly ReturnType<typeof event>[]): void {
  for (const fact of facts) session.append(TEAM_SESSION_EVENT, { event: fact })
}

function bind(session: Session, parentSessionId: string): void {
  session.append(TEAM_PARENT_BINDING_EVENT, {
    parentSessionId,
    generation: 1,
    operationId: `bind-${String(session.id)}`,
    boundAt: '2026-08-31T00:00:00Z',
  })
}

function exposeAgents(ctx: Context, agents: readonly Agent[]): void {
  ctx.provide('agents', {
    get: (id: SessionId) => agents.find(agent => String(agent.id) === String(id)),
  } as never)
  ctx.provide('agentPresets' as never, {
    resolve: async (id = 'standard') => ({ id }),
    mount: async () => undefined,
  } as never)
}

async function routedService(
  label: string,
  taskModel: Record<string, unknown>,
  teamPolicy: Record<string, unknown>,
  options: Record<string, unknown> = { provider: 'controller-provider', model: 'controller-model' },
) {
  const ctx = new Context()
  const value = harness(Session.create(SessionId(`branch-route-${label}`)), ctx, options)
  const task = { ...contract() } as Record<string, unknown>
  delete task.modelId
  task.modelRequest = taskModel
  append(value.agent.session, [
    event(301, {
      type: 'yuqi/team-created',
      title: `Route ${label}`,
      objective: 'Exercise the public route contract',
      modelRouting: {
        providerScope: { kind: 'controller-plus-allowlist', providerAllowlist: ['external-provider'] },
        teamPolicy,
      },
    } as never),
    event(302, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
    event(303, { type: 'yuqi/task-created', contract: task } as never),
  ])
  const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
  return { ctx, value, fiber }
}

describe('service public branch coverage', () => {
  it('preserves bootstrap defaults and rejects public operations that lack durable runtime facts', async () => {
    const ctx = new Context()
    const value = harness(Session.create(SessionId('branch-bootstrap-defaults')), ctx)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const service = ctx.yuqiTeamOrchestrator

    await service.bootstrapTeam({
      controller: value.agent,
      teamId: 'default-team',
      title: 'Default Team',
      objective: 'Use all public defaults',
      tasks: [contract(TaskId('default-task'))],
    })
    const journal = new HarnessSessionJournal(value.agent.session, ctx.sessions)
    const projection = replayTeamEvents(journal.read())
    expect(projection.team).toMatchObject({ id: 'default-team', status: 'running', locale: 'zh' })

    expect(() => service.waitForProgress({
      teamId: 'default-team', journal, activeTaskIds: ['default-task'], signal: new AbortController().signal,
    })).toThrow(expect.objectContaining({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' }))
    await fiber.dispose()

    const draftCtx = new Context()
    const draftHarness = harness(Session.create(SessionId('branch-schedule-draft')), draftCtx)
    append(draftHarness.agent.session, [
      event(300, { type: 'yuqi/team-created', title: 'Draft schedule', objective: 'Reject unsafe reconciliation' }),
    ])
    const draftFiber = await draftCtx.plugin(YuqiTeamOrchestratorService)
    const draftJournal = new HarnessSessionJournal(draftHarness.agent.session, draftCtx.sessions)
    const draft = replayTeamEvents(draftJournal.read())
    await expect(draftCtx.yuqiTeamOrchestrator.persistScheduleState({
      teamId: 'team-1',
      journal: draftJournal,
      plan: {
        status: 'unsafe' as never, activeTaskIds: [], readyTaskIds: [], blockedTaskIds: [], newlyBlockedTaskIds: [],
        unblockedTaskIds: [], dispatchTaskIds: [], availableSlots: 1,
        sourceLastEventId: draft.lastEventId, sourceLastEventAt: draft.lastEventAt,
      },
      taskTransitions: [],
      requiresReconciliation: true,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'STALE_SCHEDULE' })
    await draftFiber.dispose()

    const messageCtx = new Context()
    const messageHarness = harness(Session.create(SessionId('branch-message-no-attempt')), messageCtx)
    append(messageHarness.agent.session, completeTeamEvents().slice(0, 5))
    const messageFiber = await messageCtx.plugin(YuqiTeamOrchestratorService)
    await expect(messageCtx.yuqiTeamOrchestrator.sendTaskMessage({
      controller: messageHarness.agent,
      teamId: 'team-1',
      taskId: 'task-1',
      message: 'continue',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
    await messageFiber.dispose()
  })

  it('passes locale through the flat public bootstrap shape', async () => {
    const ctx = new Context()
    const value = harness(Session.create(SessionId('branch-bootstrap-locale')), ctx)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)

    await ctx.yuqiTeamOrchestrator.bootstrapTeam({
      controller: value.agent,
      teamId: 'english-flat-team',
      title: 'English Team',
      objective: 'Preserve the selected language',
      locale: 'en',
      tasks: [contract(TaskId('english-flat-task'))],
    })

    const projection = replayTeamEvents(new HarnessSessionJournal(value.agent.session, ctx.sessions).read())
    expect(projection.team.locale).toBe('en')
    await fiber.dispose()
  })

  it('renders an English Host review-skip notice from the durable Team locale', async () => {
    const ctx = new Context()
    const value = harness(Session.create(SessionId('branch-english-review-skip')), ctx)
    const parentSession = Session.create(SessionId('branch-english-review-skip-parent'))
    value.sessions.set(String(parentSession.id), parentSession)
    const followup = vi.fn()
    const parent = {
      id: parentSession.id, session: parentSession, options: {}, status: 'idle', ctx,
      steer: vi.fn(), followup,
    } as unknown as Agent
    bind(value.agent.session, String(parent.id))
    append(value.agent.session, completeTeamEvents().map(item => item.type === 'yuqi/team-created'
      ? { ...item, locale: 'en' as const }
      : item))
    exposeAgents(ctx, [value.agent, parent])
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)

    await expect(ctx.yuqiTeamOrchestrator.reviewTeam({
      controller: value.agent, teamId: 'team-1', trigger: 'pre-completion',
    })).resolves.toMatchObject({ status: 'skipped', reason: 'A simple single-task Team does not require reviewer token usage.' })
    expect(followup).toHaveBeenCalledWith(expect.objectContaining({
      content: [expect.objectContaining({ text: expect.stringMatching(/controller notice:[\s\S]*review-skipped[\s\S]*simple single-task Team/u) })],
    }))
    expect(JSON.stringify(followup.mock.calls)).not.toMatch(/简单|审查/u)
    await fiber.dispose()
  })

  it('routes legacy and fixed policies from controller options and fails closed for an incomplete controller route', async () => {
    const legacy = await routedService(
      'legacy',
      { kind: 'legacy', modelId: 'legacy-model' },
      { kind: 'fixed', model: { modelProvider: 'external-provider', modelId: 'team-fixed-model' } },
    )
    await expect(legacy.ctx.yuqiTeamOrchestrator.resolveTaskModelRoute({
      controller: legacy.value.agent, teamId: 'team-1', taskId: 'task-1',
    })).resolves.toMatchObject({
      route: { modelProvider: 'controller-provider', modelId: 'legacy-model' },
      routeBasis: 'task-exact',
    })
    await legacy.fiber.dispose()

    const fixed = await routedService(
      'fixed',
      { kind: 'default' },
      { kind: 'fixed', model: { modelProvider: 'external-provider', modelId: 'team-fixed-model' } },
    )
    await expect(fixed.ctx.yuqiTeamOrchestrator.resolveTaskModelRoute({
      controller: fixed.value.agent, teamId: 'team-1', taskId: 'task-1',
    })).resolves.toMatchObject({
      route: { modelProvider: 'external-provider', modelId: 'team-fixed-model' },
      routeBasis: 'team-fixed',
    })
    await fixed.fiber.dispose()

    const invalid = await routedService('invalid', { kind: 'default' }, { kind: 'inherit' }, {})
    await expect(invalid.ctx.yuqiTeamOrchestrator.resolveTaskModelRoute({
      controller: invalid.value.agent, teamId: 'team-1', taskId: 'task-1',
    })).rejects.toMatchObject({ code: 'FIXED_MODEL_INVALID' })
    await invalid.fiber.dispose()
  })

  it('handles missing, stale, cancelling, and quiescent dormant controllers through the public control API', async () => {
    const missingCtx = new Context()
    const missingHarness = harness(Session.create(SessionId('branch-dormant-stale')), missingCtx)
    bind(missingHarness.agent.session, 'active-parent')
    append(missingHarness.agent.session, completeTeamEvents().slice(0, 4))
    const missingFiber = await missingCtx.plugin(YuqiTeamOrchestratorService)
    for (const action of ['cancel', 'reconcile'] as const) {
      await expect(missingCtx.yuqiTeamOrchestrator.controlDormantTeam({
        controllerSessionId: 'missing-controller', parentSessionId: 'active-parent', teamId: 'team-1',
        operationId: `missing-${action}`, action,
      })).resolves.toBeUndefined()
      await expect(missingCtx.yuqiTeamOrchestrator.controlDormantTeam({
        controllerSessionId: String(missingHarness.agent.id), parentSessionId: 'stale-parent', teamId: 'team-1',
        operationId: `stale-${action}`, action,
      })).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    }
    await missingFiber.dispose()

    for (const [label, alreadyCancelling] of [['direct', false], ['settled', true]] as const) {
      const ctx = new Context()
      const value = harness(Session.create(SessionId(`branch-dormant-${label}`)), ctx)
      const parentSessionId = `parent-${label}`
      bind(value.agent.session, parentSessionId)
      append(value.agent.session, completeTeamEvents().slice(0, 4))
      if (alreadyCancelling) {
        value.agent.session.append(TEAM_SESSION_EVENT, {
          event: event(304, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling' }),
        })
      }
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      const result = await ctx.yuqiTeamOrchestrator.controlDormantTeam({
        controllerSessionId: String(value.agent.id), parentSessionId, teamId: 'team-1',
        operationId: `dormant-${label}`, action: alreadyCancelling ? 'reconcile' : 'cancel',
      })
      expect(result).toMatchObject({ team: { status: 'cancelled' }, tasks: { 'task-1': { status: 'cancelled' } } })
      await fiber.dispose()
    }

    const completedCtx = new Context()
    const completedHarness = harness(Session.create(SessionId('branch-dormant-completion')), completedCtx)
    bind(completedHarness.agent.session, 'parent-completion')
    append(completedHarness.agent.session, completeTeamEvents().slice(0, -1))
    const completedFiber = await completedCtx.plugin(YuqiTeamOrchestratorService)
    await expect(completedCtx.yuqiTeamOrchestrator.controlDormantTeam({
      controllerSessionId: String(completedHarness.agent.id), parentSessionId: 'parent-completion', teamId: 'team-1',
      operationId: 'dormant-completion', action: 'reconcile',
    })).resolves.toMatchObject({ team: { status: 'completed' } })
    await completedFiber.dispose()
  })

  it('creates structured review rework defaults and keeps a repeated terminal decision idempotent', async () => {
    const ctx = new Context()
    const value = harness(Session.create(SessionId('branch-review-rework')), ctx)
    const source = { ...contract() } as Record<string, unknown>
    delete source.modelId
    delete source.baselineRef
    source.modelRequest = { kind: 'exact', model: { modelProvider: 'deepseek', modelId: 'deepseek-v4' } }
    source.verificationChecks = [{
      checkId: 'build', kind: 'build', commandRef: 'typecheck', timeoutMs: 10_000,
      stdoutMaxBytes: 1_000, stderrMaxBytes: 1_000,
    }]
    source.maxAttempts = 3
    const completed = completeTeamEvents()
    const reviewFacts = [
      event(310, {
        type: 'yuqi/team-created', title: 'Structured rework', objective: 'Create safe fallback rework',
        reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 2, additionalPrompt: '' },
      }),
      ...completed.slice(1, 2),
      event(311, { type: 'yuqi/task-created', contract: source } as never),
      ...completed.slice(3, -1),
      event(312, {
        type: 'yuqi/review-requested', reviewId: 'structured-review', trigger: 'quality-gate',
        candidateEventId: TeamEventId('event-16'), round: 0,
      }),
      event(313, {
        type: 'yuqi/review-result-recorded', reviewId: 'structured-review', candidateEventId: TeamEventId('event-16'),
        reviewerSessionId: 'structured-reviewer', decision: 'changes_required',
        findings: [{ severity: 'high', evidence: ['src/host/harness/service.ts:1'], impact: 'branch gap', recommendation: 'Cover the structured branch' }],
        unverified: [],
      }),
    ] as const
    append(value.agent.session, reviewFacts)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const journal = new HarnessSessionJournal(value.agent.session, ctx.sessions)
    expect(journal.read().length).toBeGreaterThan(0)
    await ctx.yuqiTeamOrchestrator.coordinateCompletion({
      controller: value.agent, teamId: 'team-1', journal, signal: new AbortController().signal,
    })
    const projection = replayTeamEvents(journal.read())
    const reworkId = projection.taskIds.find(taskId => projection.tasks[taskId]?.contract.kind === 'review-rework')!
    expect(projection.tasks[reworkId]?.contract).toMatchObject({
      scope: ['Cover the structured branch'],
      acceptanceCriteria: ['Cover the structured branch'],
      modelRequest: source.modelRequest,
      verificationChecks: source.verificationChecks,
      maxAttempts: 3,
    })
    expect(projection.tasks[reworkId]?.contract).not.toHaveProperty('baselineRef')
    await fiber.dispose()

    for (const decision of ['fail', 'cancel'] as const) {
      const decisionCtx = new Context()
      const decisionHarness = harness(Session.create(SessionId(`branch-review-${decision}`)), decisionCtx)
      append(decisionHarness.agent.session, [
        event(320, {
          type: 'yuqi/team-created', title: 'Review decision', objective: 'Persist idempotently',
          reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 1, additionalPrompt: '' },
        }),
        ...completed.slice(1, -1),
        event(321, {
          type: 'yuqi/review-requested', reviewId: `review-${decision}`, trigger: 'quality-gate',
          candidateEventId: TeamEventId('event-16'), round: 0,
        }),
        event(322, {
          type: 'yuqi/review-result-recorded', reviewId: `review-${decision}`, candidateEventId: TeamEventId('event-16'),
          reviewerSessionId: 'terminal-reviewer', decision: 'inconclusive', findings: [], unverified: ['decision required'],
        }),
      ])
      const decisionFiber = await decisionCtx.plugin(YuqiTeamOrchestratorService)
      const request = {
        controller: decisionHarness.agent,
        teamId: 'team-1',
        operationId: `decision-${decision}`,
        reviewId: `review-${decision}`,
        candidateEventId: TeamEventId('event-16'),
        round: 0,
        decision,
      } as const
      await expect(decisionCtx.yuqiTeamOrchestrator.decideReview(request)).resolves.toMatchObject({ team: { status: decision === 'fail' ? 'failed' : 'cancelled' } })
      await expect(decisionCtx.yuqiTeamOrchestrator.decideReview(request)).resolves.toMatchObject({ team: { status: decision === 'fail' ? 'failed' : 'cancelled' } })
      await decisionFiber.dispose()
    }
  })

  it('reports blocked work and sends quality-gate stages to the bound parent conversation', async () => {
    const reportCtx = new Context()
    const reportHarness = harness(Session.create(SessionId('branch-parent-report')), reportCtx)
    const parentSession = Session.create(SessionId('branch-parent-report-main'))
    reportHarness.sessions.set(String(parentSession.id), parentSession)
    const inbox = new Inbox(parentSession, { inserted() {}, discarded() {}, claimed() {} })
    const send = vi.fn((message: Parameters<Agent['send']>[0], target: Parameters<Agent['send']>[1]) => {
      inbox.append(target, message)
    })
    const parent = {
      id: parentSession.id,
      session: parentSession,
      inbox,
      options: {},
      status: 'idle',
      ctx: reportCtx,
      steer: vi.fn(),
      send,
    } as unknown as Agent
    bind(reportHarness.agent.session, String(parent.id))
    append(reportHarness.agent.session, [
      event(330, { type: 'yuqi/team-created', title: 'Blocked report', objective: 'Notify the main conversation' }),
      event(331, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(332, { type: 'yuqi/task-created', contract: contract(TaskId('blocked-task')) }),
    ])
    exposeAgents(reportCtx, [reportHarness.agent, parent])
    const reportFiber = await reportCtx.plugin(YuqiTeamOrchestratorService)
    const reportJournal = new HarnessSessionJournal(reportHarness.agent.session, reportCtx.sessions)
    const before = replayTeamEvents(reportJournal.read())
    await reportCtx.yuqiTeamOrchestrator.persistScheduleState({
      teamId: 'team-1',
      journal: reportJournal,
      plan: {
        status: 'runnable', activeTaskIds: [], readyTaskIds: [], blockedTaskIds: [TaskId('blocked-task')],
        newlyBlockedTaskIds: [TaskId('blocked-task')], unblockedTaskIds: [], dispatchTaskIds: [], availableSlots: 1,
        sourceLastEventId: before.lastEventId, sourceLastEventAt: before.lastEventAt,
      },
      taskTransitions: [{ taskId: TaskId('blocked-task'), from: 'pending', to: 'blocked', reason: 'dependency is unavailable' }],
      requiresReconciliation: false,
      signal: new AbortController().signal,
    })
    const sourceEventCount = reportJournal.read().length
    const messageId = parentReportMessageId(String(reportHarness.agent.id), String(parent.id), 1, sourceEventCount)
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        id: messageId,
        content: [expect.objectContaining({ text: expect.stringMatching(/blocked-task \[blocked\]/u) })],
      }), 'next-turn', true)
      expect(inbox.nextTurn).toContainEqual(expect.objectContaining({ id: messageId }))
      expect(readLatestTeamParentReportCheckpoint(reportHarness.agent.session, String(parent.id), 1)).toMatchObject({
        sourceEventCount,
        messageId,
      })
    })
    await reportFiber.dispose()

    const completedCtx = new Context()
    const completedHarness = harness(Session.create(SessionId('branch-parent-completed')), completedCtx)
    const runningParentSession = Session.create(SessionId('branch-parent-completed-main'))
    completedHarness.sessions.set(String(runningParentSession.id), runningParentSession)
    const steer = vi.fn()
    const completedSend = vi.fn()
    const runningParent = {
      id: runningParentSession.id,
      session: runningParentSession,
      options: {},
      status: 'running',
      ctx: completedCtx,
      steer,
      send: completedSend,
      followup: vi.fn(),
    } as unknown as Agent
    bind(completedHarness.agent.session, String(runningParent.id))
    append(completedHarness.agent.session, completeTeamEvents().slice(0, -1))
    exposeAgents(completedCtx, [completedHarness.agent, runningParent])
    const completedFiber = await completedCtx.plugin(YuqiTeamOrchestratorService)
    const completedJournal = new HarnessSessionJournal(completedHarness.agent.session, completedCtx.sessions)
    await completedCtx.yuqiTeamOrchestrator.coordinateCompletion({
      controller: completedHarness.agent, teamId: 'team-1', journal: completedJournal, signal: new AbortController().signal,
    })
    expect(steer).not.toHaveBeenCalled()
    expect(completedSend).toHaveBeenCalledWith(expect.objectContaining({
      content: [expect.objectContaining({ text: expect.stringMatching(/teamStatus=completed/u) })],
    }), 'next-turn', true)
    await completedFiber.dispose()

    const reviewCtx = new Context()
    const reviewHarness = harness(Session.create(SessionId('branch-parent-awaiting-review')), reviewCtx)
    const reviewParentSession = Session.create(SessionId('branch-parent-awaiting-main'))
    reviewHarness.sessions.set(String(reviewParentSession.id), reviewParentSession)
    const reviewFollowup = vi.fn()
    const reviewParent = {
      id: reviewParentSession.id,
      session: reviewParentSession,
      options: {},
      status: 'idle',
      ctx: reviewCtx,
      steer: vi.fn(),
      followup: reviewFollowup,
    } as unknown as Agent
    bind(reviewHarness.agent.session, String(reviewParent.id))
    append(reviewHarness.agent.session, [
      event(340, {
        type: 'yuqi/team-created', title: 'Awaiting review', objective: 'Ask in the main conversation',
        reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 1, additionalPrompt: '' },
      }),
      ...completeTeamEvents().slice(1, -1),
      event(341, {
        type: 'yuqi/review-requested', reviewId: 'awaiting-review', trigger: 'quality-gate',
        candidateEventId: TeamEventId('event-16'), round: 0,
      }),
      event(342, {
        type: 'yuqi/review-result-recorded', reviewId: 'awaiting-review', candidateEventId: TeamEventId('event-16'),
        reviewerSessionId: 'reviewer-awaiting', decision: 'inconclusive', findings: [], unverified: ['manual decision'],
      }),
    ])
    exposeAgents(reviewCtx, [reviewHarness.agent, reviewParent])
    const reviewFiber = await reviewCtx.plugin(YuqiTeamOrchestratorService)
    const reviewJournal = new HarnessSessionJournal(reviewHarness.agent.session, reviewCtx.sessions)
    await reviewCtx.yuqiTeamOrchestrator.coordinateCompletion({
      controller: reviewHarness.agent, teamId: 'team-1', journal: reviewJournal, signal: new AbortController().signal,
    })
    expect(reviewFollowup).toHaveBeenCalledWith(expect.objectContaining({
      content: [expect.objectContaining({ text: expect.stringMatching(/stage=awaiting-user[\s\S]*review=awaiting-review[\s\S]*retry_review/u) })],
    }))
    await expect(reviewCtx.yuqiTeamOrchestrator.reviewTeam({
      controller: reviewHarness.agent, teamId: 'team-1', trigger: 'quality-gate', reviewId: 'awaiting-review',
    })).resolves.toMatchObject({ status: 'completed', result: { reviewId: 'awaiting-review', decision: 'inconclusive' } })
    await reviewFiber.dispose()
  })

  it('rebinds only to a fully durable same-project parent conversation', async () => {
    const cwd = process.cwd()
    const oldParentId = SessionId('branch-rebind-old-parent')
    const controllerId = SessionId('branch-rebind-controller')
    const destinationId = SessionId('branch-rebind-destination')
    const oldParent = Session.create(oldParentId, [], { version: 0, id: oldParentId, createdAt: 0, cwd })
    const controllerSession = Session.create(controllerId, [], {
      version: 0, id: controllerId, createdAt: 0, cwd, parentSession: oldParentId,
    })
    const destinationSession = Session.create(destinationId, [], { version: 0, id: destinationId, createdAt: 0, cwd })
    destinationSession.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: 'placeholder-parent', generation: 1, operationId: 'placeholder-binding', boundAt: '2026-08-31T00:00:00Z',
    })
    bind(controllerSession, String(oldParentId))
    append(controllerSession, completeTeamEvents().slice(0, 4))

    const durable = new Map<string, { meta: Session['header']; events: readonly Session['events'][number][] }>([
      [String(oldParentId), { meta: oldParent.header, events: oldParent.events }],
      [String(controllerId), { meta: controllerSession.header, events: controllerSession.events }],
    ])
    const ctx = new Context()
    ctx.provide('sessionPersistence', {
      load: async () => undefined,
      list: async () => [...durable.values()].map(value => value.meta),
      create: async (meta: Session['header']) => { durable.set(String(meta.id), { meta, events: [] }) },
      append: async (id: Session['id'], events: readonly Session['events'][number][]) => {
        const current = durable.get(String(id))!
        durable.set(String(id), { ...current, events: [...current.events, ...events] })
      },
      readFrom: async (id: Session['id'], from: number) => ({ events: durable.get(String(id))!.events.slice(from) }),
    } as never)
    const value = harness(controllerSession, ctx)
    value.sessions.set(String(oldParentId), oldParent)
    value.sessions.set(String(destinationId), destinationSession)
    const destination = {
      id: destinationId, session: destinationSession, options: {}, status: 'idle', ctx,
    } as unknown as Agent
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await expect(ctx.yuqiTeamOrchestrator.rebindTeam({
      controller: value.agent, teamId: 'team-1', parent: destination, operationId: 'rebind-durable-destination',
    })).resolves.toBeUndefined()
    expect(durable.get(String(destinationId))?.events).toHaveLength(2)
    const blankDestinationId = SessionId('branch-rebind-blank-destination')
    const blankDestinationSession = Session.create(blankDestinationId, [], {
      version: 0, id: blankDestinationId, createdAt: 0, cwd,
    })
    value.sessions.set(String(blankDestinationId), blankDestinationSession)
    await expect(ctx.yuqiTeamOrchestrator.rebindTeam({
      controller: value.agent,
      teamId: 'team-1',
      parent: {
        id: blankDestinationId, session: blankDestinationSession, options: {}, status: 'idle', ctx,
      } as unknown as Agent,
      operationId: 'rebind-blank-destination',
    })).resolves.toBeUndefined()
    expect(durable.get(String(blankDestinationId))?.events).toHaveLength(1)
    await fiber.dispose()

    const unboundCtx = new Context()
    const unboundId = SessionId('branch-rebind-unbound-controller')
    const unboundSession = Session.create(unboundId, [], { version: 0, id: unboundId, createdAt: 0, cwd })
    append(unboundSession, completeTeamEvents().slice(0, 4))
    const unbound = harness(unboundSession, unboundCtx)
    const unboundDestinationId = SessionId('branch-rebind-unbound-destination')
    const unboundDestinationSession = Session.create(unboundDestinationId, [], { version: 0, id: unboundDestinationId, createdAt: 0, cwd })
    unbound.sessions.set(String(unboundDestinationId), unboundDestinationSession)
    const unboundFiber = await unboundCtx.plugin(YuqiTeamOrchestratorService)
    await expect(unboundCtx.yuqiTeamOrchestrator.rebindTeam({
      controller: unbound.agent,
      teamId: 'team-1',
      parent: { id: unboundDestinationId, session: unboundDestinationSession, options: {}, status: 'idle', ctx: unboundCtx } as unknown as Agent,
      operationId: 'rebind-without-old-parent',
    })).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
    await unboundFiber.dispose()

    const incompleteCtx = new Context()
    const incompleteOldId = SessionId('branch-rebind-incomplete-old')
    const incompleteControllerId = SessionId('branch-rebind-incomplete-controller')
    const incompleteDestinationId = SessionId('branch-rebind-incomplete-destination')
    const incompleteOld = Session.create(incompleteOldId, [], { version: 0, id: incompleteOldId, createdAt: 0, cwd })
    const incompleteController = Session.create(incompleteControllerId, [], {
      version: 0, id: incompleteControllerId, createdAt: 0, cwd, parentSession: incompleteOldId,
    })
    const incompleteDestination = Session.create(incompleteDestinationId, [], { version: 0, id: incompleteDestinationId, createdAt: 0, cwd })
    incompleteDestination.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: 'placeholder-parent', generation: 1, operationId: 'incomplete-placeholder', boundAt: '2026-08-31T00:00:00Z',
    })
    bind(incompleteController, String(incompleteOldId))
    append(incompleteController, completeTeamEvents().slice(0, 4))
    const incompleteDurable = new Map<string, { meta: Session['header']; events: readonly Session['events'][number][] }>([
      [String(incompleteOldId), { meta: incompleteOld.header, events: [] }],
      [String(incompleteControllerId), { meta: incompleteController.header, events: incompleteController.events }],
    ])
    incompleteCtx.provide('sessionPersistence', {
      load: async () => undefined,
      list: async () => [...incompleteDurable.values()].map(value => value.meta),
      create: async (meta: Session['header']) => { incompleteDurable.set(String(meta.id), { meta, events: [] }) },
      append: async () => undefined,
      readFrom: async () => ({ events: [] }),
    } as never)
    const incompleteHarness = harness(incompleteController, incompleteCtx)
    incompleteHarness.sessions.set(String(incompleteOldId), incompleteOld)
    incompleteHarness.sessions.set(String(incompleteDestinationId), incompleteDestination)
    const incompleteFiber = await incompleteCtx.plugin(YuqiTeamOrchestratorService)
    await expect(incompleteCtx.yuqiTeamOrchestrator.rebindTeam({
      controller: incompleteHarness.agent,
      teamId: 'team-1',
      parent: {
        id: incompleteDestinationId, session: incompleteDestination, options: {}, status: 'idle', ctx: incompleteCtx,
      } as unknown as Agent,
      operationId: 'rebind-incomplete-destination',
    })).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
    await incompleteFiber.dispose()
  })
})

function parentReportHarness(options: {
  readonly bind?: boolean
  readonly bridge?: boolean
  readonly parentId?: string
  readonly flush?: (session: Session) => boolean | Promise<boolean>
  readonly send?: (message: Parameters<Agent['send']>[0], parentSession: Session) => void
} = {}) {
  const controllerId = SessionId('coverage-report-controller')
  const parentId = SessionId(options.parentId ?? 'coverage-report-parent')
  const controllerSession = Session.create(controllerId)
  const parentSession = Session.create(parentId)
  append(controllerSession, completeTeamEvents())
  if (options.bind !== false) bind(controllerSession, String(parentId))
  if (options.bridge !== false) {
    parentSession.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(controllerId), bindingGeneration: 1,
      activationGeneration: 1, bridgeRevision: 1,
      sourceEventCount: completeTeamEvents().length, events: completeTeamEvents(),
    })
  }
  const inbox = new Inbox(parentSession, { inserted() {}, discarded() {}, claimed() {} })
  const parent = {
    id: parentId,
    session: parentSession,
    inbox,
    send(message: Parameters<Agent['send']>[0], target: Parameters<Agent['send']>[1]) {
      if (options.send !== undefined) return options.send(message, parentSession)
      inbox.append(target, message)
    },
  } as unknown as Agent
  const controller = { id: controllerId, session: controllerSession } as unknown as Agent
  const sessions = { flush: vi.fn(async (session: Session) => options.flush?.(session) ?? true) }
  const journal = new HarnessSessionJournal(controllerSession, sessions)
  return {
    controller, parent, parentSession, journal, sessions,
    request: () => ({ controller, parent, journal, sessions, now: () => new Date('2026-09-01T01:00:00.000Z') }),
  }
}

describe('durable parent report residual branch coverage', () => {
  it('rejects a foreign journal and keeps missing binding, parent, and projection recoverable', async () => {
    const value = parentReportHarness()
    const foreignSession = Session.create(SessionId('coverage-report-foreign'))
    const foreignJournal = new HarnessSessionJournal(foreignSession, value.sessions)
    await expect(deliverParentReport({ ...value.request(), journal: foreignJournal })).rejects.toThrow(/does not belong/u)

    const unbound = parentReportHarness({ bind: false })
    await expect(deliverParentReport(unbound.request())).resolves.toEqual({ kind: 'pending', reason: 'binding-unavailable' })
    await expect(deliverParentReport({ ...value.request(), parent: undefined })).resolves.toEqual({ kind: 'pending', reason: 'parent-offline' })

    const wrongParent = parentReportHarness({ parentId: 'coverage-report-wrong-parent' })
    await expect(deliverParentReport({ ...value.request(), parent: wrongParent.parent })).resolves.toEqual({ kind: 'pending', reason: 'parent-offline' })
    const noBridge = parentReportHarness({ bridge: false })
    await expect(deliverParentReport(noBridge.request())).resolves.toEqual({ kind: 'pending', reason: 'projection-unavailable' })
  })

  it('propagates an uncommitted send failure but accepts the same deterministic user-message write', async () => {
    const failed = parentReportHarness({ send: () => { throw new Error('send failed') } })
    await expect(deliverParentReport(failed.request())).rejects.toThrow('send failed')

    const replayed = parentReportHarness({
      send(message, parentSession) {
        parentSession.append('user/message', { message } as never, { surfaceOp: 'append' })
        throw new Error('concurrent deterministic insert')
      },
    })
    await expect(deliverParentReport(replayed.request())).resolves.toMatchObject({
      kind: 'delivered', replayedInboxWrite: false,
    })
  })

  it('returns retryable results for thrown parent flushes and checkpoint failures', async () => {
    const flushFailure = parentReportHarness({ flush: async () => { throw new Error('flush offline') } })
    await expect(deliverParentReport(flushFailure.request())).resolves.toMatchObject({
      kind: 'pending', reason: 'parent-flush-failed',
    })

    const checkpointFailure = parentReportHarness()
    vi.spyOn(checkpointFailure.journal, 'commitParentReportCheckpoint').mockRejectedValueOnce(new Error('checkpoint offline'))
    await expect(deliverParentReport(checkpointFailure.request())).resolves.toMatchObject({
      kind: 'pending', reason: 'checkpoint-failed',
    })
  })

  it('selects the newest compatible bridge revision across malformed and stale candidates', async () => {
    const value = parentReportHarness({ bridge: false })
    const bridge = {
      controllerSessionId: String(value.controller.id), bindingGeneration: 1,
      activationGeneration: 1, sourceEventCount: completeTeamEvents().length, events: completeTeamEvents(),
    }
    value.parentSession.append(TEAM_PARENT_PROJECTION_EVENT, { invalid: true } as never)
    value.parentSession.append(TEAM_PARENT_PROJECTION_EVENT, { ...bridge, controllerSessionId: 'other-controller' })
    value.parentSession.append(TEAM_PARENT_PROJECTION_EVENT, { ...bridge, bindingGeneration: 2 })
    value.parentSession.append(TEAM_PARENT_PROJECTION_EVENT, bridge)
    value.parentSession.append(TEAM_PARENT_PROJECTION_EVENT, { ...bridge, bridgeRevision: 1 })
    value.parentSession.append(TEAM_PARENT_PROJECTION_EVENT, bridge)
    value.parentSession.append(TEAM_PARENT_PROJECTION_EVENT, { ...bridge, bridgeRevision: 1 })
    value.parentSession.append(TEAM_PARENT_PROJECTION_EVENT, { ...bridge, bridgeRevision: 2 })
    await expect(deliverParentReport(value.request())).resolves.toMatchObject({ kind: 'delivered' })
  })

  it('supports legacy generation-zero bridges and skips malformed user-message envelopes', async () => {
    const parentId = SessionId('coverage-legacy-parent')
    const controllerId = SessionId('coverage-legacy-controller')
    const parentSession = Session.create(parentId)
    const controllerSession = Session.create(controllerId, [], {
      version: 0, id: controllerId, createdAt: 0, parentSession: parentId,
    })
    append(controllerSession, completeTeamEvents())
    const bridge = {
      controllerSessionId: String(controllerId),
      sourceEventCount: completeTeamEvents().length, events: completeTeamEvents(),
    }
    parentSession.append(TEAM_PARENT_PROJECTION_EVENT, bridge)
    parentSession.append(TEAM_PARENT_PROJECTION_EVENT, bridge)
    parentSession.append('user/message', { message: 'malformed' } as never, { surfaceOp: 'append' })
    const inbox = new Inbox(parentSession, { inserted() {}, discarded() {}, claimed() {} })
    const parent = {
      id: parentId, session: parentSession, inbox,
      send(message: Parameters<Agent['send']>[0], target: Parameters<Agent['send']>[1]) { inbox.append(target, message) },
    } as unknown as Agent
    const controller = { id: controllerId, session: controllerSession } as unknown as Agent
    const sessions = { flush: vi.fn(async () => true) }
    const journal = new HarnessSessionJournal(controllerSession, sessions)
    await expect(deliverParentReport({ controller, parent, journal, sessions })).resolves.toMatchObject({ kind: 'delivered' })
  })

  it.each(['zh', 'en'] as const)('truncates a large %s controller report with a localized suffix', locale => {
    const facts = [
      event(9_000, { type: 'yuqi/team-created', title: 'Large report', objective: 'Bound output', locale }),
      event(9_001, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      ...Array.from({ length: 30 }, (_, index) => event(9_010 + index, {
        type: 'yuqi/task-created',
        contract: { ...contract(TaskId(`large-report-${index}`)), goal: `${index}-${'x'.repeat(1_000)}` },
      })),
    ]
    const report = buildBoundedParentReport({
      controllerSessionId: `large-${locale}`, sourceEventCount: facts.length, events: facts,
    }, 3)
    expect(report).toHaveLength(PARENT_REPORT_MAX_CHARS)
    expect(report.endsWith(locale === 'en' ? '[report truncated]' : '[报告已截断]')).toBe(true)
  })
})

describe('Host service internal boundary branch coverage', () => {
  it('updates the live parent projection when a cold controller has no public SessionStore entry', async () => {
    const ctx = new Context()
    const controllerSession = Session.create(SessionId('yuqi-team-cold-projection-controller'))
    const parentSession = Session.create(SessionId('cold-projection-live-parent'))
    bind(controllerSession, String(parentSession.id))
    append(controllerSession, completeTeamEvents().slice(0, 8))
    const durable = new Map<string, { meta: Session['header']; events: Session['events'] }>([
      [String(controllerSession.id), { meta: controllerSession.header, events: [...controllerSession.events] }],
      [String(parentSession.id), { meta: parentSession.header, events: [] }],
    ])
    ctx.provide('sessionPersistence', {
      load: async (id: SessionId) => durable.get(String(id)),
      readFrom: async (id: SessionId, from: number) => ({ events: durable.get(String(id))?.events.slice(from) ?? [] }),
      append: async (id: SessionId, events: Session['events']) => {
        const current = durable.get(String(id))!
        durable.set(String(id), { ...current, events: [...current.events, ...events] })
      },
      list: async () => [...durable.values()].map(item => item.meta),
    } as never)
    ctx.provide('sessions', {
      // The controller is present, but the parent is only discoverable through
      // the live Agent registry, matching the post-restart Host race.
      get: (id: SessionId) => String(id) === String(controllerSession.id) ? controllerSession : undefined,
      list: () => [controllerSession],
      flush: async () => false,
    } as never)
    const value = harness(controllerSession, ctx)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const service = ctx.yuqiTeamOrchestrator as unknown as {
      controllerAgents?: { get(id: SessionId): Agent | undefined }
      syncProjectionToDurableParent(session: Session): Promise<boolean>
    }
    service.controllerAgents = {
      get: id => String(id) === String(parentSession.id)
        ? { id: parentSession.id, session: parentSession } as unknown as Agent
        : undefined,
    }

    await expect(service.syncProjectionToDurableParent(controllerSession)).resolves.toBe(true)
    const bridge = parentSession.events
      .map(item => item.type === TEAM_PARENT_PROJECTION_EVENT ? parseTeamProjectionBridgeData(item.data) : undefined)
      .find(item => item !== undefined)
    expect(bridge).toBeDefined()
    expect(replayTeamEvents(bridge!.events).team.status).toBe('needs_reconciliation')
    expect(durable.get(String(parentSession.id))?.events).toHaveLength(parentSession.events.length)
    expect(value.agent.id).toBe(controllerSession.id)
    await fiber.dispose()
  })

  it('hydrates a stale live parent from a durable projection tail', async () => {
    const ctx = new Context()
    const controllerSession = Session.create(SessionId('yuqi-team-stale-parent-controller'))
    const parentSession = Session.create(SessionId('stale-parent-live-copy'))
    const persistedParent = Session.create(SessionId('stale-parent-live-copy'), [], parentSession.header)
    bind(controllerSession, String(parentSession.id))
    append(controllerSession, completeTeamEvents().slice(0, 4))
    const durable = new Map<string, { meta: Session['header']; events: Session['events'] }>([
      [String(parentSession.id), { meta: parentSession.header, events: [] }],
    ])
    ctx.provide('sessionPersistence', {
      load: async (id: SessionId) => durable.get(String(id)),
      readFrom: async (id: SessionId, index: number) => ({ events: durable.get(String(id))?.events.slice(index) ?? [] }),
      append: async () => { throw new Error('projection seed must use the isolated parent copy') },
      list: async () => [],
    } as never)
    harness(Session.create(SessionId('stale-parent-host')), ctx)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await expect(syncTeamProjectionToParent(controllerSession, {
      get: id => String(id) === String(parentSession.id) ? persistedParent : undefined,
      flush: async session => {
        durable.set(String(session.id), { meta: session.header, events: [...session.events] })
        return true
      },
    })).resolves.toBe(true)

    const service = ctx.yuqiTeamOrchestrator as unknown as {
      controllerAgents?: { get(id: SessionId): Agent | undefined }
      syncProjectionToDurableParent(session: Session): Promise<boolean>
    }
    service.controllerAgents = {
      get: id => String(id) === String(parentSession.id)
        ? { id: parentSession.id, session: parentSession } as unknown as Agent
        : undefined,
    }
    await expect(service.syncProjectionToDurableParent(controllerSession)).resolves.toBe(true)
    expect(parentSession.events.filter(event => event.type === TEAM_PARENT_PROJECTION_EVENT)).toHaveLength(1)
    await fiber.dispose()
  })

  it('controls a live Team by durable identity without crossing controller boundaries', async () => {
    const missingCtx = new Context()
    harness(Session.create(SessionId('coverage-identity-missing')), missingCtx)
    const missingFiber = await missingCtx.plugin(YuqiTeamOrchestratorService)
    await expect(missingCtx.yuqiTeamOrchestrator.controlTeamByIdentity({
      controllerSessionId: 'missing-controller', teamId: 'team-1', operationId: 'identity-missing', action: 'cancel',
    })).resolves.toBeUndefined()
    await missingFiber.dispose()

    const mismatchCtx = new Context()
    const mismatch = harness(Session.create(SessionId('yuqi-team-coverage-identity-mismatch')), mismatchCtx)
    append(mismatch.agent.session, completeTeamEvents().slice(0, 4))
    exposeAgents(mismatchCtx, [mismatch.agent])
    const mismatchFiber = await mismatchCtx.plugin(YuqiTeamOrchestratorService)
    await expect(mismatchCtx.yuqiTeamOrchestrator.controlTeamByIdentity({
      controllerSessionId: String(mismatch.agent.id), teamId: 'wrong-team', operationId: 'identity-mismatch', action: 'cancel',
    })).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    await mismatchFiber.dispose()

    const runningCtx = new Context()
    const running = harness(Session.create(SessionId('yuqi-team-coverage-identity-running')), runningCtx)
    append(running.agent.session, completeTeamEvents().slice(0, 4))
    exposeAgents(runningCtx, [running.agent])
    const runningFiber = await runningCtx.plugin(YuqiTeamOrchestratorService)
    await expect(runningCtx.yuqiTeamOrchestrator.controlTeamByIdentity({
      controllerSessionId: String(running.agent.id), teamId: 'team-1', operationId: 'identity-cancel-running', action: 'cancel',
    })).resolves.toMatchObject({ team: { status: 'cancelled' } })
    await expect(runningCtx.yuqiTeamOrchestrator.controlTeamByIdentity({
      controllerSessionId: String(running.agent.id), teamId: 'team-1', operationId: 'identity-cancel-idempotent', action: 'cancel',
    })).resolves.toMatchObject({ team: { status: 'cancelled' } })
    await runningFiber.dispose()

    const recoveryCtx = new Context()
    const recovery = harness(Session.create(SessionId('yuqi-team-coverage-identity-recovery')), recoveryCtx)
    append(recovery.agent.session, [
      ...completeTeamEvents().slice(0, 4),
      event(9_090, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ])
    exposeAgents(recoveryCtx, [recovery.agent])
    const recoveryFiber = await recoveryCtx.plugin(YuqiTeamOrchestratorService)
    await expect(recoveryCtx.yuqiTeamOrchestrator.controlTeamByIdentity({
      controllerSessionId: String(recovery.agent.id), teamId: 'team-1', operationId: 'identity-recovery-no-binding', action: 'cancel',
    })).resolves.toBeUndefined()
    await recoveryFiber.dispose()

    const boundCtx = new Context()
    const bound = harness(Session.create(SessionId('yuqi-team-coverage-identity-bound')), boundCtx)
    bind(bound.agent.session, 'coverage-identity-parent')
    append(bound.agent.session, [
      ...completeTeamEvents().slice(0, 4),
      event(9_091, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ])
    exposeAgents(boundCtx, [bound.agent])
    const boundFiber = await boundCtx.plugin(YuqiTeamOrchestratorService)
    await expect(boundCtx.yuqiTeamOrchestrator.controlTeamByIdentity({
      controllerSessionId: String(bound.agent.id), teamId: 'team-1', operationId: 'identity-bound-cancel', action: 'cancel',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ team: { status: 'cancelled' } })
    await boundFiber.dispose()

    const reconcileCtx = new Context()
    const reconcile = harness(Session.create(SessionId('yuqi-team-coverage-identity-reconcile')), reconcileCtx)
    append(reconcile.agent.session, [
      ...completeTeamEvents().slice(0, 4),
      event(9_092, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ])
    exposeAgents(reconcileCtx, [reconcile.agent])
    const reconcileFiber = await reconcileCtx.plugin(YuqiTeamOrchestratorService)
    await expect(reconcileCtx.yuqiTeamOrchestrator.controlTeamByIdentity({
      controllerSessionId: String(reconcile.agent.id), teamId: 'team-1', operationId: 'identity-reconcile', action: 'reconcile',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'RECONCILIATION_NOT_ALLOWED' })
    await reconcileFiber.dispose()

    for (const [label, facts, expected] of [
      ['empty', [], 'TEAM_MISMATCH'],
      ['mismatch', completeTeamEvents().map(item => ({ ...item, teamId: 'different-team' })), 'TEAM_MISMATCH'],
    ] as const) {
      const coldCtx = new Context()
      const coldSession = Session.create(SessionId(`yuqi-team-coverage-identity-cold-${label}`))
      append(coldSession, facts as never)
      coldCtx.provide('sessionPersistence', {
        load: async (id: SessionId) => id === coldSession.id
          ? { meta: coldSession.header, events: coldSession.events }
          : undefined,
      } as never)
      harness(Session.create(SessionId(`coverage-identity-cold-host-${label}`)), coldCtx)
      const coldFiber = await coldCtx.plugin(YuqiTeamOrchestratorService)
      await expect(coldCtx.yuqiTeamOrchestrator.controlTeamByIdentity({
        controllerSessionId: String(coldSession.id), teamId: 'team-1', operationId: `identity-cold-${label}`, action: 'cancel',
      })).rejects.toMatchObject({ code: expected })
      await coldFiber.dispose()
    }

    const coldCancelledCtx = new Context()
    const coldCancelled = Session.create(SessionId('yuqi-team-coverage-identity-cold-cancelled'))
    append(coldCancelled, [
      ...completeTeamEvents().slice(0, 4),
      event(9_093, { type: 'yuqi/team-control-requested', operationId: 'identity-cold-cancel' as never, action: 'cancel' }),
      event(9_094, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling' }),
      event(9_095, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'ready', to: 'cancelled' }),
      event(9_096, { type: 'yuqi/team-status-changed', from: 'cancelling', to: 'cancelled' }),
    ])
    coldCancelledCtx.provide('sessionPersistence', {
      load: async (id: SessionId) => id === coldCancelled.id
        ? { meta: coldCancelled.header, events: coldCancelled.events }
        : undefined,
    } as never)
    harness(Session.create(SessionId('coverage-identity-cold-cancelled-host')), coldCancelledCtx)
    const coldCancelledFiber = await coldCancelledCtx.plugin(YuqiTeamOrchestratorService)
    await expect(coldCancelledCtx.yuqiTeamOrchestrator.controlTeamByIdentity({
      controllerSessionId: String(coldCancelled.id), teamId: 'team-1', operationId: 'identity-cold-cancelled', action: 'cancel',
    })).resolves.toMatchObject({ team: { status: 'cancelled' } })
    await coldCancelledFiber.dispose()

    const coldUnboundCtx = new Context()
    const coldUnbound = Session.create(SessionId('yuqi-team-coverage-identity-cold-unbound'))
    append(coldUnbound, completeTeamEvents().slice(0, 4))
    coldUnboundCtx.provide('sessionPersistence', {
      load: async (id: SessionId) => id === coldUnbound.id
        ? { meta: coldUnbound.header, events: coldUnbound.events }
        : undefined,
    } as never)
    harness(Session.create(SessionId('coverage-identity-cold-unbound-host')), coldUnboundCtx)
    const coldUnboundFiber = await coldUnboundCtx.plugin(YuqiTeamOrchestratorService)
    await expect(coldUnboundCtx.yuqiTeamOrchestrator.controlTeamByIdentity({
      controllerSessionId: String(coldUnbound.id), teamId: 'team-1', operationId: 'identity-cold-unbound', action: 'reconcile',
    })).resolves.toBeUndefined()
    await coldUnboundFiber.dispose()

    const syncedCtx = new Context()
    const syncedController = Session.create(SessionId('yuqi-team-coverage-identity-cold-synced'))
    const syncedParent = Session.create(SessionId('coverage-identity-synced-parent'))
    bind(syncedController, String(syncedParent.id))
    append(syncedController, completeTeamEvents().slice(0, 4))
    const durable = new Map<string, { meta: Session['header']; events: Session['events'] }>([
      [String(syncedController.id), { meta: syncedController.header, events: [...syncedController.events] }],
      [String(syncedParent.id), { meta: syncedParent.header, events: [...syncedParent.events] }],
    ])
    syncedCtx.provide('sessionPersistence', {
      load: async (id: SessionId) => durable.get(String(id)),
      readFrom: async (id: SessionId, index: number) => {
        const stored = durable.get(String(id))
        return stored === undefined ? { events: [] } : { meta: stored.meta, events: stored.events.slice(index) }
      },
      append: async (id: SessionId, events: Session['events']) => {
        const stored = durable.get(String(id))!
        durable.set(String(id), { meta: stored.meta, events: [...stored.events, ...events] })
      },
      list: async () => [],
    } as never)
    harness(Session.create(SessionId('coverage-identity-cold-synced-host')), syncedCtx)
    const syncedFiber = await syncedCtx.plugin(YuqiTeamOrchestratorService)
    const syncedService = syncedCtx.yuqiTeamOrchestrator as unknown as {
      controlDormantTeam(request: unknown): Promise<ReturnType<typeof replayTeamEvents>>
      syncProjectionToDurableParent(session: Session): Promise<boolean>
      controllerAgents?: { get(id: SessionId): Agent | undefined }
    }
    const syncedProjection = replayTeamEvents(new HarnessSessionJournal(syncedController, {
      get: () => syncedController, flush: async () => true,
    }).read())
    vi.spyOn(syncedService, 'controlDormantTeam').mockResolvedValue(syncedProjection)
    await expect(syncedCtx.yuqiTeamOrchestrator.controlTeamByIdentity({
      controllerSessionId: String(syncedController.id), teamId: 'team-1', operationId: 'identity-cold-synced', action: 'reconcile',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ team: { status: 'running' } })
    expect(durable.get(String(syncedParent.id))!.events.length).toBeGreaterThan(0)

    syncedService.controllerAgents = { get: id => String(id) === String(syncedParent.id)
      ? { id: syncedParent.id, session: syncedParent } as unknown as Agent
      : undefined }
    await expect(syncedService.syncProjectionToDurableParent(syncedController)).resolves.toBe(true)
    await syncedFiber.dispose()
  })

  it('fails closed at unowned runner, mismatched projection, and unsupported verification boundaries', async () => {
    const ctx = new Context()
    const value = harness(Session.create(SessionId('coverage-service-boundaries')), ctx)
    append(value.agent.session, completeTeamEvents())
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const service = ctx.yuqiTeamOrchestrator as unknown as {
      subprocessRuntime(): unknown
      projectionForTeam(journal: HarnessSessionJournal, teamId: string): unknown
      wakeTeamRunner(journal: HarnessSessionJournal, teamId: string, reason: string): void
      assertRunnableTeamRunner(journalKey: string, action: string): void
      acquireRunnerWakeLease(journalKey: string, action: string): unknown
      releaseTeamRunner(journalKey: string, reason: string): void
      assertVerificationReadiness(tasks: readonly unknown[]): void
      childPort(controller: Agent): unknown
    }
    const journal = new HarnessSessionJournal(value.agent.session, ctx.sessions)
    expect(service.subprocessRuntime()).toBeUndefined()
    expect(() => service.projectionForTeam(journal, 'wrong-team')).toThrow(/does not own/u)
    expect(() => service.wakeTeamRunner(journal, 'team-1', 'coverage wake')).toThrow(/does not own a runnable controller/u)
    expect(() => service.assertRunnableTeamRunner(journal.key, 'coverage action')).toThrow(/no registered runner/u)
    expect(() => service.acquireRunnerWakeLease(journal.key, 'coverage lease')).toThrow(/no registered runner/u)
    expect(() => service.releaseTeamRunner('missing-runner', 'coverage release')).not.toThrow()
    expect(() => service.assertVerificationReadiness([{
      ...contract(TaskId('unsupported-verification')),
      verificationChecks: [{ checkId: 'screenshot', kind: 'screenshot' }],
    }])).toThrow(/cannot start verification/u)
    expect(service.childPort(value.agent)).toBe(service.childPort(value.agent))
    await fiber.dispose()
  })

  it.each([
    ['pre-completion', 'pre-completion review 需要已完成的 Team projection'],
    ['consecutive-failure', '当前没有两次可核验的连续失败'],
  ] as const)('localizes the %s public review skip without launching a reviewer', async (trigger, expected) => {
    const ctx = new Context()
    const value = harness(Session.create(SessionId(`coverage-review-skip-${trigger}`)), ctx)
    append(value.agent.session, [
      event(9_100, {
        type: 'yuqi/team-created', title: 'Review skip', objective: 'Exercise skip localization',
        reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 1, additionalPrompt: '' },
      }),
      event(9_101, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(9_102, { type: 'yuqi/task-created', contract: contract(TaskId('review-skip-task')) }),
      event(9_103, { type: 'yuqi/task-created', contract: contract(TaskId('review-skip-task-2')) }),
    ])
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await expect(ctx.yuqiTeamOrchestrator.reviewTeam({
      controller: value.agent, teamId: 'team-1', trigger,
    })).resolves.toMatchObject({ status: 'skipped', reason: expected })
    await fiber.dispose()
  })

  it('fails a plan review closed when neither durable facts nor the controller provide a model route', async () => {
    const ctx = new Context()
    const value = harness(Session.create(SessionId('coverage-review-no-route')), ctx, {})
    const workspaceId = 'coverage-review-workspace' as never
    append(value.agent.session, [
      event(9_200, {
        type: 'yuqi/team-created', title: 'No route review', objective: 'Fail closed without a model',
        reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 1, additionalPrompt: '' },
      }),
      event(9_201, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(9_202, { type: 'yuqi/task-created', contract: contract(TaskId('no-route-task')) }),
      event(9_203, {
        type: 'yuqi/workspace-provisioning-started',
        workspace: {
          workspaceId,
          project: { projectRoot: process.cwd(), repositoryRoot: process.cwd(), gitCommonDirectory: process.cwd(), baselineRef: 'base', volumeRoot: 'F:\\', protectedRoots: [] },
          worktreePath: process.cwd(), branchName: 'yuqi/no-route', status: 'provisioning',
        },
      }),
      event(9_204, { type: 'yuqi/workspace-provisioned', workspaceId }),
    ])
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await expect(ctx.yuqiTeamOrchestrator.reviewTeam({
      controller: value.agent, teamId: 'team-1', trigger: 'plan-confirmation',
      checkpointSubject: 'team-plan', checkpointAnchor: { eventId: 'event-9200' }, candidateEventId: 'event-9200',
    } as never)).rejects.toMatchObject({ code: 'FIXED_MODEL_INVALID' })
    await fiber.dispose()
  })

  it('resolves exact, automatic-tier, automatic-default, and inherited public model routes', async () => {
    const exact = await routedService(
      'coverage-exact',
      { kind: 'exact', model: { modelProvider: 'external-provider', modelId: 'exact-model' } },
      { kind: 'inherit' },
    )
    await expect(exact.ctx.yuqiTeamOrchestrator.resolveTaskModelRoute({
      controller: exact.value.agent, teamId: 'team-1', taskId: 'task-1',
    })).resolves.toMatchObject({
      route: { modelProvider: 'external-provider', modelId: 'exact-model' }, routeBasis: 'task-exact',
    })
    await exact.fiber.dispose()

    const exactUnderAutomatic = await routedService(
      'coverage-exact-under-automatic',
      { kind: 'exact', model: { modelProvider: 'external-provider', modelId: 'automatic-exact-model' } },
      { kind: 'automatic', tierCandidates: { quick: [], standard: [], critical: [] } },
    )
    await expect(exactUnderAutomatic.ctx.yuqiTeamOrchestrator.resolveTaskModelRoute({
      controller: exactUnderAutomatic.value.agent, teamId: 'team-1', taskId: 'task-1',
    })).resolves.toMatchObject({
      route: { modelProvider: 'external-provider', modelId: 'automatic-exact-model' }, routeBasis: 'task-exact',
    })
    await exactUnderAutomatic.fiber.dispose()

    const tier = await routedService(
      'coverage-tier',
      { kind: 'tier', tier: 'critical' },
      { kind: 'automatic', tierCandidates: {
        quick: [], standard: [], critical: [{ modelProvider: 'controller-provider', modelId: 'critical-model' }],
      } },
    )
    await expect(tier.ctx.yuqiTeamOrchestrator.resolveTaskModelRoute({
      controller: tier.value.agent, teamId: 'team-1', taskId: 'task-1',
    })).resolves.toMatchObject({
      route: { modelProvider: 'controller-provider', modelId: 'critical-model' },
      routeBasis: 'automatic', requestedTier: 'critical',
    })
    await tier.fiber.dispose()

    const automaticDefault = await routedService(
      'coverage-automatic-default',
      { kind: 'default' },
      { kind: 'automatic', tierCandidates: {
        quick: [], standard: [{ modelProvider: 'controller-provider', modelId: 'standard-model' }], critical: [],
      } },
    )
    await expect(automaticDefault.ctx.yuqiTeamOrchestrator.resolveTaskModelRoute({
      controller: automaticDefault.value.agent, teamId: 'team-1', taskId: 'task-1',
    })).resolves.toMatchObject({
      route: { modelProvider: 'controller-provider', modelId: 'standard-model' },
      routeBasis: 'automatic', requestedTier: 'standard',
    })
    await automaticDefault.fiber.dispose()

    const inherited = await routedService(
      'coverage-inherited', { kind: 'default' }, { kind: 'inherit' },
    )
    await expect(inherited.ctx.yuqiTeamOrchestrator.resolveTaskModelRoute({
      controller: inherited.value.agent, teamId: 'team-1', taskId: 'task-1',
    })).resolves.toMatchObject({
      route: { modelProvider: 'controller-provider', modelId: 'controller-model' },
      routeBasis: 'controller-inherit', fallbackReason: 'task-default-controller-inherit',
    })
    await inherited.fiber.dispose()
  })

  it('covers public task model, authority, and message validation plus successful relay', async () => {
    const readyCtx = new Context()
    const ready = harness(Session.create(SessionId('coverage-task-controls-ready')), readyCtx)
    append(ready.agent.session, completeTeamEvents().slice(0, 4))
    const readyFiber = await readyCtx.plugin(YuqiTeamOrchestratorService)
    const service = readyCtx.yuqiTeamOrchestrator

    await expect(service.setTaskModel({
      controller: ready.agent, teamId: 'team-1', taskId: 'task-1', providerId: 'external-provider',
      modelId: 'replacement-model', operationId: 'coverage-model-change',
    })).resolves.toMatchObject({
      tasks: { 'task-1': { contract: { revision: 2, modelRequest: {
        kind: 'exact', model: { modelProvider: 'external-provider', modelId: 'replacement-model' },
      } } } },
    })
    await expect(service.setTaskModel({
      controller: ready.agent, teamId: 'team-1', taskId: 'task-1', providerId: 'external-provider',
      modelId: 'replacement-model', operationId: 'coverage-model-same',
    })).resolves.toMatchObject({ tasks: { 'task-1': { contract: { revision: 2 } } } })
    await expect(service.setTaskModel({
      controller: ready.agent, teamId: 'team-1', taskId: 'task-1', modelId: '', operationId: 'coverage-model-empty',
    })).rejects.toMatchObject({ code: 'FIXED_MODEL_INVALID' })
    await expect(service.setTaskModel({
      controller: ready.agent, teamId: 'team-1', taskId: 'task-1', providerId: ' ',
      modelId: 'model', operationId: 'coverage-provider-empty',
    })).rejects.toMatchObject({ code: 'FIXED_MODEL_INVALID' })
    await expect(service.setTaskModel({
      controller: ready.agent, teamId: 'team-1', taskId: 'missing-task',
      modelId: 'model', operationId: 'coverage-model-missing',
    })).rejects.toMatchObject({ code: 'INVALID_BATCH' })

    await expect(service.setTaskAuthority({
      controller: ready.agent, teamId: 'team-1', taskId: 'task-1',
      authorityMode: 'read-only', operationId: 'coverage-authority-change',
    })).resolves.toMatchObject({ tasks: { 'task-1': { contract: { revision: 3, authorityMode: 'read-only' } } } })
    await expect(service.setTaskAuthority({
      controller: ready.agent, teamId: 'team-1', taskId: 'task-1',
      authorityMode: 'read-only', operationId: 'coverage-authority-same',
    })).resolves.toMatchObject({ tasks: { 'task-1': { contract: { revision: 3 } } } })
    await expect(service.setTaskAuthority({
      controller: ready.agent, teamId: 'team-1', taskId: 'missing-task',
      authorityMode: 'read-only', operationId: 'coverage-authority-missing',
    })).rejects.toMatchObject({ code: 'INVALID_BATCH' })
    for (const message of ['', 'x'.repeat(16_385)]) {
      await expect(service.sendTaskMessage({
        controller: ready.agent, teamId: 'team-1', taskId: 'task-1', message,
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'INVALID_BATCH' })
    }
    await expect(service.sendTaskMessage({
      controller: ready.agent, teamId: 'team-1', taskId: 'task-1', message: 'continue',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' })
    await readyFiber.dispose()

    const runningCtx = new Context()
    const running = harness(Session.create(SessionId('coverage-task-message-running')), runningCtx)
    append(running.agent.session, completeTeamEvents().slice(0, 8))
    const runningFiber = await runningCtx.plugin(YuqiTeamOrchestratorService)
    await expect(runningCtx.yuqiTeamOrchestrator.sendTaskMessage({
      controller: running.agent, teamId: 'team-1', taskId: 'task-1', message: '  proceed  ',
      signal: new AbortController().signal,
    })).resolves.toEqual({ childSessionId: 'session-worker-1', messageId: 'branch-send-message' })
    // Delivery is confirmed by the returned messageId, not by an injected echo.
    expect(running.agent.inject).not.toHaveBeenCalled()
    await runningFiber.dispose()
  })

  it('reports pending, running, failed, and verified task states through the public report API', async () => {
    async function reports(label: string, facts: readonly ReturnType<typeof event>[]) {
      const ctx = new Context()
      const value = harness(Session.create(SessionId(`coverage-task-report-${label}`)), ctx)
      append(value.agent.session, facts)
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      return { ctx, value, fiber }
    }

    const pending = await reports('pending', completeTeamEvents().slice(0, 3))
    await expect(pending.ctx.yuqiTeamOrchestrator.readTeamTaskReports({
      controller: pending.value.agent, teamId: 'team-1',
    })).resolves.toEqual([{ taskId: 'task-1', status: 'pending' }])
    await expect(pending.ctx.yuqiTeamOrchestrator.readTeamTaskReports({
      controller: pending.value.agent, teamId: 'wrong-team',
    })).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    const aborted = new AbortController(); aborted.abort()
    await expect(pending.ctx.yuqiTeamOrchestrator.readTeamTaskReports({
      controller: pending.value.agent, teamId: 'team-1', signal: aborted.signal,
    })).rejects.toThrow()
    await pending.fiber.dispose()

    const running = await reports('running', completeTeamEvents().slice(0, 8))
    await expect(running.ctx.yuqiTeamOrchestrator.readTeamTaskReports({
      controller: running.value.agent, teamId: 'team-1',
    })).resolves.toEqual([expect.objectContaining({
      taskId: 'task-1', status: 'running', agentSessionId: 'session-worker-1',
    })])
    await running.fiber.dispose()

    const failed = await reports('failed', [
      ...completeTeamEvents().slice(0, 8),
      event(9_300, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: 'attempt-1' as never, from: 'running', to: 'failed' }),
      event(9_301, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'failed' }),
    ])
    await expect(failed.ctx.yuqiTeamOrchestrator.readTeamTaskReports({
      controller: failed.value.agent, teamId: 'team-1',
    })).resolves.toEqual([expect.objectContaining({
      taskId: 'task-1', status: 'failed', agentSessionId: 'session-worker-1', reportUnavailable: true,
    })])
    await failed.fiber.dispose()

    const completed = await reports('completed', completeTeamEvents())
    await expect(completed.ctx.yuqiTeamOrchestrator.readTeamTaskReports({
      controller: completed.value.agent, teamId: 'team-1',
    })).resolves.toEqual([expect.objectContaining({
      taskId: 'task-1', status: 'completed', stopReason: 'completed', agentSessionId: 'session-worker-1',
    })])
    await completed.fiber.dispose()
  })

  it('stops a quality-gated public batch at plan and dependency review boundaries', async () => {
    const childRequest = (taskId: string) => ({
      taskId, attemptId: `${taskId}-attempt`, leaseId: `${taskId}-lease`, label: taskId,
      prompt: [{ type: 'text' as const, text: `run ${taskId}` }],
      signal: new AbortController().signal,
      modelPolicy: {
        task: { subagentProvider: 'in-process', modelProvider: 'deepseek', modelId: 'deepseek-v4', role: 'worker' as const },
        harnessDefault: { subagentProvider: 'in-process', modelProvider: 'deepseek', modelId: 'deepseek-v4', role: 'worker' as const },
      },
    })

    const planCtx = new Context()
    const plan = harness(Session.create(SessionId('coverage-gated-plan-stop')), planCtx)
    append(plan.agent.session, [
      event(9_400, {
        type: 'yuqi/team-created', title: 'Plan stop', objective: 'Stop before admission',
        reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 1, additionalPrompt: '' },
      }),
      event(9_401, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(9_402, { type: 'yuqi/task-created', contract: contract(TaskId('plan-task')) }),
    ])
    const planFiber = await planCtx.plugin(YuqiTeamOrchestratorService)
    const planService = planCtx.yuqiTeamOrchestrator as unknown as {
      executeGatedBatch(request: unknown): Promise<{ handles: readonly unknown[] }>
      coordinateReviewCheckpoint(request: unknown): Promise<boolean>
    }
    planService.coordinateReviewCheckpoint = vi.fn(async () => false)
    await expect(planService.executeGatedBatch({
      controller: plan.agent, teamId: 'team-1', workspaceId: 'unused', worktreePath: process.cwd(),
      plan: {} as never, maxConcurrency: 1, children: [childRequest('plan-task')],
    })).resolves.toMatchObject({ handles: [{ taskId: 'plan-task', attemptId: 'plan-task-attempt' }] })
    await planFiber.dispose()

    const dependencyCtx = new Context()
    const dependency = harness(Session.create(SessionId('coverage-gated-dependency-stop')), dependencyCtx)
    const completed = completeTeamEvents()
    append(dependency.agent.session, [
      { ...completed[0]!, reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 1, additionalPrompt: '' } } as never,
      ...completed.slice(1, -1),
      event(9_410, { type: 'yuqi/task-created', contract: contract(TaskId('dependent-task'), 1, [TaskId('task-1')]) }),
      event(9_411, { type: 'yuqi/task-status-changed', taskId: TaskId('dependent-task'), from: 'pending', to: 'ready' }),
    ])
    const dependencyFiber = await dependencyCtx.plugin(YuqiTeamOrchestratorService)
    const dependencyService = dependencyCtx.yuqiTeamOrchestrator as unknown as {
      executeGatedBatch(request: unknown): Promise<{ handles: readonly unknown[] }>
      coordinateReviewCheckpoint(request: unknown): Promise<boolean>
    }
    dependencyService.coordinateReviewCheckpoint = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    await expect(dependencyService.executeGatedBatch({
      controller: dependency.agent, teamId: 'team-1', workspaceId: 'unused', worktreePath: process.cwd(),
      plan: {} as never, maxConcurrency: 1, children: [childRequest('dependent-task')],
    })).resolves.toMatchObject({ handles: [{ taskId: 'dependent-task', attemptId: 'dependent-task-attempt' }] })
    expect(dependencyService.coordinateReviewCheckpoint).toHaveBeenCalledTimes(2)
    await dependencyFiber.dispose()
  })

  it('reviews a completion candidate with omitted checkpoint options and durable-attempt route fallback', async () => {
    async function reviewFixture(label: string, options: Record<string, unknown>, rejectCatalog: boolean) {
      const ctx = new Context()
      const value = harness(Session.create(SessionId(`coverage-review-options-${label}`)), ctx, options)
      if (rejectCatalog) {
        ;(ctx.llm as unknown as {
          resolveModelInfo(provider: string, model: string): Promise<unknown>
        }).resolveModelInfo = async () => { throw new Error('catalog intentionally unavailable') }
      }
      const workspaceId = `coverage-review-options-${label}` as never
      const source = completeTeamEvents()
      append(value.agent.session, [
        {
          ...source[0]!,
          reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 1, additionalPrompt: '' },
          ...(options.provider === undefined ? {} : { controllerModel: { provider: options.provider, model: options.model } }),
        } as never,
        source[1]!, source[2]!,
        event(9_420, {
          type: 'yuqi/workspace-provisioning-started', workspace: {
            workspaceId,
            project: {
              projectRoot: process.cwd(), repositoryRoot: process.cwd(), gitCommonDirectory: process.cwd(),
              baselineRef: 'coverage-base', volumeRoot: 'F:\\', protectedRoots: [],
            },
            worktreePath: process.cwd(), branchName: `yuqi/review-options-${label}`, status: 'provisioning',
          },
        }),
        event(9_421, { type: 'yuqi/workspace-provisioned', workspaceId }),
        ...source.slice(3, -1),
      ])
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      const service = ctx.yuqiTeamOrchestrator as unknown as {
        reviewer: { run(request: { readonly reviewId: string; readonly trigger: string }): Promise<unknown> }
      }
      service.reviewer = {
        async run(request) {
          return {
            reviewId: request.reviewId, trigger: request.trigger, reviewerSessionId: `reviewer-${label}`,
            decision: 'pass', findings: [], unverified: [],
          }
        },
      }
      return { ctx, value, fiber }
    }

    const omitted = await reviewFixture('omitted', { provider: 'deepseek', model: 'deepseek-v4' }, false)
    await expect(omitted.ctx.yuqiTeamOrchestrator.reviewTeam({
      controller: omitted.value.agent, teamId: 'team-1', trigger: 'user-request', reviewId: 'review-options-omitted',
    })).resolves.toMatchObject({ status: 'completed', result: { decision: 'pass' } })
    await omitted.fiber.dispose()

    const fallback = await reviewFixture('fallback', {}, true)
    await expect(fallback.ctx.yuqiTeamOrchestrator.reviewTeam({
      controller: fallback.value.agent, teamId: 'team-1', trigger: 'user-request', reviewId: 'review-options-fallback',
      checkpointSubject: 'task-attempt',
      checkpointAnchor: { eventId: 'event-10', taskId: 'task-1', attemptId: 'attempt-1' },
    } as never)).resolves.toMatchObject({ status: 'completed', result: { decision: 'pass' } })
    await fallback.fiber.dispose()
  })

  it('fails reviewer admission when durable routing cannot supply its final provider or model fallback', async () => {
    async function unroutableReview(label: string, mode: 'provider' | 'model') {
      const ctx = new Context()
      const options = mode === 'model' ? { provider: 'controller-provider' } : {}
      const value = harness(Session.create(SessionId(`coverage-review-missing-${label}`)), ctx, options)
      ;(ctx.llm as unknown as {
        resolveModelInfo(provider: string, model: string): Promise<unknown>
      }).resolveModelInfo = async () => { throw new Error('no reviewer catalog route') }
      const workspaceId = `coverage-review-missing-${label}` as never
      const task = { ...contract(TaskId(`review-missing-${label}-task`)) } as Record<string, unknown>
      if (mode === 'model') {
        delete task.modelId
        task.modelRequest = { kind: 'default' }
      }
      append(value.agent.session, [
        event(9_430, {
          type: 'yuqi/team-created', title: `Missing ${label}`, objective: 'Reject incomplete reviewer route',
          controllerModel: { provider: 'durable-provider', model: 'durable-model' },
          reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 1, additionalPrompt: '' },
        }),
        event(9_431, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
        event(9_432, { type: 'yuqi/task-created', contract: task } as never),
        event(9_433, {
          type: 'yuqi/workspace-provisioning-started', workspace: {
            workspaceId,
            project: {
              projectRoot: process.cwd(), repositoryRoot: process.cwd(), gitCommonDirectory: process.cwd(),
              baselineRef: 'coverage-base', volumeRoot: 'F:\\', protectedRoots: [],
            },
            worktreePath: process.cwd(), branchName: `yuqi/review-missing-${label}`, status: 'provisioning',
          },
        }),
        event(9_434, { type: 'yuqi/workspace-provisioned', workspaceId }),
      ])
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      return { ctx, value, fiber }
    }

    const provider = await unroutableReview('provider', 'provider')
    await expect(provider.ctx.yuqiTeamOrchestrator.reviewTeam({
      controller: provider.value.agent, teamId: 'team-1', trigger: 'user-request',
      checkpointSubject: 'team-plan', checkpointAnchor: { eventId: 'event-9430' }, candidateEventId: 'event-9430',
    } as never)).rejects.toMatchObject({ code: 'FIXED_MODEL_INVALID' })
    await provider.fiber.dispose()

    const model = await unroutableReview('model', 'model')
    await expect(model.ctx.yuqiTeamOrchestrator.reviewTeam({
      controller: model.value.agent, teamId: 'team-1', trigger: 'user-request',
      checkpointSubject: 'team-plan', checkpointAnchor: { eventId: 'event-9430' }, candidateEventId: 'event-9430',
    } as never)).rejects.toMatchObject({ code: 'FIXED_MODEL_INVALID' })
    await model.fiber.dispose()
  })

  it('keeps recovery and abort idempotent for graphs with no attempt and an already-cancelled Team', async () => {
    const pendingCtx = new Context()
    const pending = harness(Session.create(SessionId('coverage-recover-no-attempt')), pendingCtx)
    append(pending.agent.session, [
      event(9_440, { type: 'yuqi/team-created', title: 'No attempt', objective: 'Recover without an attempt' }),
      event(9_441, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(9_442, { type: 'yuqi/task-created', contract: contract(TaskId('no-attempt-task')) }),
    ])
    const pendingFiber = await pendingCtx.plugin(YuqiTeamOrchestratorService)
    await expect(pendingCtx.yuqiTeamOrchestrator.recoverAndContinueTeam({
      controller: pending.agent, teamId: 'team-1', operationId: 'coverage-recover-no-attempt',
    })).resolves.toMatchObject({ team: { status: 'running' }, tasks: { 'no-attempt-task': { status: 'pending' } } })
    await pendingFiber.dispose()

    const cancelledCtx = new Context()
    const cancelled = harness(Session.create(SessionId('coverage-abort-cancelled')), cancelledCtx)
    append(cancelled.agent.session, [
      event(9_450, { type: 'yuqi/team-created', title: 'Cancelled', objective: 'Keep abort idempotent' }),
      event(9_451, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(9_452, { type: 'yuqi/task-created', contract: contract(TaskId('cancelled-task')) }),
    ])
    const cancelledFiber = await cancelledCtx.plugin(YuqiTeamOrchestratorService)
    await expect(cancelledCtx.yuqiTeamOrchestrator.abortTeam({
      controller: cancelled.agent, teamId: 'team-1', operationId: 'coverage-abort-cancelled',
    })).resolves.toMatchObject({ team: { status: 'cancelled' } })
    await cancelledFiber.dispose()
  })

})
