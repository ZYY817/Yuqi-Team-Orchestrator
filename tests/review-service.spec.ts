import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TeamEvent, TeamEventJournal } from '../src/index.ts'
import { TEAM_SETTINGS_NAMESPACE } from '../src/application/team-settings.ts'
import { YuqiTeamOrchestratorService } from '../src/host/harness/service.ts'
import { readActiveTeamParentBinding, readTeamEventsFromSession, TEAM_SESSION_EVENT } from '../src/host/harness/session-journal.ts'
import { REVIEW_SESSION_EVENT } from '../src/host/harness/review-journal.ts'
import { completeTeamEvents, contract, event, verificationOperationEvents } from './fixtures.ts'
import { ControlOperationId, replayTeamEvents, TaskId, TeamEventId, WorkspaceId } from '../src/index.ts'

class MemoryJournal implements TeamEventJournal {
  readonly key: string
  readonly events: TeamEvent[]
  constructor(key: string, events: readonly TeamEvent[]) { this.key = key; this.events = [...events] }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> { this.events.push(...events) }
}

function serviceHarness(events = completeTeamEvents(), includeChild = true, settings?: unknown) {
  const id = SessionId(`review-service-${Math.random()}`)
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd: process.cwd() })
  for (const event of events) session.append(TEAM_SESSION_EVENT, { event })
  const sessions = new Map([[String(id), session]])
  const childId = SessionId('session-worker-1')
  const child = Session.create(childId, [], { version: 0, id: childId, createdAt: 0, cwd: process.cwd() })
  child.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'name=website; scripts=4' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append' })
  if (includeChild) sessions.set(String(childId), child)
  const context = new Context()
  context.provide('sessions', { get(sessionId: SessionId) { return sessions.get(String(sessionId)) }, flush: async () => true } as never)
  context.provide('subagents', { async startContinuable() { throw new Error('not expected for simple Team') } } as never)
  context.provide('sessionPersistence', { load: async () => ({ meta: session.header, events: session.events }) } as never)
  context.provide('llm', { async listModels(provider: string) { return [{ provider, id: 'deepseek-v4', name: 'mock' }] }, async resolveModelInfo(provider: string, model: string) { return { provider, id: model, name: 'mock' } } } as never)
  context.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: process.cwd() }) } as never)
  if (settings !== undefined) context.provide('settings', settings as never)
  const service = new YuqiTeamOrchestratorService(context)
  const controller = { id, session, options: { provider: 'mock' }, ctx: context } as unknown as Agent
  const journal: TeamEventJournal = {
    key: String(id),
    read: () => readTeamEventsFromSession(session),
    async commit(nextEvents: readonly TeamEvent[]) {
      if (nextEvents.length === 1) session.append(TEAM_SESSION_EVENT, { event: nextEvents[0]! })
      else if (nextEvents.length > 1) session.append(TEAM_SESSION_EVENT, { events: [...nextEvents] })
    },
  }
  return { service, controller, journal }
}

function runningCompletedReviewEvents(
  decision: 'pass' | 'changes_required' | 'inconclusive',
  options: { readonly reviewId?: string; readonly maxReworkRounds?: number; readonly workspace?: boolean } = {},
) {
  const reviewId = options.reviewId ?? `review-${decision}`
  const events: TeamEvent[] = [
    event(1, {
      type: 'yuqi/team-created', title: 'Yuqi Team', objective: 'Build the plugin',
      reviewPolicy: { mode: 'quality-gate', maxReworkRounds: options.maxReworkRounds ?? 0, additionalPrompt: '' },
    }),
    ...completeTeamEvents().slice(1, 2),
  ]
  if (options.workspace === true) {
    const workspaceId = WorkspaceId(`workspace-${reviewId}`)
    events.push(
      event(220, { type: 'yuqi/workspace-provisioning-started', workspace: {
        workspaceId, project: {
          projectRoot: process.cwd(), repositoryRoot: process.cwd(), gitCommonDirectory: process.cwd(), baselineRef: 'baseline',
          volumeRoot: path.parse(process.cwd()).root, protectedRoots: [],
        }, worktreePath: process.cwd(), branchName: `yuqi/${reviewId}`, status: 'provisioning',
      } }),
      event(221, { type: 'yuqi/workspace-provisioned', workspaceId }),
    )
  }
  events.push(
    ...completeTeamEvents().slice(2, -1),
    event(222, {
      type: 'yuqi/review-requested', reviewId, trigger: 'quality-gate', candidateEventId: completeTeamEvents()[15]!.eventId, round: 0,
    }),
    event(223, {
      type: 'yuqi/review-result-recorded', reviewId, candidateEventId: completeTeamEvents()[15]!.eventId,
      reviewerSessionId: `reviewer-${decision}`, decision,
      findings: decision === 'changes_required'
        ? [{ severity: 'high', evidence: ['src/review.ts:1'], impact: 'unsafe', recommendation: 'repair the finding' }]
        : [],
      unverified: decision === 'inconclusive' ? ['review route unavailable'] : [],
    }),
  )
  return events
}

function completionRequest(harness: ReturnType<typeof serviceHarness>) {
  return {
    controller: harness.controller,
    teamId: 'team-1',
    journal: harness.journal,
    signal: new AbortController().signal,
  }
}

describe('review service trigger gate', () => {
  it('registers a mutable Team settings base when settings are available', async () => {
    let registeredNamespace = ''
    let registeredBase: unknown
    const current = {
      maxConcurrency: 7,
      childPresetId: 'standard',
      childModelId: '',
      childModelPolicy: 'inherit' as const,
      quickModelId: '',
      standardModelId: '',
      criticalModelId: '',
      requirePlanConfirmation: false,
      defaultAuthorityMode: 'write-authorized' as const,
      defaultWorkspaceMode: 'direct' as const,
      reviewPolicy: { mode: 'manual' as const, maxReworkRounds: 2, additionalPrompt: '' },
    }
    const settings = {
      register(namespace: string, _schema: unknown, options: { base: unknown }) {
        registeredNamespace = String(namespace)
        registeredBase = options.base
        return { get: () => current }
      },
    }

    const { service } = serviceHarness(completeTeamEvents(), true, settings)

    await vi.waitFor(() => expect(registeredNamespace).toBe(String(TEAM_SETTINGS_NAMESPACE)))
    expect(Object.isFrozen(registeredBase)).toBe(false)
    expect(Object.isFrozen((registeredBase as { reviewPolicy: unknown }).reviewPolicy)).toBe(false)
    expect(service.maxConcurrencyLimit()).toBe(100)
  })

  it('atomically materializes blocked, unblocked, and reconciliation schedule state', async () => {
    const { service } = serviceHarness()
    const source = new MemoryJournal('schedule-materialization', [
      event(201, { type: 'yuqi/team-created', title: 'Schedule state', objective: 'Persist scheduler facts' }),
      event(202, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(203, { type: 'yuqi/task-created', contract: contract(TaskId('newly-blocked')) }),
      event(204, { type: 'yuqi/task-created', contract: contract(TaskId('unblocked')) }),
      event(205, { type: 'yuqi/task-status-changed', taskId: TaskId('unblocked'), from: 'pending', to: 'blocked', reason: 'old dependency block' }),
    ])
    const cut = replayTeamEvents(source.read())
    const plan = {
      status: 'runnable' as const,
      activeTaskIds: [], readyTaskIds: [], blockedTaskIds: [TaskId('newly-blocked')],
      newlyBlockedTaskIds: [TaskId('newly-blocked')], unblockedTaskIds: [TaskId('unblocked')],
      dispatchTaskIds: [], availableSlots: 1,
      sourceLastEventAt: cut.lastEventAt, sourceLastEventId: cut.lastEventId,
    }
    await service.persistScheduleState({
      teamId: 'team-1', journal: source, plan,
      taskTransitions: [
        { taskId: 'newly-blocked', from: 'pending', to: 'blocked', reason: 'dependency failed' },
        { taskId: 'unblocked', from: 'blocked', to: 'pending', reason: 'dependency block cleared' },
      ],
      requiresReconciliation: false,
      signal: new AbortController().signal,
    })
    const persisted = replayTeamEvents(source.read())
    expect(persisted.tasks[TaskId('newly-blocked')]?.status).toBe('blocked')
    expect(persisted.tasks[TaskId('unblocked')]?.status).toBe('pending')

    const reconciliation = new MemoryJournal('schedule-reconciliation', [
      event(211, { type: 'yuqi/team-created', title: 'Unsafe schedule', objective: 'Fail closed' }),
      event(212, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(213, { type: 'yuqi/task-created', contract: contract(TaskId('unsafe')) }),
    ])
    const unsafeCut = replayTeamEvents(reconciliation.read())
    await service.persistScheduleState({
      teamId: 'team-1', journal: reconciliation,
      plan: { ...plan, status: 'requires_reconciliation', newlyBlockedTaskIds: [], unblockedTaskIds: [], blockedTaskIds: [], sourceLastEventAt: unsafeCut.lastEventAt, sourceLastEventId: unsafeCut.lastEventId },
      taskTransitions: [], requiresReconciliation: true, signal: new AbortController().signal,
    })
    expect(replayTeamEvents(reconciliation.read()).team.status).toBe('needs_reconciliation')

    await expect(service.persistScheduleState({
      teamId: 'team-1', journal: source,
      plan: { ...plan, sourceLastEventId: 'stale-event' },
      taskTransitions: [], requiresReconciliation: false, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'STALE_SCHEDULE' })
  })

  it('rebinds only to a top-level conversation in the same project', async () => {
    const oldParentId = SessionId('service-rebind-old')
    const controllerId = SessionId('service-rebind-controller')
    const oldParent = Session.create(oldParentId, [], { version: 0, id: oldParentId, createdAt: 0, cwd: process.cwd() })
    const controllerSession = Session.create(controllerId, [], {
      version: 0, id: controllerId, createdAt: 0, cwd: path.join(process.cwd(), '.yuqi-worktree'), parentSession: oldParentId,
    })
    for (const fact of completeTeamEvents()) controllerSession.append(TEAM_SESSION_EVENT, { event: fact })
    const destinationId = SessionId('service-rebind-destination')
    const destinationSession = Session.create(destinationId, [], { version: 0, id: destinationId, createdAt: 0, cwd: process.cwd() })
    const sessions = new Map([[String(oldParentId), oldParent], [String(controllerId), controllerSession], [String(destinationId), destinationSession]])
    const context = new Context()
    context.provide('sessions', { get: (id: SessionId) => sessions.get(String(id)), flush: async () => true } as never)
    context.provide('subagents', {} as never)
    const persisted = new Map<string, { meta: Session['header']; events: readonly unknown[] }>([
      [String(oldParentId), { meta: oldParent.header, events: oldParent.events }],
      [String(controllerId), { meta: controllerSession.header, events: controllerSession.events }],
    ])
    context.provide('sessionPersistence', {
      list: async () => [...persisted.values()].map(value => value.meta),
      create: async (meta: Session['header']) => { persisted.set(String(meta.id), { meta, events: [] }) },
      append: async (id: Session['id'], events: readonly unknown[]) => {
        const current = persisted.get(String(id))!
        persisted.set(String(id), { ...current, events: [...current.events, ...events] })
      },
      readFrom: async (id: Session['id'], fromSeq: number) => ({ events: persisted.get(String(id))!.events.slice(fromSeq) }),
    } as never)
    context.provide('llm', { async listModels() { return [] }, async resolveModelInfo() { throw new Error('unused') } } as never)
    context.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: process.cwd() }) } as never)
    const service = new YuqiTeamOrchestratorService(context)
    const controller = { id: controllerId, session: controllerSession, options: {}, ctx: context } as unknown as Agent
    const destination = { id: destinationId, session: destinationSession, options: {}, ctx: context } as unknown as Agent

    await expect(service.rebindTeam({ controller, teamId: 'team-1', parent: destination, operationId: 'ui-v1:service-rebind' })).resolves.toBeUndefined()
    expect(readActiveTeamParentBinding(controllerSession)?.parentSessionId).toBe(String(destinationId))
    expect(persisted.has(String(destinationId))).toBe(true)
    await expect(service.rebindTeam({ controller, teamId: 'other', parent: destination, operationId: 'ui-v1:mismatch' }))
      .rejects.toMatchObject({ code: 'TEAM_MISMATCH' })

    const nestedId = SessionId('service-rebind-nested')
    const nestedSession = Session.create(nestedId, [], { version: 0, id: nestedId, createdAt: 0, cwd: process.cwd(), parentSession: destinationId })
    const nested = { id: nestedId, session: nestedSession, options: {}, ctx: context } as unknown as Agent
    await expect(service.rebindTeam({ controller, teamId: 'team-1', parent: nested, operationId: 'ui-v1:nested' }))
      .rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })

    const otherId = SessionId('service-rebind-other-project')
    const otherSession = Session.create(otherId, [], { version: 0, id: otherId, createdAt: 0, cwd: path.parse(process.cwd()).root })
    const other = { id: otherId, session: otherSession, options: {}, ctx: context } as unknown as Agent
    await expect(service.rebindTeam({ controller, teamId: 'team-1', parent: other, operationId: 'ui-v1:other-project' }))
      .rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
  })

  it('rejects public service calls that address a different durable Team', async () => {
    const { service, controller } = serviceHarness()
    await expect(service.runTeam({ controller, teamId: 'other-team', maxConcurrency: 1 }))
      .rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    await expect(service.reviewTeam({ controller, teamId: 'other-team', trigger: 'user-request' }))
      .rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
  })

  it('does not start a child reviewer for a simple pre-completion Team', async () => {
    const { service, controller } = serviceHarness()
    const result = await service.reviewTeam({ controller, teamId: 'team-1', trigger: 'pre-completion' })
    expect(result).toEqual({ status: 'skipped', reviewId: expect.stringContaining('review:team-1:pre-completion'), trigger: 'pre-completion', reason: '简单单任务不强制消耗 reviewer Token' })
  })

  it('projects bounded latest child conclusions without duplicating them into Team events', async () => {
    const { service, controller } = serviceHarness()
    await expect(service.readTeamTaskReports({ controller, teamId: 'team-1' })).resolves.toEqual([{
      taskId: 'task-1',
      status: 'completed',
      agentSessionId: 'session-worker-1',
      output: 'name=website; scripts=4',
      truncated: false,
      stopReason: 'completed',
    }])
  })

  it('projects truthful task status when no child exists yet and uses admitted identity before evidence', async () => {
    const pending = serviceHarness(completeTeamEvents().slice(0, 3))
    await expect(pending.service.readTeamTaskReports({ controller: pending.controller, teamId: 'team-1' })).resolves.toEqual([{
      taskId: 'task-1', status: 'pending',
    }])

    const running = serviceHarness(completeTeamEvents().slice(0, 8))
    await expect(running.service.readTeamTaskReports({ controller: running.controller, teamId: 'team-1' })).resolves.toEqual([{
      taskId: 'task-1',
      status: 'running',
      agentSessionId: 'session-worker-1',
      output: 'name=website; scripts=4',
      truncated: false,
    }])
  })

  it('returns stop and verification problems or an explicit unavailable report for blocked work', async () => {
    const blocked = serviceHarness([
      ...verificationOperationEvents('blocked-report-verdict'),
      event(181, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'verifying', to: 'blocked', reason: 'human confirmation required' }),
    ], false)
    await expect(blocked.service.readTeamTaskReports({ controller: blocked.controller, teamId: 'team-1' })).resolves.toEqual([{
      taskId: 'task-1',
      status: 'blocked',
      agentSessionId: 'session-worker-1',
      stopReason: 'completed',
      verificationReasons: [{ checkId: 'build', code: 'missing-evidence', detail: 'No structured host evidence was supplied' }],
      reportUnavailable: true,
    }])
  })

  it('deduplicates a previously persisted short review result and defers active children', async () => {
    const first = serviceHarness()
    const stored = { reviewId: 'stored-review', trigger: 'user-request' as const, reviewerSessionId: 'reviewer', decision: 'pass' as const, findings: [], unverified: [] }
    first.controller.session.append(REVIEW_SESSION_EVENT, { result: stored })
    await expect(first.service.reviewTeam({ controller: first.controller, teamId: 'team-1', trigger: 'user-request', reviewId: 'stored-review' })).resolves.toEqual({ status: 'completed', result: stored })

    const active = serviceHarness(completeTeamEvents().slice(0, 8))
    await expect(active.service.reviewTeam({ controller: active.controller, teamId: 'team-1', trigger: 'user-request' })).resolves.toMatchObject({ status: 'skipped', reason: '存在活动中的子 Agent；审查延迟到安全边界' })
  })

  it('fails closed without a workspace and recovers the reviewer route from durable attempts', async () => {
    const noWorkspace = serviceHarness()
    await expect(noWorkspace.service.reviewTeam({ controller: noWorkspace.controller, teamId: 'team-1', trigger: 'user-request' }))
      .rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })

    const workspaceId = WorkspaceId('workspace-review-service')
    const workspaceEvents = [
      ...completeTeamEvents(),
      event(18, { type: 'yuqi/workspace-provisioning-started', workspace: {
        workspaceId, project: {
          projectRoot: process.cwd(), repositoryRoot: process.cwd(), gitCommonDirectory: process.cwd(), baselineRef: 'baseline',
          volumeRoot: path.parse(process.cwd()).root, protectedRoots: [],
        }, worktreePath: process.cwd(), branchName: 'yuqi/review-service', status: 'provisioning',
      } }),
      event(19, { type: 'yuqi/workspace-provisioned', workspaceId }),
    ]
    const missingProvider = serviceHarness(workspaceEvents)
    ;(missingProvider.controller as unknown as { options: Record<string, unknown> }).options = {}
    await expect(missingProvider.service.reviewTeam({ controller: missingProvider.controller, teamId: 'team-1', trigger: 'user-request' }))
      .resolves.toMatchObject({ status: 'completed', result: { decision: 'inconclusive' } })
  })

  it('routes a direct Team reviewer through the direct workspace verifier', async () => {
    const workspaceId = WorkspaceId('workspace-review-direct')
    const directEvents = [
      ...completeTeamEvents(),
      event(20, { type: 'yuqi/workspace-provisioning-started', workspace: {
        workspaceId,
        project: { mode: 'direct', projectRoot: process.cwd(), volumeRoot: path.parse(process.cwd()).root, protectedRoots: [] },
        worktreePath: process.cwd(), branchName: 'direct', status: 'provisioning',
      } as never }),
      event(21, { type: 'yuqi/workspace-provisioned', workspaceId }),
    ]
    const direct = serviceHarness(directEvents)
    ;(direct.controller as unknown as { options: Record<string, unknown> }).options = {}
    await expect(direct.service.reviewTeam({ controller: direct.controller, teamId: 'team-1', trigger: 'user-request' }))
      .resolves.toMatchObject({ status: 'completed', result: { decision: 'inconclusive', unverified: [expect.stringContaining('not expected for simple Team')] } })
  })

  it('coordinates complete, review, create-rework, verify, and awaiting-user through public service calls', async () => {
    const completes = serviceHarness([
      event(1, {
        type: 'yuqi/team-created', title: 'Manual Team', objective: 'Complete without a pending review',
        reviewPolicy: { mode: 'manual', maxReworkRounds: 2, additionalPrompt: '' },
      }),
      ...completeTeamEvents().slice(1, -1),
    ])
    await completes.service.coordinateCompletion(completionRequest(completes))
    expect(replayTeamEvents(completes.journal.read()).team.status).toBe('completed')

    const reviews = serviceHarness([
      event(1, {
        type: 'yuqi/team-created', title: 'Reviewed Team', objective: 'Run the quality gate',
        reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 0, additionalPrompt: '' },
      }),
      ...completeTeamEvents().slice(1, 2),
      event(224, { type: 'yuqi/workspace-provisioning-started', workspace: {
        workspaceId: WorkspaceId('workspace-coordinate-review'), project: {
          projectRoot: process.cwd(), repositoryRoot: process.cwd(), gitCommonDirectory: process.cwd(), baselineRef: 'baseline',
          volumeRoot: path.parse(process.cwd()).root, protectedRoots: [],
        }, worktreePath: process.cwd(), branchName: 'yuqi/coordinate-review', status: 'provisioning',
      } }),
      event(225, { type: 'yuqi/workspace-provisioned', workspaceId: WorkspaceId('workspace-coordinate-review') }),
      ...completeTeamEvents().slice(2, -1),
    ])
    await reviews.service.coordinateCompletion(completionRequest(reviews))
    const reviewed = replayTeamEvents(reviews.journal.read())
    expect(reviewed.reviewIds).toHaveLength(1)
    expect(reviewed.reviews[reviewed.reviewIds[0]!]!).toMatchObject({
      status: 'awaiting_user', reviewerIndependence: 'context-only', result: { decision: 'inconclusive' },
    })
    expect(reviewed.team.status).toBe('paused')

    const reworks = serviceHarness(runningCompletedReviewEvents('changes_required', { reviewId: 'review-create-rework', maxReworkRounds: 1 }))
    await reworks.service.coordinateCompletion(completionRequest(reworks))
    const created = replayTeamEvents(reworks.journal.read())
    expect(created.tasks['review-rework:review-create-rework:1']?.contract).toMatchObject({
      kind: 'review-rework', reviewRework: { sourceReviewId: 'review-create-rework', round: 1 },
    })
    const eventCount = reworks.journal.read().length
    await reworks.service.coordinateCompletion(completionRequest(reworks))
    expect(reworks.journal.read()).toHaveLength(eventCount)
    expect(replayTeamEvents(reworks.journal.read()).tasks['review-rework:review-create-rework:1']?.status).toBe('pending')

    const awaiting = serviceHarness(runningCompletedReviewEvents('inconclusive', { reviewId: 'review-awaiting-user' }))
    const awaitingEventCount = awaiting.journal.read().length
    await awaiting.service.coordinateCompletion(completionRequest(awaiting))
    expect(awaiting.journal.read()).toHaveLength(awaitingEventCount + 2)
    expect(replayTeamEvents(awaiting.journal.read()).team.status).toBe('paused')
    expect(replayTeamEvents(awaiting.journal.read()).reviews['review-awaiting-user']?.status).toBe('awaiting_user')
  })

  it('persists a terminal fail decision and replays it idempotently', async () => {
    const harness = serviceHarness(runningCompletedReviewEvents('inconclusive', { reviewId: 'review-fail' }))
    const candidateEventId = String(replayTeamEvents(harness.journal.read()).completionCandidateEventId)
    const request = {
      controller: harness.controller, teamId: 'team-1', operationId: 'ui-v1:fail-review',
      reviewId: 'review-fail', candidateEventId, round: 0, decision: 'fail' as const,
    }
    const first = await harness.service.decideReview(request)
    const afterFirst = harness.journal.read().length
    const replayed = await harness.service.decideReview(request)
    expect(first.team.status).toBe('failed')
    expect(replayed.team.status).toBe(first.team.status)
    expect(harness.journal.read()).toHaveLength(afterFirst)
  })

  it('persists a cancel decision through the legal cancellation path and replays it idempotently', async () => {
    const harness = serviceHarness(runningCompletedReviewEvents('inconclusive', { reviewId: 'review-cancel' }))
    const candidateEventId = String(replayTeamEvents(harness.journal.read()).completionCandidateEventId)
    const request = {
      controller: harness.controller, teamId: 'team-1', operationId: 'ui-v1:cancel-review',
      reviewId: 'review-cancel', candidateEventId, round: 0, decision: 'cancel' as const,
    }
    const beforeDecision = harness.journal.read().length
    const first = await harness.service.decideReview(request)
    expect(first.team.status).toBe('cancelled')
    expect(first.reviews['review-cancel']?.userDecision?.decision).toBe('cancel')
    expect(first.controlOperations['ui-v1:cancel-review']?.action).toBeUndefined()
    expect(first.controlOperations['ui-v1:cancel-review:cancel']?.action).toBe('cancel')
    expect(harness.journal.read()).toHaveLength(beforeDecision + 4)

    const beforeReplay = harness.journal.read().length
    const replayed = await harness.service.decideReview(request)
    expect(replayed.team.status).toBe('cancelled')
    expect(harness.journal.read()).toHaveLength(beforeReplay)
  })

  it('repairs a legacy half-persisted cancel decision without duplicating the decision event', async () => {
    const base = runningCompletedReviewEvents('inconclusive', { reviewId: 'review-cancel-replay' })
    const candidateEventId = String(replayTeamEvents(base).completionCandidateEventId)
    const operationId = 'ui-v1:cancel-review-replay'
    const harness = serviceHarness([...base, event(226, {
      type: 'yuqi/review-user-decision-recorded', operationId: ControlOperationId(operationId),
      reviewId: 'review-cancel-replay', candidateEventId: TeamEventId(candidateEventId), round: 0, decision: 'cancel',
    })])
    const beforeReplay = harness.journal.read().length

    const repaired = await harness.service.decideReview({
      controller: harness.controller, teamId: 'team-1', operationId,
      reviewId: 'review-cancel-replay', candidateEventId, round: 0, decision: 'cancel',
    })

    expect(repaired.team.status).toBe('cancelled')
    expect(repaired.reviews['review-cancel-replay']?.userDecision?.decision).toBe('cancel')
    expect(harness.journal.read()).toHaveLength(beforeReplay + 3)
  })

  it('persists retry_review, authorize_final_rework, and waive and advances each decision publicly', async () => {
    const retry = serviceHarness(runningCompletedReviewEvents('inconclusive', { reviewId: 'review-retry', workspace: true }))
    await retry.service.runTeam({ controller: retry.controller, teamId: 'team-1', maxConcurrency: 1, maxCycles: 1 })
    const retryCandidate = String(replayTeamEvents(retry.journal.read()).completionCandidateEventId)
    await retry.service.decideReview({
      controller: retry.controller, teamId: 'team-1', operationId: 'ui-v1:retry-review',
      reviewId: 'review-retry', candidateEventId: retryCandidate, round: 0, decision: 'retry_review',
    })
    await vi.waitFor(() => {
      const retried = replayTeamEvents(retry.journal.read())
      expect(retried.reviewIds).toHaveLength(2)
      expect(retried.reviews[retried.reviewIds[1]!]!).toMatchObject({ trigger: 'user-request', status: 'awaiting_user' })
    })

    const authorize = serviceHarness(runningCompletedReviewEvents('changes_required', { reviewId: 'review-authorize' }))
    await authorize.service.runTeam({ controller: authorize.controller, teamId: 'team-1', maxConcurrency: 1, maxCycles: 1 })
    const authorizeCandidate = String(replayTeamEvents(authorize.journal.read()).completionCandidateEventId)
    await authorize.service.decideReview({
      controller: authorize.controller, teamId: 'team-1', operationId: 'ui-v1:authorize-final-rework',
      reviewId: 'review-authorize', candidateEventId: authorizeCandidate, round: 0, decision: 'authorize_final_rework',
    })
    await vi.waitFor(() => expect(replayTeamEvents(authorize.journal.read()).tasks['review-rework:review-authorize:1']?.contract.kind).toBe('review-rework'))

    const waive = serviceHarness(runningCompletedReviewEvents('inconclusive', { reviewId: 'review-waive' }))
    await waive.service.runTeam({ controller: waive.controller, teamId: 'team-1', maxConcurrency: 1, maxCycles: 1 })
    const waiveCandidate = String(replayTeamEvents(waive.journal.read()).completionCandidateEventId)
    const waiver = {
      controller: waive.controller, teamId: 'team-1', operationId: 'ui-v1:waive-review',
      reviewId: 'review-waive', candidateEventId: waiveCandidate, round: 0, decision: 'waive' as const, reason: 'accepted bounded risk',
    }
    await waive.service.decideReview(waiver)
    await vi.waitFor(() => expect(replayTeamEvents(waive.journal.read()).team.status).toBe('completed'))
  })

  it('rejects a stale review candidate and a missing reviewer route without private helpers', async () => {
    const stale = serviceHarness(runningCompletedReviewEvents('inconclusive', { reviewId: 'review-stale-service' }))
    await expect(stale.service.decideReview({
      controller: stale.controller, teamId: 'team-1', operationId: 'ui-v1:stale-review',
      reviewId: 'review-stale-service', candidateEventId: 'stale-candidate', round: 0, decision: 'retry_review',
    })).rejects.toMatchObject({ code: 'REFERENCE_MISMATCH' })

    const noRoute = serviceHarness([
      event(230, {
        type: 'yuqi/team-created', title: 'No route Team', objective: 'Expose missing reviewer route',
        reviewPolicy: { mode: 'manual', maxReworkRounds: 0, additionalPrompt: '' },
      }),
      event(231, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(232, { type: 'yuqi/workspace-provisioning-started', workspace: {
        workspaceId: WorkspaceId('workspace-no-review-route'), project: {
          projectRoot: process.cwd(), repositoryRoot: process.cwd(), gitCommonDirectory: process.cwd(), baselineRef: 'baseline',
          volumeRoot: path.parse(process.cwd()).root, protectedRoots: [],
        }, worktreePath: process.cwd(), branchName: 'yuqi/no-review-route', status: 'provisioning',
      } }),
      event(233, { type: 'yuqi/workspace-provisioned', workspaceId: WorkspaceId('workspace-no-review-route') }),
      event(234, { type: 'yuqi/team-status-changed', from: 'running', to: 'completed' }),
    ], false)
    ;(noRoute.controller as unknown as { options: Record<string, unknown> }).options = {}
    await expect(noRoute.service.reviewTeam({ controller: noRoute.controller, teamId: 'team-1', trigger: 'user-request' }))
      .rejects.toMatchObject({ code: 'FIXED_MODEL_INVALID' })
  })
})
