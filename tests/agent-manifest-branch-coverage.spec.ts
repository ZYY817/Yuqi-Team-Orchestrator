import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/agent/index.ts'
import { replayTeamEvents } from '../src/domain/projection.ts'
import { TEAM_PARENT_BINDING_EVENT, TEAM_PARENT_PROJECTION_EVENT, TEAM_SESSION_EVENT } from '../src/host/harness/session-journal.ts'
import { completeTeamEvents } from './fixtures.ts'

const scopes: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(scopes.splice(0).map(dispose => dispose()))
})

const compactTask = {
  taskId: 'task-1',
  revision: 1,
  goal: 'Exercise the public Team boundary.',
  dependencies: [],
  fileScope: ['src/**'],
  modelRole: 'worker',
}

const compactInput = {
  title: 'Boundary Team',
  objective: 'Exercise real model-facing boundary inputs.',
  tasks: [compactTask],
}

function parentAgent(overrides: Record<string, unknown> = {}): Agent {
  return {
    id: 'parent-session',
    options: { provider: 'provider-a', model: 'model-a' },
    session: { header: { cwd: 'F:\\project' }, events: [] },
    ...overrides,
  } as unknown as Agent
}

function execution(agent: Agent | undefined, signal = new AbortController().signal): ToolRunContext {
  return { agent, signal } as ToolRunContext
}

function mount(serviceOverrides: Record<string, unknown> = {}) {
  const tools: ToolDefinition[] = []
  const service = {
    startTeam: vi.fn(async () => ({
      teamId: 'team-1',
      sessionId: 'controller-1',
      controller: { id: 'controller-1' },
      dispose: vi.fn(async () => undefined),
    })),
    runTeam: vi.fn(async () => ({
      projection: { team: { id: 'team-1', status: 'completed' }, taskIds: [], tasks: {}, reviews: {} },
      reason: 'completed',
    })),
    ...serviceOverrides,
  }
  const root = new Context()
  root.provide('tools', { register(tool: ToolDefinition) { tools.push(tool) } } as never)
  root.provide('yuqiTeamOrchestrator', service as never)
  const scope = createScope(root, {})
  apply(scope.ctx)
  scopes.push(scope.dispose)
  const byName = (name: string): ToolDefinition => {
    const tool = tools.find(candidate => candidate.name === name)
    if (tool === undefined) throw new Error(`Missing tool ${name}`)
    return tool
  }
  return { service, start: byName('yuqi_team_start'), control: byName('yuqi_team_control'), message: byName('yuqi_team_message') }
}

describe('agent and compatibility manifest branch coverage', () => {
  it.each([
    [null, /invalid arguments/u],
    [{}, /invalid arguments/u],
    [{ ...compactInput, tasks: [null] }, /invalid arguments/u],
    [{ ...compactInput, tasks: [{ ...compactTask, dependencies: 'none' }] }, /invalid arguments/u],
    [{ ...compactInput, tasks: [{ ...compactTask, modelRole: 7 }] }, /invalid arguments/u],
    [{ ...compactInput, tasks: [{ ...compactTask, verificationChecks: [null] }] }, /invalid arguments/u],
    [{ ...compactInput, tasks: [{ ...compactTask, model: { providerId: 'p', modelId: 'm' }, modelId: 'legacy' }] }, /mutually exclusive/u],
    [{ ...compactInput, projectPath: 'F:\\absolute' }, /projectPath must be relative/u],
    [{ ...compactInput, projectPath: '.' }, /projectPath must select a nested directory/u],
  ])('rejects malformed public start input %# without Host startup', async (input, message) => {
    const { start, service } = mount()
    await expect(start.execute(input, execution(parentAgent()))).rejects.toThrow(message)
    expect(service.startTeam).not.toHaveBeenCalled()
  })

  it('normalizes non-record task fields and finite verification limits through the public schema', async () => {
    const { start, service } = mount()
    await expect(start.execute({
      ...compactInput,
      tasks: [{
        ...compactTask,
        dependencies: [0],
        modelRole: 3,
        verificationChecks: ['not-an-object'],
      }],
    }, execution(parentAgent()))).rejects.toThrow(/invalid arguments/u)
    expect(service.startTeam).not.toHaveBeenCalled()

    await start.execute({
      ...compactInput,
      workspaceMode: 'git-worktree',
      tasks: [{
        ...compactTask,
        dependencies: ['[]', '  '],
        modelRole: 'researcher',
        verificationChecks: [{
          checkId: 'test', kind: 'test', commandRef: 'pnpm-test',
          timeoutMs: 999_999,
          stdoutMaxBytes: 1,
          stderrMaxBytes: 1,
        }],
      }],
    }, execution(parentAgent()))
    expect(service.startTeam).toHaveBeenCalledWith(expect.objectContaining({
      workspaceMode: 'git-worktree',
      managedRoot: expect.stringContaining('.yuqi-team-worktrees'),
      tasks: [expect.objectContaining({ dependencies: [], modelRole: 'worker' })],
    }))
  })

  it.each([
    [{ model: { providerId: 'provider-b', modelId: 'model-b' } }, { kind: 'exact', model: { modelProvider: 'provider-b', modelId: 'model-b' } }],
    [{ modelId: 'legacy-model' }, { kind: 'legacy', modelId: 'legacy-model' }],
    [{ modelTier: 'critical' }, { kind: 'tier', tier: 'critical' }],
  ])('maps every public model selection form %#', async (selection, expected) => {
    const { start, service } = mount({
      teamDefaults: () => ({
        maxConcurrency: 8,
        childPresetId: 'standard',
        childModelId: '',
        childModelPolicy: 'inherit',
        quickModelId: '',
        standardModelId: '',
        criticalModelId: '',
        defaultAuthorityMode: undefined,
        defaultWorkspaceMode: undefined,
        requirePlanConfirmation: false,
      }),
    })
    await start.execute({ ...compactInput, tasks: [{ ...compactTask, ...selection }] }, execution(parentAgent()))
    expect(service.startTeam).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({ modelRequest: expected, authorityMode: 'write-authorized' })],
    }))
  })

  it.each([
    [undefined, /configured controller model/u],
    [7, /configured controller model/u],
  ])('rejects a non-string controller model %#', async (model, message) => {
    const { start } = mount()
    await expect(start.execute(compactInput, execution(parentAgent({ options: { provider: 'provider-a', model } })))).rejects.toThrow(message)
  })

  it.each([
    [undefined, /configured controller provider/u],
    [7, /configured controller provider/u],
  ])('rejects a non-string controller provider %#', async (provider, message) => {
    const { start } = mount()
    await expect(start.execute(compactInput, execution(parentAgent({ options: { provider, model: 'model-a' } })))).rejects.toThrow(message)
  })

  it('covers completed review, unavailable report, and non-pass attention mappings', async () => {
    const review = {
      id: 'review-1',
      teamId: 'team-1',
      trigger: 'pre-completion',
      result: {
        reviewerSessionId: 'reviewer-1',
        decision: 'changes_required',
        findings: [{ severity: 'high', evidence: ['failed assertion'], impact: 'Release is blocked.', recommendation: 'Fix the assertion.' }],
        unverified: [],
      },
    }
    const { start } = mount({
      runTeam: vi.fn(async () => ({
        projection: {
          team: { id: 'team-1', status: 'completed' },
          taskIds: [], tasks: {}, reviewIds: ['review-1'], reviews: { 'review-1': review },
        },
        reason: 'completed',
      })),
      readTeamTaskReports: vi.fn(async () => { throw new Error('temporarily unavailable') }),
    })
    await expect(start.execute(compactInput, execution(parentAgent()))).resolves.toMatchObject({
      status: 'completed',
      review: { status: 'completed', result: { decision: 'changes_required' } },
      requiresAttention: true,
    })
  })

  it.each(['completed', 'failed', 'cancelled', 'needs_reconciliation', 'paused'])('maps abort recovery status %s', async status => {
    const abort = new AbortController()
    const { start } = mount({
      runTeam: vi.fn(async () => {
        abort.abort()
        return {
          projection: { team: { id: 'team-1', status: 'running' }, taskIds: [], tasks: {}, reviews: {} },
          reason: 'aborted',
        }
      }),
      abortTeam: vi.fn(async () => ({ team: { id: 'team-1', status }, taskIds: [], tasks: {}, reviews: {} })),
    })
    await expect(start.execute(compactInput, execution(parentAgent(), abort.signal))).resolves.toMatchObject({
      status,
      stopReason: status === 'paused' ? 'aborted' : status,
    })
  })

  it('covers retry without auto-resume and every public review decision alias', async () => {
    const controllerId = SessionId('controller-explicit')
    const parentId = SessionId('parent-explicit')
    const controllerSession = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, cwd: 'F:\\project' })
    const parentSession = Session.create(parentId, [], { version: 0, id: parentId, createdAt: 0, cwd: 'F:\\project' })
    const events = completeTeamEvents()
    for (const event of events) controllerSession.append(TEAM_SESSION_EVENT, { event })
    controllerSession.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: String(parentId), generation: 1, operationId: 'bind', boundAt: '2026-08-31T00:00:00.000Z',
    })
    parentSession.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(controllerId), sourceEventCount: events.length, events,
    })
    const projection = replayTeamEvents(events)
    const decision = vi.fn(async () => ({ team: { id: 'team-1', status: 'running' } }))
    const retryTask = vi.fn(async () => ({ team: { id: 'team-1', status: 'running' } }))
    const resumeTeam = vi.fn(async () => ({ team: { id: 'team-1', status: 'running' } }))
    const resolveTeamController = vi.fn(async () => ({ id: controllerId, session: controllerSession }))
    const { control } = mount({ decideReview: decision, retryTask, resumeTeam, resolveTeamController })
    const exec = execution({ id: parentId, session: parentSession, options: { provider: 'provider-a', model: 'model-a' } } as unknown as Agent)

    await control.execute({ action: 'retry', taskId: 'task-1', teamId: 'team-1', controllerSessionId: 'controller-explicit' }, exec)
    expect(resumeTeam).not.toHaveBeenCalled()

    for (const action of ['cancel_review', 'retry_review', 'authorize_final_rework', 'waive', 'fail']) {
      await control.execute({
        action, teamId: projection.team.id, controllerSessionId: String(controllerId),
        reviewId: 'review-1', candidateEventId: 'candidate-1', reviewRound: 1,
        requestId: `request-${action}`, ...(action === 'waive' ? { reason: 'accepted risk' } : {}),
      }, exec)
    }
    const decisionCalls = decision.mock.calls as unknown as Array<[{ decision: string }]>
    expect(decisionCalls.map(call => call[0].decision)).toEqual([
      'cancel', 'retry_review', 'authorize_final_rework', 'waive', 'fail',
    ])
  })

  it('auto-resumes a paused retry and identifies an untouched paused plan', async () => {
    const controllerId = SessionId('controller-paused-retry')
    const parentId = SessionId('parent-paused-retry')
    const controllerSession = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, cwd: 'F:\\project' })
    const parentSession = Session.create(parentId, [], { version: 0, id: parentId, createdAt: 0, cwd: 'F:\\project' })
    const events = completeTeamEvents()
    for (const event of events) controllerSession.append(TEAM_SESSION_EVENT, { event })
    controllerSession.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: String(parentId), generation: 1, operationId: 'bind-paused-retry', boundAt: '2026-08-31T00:00:00.000Z',
    })
    parentSession.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(controllerId), sourceEventCount: events.length, events,
    })
    const resumeTeam = vi.fn(async () => ({ team: { id: 'team-1', status: 'running' } }))
    const { control } = mount({
      retryTask: vi.fn(async () => ({ team: { id: 'team-1', status: 'paused' } })),
      resumeTeam,
      resolveTeamController: vi.fn(async () => ({ id: controllerId, session: controllerSession })),
    })
    const exec = execution({ id: parentId, session: parentSession, options: { provider: 'provider-a', model: 'model-a' } } as unknown as Agent)

    await control.execute({ action: 'retry', taskId: 'task-1' }, exec)
    expect(resumeTeam).toHaveBeenCalledOnce()

    const { start } = mount({
      runTeam: vi.fn(async () => ({
        projection: {
          team: { id: 'team-plan', status: 'paused' },
          taskIds: ['task-plan'],
          tasks: { 'task-plan': { status: 'pending', contract: { goal: 'Await plan confirmation.' } } },
          reviews: {},
        },
        reason: 'paused',
      })),
    })
    await expect(start.execute(compactInput, execution(parentAgent()))).resolves.toMatchObject({
      status: 'paused', attentionReason: 'plan_confirmation', requiresAttention: true,
    })
  })
})
