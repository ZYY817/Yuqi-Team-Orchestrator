import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/agent/index.ts'
import { DEFAULT_TEAM_CONCURRENCY } from '../src/application/team-settings.ts'
import { YuqiOrchestratorError } from '../src/application/errors.ts'
import { teamWorkspaceSchema } from '../src/domain/workspace.ts'
import { NodeGitWorkspacePort } from '../src/host/git/git-workspace.ts'
import { StartTeamCoordinator } from '../src/host/harness/start-team.ts'
import { replayTeamEvents } from '../src/domain/projection.ts'
import { commitYuqiSessionEvent, TEAM_PARENT_BINDING_EVENT, TEAM_PARENT_PROJECTION_EVENT, TEAM_SESSION_EVENT } from '../src/host/harness/session-journal.ts'
import { SidecarRepository } from '../src/host/storage/session-sidecar.ts'
import type { OwnedEventRecord, OwnedEventTable } from '../src/host/storage/owned-event-store.ts'
import { completeTeamEvents } from './fixtures.ts'
import type { ReviewPolicy } from '../src/domain/review-policy.ts'
import { DurableJournalCoordinator } from '../src/application/durable-journal.ts'
import { TaskRevisionCoordinator } from '../src/application/create-task-revision.ts'
import { TeamBootstrapCoordinator } from '../src/application/bootstrap-team.ts'
import { decideQualityGate } from '../src/application/quality-gate.ts'
import type { TeamEvent } from '../src/domain/events.ts'

const execFileAsync = promisify(execFile)

const controller = {
  id: 'controller-1', options: { provider: 'deepseek', model: 'deepseek-v4' },
  session: { header: { cwd: 'F:\\project' }, events: [] },
} as unknown as Agent

const validInput = {
  title: 'Yuqi Team',
  objective: 'Build the first agent entry',
  tasks: [{
    taskId: 'task-1',
    revision: 1,
    goal: 'Implement the entry',
    scope: ['src/agent'],
    nonGoals: ['run execution'],
    dependencies: [],
    fileScope: ['src/agent/**'],
    modelRole: 'worker' as const,
    acceptanceCriteria: ['typecheck passes'],
    authorityMode: 'write-authorized' as const,
    verificationChecks: [{
      checkId: 'build', kind: 'build' as const, commandRef: 'pnpm-typecheck', timeoutMs: 120_000,
      stdoutMaxBytes: 64_000, stderrMaxBytes: 64_000,
    }],
    maxAttempts: 2,
  }],
  maxConcurrency: 2,
}

const disposers: Array<() => Promise<void>> = []

function bindSidecar(...sessions: Session[]): void {
  const records = new Map<string, OwnedEventRecord>()
  const table: OwnedEventTable = {
    get: key => records.get(key), entries: () => records.entries(),
    put: async (key, value) => { records.set(key, value) },
    update: async (key, transform) => {
      const value = transform(records.get(key)!)
      records.set(key, value)
      return value
    },
  }
  const repository = new SidecarRepository(table)
  for (const session of sessions) repository.bind(session)
  disposers.push(async () => { repository.dispose() })
}

afterEach(async () => {
  await Promise.all(disposers.splice(0).map(dispose => dispose()))
})

function registerTool(service: {
  startTeam: ReturnType<typeof vi.fn>
  runTeam: ReturnType<typeof vi.fn>
  launchTeamInBackground?: ReturnType<typeof vi.fn>
  abortTeam?: ReturnType<typeof vi.fn>
  pauseTeam?: ReturnType<typeof vi.fn>
  maxConcurrencyLimit?: () => number
  teamDefaults?: () => {
    maxConcurrency: number
    childPresetId: string
    childModelId: string
    childModelPolicy: 'inherit' | 'fixed' | 'automatic'
    quickModelId: string
    standardModelId: string
    criticalModelId: string
    requirePlanConfirmation?: boolean
    defaultAuthorityMode: 'read-only' | 'write-authorized' | 'full-access'
    defaultWorkspaceMode?: 'direct' | 'git-worktree'
    gitWorkspaceRoot?: string
    reviewPolicy?: ReviewPolicy
  }
}): { tool: ToolDefinition; tools: readonly ToolDefinition[]; scoped: boolean } {
  let definition: ToolDefinition | undefined
  const tools: ToolDefinition[] = []
  const registry = { register(value: ToolDefinition) { tools.push(value); if (value.name === 'yuqi_team_start') definition = value } }
  const root = new Context()
  root.provide('tools', registry as never)
  root.provide('yuqiTeamOrchestrator', service as never)
  const key = {}
  const scope = createScope(root, key)
  apply(scope.ctx)
  disposers.push(scope.dispose)
  if (definition === undefined) throw new Error('tool was not registered')
  return { tool: definition, tools, scoped: scopeOf(scope.ctx) === key }
}

function execution(agent: Agent | undefined, signal = new AbortController().signal): ToolRunContext {
  return { agent, signal } as ToolRunContext
}

describe('Yuqi preset agent tool', () => {
  it('routes a configured isolation parent only to Git Teams', async () => {
    const startTeam = vi.fn(async () => ({ teamId: 'custom-root', sessionId: 'custom-session', controller: { id: 'custom-controller' }, dispose: vi.fn(async () => {}) }))
    const runTeam = vi.fn(async () => ({ projection: { team: { id: 'custom-root', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed' }))
    const tool = registerTool({ startTeam, runTeam, teamDefaults: () => ({
      maxConcurrency: 100, childPresetId: 'standard', childModelId: '', childModelPolicy: 'inherit',
      quickModelId: '', standardModelId: '', criticalModelId: '', defaultAuthorityMode: 'write-authorized',
      defaultWorkspaceMode: 'git-worktree', gitWorkspaceRoot: 'F:\\Custom Team Workspaces',
    }) }).tool
    await tool.execute(validInput, execution(controller))
    expect(startTeam).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceMode: 'git-worktree', managedRoot: 'F:\\Custom Team Workspaces' }))
    await tool.execute({ ...validInput, workspaceMode: 'direct' }, execution(controller))
    expect(startTeam).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceMode: 'direct', managedRoot: path.dirname('F:\\project') }))
  })
  it('requests an atomically paused Team before dispatch when graphical plan confirmation is enabled', async () => {
    const startedController = { id: 'started-controller' }
    const pauseTeam = vi.fn(async () => ({ team: { id: 'team-plan', status: 'paused' } }))
    const pausedProjection = { team: { id: 'team-plan', status: 'paused', planConfirmationRequired: true }, taskIds: ['task-1'], controlOperations: { 'plan-review:team-plan': { action: 'pause' } } }
    const startTeam = vi.fn(async () => ({ teamId: 'team-plan', sessionId: 'session-plan', controller: startedController, bootstrap: pausedProjection, dispose: vi.fn(async () => {}) }))
    const runTeam = vi.fn(async () => ({ projection: { team: { id: 'team-plan', status: 'paused' }, taskIds: ['task-1'] }, reason: 'paused' }))
    const tool = registerTool({ startTeam, pauseTeam, runTeam, teamDefaults: () => ({
      maxConcurrency: 4, childPresetId: 'standard', childModelId: '', childModelPolicy: 'inherit',
      quickModelId: '', standardModelId: '', criticalModelId: '', requirePlanConfirmation: true, defaultAuthorityMode: 'write-authorized',
    }) }).tool
    await expect(tool.execute(validInput, execution(controller))).resolves.toMatchObject({ teamId: 'team-plan', status: 'paused', terminal: false })
    expect(startTeam).toHaveBeenCalledWith(expect.objectContaining({ requirePlanConfirmation: true }))
    expect(pauseTeam).not.toHaveBeenCalled()
    expect(runTeam).toHaveBeenCalled()
  })
  it('registers a paused plan with the Host background runner without holding the tool call open', async () => {
    const startedController = { id: 'started-controller-background-plan' }
    const pausedProjection = { team: { id: 'team-background-plan', status: 'paused', planConfirmationRequired: true }, controlOperations: { 'plan-review:team-background-plan': { action: 'pause' } }, taskIds: ['task-1'], tasks: { 'task-1': { status: 'pending', contract: { goal: 'Implement the entry' } } } }
    const startTeam = vi.fn(async () => ({ teamId: 'team-background-plan', sessionId: 'session-background-plan', controller: startedController, bootstrap: pausedProjection, dispose: vi.fn(async () => {}) }))
    const pauseTeam = vi.fn(async () => pausedProjection)
    const runTeam = vi.fn()
    const launchTeamInBackground = vi.fn(() => ({ projection: pausedProjection, reason: 'background-started', disposition: 'started', cycles: 0 }))
    const tool = registerTool({ startTeam, pauseTeam, runTeam, launchTeamInBackground, teamDefaults: () => ({
      maxConcurrency: 4, childPresetId: 'standard', childModelId: '', childModelPolicy: 'inherit',
      quickModelId: '', standardModelId: '', criticalModelId: '', requirePlanConfirmation: true, defaultAuthorityMode: 'write-authorized',
    }) }).tool
    await expect(tool.execute(validInput, execution(controller))).resolves.toMatchObject({
      teamId: 'team-background-plan', status: 'paused', stopReason: 'paused', disposition: 'recoverable',
    })
    expect(launchTeamInBackground).toHaveBeenCalledWith(expect.objectContaining({ controller: startedController, teamId: 'team-background-plan' }))
    expect(runTeam).not.toHaveBeenCalled()
  })

  it('reports a background launch without fabricating a loop stop reason', async () => {
    const startedController = { id: 'started-controller-background' }
    const runningProjection = { team: { id: 'team-background', status: 'running' }, taskIds: ['task-1'], tasks: { 'task-1': { status: 'pending', contract: { goal: 'Implement the entry' } } } }
    const startTeam = vi.fn(async () => ({ teamId: 'team-background', sessionId: 'session-background', controller: startedController, dispose: vi.fn(async () => {}) }))
    const launchTeamInBackground = vi.fn(() => ({ projection: runningProjection, reason: 'background-started' as const, disposition: 'started' as const, cycles: 0 }))
    const tool = registerTool({ startTeam, runTeam: vi.fn(), launchTeamInBackground }).tool

    await expect(tool.execute(validInput, execution(controller))).resolves.toMatchObject({
      teamId: 'team-background', status: 'running', stopReason: 'background-started', disposition: 'started',
      terminal: false, requiresAttention: false,
    })
    expect(launchTeamInBackground).toHaveBeenCalledOnce()
  })
  it('fails closed and aborts when an older Host ignores the atomic plan gate', async () => {
    const startedController = { id: 'legacy-controller' }
    const runningProjection = { team: { id: 'team-legacy', status: 'running' }, taskIds: ['task-1'], controlOperations: {} }
    const startTeam = vi.fn(async () => ({ teamId: 'team-legacy', sessionId: 'session-legacy', controller: startedController, bootstrap: runningProjection, dispose: vi.fn(async () => {}) }))
    const abortTeam = vi.fn(async () => ({ team: { id: 'team-legacy', status: 'cancelled' } }))
    const runTeam = vi.fn()
    const launchTeamInBackground = vi.fn()
    const tool = registerTool({ startTeam, abortTeam, runTeam, launchTeamInBackground, teamDefaults: () => ({
      maxConcurrency: 4, childPresetId: 'standard', childModelId: '', childModelPolicy: 'inherit',
      quickModelId: '', standardModelId: '', criticalModelId: '', requirePlanConfirmation: true, defaultAuthorityMode: 'write-authorized',
    }) }).tool

    await expect(tool.execute(validInput, execution(controller))).rejects.toThrow(/CONTROLLER_REQUIRES_RECONCILIATION/u)
    expect(abortTeam).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team-legacy' }))
    expect(launchTeamInBackground).not.toHaveBeenCalled()
    expect(runTeam).not.toHaveBeenCalled()
  })
  it('registers only in the supplied preset context and starts then runs the complete contract', async () => {
    const startedController = { id: 'started-controller' }
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({ teamId: 'team-host-1', sessionId: 'session-host-1', controller: startedController, dispose }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-host-1', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed',
    }))
    const mounted = registerTool({ startTeam, runTeam })
    const tool = mounted.tool

    expect(name).toBe('yuqi-team-orchestrator-agent')
    expect(inject).toEqual(['tools', 'yuqiTeamOrchestrator'])
    expect(mounted.scoped).toBe(true)
    expect(mounted.tools.map(item => item.name)).toEqual(['yuqi_team_knowledge', 'yuqi_team_start', 'yuqi_team_control', 'yuqi_team_revise', 'yuqi_team_message'])
    for (const registered of mounted.tools) {
      expect(registered.output?.render({}, { ok: true })).toEqual([{ type: 'text', text: '{"ok":true}' }])
    }
    const parameters = JSON.stringify(tool.parameters)
    expect(parameters).toMatch(/verificationChecks|pnpm-typecheck|maxAttempts/)
    expect(parameters).toContain('Omit or use [] when the task has no dependencies')
    expect(parameters).toContain('at most 300000')
    expect(parameters).toContain('planning, conflict-avoidance, and change-presentation hint')
    expect(parameters).toContain('not a filesystem write limit')
    expect(parameters).toContain('Do not split one module into one task per file')
    expect(parameters).toContain('src/features/auth/**')
    expect(parameters).toContain('projectPath')
    expect(parameters).toContain('Normally omit')
    expect(parameters).toContain('Goals are shown to the user before execution and passed unchanged to the child')
    expect((tool.parameters as any).properties.tasks.items.properties.goal.description).toContain('actual action, its object, and the intended result')
    expect((tool.parameters as any).properties.tasks.items.properties.goal.description).toContain('Distinguish reading/organizing from changing')
    expect((tool.parameters as any).properties.tasks.items.properties.scope.required).toBeUndefined()
    expect((tool.parameters as any).properties.tasks.items.properties.nonGoals.required).toBeUndefined()
    expect((tool.parameters as any).properties.tasks.items.properties.acceptanceCriteria.required).toBeUndefined()
    expect(parameters).toContain('researcher')
    expect(parameters).toContain('ui-designer')
    expect(tool.description).toContain('call this tool promptly before Shell')
    expect(tool.description).toContain('ordinary discussion and simple work stay on normal tools')
    expect(parameters).toContain('modelId')
    expect(parameters).toContain('providerId')
    expect(parameters).not.toMatch(/inputDigest|baselineRef/)
    const revise = mounted.tools.find(item => item.name === 'yuqi_team_revise')!
    expect((revise.parameters as any).properties.goal.description).toContain('actual action, object, and intended result')
    expect((revise.parameters as any).properties.goal.description).toContain('passed unchanged to the revision child')
    await expect(tool.execute(validInput, execution(controller))).resolves.toEqual({
      teamId: 'team-host-1', status: 'completed', taskCount: 1,
      controllerSessionId: 'session-host-1', stopReason: 'completed',
      disposition: 'completed',
      terminal: true, requiresAttention: false,
    })
    expect(startTeam).toHaveBeenCalledWith(expect.objectContaining({
      title: validInput.title, objective: validInput.objective,
      tasks: [expect.objectContaining({
        ...validInput.tasks[0],
        modelRequest: { kind: 'default' },
        baselineRef: 'host-pending-baseline',
        inputDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      })],
      projectCwd: 'F:\\project', controllerModel: controller.options,
      workspaceMode: 'direct',
      modelRouting: { providerScope: { kind: 'controller-only' }, teamPolicy: { kind: 'inherit' } },
    }))
    expect(runTeam).toHaveBeenCalledWith(expect.objectContaining({
      controller: startedController, teamId: 'team-host-1', maxConcurrency: DEFAULT_TEAM_CONCURRENCY,
      disposeController: dispose,
    }))
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('persists the current request route instead of the stale Agent default when starting a Team', async () => {
    const startTeam = vi.fn(async () => ({
      teamId: 'team-request-route', sessionId: 'session-request-route', controller: {}, dispose: vi.fn(async () => {}),
    }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-request-route', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed',
    }))
    const selected = {
      provider: 'deepxiaohao',
      model: 'deepseek-v4-flash-0731',
      reasoningEffort: 'medium',
    }
    const parent = {
      ...controller,
      options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      session: {
        header: { cwd: 'F:\\project' },
        requestHeader: () => ({ config: selected }),
        events: [],
      },
    } as unknown as Agent
    const tool = registerTool({ startTeam, runTeam }).tool

    await expect(tool.execute(validInput, execution(parent))).resolves.toMatchObject({ teamId: 'team-request-route' })
    expect(startTeam).toHaveBeenCalledWith(expect.objectContaining({
      controllerModel: { provider: selected.provider, model: selected.model },
      modelRouting: { providerScope: { kind: 'controller-only' }, teamPolicy: { kind: 'inherit' } },
    }))
  })

  it.each([
    { provider: undefined, model: 'request-model' },
    { provider: 'request-provider', model: undefined },
  ])('falls back as one route when request header has an incomplete provider/model pair', async incomplete => {
    const startTeam = vi.fn(async () => ({
      teamId: 'team-incomplete-route', sessionId: 'session-incomplete-route', controller: {}, dispose: vi.fn(async () => {}),
    }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-incomplete-route', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed',
    }))
    const fallback = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    const parent = {
      ...controller,
      options: fallback,
      session: {
        header: { cwd: 'F:\\project' },
        requestHeader: () => ({ config: incomplete }),
        events: [],
      },
    } as unknown as Agent
    const tool = registerTool({ startTeam, runTeam }).tool

    await tool.execute(validInput, execution(parent))

    expect(startTeam).toHaveBeenCalledWith(expect.objectContaining({ controllerModel: fallback }))
  })

  it('keeps the captured request route when Agent options change to the next-step selection during start', async () => {
    const selected = { provider: 'deepxiaohao', model: 'deepseek-v4-flash-0731' }
    const next = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    const parent = {
      ...controller,
      options: { ...next },
      session: {
        header: { cwd: 'F:\\project' },
        requestHeader: () => ({ config: selected }),
        events: [],
      },
    } as unknown as Agent
    const startTeam = vi.fn(async () => {
      ;(parent.options as { provider: string; model: string }).provider = next.provider
      ;(parent.options as { provider: string; model: string }).model = next.model
      return { teamId: 'team-route-race', sessionId: 'session-route-race', controller: {}, dispose: vi.fn(async () => {}) }
    })
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-route-race', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed',
    }))
    const tool = registerTool({ startTeam, runTeam }).tool

    await tool.execute(validInput, execution(parent))

    expect(startTeam).toHaveBeenCalledWith(expect.objectContaining({ controllerModel: selected }))
  })

  it('accepts an explicit locale, infers a clear user language, and otherwise keeps the zh compatibility default', async () => {
    const startTeam = vi.fn(async (_request: { readonly locale?: 'zh' | 'en' }) => ({
      teamId: 'team-locale', sessionId: 'session-locale', controller: {}, dispose: vi.fn(async () => {}),
    }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-locale', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed',
    }))
    const tool = registerTool({ startTeam, runTeam }).tool
    const englishController = {
      ...controller,
      session: {
        header: { cwd: 'F:\\project' },
        events: [{
          type: 'user/message',
          data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please run this work as a team.' }] },
        }],
      },
    } as unknown as Agent

    await tool.execute({ ...validInput, locale: 'en' }, execution(controller))
    await tool.execute(validInput, execution(englishController))
    await tool.execute(validInput, execution(controller))
    const snapshotController = { ...englishController, session: {
      header: englishController.session.header,
      snapshotEvents: () => englishController.session.events,
      get events(): never { throw new Error('legacy events must not be read') },
    } } as unknown as Agent
    await tool.execute(validInput, execution(snapshotController))

    const sidecarController = { ...englishController, session: {
      ...englishController.session, id: SessionId('sidecar-locale'),
    } } as unknown as Agent
    bindSidecar(sidecarController.session)
    await tool.execute(validInput, execution(sidecarController))

    expect((tool.parameters as any).properties.locale.enum).toEqual(['zh', 'en'])
    expect(startTeam.mock.calls.map(([request]) => request.locale)).toEqual(['en', 'en', 'zh', 'en', 'en'])
  })

  it('infers locale from the latest usable user text while ignoring malformed and non-user events', async () => {
    const startTeam = vi.fn(async () => ({
      teamId: 'team-locale-branches', sessionId: 'session-locale-branches', controller: {}, dispose: vi.fn(async () => {}),
    }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-locale-branches', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed',
    }))
    const tool = registerTool({ startTeam, runTeam }).tool
    const withEvents = (events: readonly unknown[]) => ({
      ...controller,
      session: { header: { cwd: 'F:\\project' }, events },
    }) as unknown as Agent

    await tool.execute(validInput, execution(withEvents([
      { type: 'user/message', data: { content: [{ type: 'text', text: '请执行团队任务' }] } },
      7,
      { type: 'assistant/message', data: {} },
      { type: 'user/message', data: null },
      { type: 'user/message', data: { source: { kind: 'assistant' }, content: [{ type: 'text', text: 'Ignore me please' }] } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: 'not-an-array' } },
    ])))
    await tool.execute(validInput, execution(withEvents([{
      type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'image' }, null] },
    }])))
    await tool.execute(validInput, execution(withEvents([{
      type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Proceed' }] },
    }])))

    expect(startTeam.mock.calls.map(call => (call as unknown as [{ locale: string }])[0].locale)).toEqual(['zh', 'zh', 'zh'])
  })

  it('expands a compact model task into the complete durable contract', async () => {
    const startTeam = vi.fn(async () => ({ teamId: 'team-compact', sessionId: 'controller-compact', controller: { id: 'controller-compact' }, dispose: vi.fn(async () => {}) }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-compact', status: 'completed' }, taskIds: ['task-compact'] }, reason: 'completed',
    }))
    const tool = registerTool({ startTeam, runTeam }).tool

    await tool.execute({
      title: 'Compact Team',
      objective: 'Upgrade the website visual system.',
      projectPath: 'website',
      tasks: [{
        taskId: 'task-compact', revision: 1, goal: 'Upgrade the hero section.', dependencies: [],
        fileScope: ['src/components/Hero.tsx', 'src/hero.css'], modelRole: 'worker',
      }],
    }, execution(controller))

    expect(startTeam).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({
        fileScope: ['src/components/Hero.tsx', 'src/hero.css'],
        scope: ['Upgrade the hero section.'],
        nonGoals: ['Do not make changes unrelated to the assigned task goal.'],
        acceptanceCriteria: ['Complete the task goal and report every repository-relative file changed: Upgrade the hero section.'],
      })],
    }))
  })

  it('selects a nested project root explicitly and rejects path escape', async () => {
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({
      teamId: 'team-nested', sessionId: 'session-nested', controller: { id: 'nested-controller' }, dispose,
    }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-nested', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed',
    }))
    const tool = registerTool({ startTeam, runTeam }).tool

    await expect(tool.execute({ ...validInput, projectPath: 'website' }, execution(controller))).resolves.toMatchObject({
      teamId: 'team-nested', status: 'completed',
    })
    expect(startTeam).toHaveBeenCalledWith(expect.objectContaining({
      projectCwd: path.resolve('F:\\project', 'website'),
      workspaceMode: 'direct',
      managedRoot: path.resolve('F:\\project'),
    }))
    await tool.execute({ ...validInput, projectPath: 'website', workspaceMode: 'git-worktree' }, execution(controller))
    expect(startTeam).toHaveBeenLastCalledWith(expect.objectContaining({
      projectCwd: path.resolve('F:\\project', 'website'),
      workspaceMode: 'git-worktree',
      managedRoot: path.resolve('F:\\project', '..', '.yuqi-team-worktrees'),
    }))
    await expect(tool.execute({ ...validInput, projectPath: '..\\outside' }, execution(controller)))
      .rejects.toThrow(/projectPath must select a nested directory/u)
  })

  it.each(['native', 'sidecar'] as const)('rejects duplicate Team startup from %s while the current conversation already owns a non-terminal Team', async source => {
    const controllerId = SessionId('existing-team-controller')
    const parentId = SessionId('existing-team-parent')
    const parentSession = Session.create(parentId, [], { version: 0, id: parentId, createdAt: 0, cwd: 'F:\\project' })
    const pausedEvents = [
      ...completeTeamEvents().slice(0, 4),
      { ...completeTeamEvents()[1]!, eventId: 'existing-team-pausing' as never, type: 'yuqi/team-status-changed' as const, from: 'running' as const, to: 'pausing' as const },
      { ...completeTeamEvents()[1]!, eventId: 'existing-team-paused' as never, type: 'yuqi/team-status-changed' as const, from: 'pausing' as const, to: 'paused' as const },
    ]
    if (source === 'sidecar') bindSidecar(parentSession)
    await commitYuqiSessionEvent(parentSession, TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(controllerId), sourceEventCount: pausedEvents.length, events: pausedEvents,
    })
    const parentAgent = { id: parentId, session: parentSession, options: controller.options } as unknown as Agent
    const startTeam = vi.fn()
    const tool = registerTool({ startTeam, runTeam: vi.fn() }).tool

    await expect(tool.execute(validInput, execution(parentAgent))).rejects.toThrow(/already has active Team team-1 \(paused\).*instead of creating a duplicate Team/u)
    expect(startTeam).not.toHaveBeenCalled()
  })

  it.each(['native', 'sidecar'] as const)('resumes the active bound Team from %s natural-language control without requiring copied identities', async source => {
    const controllerId = SessionId('bound-controller')
    const parentId = SessionId('bound-parent')
    const controllerSession = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, cwd: 'F:\\project' })
    const parentSession = Session.create(parentId, [], { version: 0, id: parentId, createdAt: 0, cwd: 'F:\\project' })
    const pausedEvents = [
      ...completeTeamEvents().slice(0, 4),
      { ...completeTeamEvents()[1]!, eventId: 'control-pausing' as never, type: 'yuqi/team-status-changed' as const, from: 'running' as const, to: 'pausing' as const },
      { ...completeTeamEvents()[1]!, eventId: 'control-paused' as never, type: 'yuqi/team-status-changed' as const, from: 'pausing' as const, to: 'paused' as const },
    ]
    if (source === 'sidecar') bindSidecar(controllerSession, parentSession)
    for (const fact of pausedEvents) await commitYuqiSessionEvent(controllerSession, TEAM_SESSION_EVENT, { event: fact })
    await commitYuqiSessionEvent(controllerSession, TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: String(parentId), generation: 1, operationId: 'bind-control', boundAt: '2026-08-29T00:00:00.000Z',
    })
    await commitYuqiSessionEvent(parentSession, TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(controllerId), sourceEventCount: pausedEvents.length, events: pausedEvents,
    })
    const controllerAgent = { id: controllerId, session: controllerSession } as unknown as Agent
    const parentAgent = { id: parentId, session: parentSession, options: { provider: 'deepseek', model: 'deepseek-v4' } } as unknown as Agent
    const projection = replayTeamEvents(pausedEvents)
    const pauseTeam = vi.fn(async () => projection)
    const resumeTeam = vi.fn(async () => ({ ...projection, team: { ...projection.team, status: 'running' as const } }))
    const cancelTeam = vi.fn(async () => ({ ...projection, team: { ...projection.team, status: 'cancelled' as const } }))
    const reconcileTeam = vi.fn(async () => projection)
    const clearTeamRecovery = vi.fn(async () => projection)
    const recoverAndContinueTeam = vi.fn(async () => ({ ...projection, team: { ...projection.team, status: 'running' as const } }))
    const retryTask = vi.fn(async () => projection)
    const stopTask = vi.fn(async () => projection)
    const decideReview = vi.fn(async () => projection)
    const mounted = registerTool({
      startTeam: vi.fn(), runTeam: vi.fn(),
      resolveTeamController: vi.fn(async () => controllerAgent),
      pauseTeam, resumeTeam, cancelTeam, reconcileTeam, clearTeamRecovery, recoverAndContinueTeam, retryTask, stopTask, decideReview,
    } as never)
    const control = mounted.tools.find(item => item.name === 'yuqi_team_control')!
    expect((control.parameters as any).properties.action.enum).toEqual([
      'pause', 'resume', 'cancel', 'reconcile', 'recover', 'recover_continue', 'retry', 'stop', 'scope',
      'retry_review', 'authorize_final_rework', 'waive', 'fail', 'cancel_review',
    ])
    await expect(control.execute({ action: 'resume' }, execution(parentAgent))).resolves.toMatchObject({ accepted: true, status: 'running' })
    await expect(control.execute({ action: 'pause', teamId: 'team-1', controllerSessionId: String(controllerId) }, execution(parentAgent))).resolves.toMatchObject({ accepted: true })
    await expect(control.execute({ action: 'cancel' }, execution(parentAgent))).resolves.toMatchObject({ accepted: true, status: 'cancelled' })
    await expect(control.execute({ action: 'reconcile' }, execution(parentAgent))).resolves.toMatchObject({ accepted: true })
    await expect(control.execute({ action: 'recover' }, execution(parentAgent))).resolves.toMatchObject({ accepted: true })
    await expect(control.execute({ action: 'recover_continue', requestId: 'recover-current-team' }, execution(parentAgent))).resolves.toMatchObject({ accepted: true, status: 'running' })
    expect(recoverAndContinueTeam).toHaveBeenCalledWith(expect.objectContaining({ controller: controllerAgent, teamId: 'team-1', signal: expect.any(AbortSignal) }))
    recoverAndContinueTeam.mockResolvedValueOnce({ ...projection, team: { ...projection.team, status: 'needs_reconciliation' } } as never)
    await expect(control.execute({ action: 'recover_continue', requestId: 'recover-still-blocked' }, execution(parentAgent))).resolves.toMatchObject({ accepted: true, status: 'needs_reconciliation' })
    await expect(control.execute({ action: 'retry', taskId: 'task-1' }, execution(parentAgent))).resolves.toMatchObject({ accepted: true, status: 'running', taskId: 'task-1' })
    await expect(control.execute({ action: 'stop', taskId: 'task-1' }, execution(parentAgent))).resolves.toMatchObject({ accepted: true, taskId: 'task-1' })
    await expect(control.execute({ action: 'stop' }, execution(parentAgent))).rejects.toThrow(/taskId is required/u)
    await expect(control.execute({ action: 'retry' }, execution(parentAgent))).rejects.toThrow(/taskId is required/u)
    await expect(control.execute({ action: 'pause', taskId: 'task-1' }, execution(parentAgent))).rejects.toThrow(/taskId is only valid for retry, stop, or scope/u)
    await expect(control.execute({ action: 'retry_review' }, execution(parentAgent))).rejects.toThrow(/reviewId, candidateEventId, reviewRound, and requestId are required/u)
    await expect(control.execute({
      action: 'waive', reviewId: 'review-1', candidateEventId: 'candidate-1', reviewRound: 1, requestId: 'request-waive',
    }, execution(parentAgent))).rejects.toThrow(/waive requires a reason/u)

    for (const [action, decision] of [
      ['retry_review', 'retry_review'],
      ['authorize_final_rework', 'authorize_final_rework'],
      ['waive', 'waive'],
      ['fail', 'fail'],
      ['cancel_review', 'cancel'],
    ] as const) {
      await expect(control.execute({
        action, reviewId: 'review-1', candidateEventId: 'candidate-1', reviewRound: 1,
        requestId: `request-${action}`, ...(action === 'waive' ? { reason: 'accepted risk' } : {}),
      }, execution(parentAgent))).resolves.toMatchObject({ teamId: 'team-1', accepted: true })
      expect(decideReview).toHaveBeenLastCalledWith(expect.objectContaining({
        controller: controllerAgent, teamId: 'team-1', reviewId: 'review-1', candidateEventId: 'candidate-1',
        round: 1, decision, ...(action === 'waive' ? { reason: 'accepted risk' } : {}),
      }))
    }
    expect(resumeTeam).toHaveBeenCalledWith(expect.objectContaining({ controller: controllerAgent, teamId: 'team-1' }))
    expect(pauseTeam).toHaveBeenCalledTimes(1)
    expect(cancelTeam).toHaveBeenCalledTimes(1)
    expect(reconcileTeam).toHaveBeenCalledTimes(1)
    expect(clearTeamRecovery).toHaveBeenCalledWith(expect.objectContaining({
      controller: controllerAgent, teamId: 'team-1', target: 'paused',
    }))
    expect(retryTask).toHaveBeenCalledWith(expect.objectContaining({ controller: controllerAgent, teamId: 'team-1', taskId: 'task-1' }))
    expect(stopTask).toHaveBeenCalledWith(expect.objectContaining({ controller: controllerAgent, teamId: 'team-1', taskId: 'task-1' }))
    expect(decideReview).toHaveBeenCalledTimes(5)
  })

  it('cancels an exact workspace-conflict Team from another conversation', async () => {
    const currentId = SessionId('unrelated-parent')
    const current = {
      id: currentId,
      session: Session.create(currentId),
      options: { provider: 'deepseek', model: 'deepseek-v4' },
    } as unknown as Agent
    const projection = replayTeamEvents(completeTeamEvents())
    const controlTeamByIdentity = vi.fn(async () => ({
      ...projection,
      team: { ...projection.team, status: 'cancelled' as const },
    }))
    const mounted = registerTool({
      startTeam: vi.fn(), runTeam: vi.fn(), controlTeamByIdentity,
    } as never)
    const control = mounted.tools.find(item => item.name === 'yuqi_team_control')!

    await expect(control.execute({
      action: 'cancel',
      teamId: 'team-1',
      controllerSessionId: 'foreign-controller',
      requestId: 'cancel-conflict-team',
    }, execution(current))).resolves.toMatchObject({
      teamId: 'team-1', status: 'cancelled', accepted: true,
    })
    expect(controlTeamByIdentity).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-1', controllerSessionId: 'foreign-controller', action: 'cancel',
    }))
  })

  it('routes a completed-task revision from the bound main conversation with stable identity', async () => {
    const controllerId = SessionId('revision-controller')
    const parentId = SessionId('revision-parent')
    const controllerSession = Session.create(controllerId)
    const parentSession = Session.create(parentId)
    const stored = [...completeTeamEvents().slice(0, -1)]
    for (const fact of stored) controllerSession.append(TEAM_SESSION_EVENT, { event: fact })
    controllerSession.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: String(parentId), generation: 1, operationId: 'bind-revision', boundAt: '2026-09-07T00:00:00Z',
    })
    parentSession.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(controllerId), sourceEventCount: stored.length, events: stored,
    })
    const controllerAgent = { id: controllerId, session: controllerSession } as unknown as Agent
    const parentAgent = { id: parentId, session: parentSession } as unknown as Agent
    let sequence = 1000
    const coordinator = new TaskRevisionCoordinator({ nowIso: () => '2026-09-07T00:00:00Z' },
      { next: () => `tool-revision-${++sequence}` }, new DurableJournalCoordinator())
    const createTaskRevision = vi.fn(async (request: Parameters<TaskRevisionCoordinator['create']>[0] & { controller: Agent }) => {
      const { controller: _controller, ...input } = request
      return coordinator.create(input, { key: String(controllerId), read: () => stored,
        commit: async events => { stored.push(...events) } })
    })
    const mounted = registerTool({ startTeam: vi.fn(), runTeam: vi.fn(),
      resolveTeamController: vi.fn(async () => controllerAgent), createTaskRevision } as never)
    const revise = mounted.tools.find(item => item.name === 'yuqi_team_revise')!
    const request = { sourceTaskId: 'task-1', requestId: 'ui-request-1', goal: 'Revise the text',
      acceptanceCriteria: ['New text verified'], includeDependents: true }
    const first = await revise.execute(request, execution(parentAgent))
    await expect(revise.execute(request, execution(parentAgent))).resolves.toEqual(first)
    expect(createTaskRevision).toHaveBeenLastCalledWith(expect.objectContaining({
      controller: controllerAgent, teamId: 'team-1', includeDependents: true,
      goal: request.goal, acceptanceCriteria: request.acceptanceCriteria,
    }))
    expect(first).toMatchObject({ accepted: true, taskIds: [expect.stringMatching(/^user-revision:/u)] })
    expect(replayTeamEvents(stored).taskIds).toHaveLength(2)
    await expect(revise.execute({ ...request, goal: 'Different request' }, execution(parentAgent))).rejects.toThrow('different requirements')
  })

  it('delivers a main-conversation follow-up to the active running child task', async () => {
    const controllerId = SessionId('message-controller')
    const parentId = SessionId('message-parent')
    const controllerSession = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, cwd: 'F:\\project' })
    const parentSession = Session.create(parentId, [], { version: 0, id: parentId, createdAt: 0, cwd: 'F:\\project' })
    const runningEvents = completeTeamEvents().slice(0, 8)
    for (const fact of runningEvents) controllerSession.append(TEAM_SESSION_EVENT, { event: fact })
    controllerSession.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: String(parentId), generation: 1, operationId: 'bind-message', boundAt: '2026-08-29T00:00:00.000Z',
    })
    parentSession.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(controllerId), sourceEventCount: runningEvents.length, events: runningEvents,
    })
    const controllerAgent = { id: controllerId, session: controllerSession } as unknown as Agent
    const parentAgent = { id: parentId, session: parentSession, options: { provider: 'deepseek', model: 'deepseek-v4' } } as unknown as Agent
    const sendTaskMessage = vi.fn(async () => ({ childSessionId: 'session-worker-1', messageId: 'followup-1' }))
    const mounted = registerTool({
      startTeam: vi.fn(), runTeam: vi.fn(), resolveTeamController: vi.fn(async () => controllerAgent), sendTaskMessage,
    } as never)
    const message = mounted.tools.find(item => item.name === 'yuqi_team_message')!
    await expect(message.execute({ taskId: 'task-1', message: '继续视觉升级' }, execution(parentAgent))).resolves.toEqual({
      taskId: 'task-1', childSessionId: 'session-worker-1', messageId: 'followup-1', accepted: true,
    })
    expect(sendTaskMessage).toHaveBeenCalledWith(expect.objectContaining({ controller: controllerAgent, teamId: 'team-1', taskId: 'task-1' }))
  })

  it('fails closed for stale, mismatched, unavailable, or foreign Team bindings', async () => {
    const controllerId = SessionId('guard-controller')
    const parentId = SessionId('guard-parent')
    const controllerSession = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, cwd: 'F:\\project' })
    const parentSession = Session.create(parentId, [], { version: 0, id: parentId, createdAt: 0, cwd: 'F:\\project' })
    const events = completeTeamEvents().slice(0, 8)
    for (const fact of events) controllerSession.append(TEAM_SESSION_EVENT, { event: fact })
    parentSession.append(TEAM_PARENT_PROJECTION_EVENT, { controllerSessionId: String(controllerId), sourceEventCount: events.length, events })
    const controllerAgent = { id: controllerId, session: controllerSession } as unknown as Agent
    const parentAgent = { id: parentId, session: parentSession } as unknown as Agent
    const resolver = vi.fn(async () => undefined as Agent | undefined)
    const mounted = registerTool({ startTeam: vi.fn(), runTeam: vi.fn(), resolveTeamController: resolver, resumeTeam: vi.fn() } as never)
    const control = mounted.tools.find(item => item.name === 'yuqi_team_control')!
    await expect(control.execute({ action: 'resume' }, execution(parentAgent))).rejects.toThrow(/unavailable/u)
    resolver.mockResolvedValue(controllerAgent)
    await expect(control.execute({ action: 'resume', teamId: 'other-team' }, execution(parentAgent))).rejects.toThrow(/identity mismatch/u)
    await expect(control.execute({ action: 'resume', controllerSessionId: 'missing-controller' }, execution(parentAgent))).rejects.toThrow(/not bound/u)
    const emptyId = SessionId('empty-parent')
    const empty = { id: emptyId, session: Session.create(emptyId) } as unknown as Agent
    await expect(control.execute({ action: 'resume' }, execution(empty))).rejects.toThrow(/no active/u)
    controllerSession.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: 'another-parent', generation: 1, operationId: 'foreign-bind', boundAt: '2026-08-29T00:00:00.000Z',
    })
    await expect(control.execute({ action: 'resume' }, execution(parentAgent))).rejects.toThrow(/another main conversation/u)
  })

  it('accepts human speciality aliases without forcing a lossy model retry', async () => {
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({
      teamId: 'team-role-alias', sessionId: 'session-role-alias', controller: { id: 'alias-controller' }, dispose,
    }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-role-alias', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed',
    }))
    const tool = registerTool({ startTeam, runTeam }).tool

    await tool.execute({
      ...validInput,
      tasks: validInput.tasks.map(task => ({ ...task, modelRole: 'researcher' })),
    }, execution(controller))

    expect(startTeam).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({ modelRole: 'worker', dependencies: [] })],
    }))
  })

  it('uses only the persisted user limit and never lets a model raise or lower it', async () => {
    const startedController = { id: 'configured-limit-controller' }
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({ teamId: 'team-configured-limit', sessionId: 'session-configured-limit', controller: startedController, dispose }))
    const runTeam = vi.fn(async () => ({ projection: { team: { id: 'team-configured-limit', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed' }))
    const tool = registerTool({ startTeam, runTeam, maxConcurrencyLimit: () => 16 }).tool

    const { maxConcurrency: _omitted, ...withoutRequest } = validInput
    await tool.execute(withoutRequest, execution(controller))
    expect(runTeam).toHaveBeenLastCalledWith(expect.objectContaining({ maxConcurrency: 16 }))

    await tool.execute({ ...validInput, maxConcurrency: 100 }, execution(controller))
    expect(runTeam).toHaveBeenLastCalledWith(expect.objectContaining({ maxConcurrency: 16 }))

    await tool.execute({ ...validInput, maxConcurrency: 3 }, execution(controller))
    expect(runTeam).toHaveBeenLastCalledWith(expect.objectContaining({ maxConcurrency: 16 }))
  })

  it('applies the saved child preset/model and allows an exact per-task model override', async () => {
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({ teamId: 'team-settings', sessionId: 'session-settings', controller: {}, dispose }))
    const runTeam = vi.fn(async () => ({ projection: { team: { id: 'team-settings', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed' }))
    const tool = registerTool({
      startTeam,
      runTeam,
      teamDefaults: () => ({
        maxConcurrency: 5,
        childPresetId: 'ptc',
        childModelId: 'saved-model',
        childModelPolicy: 'fixed',
        quickModelId: '',
        standardModelId: '',
        criticalModelId: '',
        defaultAuthorityMode: 'read-only',
      }),
    }).tool

    const { maxConcurrency: _omitted, ...withoutConcurrency } = validInput
    await tool.execute(withoutConcurrency, execution(controller))
    expect(startTeam).toHaveBeenLastCalledWith(expect.objectContaining({
      childPresetId: 'ptc',
      tasks: [expect.objectContaining({ modelRequest: { kind: 'default' } })],
      modelRouting: expect.objectContaining({ teamPolicy: { kind: 'fixed', model: { modelProvider: 'deepseek', modelId: 'saved-model' } } }),
    }))

    await tool.execute({
      ...withoutConcurrency,
      tasks: withoutConcurrency.tasks.map(task => ({ ...task, modelId: 'task-model' })),
    }, execution(controller))
    expect(startTeam).toHaveBeenLastCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({ modelRequest: { kind: 'legacy', modelId: 'task-model' } })],
    }))
  })

  it.each([
    { mode: 'off', maxReworkRounds: 0, additionalPrompt: 'no review' },
    { mode: 'manual', maxReworkRounds: 2, additionalPrompt: 'manual criteria' },
    { mode: 'quality-gate', maxReworkRounds: 3, additionalPrompt: 'inspect migrations and rollback' },
  ] as const)('snapshots the saved $mode reviewer policy into standard yuqi_team_start', async reviewPolicy => {
    const startTeam = vi.fn(async () => ({
      teamId: `team-${reviewPolicy.mode}`, sessionId: `session-${reviewPolicy.mode}`, controller: {}, dispose: vi.fn(async () => {}),
    }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: `team-${reviewPolicy.mode}`, status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed',
    }))
    const tool = registerTool({
      startTeam,
      runTeam,
      teamDefaults: () => ({
        maxConcurrency: 4, childPresetId: 'standard', childModelId: '', childModelPolicy: 'inherit',
        quickModelId: '', standardModelId: '', criticalModelId: '', defaultAuthorityMode: 'write-authorized',
        reviewPolicy,
      }),
    }).tool

    await tool.execute(validInput, execution(controller))

    expect(startTeam).toHaveBeenCalledWith(expect.objectContaining({ reviewPolicy }))
  })

  it('integrates saved settings through yuqi_team_start, Team event, projection, and quality gate snapshot', async () => {
    let savedReviewPolicy: ReviewPolicy = {
      mode: 'quality-gate', maxReworkRounds: 3, additionalPrompt: 'inspect migrations and rollback',
    }
    const events: TeamEvent[] = []
    const journal = {
      key: 'review-policy-integration',
      read: () => events,
      async commit(committed: readonly TeamEvent[]) { events.push(...committed) },
    }
    let sequence = 0
    const transactions = new DurableJournalCoordinator()
    const bootstrap = new TeamBootstrapCoordinator(
      { nowIso: () => '2026-08-31T00:00:00Z' },
      { next: () => `review-policy-${sequence++}` },
      transactions,
    )
    const startTeam = vi.fn(async request => {
      await bootstrap.bootstrap({
        metadata: {
          teamId: 'team-review-policy', title: request.title, objective: request.objective,
          reviewPolicy: request.reviewPolicy,
        },
        tasks: request.tasks,
      }, journal)
      return {
        teamId: 'team-review-policy', sessionId: 'session-review-policy', controller: {}, dispose: vi.fn(async () => {}),
      }
    })
    let qualityGateDecision: ReturnType<typeof decideQualityGate> | undefined
    const runTeam = vi.fn(async () => {
      events.push(...completeTeamEvents().slice(3, 16).map(item => ({ ...item, teamId: 'team-review-policy' } as TeamEvent)))
      const projection = replayTeamEvents(events)
      qualityGateDecision = decideQualityGate(projection)
      return { projection, reason: 'no-progress' as const }
    })
    const tool = registerTool({
      startTeam,
      runTeam,
      teamDefaults: () => ({
        maxConcurrency: 4, childPresetId: 'standard', childModelId: '', childModelPolicy: 'inherit',
        quickModelId: '', standardModelId: '', criticalModelId: '', defaultAuthorityMode: 'write-authorized',
        reviewPolicy: savedReviewPolicy,
      }),
    }).tool

    await tool.execute(validInput, execution(controller))
    savedReviewPolicy = { mode: 'off', maxReworkRounds: 0, additionalPrompt: 'new global value' }

    const created = events.find(item => item.type === 'yuqi/team-created')
    const projection = replayTeamEvents(events)
    expect(created).toMatchObject({ reviewPolicy: {
      mode: 'quality-gate', maxReworkRounds: 3, additionalPrompt: 'inspect migrations and rollback',
    } })
    expect(projection.team.reviewPolicy).toEqual({
      mode: 'quality-gate', maxReworkRounds: 3, additionalPrompt: 'inspect migrations and rollback',
    })
    expect(qualityGateDecision).toMatchObject({ kind: 'review', trigger: 'quality-gate', round: 0 })
    await transactions.dispose()
  })

  it('applies the saved default permission when a task omits its override', async () => {
    const startTeam = vi.fn(async () => ({ teamId: 'team-authority', sessionId: 'session-authority', controller: {}, dispose: vi.fn(async () => {}) }))
    const runTeam = vi.fn(async () => ({ projection: { team: { id: 'team-authority', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed' }))
    const mounted = registerTool({ startTeam, runTeam, teamDefaults: () => ({
      maxConcurrency: 4, childPresetId: 'standard', childModelId: '', childModelPolicy: 'inherit',
      quickModelId: '', standardModelId: '', criticalModelId: '', defaultAuthorityMode: 'read-only',
    }) })
    const { authorityMode: _authority, ...withoutAuthority } = validInput.tasks[0]!
    await mounted.tool.execute({ ...validInput, tasks: [withoutAuthority] }, execution(controller))
    expect(startTeam).toHaveBeenCalledWith(expect.objectContaining({
      workspaceMode: 'direct', tasks: [expect.objectContaining({ authorityMode: 'read-only' })],
    }))
  })

  it('routes automatic model tiers deterministically and keeps an exact task override authoritative', async () => {
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({ teamId: 'team-routing', sessionId: 'session-routing', controller: {}, dispose }))
    const runTeam = vi.fn(async () => ({ projection: { team: { id: 'team-routing', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed' }))
    const tool = registerTool({
      startTeam,
      runTeam,
      teamDefaults: () => ({
        maxConcurrency: 4,
        childPresetId: 'standard',
        childModelId: '',
        childModelPolicy: 'automatic',
        quickModelId: 'quick-model',
        standardModelId: 'standard-model',
        criticalModelId: 'critical-model',
        defaultAuthorityMode: 'write-authorized',
      }),
    }).tool
    const { maxConcurrency: _omitted, ...withoutConcurrency } = validInput

    await tool.execute({
      ...withoutConcurrency,
      tasks: withoutConcurrency.tasks.map(task => ({ ...task, modelTier: 'critical' as const })),
    }, execution(controller))
    expect(startTeam).toHaveBeenLastCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({ modelRequest: { kind: 'tier', tier: 'critical' } })],
    }))

    await tool.execute({
      ...withoutConcurrency,
      tasks: withoutConcurrency.tasks.map(task => ({ ...task, model: { providerId: 'deepseek', modelId: 'exact-model' } })),
    }, execution(controller))
    expect(startTeam).toHaveBeenLastCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({ modelRequest: { kind: 'exact', model: { modelProvider: 'deepseek', modelId: 'exact-model' } } })],
    }))
  })

  it.each([
    ['quick', 'quick-model'],
    ['standard', 'standard-model'],
  ] as const)('uses the configured %s automatic model tier', async (modelTier, expectedModel) => {
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({ teamId: `team-${modelTier}`, sessionId: `session-${modelTier}`, controller: {}, dispose }))
    const runTeam = vi.fn(async () => ({ projection: { team: { id: `team-${modelTier}`, status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed' }))
    const tool = registerTool({
      startTeam,
      runTeam,
      teamDefaults: () => ({
        maxConcurrency: 4,
        childPresetId: 'standard',
        childModelId: '',
        childModelPolicy: 'automatic',
        quickModelId: 'quick-model',
        standardModelId: 'standard-model',
        criticalModelId: 'critical-model',
        defaultAuthorityMode: 'write-authorized',
      }),
    }).tool
    const { maxConcurrency: _omitted, ...withoutConcurrency } = validInput
    await tool.execute({
      ...withoutConcurrency,
      tasks: withoutConcurrency.tasks.map(task => ({ ...task, modelTier })),
    }, execution(controller))
    expect(startTeam).toHaveBeenLastCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({ modelRequest: { kind: 'tier', tier: modelTier } })],
      modelRouting: expect.objectContaining({ teamPolicy: expect.objectContaining({ kind: 'automatic' }) }),
    }))
  })

  it.each([
    ['inherit', '', 'deepseek-v4'],
    ['fixed', '', 'deepseek-v4'],
    ['automatic', '', 'deepseek-v4'],
  ] as const)('preserves default intent for the %s policy when no usable model is configured', async (childModelPolicy, configured, _expectedModel) => {
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({ teamId: `team-${childModelPolicy}`, sessionId: `session-${childModelPolicy}`, controller: {}, dispose }))
    const runTeam = vi.fn(async () => ({ projection: { team: { id: `team-${childModelPolicy}`, status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed' }))
    const tool = registerTool({
      startTeam,
      runTeam,
      teamDefaults: () => ({
        maxConcurrency: 4,
        childPresetId: 'standard',
        childModelId: configured,
        childModelPolicy,
        quickModelId: '',
        standardModelId: '',
        criticalModelId: '',
        defaultAuthorityMode: 'write-authorized',
      }),
    }).tool
    const { maxConcurrency: _omitted, ...withoutConcurrency } = validInput
    await tool.execute(withoutConcurrency, execution(controller))
    expect(startTeam).toHaveBeenLastCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({ modelRequest: { kind: 'default' } })],
    }))
  })

  it('keeps an all-read-only Team in the default direct workspace without requiring Git', async () => {
    const startedController = { id: 'read-controller' }
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({
      teamId: 'team-read', sessionId: 'session-read', controller: startedController, dispose,
    }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-read', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed',
    }))
    const tool = registerTool({ startTeam, runTeam }).tool
    const readOnlyInput = {
      ...validInput,
      tasks: validInput.tasks.map(task => ({ ...task, authorityMode: 'read-only' as const })),
    }

    await expect(tool.execute(readOnlyInput, execution(controller))).resolves.toMatchObject({
      teamId: 'team-read', status: 'completed', terminal: true,
    })
    expect(startTeam).toHaveBeenCalledWith(expect.objectContaining({
      projectCwd: 'F:\\project',
      workspaceMode: 'direct',
      managedRoot: path.dirname('F:\\project'),
      tasks: [expect.objectContaining({ authorityMode: 'read-only' })],
    }))
  })

  it('returns bounded child task reports so the entry agent does not repeat completed work', async () => {
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({
      teamId: 'team-report', sessionId: 'session-report', controller: { id: 'report-controller' }, dispose,
    }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-report', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed',
    }))
    const readTeamTaskReports = vi.fn(async () => ([{
      taskId: 'task-1', status: 'completed', agentSessionId: 'child-report', output: 'name=website; scripts=4', truncated: false,
    }]))
    const tool = registerTool({ startTeam, runTeam, readTeamTaskReports } as never).tool

    await expect(tool.execute(validInput, execution(controller))).resolves.toMatchObject({
      status: 'completed',
      taskReports: [{ taskId: 'task-1', status: 'completed', output: 'name=website; scripts=4', truncated: false }],
    })
    expect(readTeamTaskReports).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team-report' }))
  })

  it('keeps a completed Team result when bounded task-report projection is unavailable', async () => {
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({
      teamId: 'team-report-fallback', sessionId: 'session-report-fallback', controller: { id: 'report-controller' }, dispose,
    }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-report-fallback', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed',
    }))
    const readTeamTaskReports = vi.fn(async () => { throw new Error('session output unavailable') })
    const tool = registerTool({ startTeam, runTeam, readTeamTaskReports } as never).tool

    await expect(tool.execute(validInput, execution(controller))).resolves.toMatchObject({
      status: 'completed', terminal: true,
    })
    const result = await tool.execute(validInput, execution(controller))
    expect(result).not.toHaveProperty('taskReports')
  })

  it.each([false, true])('drives the real model entry through an isolated Git worktree (custom root: %s)', async customRoot => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-agent-entry-'))
    const projectRoot = path.join(root, 'project')
    let launchedWorkspace: ReturnType<typeof teamWorkspaceSchema.parse> | undefined
    try {
      await mkdir(projectRoot)
      await execFileAsync('git', ['init', projectRoot], { windowsHide: true })
      await execFileAsync('git', ['-C', projectRoot, 'config', 'user.email', 'yuqi@example.invalid'], { windowsHide: true })
      await execFileAsync('git', ['-C', projectRoot, 'config', 'user.name', 'Yuqi Test'], { windowsHide: true })
      await writeFile(path.join(projectRoot, 'README.md'), 'fixture\n', 'utf8')
      await execFileAsync('git', ['-C', projectRoot, 'add', 'README.md'], { windowsHide: true })
      await execFileAsync('git', ['-C', projectRoot, 'commit', '-m', 'fixture'], { windowsHide: true })

      const coordinator = new StartTeamCoordinator(
        new NodeGitWorkspacePort(),
        { async launch(request) {
          launchedWorkspace = request.workspace
          return { sessionId: 'controller-real-entry', controller: { id: 'controller-real-entry' }, async dispose() {} }
        } },
        { async bootstrap() { return { status: 'running' } } },
        { async provision(request) {
          return teamWorkspaceSchema.parse({
            workspaceId: request.workspaceId, project: request.identity, worktreePath: request.worktreePath,
            branchName: request.branchName, status: 'ready',
          })
        } },
        { nextTeamId: () => 'team-real-entry', nextWorkspaceId: () => 'workspace-real-entry' },
      )
      const startTeam = vi.fn(async request => coordinator.start(request))
      const runTeam = vi.fn(async () => ({
        projection: { team: { id: 'team-real-entry', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed',
      }))
      const tool = registerTool({ startTeam, runTeam, ...(customRoot ? { teamDefaults: () => ({
        maxConcurrency: 100, childPresetId: 'standard', childModelId: '', childModelPolicy: 'inherit' as const,
        quickModelId: '', standardModelId: '', criticalModelId: '', defaultAuthorityMode: 'write-authorized' as const,
        gitWorkspaceRoot: path.join(root, '自定义 Team Workspaces'),
      }) } : {}) }).tool
      const entryAgent = {
        ...controller,
        session: { header: { cwd: projectRoot }, events: [] },
      } as unknown as Agent

      await expect(tool.execute({ ...validInput, workspaceMode: 'git-worktree' }, execution(entryAgent))).resolves.toMatchObject({
        teamId: 'team-real-entry', status: 'completed', terminal: true,
      })
      const request = startTeam.mock.calls[0]![0]
      expect(request.workspaceMode).toBe('git-worktree')
      expect(launchedWorkspace).toBeDefined()
      expect(path.resolve(launchedWorkspace!.worktreePath)).not.toBe(path.resolve(projectRoot))
      expect(launchedWorkspace!.branchName).toMatch(/^yuqi\//u)
      expect(path.resolve(launchedWorkspace!.worktreePath)).toBe(path.resolve(root, customRoot ? '自定义 Team Workspaces' : '.yuqi-team-worktrees', 'workspace-real-entry'))
      expect(launchedWorkspace!.branchName).toBe('yuqi/team-real-entry')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('normalizes the model shorthand for no dependencies before durable validation', async () => {
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({
      teamId: 'team-host-1', sessionId: 'session-host-1', controller: { id: 'started-controller' }, dispose,
    }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-host-1', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed',
    }))
    const tool = registerTool({ startTeam, runTeam }).tool

    await tool.execute({
      ...validInput,
      tasks: [{
        ...validInput.tasks[0],
        dependencies: ['', '   ', '[]'],
        verificationChecks: [{
          ...validInput.tasks[0]!.verificationChecks[0]!,
          timeoutMs: 600_000,
          stdoutMaxBytes: 2_000_000,
          stderrMaxBytes: 2_000_000,
        }],
      }],
    }, execution(controller))

    expect(startTeam).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({
        dependencies: [],
        verificationChecks: [expect.objectContaining({
          timeoutMs: 300_000,
          stdoutMaxBytes: 1_048_576,
          stderrMaxBytes: 1_048_576,
        })],
      })],
    }))
  })

  it('normalizes defensively shaped model input before strict contract rejection', async () => {
    const startTeam = vi.fn()
    const runTeam = vi.fn()
    const tool = registerTool({ startTeam, runTeam }).tool
    const malformed = [
      null,
      { ...validInput, tasks: 'none' },
      { ...validInput, tasks: [null] },
      { ...validInput, tasks: [{ ...validInput.tasks[0], modelRole: 42 }] },
      { ...validInput, tasks: [{ ...validInput.tasks[0], dependencies: 'none' }] },
      { ...validInput, tasks: [{ ...validInput.tasks[0], dependencies: [0] }] },
      { ...validInput, tasks: [{ ...validInput.tasks[0], verificationChecks: [] }] },
      { ...validInput, tasks: [{ ...validInput.tasks[0], verificationChecks: [null] }] },
    ]
    for (const input of malformed) {
      await expect(tool.execute(input as never, execution(controller))).rejects.toThrow()
    }
    // An empty verificationChecks array is deliberately normalized to omission
    // and may reach the Host boundary; every other malformed shape is rejected.
    expect(startTeam).toHaveBeenCalledTimes(1)
    expect(runTeam).not.toHaveBeenCalled()
  })

  it('does not erase malformed dependency entries from a real dependency list', async () => {
    const startTeam = vi.fn()
    const runTeam = vi.fn()
    const tool = registerTool({ startTeam, runTeam }).tool

    await expect(tool.execute({
      ...validInput,
      tasks: [{ ...validInput.tasks[0], dependencies: ['task-0', ''] }],
    }, execution(controller))).rejects.toThrow('Yuqi team start rejected')
    expect(startTeam).not.toHaveBeenCalled()
  })

  it('does not erase a no-dependency sentinel mixed with a real dependency', async () => {
    const startTeam = vi.fn(async () => ({
      teamId: 'team-host-1', sessionId: 'session-host-1', controller: { id: 'started-controller' },
      dispose: vi.fn(async () => {}),
    }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-host-1', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed',
    }))
    const tool = registerTool({ startTeam, runTeam }).tool

    await expect(tool.execute({
      ...validInput,
      tasks: [{ ...validInput.tasks[0], dependencies: ['task-0', '[]'] }],
    }, execution(controller))).resolves.toMatchObject({ status: 'completed' })
    expect(startTeam).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({ dependencies: ['task-0', '[]'] })],
    }))
  })

  it('defaults omitted model-facing dependencies to an empty durable dependency list', async () => {
    const startTeam = vi.fn(async () => ({
      teamId: 'team-host-1', sessionId: 'session-host-1', controller: { id: 'started-controller' },
      dispose: vi.fn(async () => {}),
    }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-host-1', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed',
    }))
    const tool = registerTool({ startTeam, runTeam }).tool
    const { dependencies: _dependencies, ...taskWithoutDependencies } = validInput.tasks[0]!

    await tool.execute({ ...validInput, tasks: [taskWithoutDependencies] }, execution(controller))

    expect(startTeam).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({ dependencies: [] })],
    }))
  })

  it('starts a Team when verification checks are omitted from a task contract', async () => {
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({
      teamId: 'team-host-optional-verification', sessionId: 'session-host-optional-verification',
      controller: { id: 'started-controller' }, dispose,
    }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-host-optional-verification', status: 'completed' }, taskIds: ['task-1'] },
      reason: 'completed',
    }))
    const tool = registerTool({ startTeam, runTeam }).tool
    const { verificationChecks: _verificationChecks, ...taskWithoutChecks } = validInput.tasks[0]!

    await expect(tool.execute({ ...validInput, tasks: [taskWithoutChecks] }, execution(controller)))
      .resolves.toMatchObject({ teamId: 'team-host-optional-verification', status: 'completed' })
    expect(startTeam).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [expect.not.objectContaining({ verificationChecks: expect.anything() })],
    }))
    const startedTask = (startTeam.mock.calls as unknown as Array<[{ tasks: unknown[] }]>)[0]?.[0].tasks[0]
    expect(Object.prototype.hasOwnProperty.call(startedTask, 'verificationChecks')).toBe(false)
    expect(JSON.parse(JSON.stringify(startedTask))).toEqual(startedTask)
  })

  it('rejects agent-less execution before touching the Host service', async () => {
    const startTeam = vi.fn()
    const runTeam = vi.fn()
    const tool = registerTool({ startTeam, runTeam }).tool

    await expect(tool.execute(validInput, execution(undefined))).rejects.toThrow('agent-owned execution')
    expect(startTeam).not.toHaveBeenCalled()
  })

  it('rejects caller-owned sensitive fields and does not expose them in the schema', async () => {
    const startTeam = vi.fn()
    const runTeam = vi.fn()
    const tool = registerTool({ startTeam, runTeam }).tool
    const forged = {
      ...validInput,
      credentials: 'secret-token', proof: 'secret-proof', leaseId: 'lease-1', childId: 'child-1',
      tasks: [{ ...validInput.tasks[0], modelId: 'claude-sonnet-4-5', inputDigest: '', baselineRef: '' }],
    }

    await expect(tool.execute(forged, execution(controller))).rejects.toThrow('invalid arguments')
    expect(startTeam).not.toHaveBeenCalled()
    expect(JSON.stringify(tool.parameters)).not.toMatch(/credentials|proof|leaseId|childId/)
  })

  it('fails before Host bootstrap when the controller model is unavailable', async () => {
    const startTeam = vi.fn()
    const runTeam = vi.fn()
    const tool = registerTool({ startTeam, runTeam }).tool
    const noModel = { ...controller, options: { provider: 'deepseek' } } as unknown as Agent

    await expect(tool.execute(validInput, execution(noModel))).rejects.toThrow('configured controller model')
    expect(startTeam).not.toHaveBeenCalled()
  })

  it('rejects a blank controller model before Host bootstrap', async () => {
    const startTeam = vi.fn()
    const tool = registerTool({ startTeam, runTeam: vi.fn() }).tool
    const blankModel = { ...controller, options: { provider: 'deepseek', model: '   ' } } as unknown as Agent

    await expect(tool.execute(validInput, execution(blankModel))).rejects.toThrow('configured controller model')
    expect(startTeam).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', undefined],
    ['relative', 'relative/project'],
  ] as const)('rejects a %s project cwd before Host bootstrap', async (_label, cwd) => {
    const startTeam = vi.fn()
    const tool = registerTool({ startTeam, runTeam: vi.fn() }).tool
    const invalidCwd = {
      ...controller,
      session: { header: { cwd }, events: [] },
    } as unknown as Agent

    await expect(tool.execute(validInput, execution(invalidCwd))).rejects.toThrow('project working directory')
    expect(startTeam).not.toHaveBeenCalled()
  })

  it('derives a stable digest from the model-visible contract', async () => {
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({
      teamId: 'team-host-1', sessionId: 'session-host-1', controller: { id: 'started-controller' }, dispose,
    }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-host-1', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed',
    }))
    const tool = registerTool({ startTeam, runTeam }).tool

    await tool.execute(validInput, execution(controller))
    await tool.execute(validInput, execution(controller))

    const firstCall = startTeam.mock.calls[0] as unknown as [{ readonly tasks: readonly [{ readonly inputDigest?: string }] }] | undefined
    const secondCall = startTeam.mock.calls[1] as unknown as [{ readonly tasks: readonly [{ readonly inputDigest?: string }] }] | undefined
    const first = firstCall?.[0].tasks[0]
    const second = secondCall?.[0].tasks[0]
    expect(first?.inputDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(first?.inputDigest).toBe(second?.inputDigest)
  })

  it('returns a safe error when Host bootstrap fails', async () => {
    const startTeam = vi.fn(async () => { throw new Error('secret path C:\\private\\token') })
    const runTeam = vi.fn()
    const tool = registerTool({ startTeam, runTeam }).tool

    await expect(tool.execute(validInput, execution(controller))).rejects.toThrow('Yuqi team start failed')
    await expect(tool.execute(validInput, execution(controller))).rejects.not.toThrow('private')
  })

  it('requires reconciliation when bootstrap aborts before Host startup', async () => {
    const startTeam = vi.fn(async () => { throw new Error('startup interrupted') })
    const tool = registerTool({ startTeam, runTeam: vi.fn() }).tool
    const signal = new AbortController()
    signal.abort()

    await expect(tool.execute(validInput, execution(controller, signal.signal)))
      .rejects.toThrow('Yuqi team abort requires reconciliation')
    expect(startTeam).toHaveBeenCalledOnce()
  })

  it('preserves a stable Yuqi error code without exposing Host details', async () => {
    const startTeam = vi.fn().mockRejectedValue(new YuqiOrchestratorError(
      'VERIFICATION_NOT_ALLOWED',
      'Host verification capability is unavailable',
      { cause: new Error('private Host capability detail') },
    ))
    const tool = registerTool({ startTeam, runTeam: vi.fn() }).tool

    await expect(tool.execute(validInput, execution(controller)))
      .rejects.toThrow('Yuqi team start failed (VERIFICATION_NOT_ALLOWED): Host verification capability is unavailable')
    await expect(tool.execute(validInput, execution(controller))).rejects.not.toThrow('private')
  })

  it('releases the Host-owned controller when execution fails after startup', async () => {
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({
      teamId: 'team-host-1', sessionId: 'session-host-1', controller: { id: 'started-controller' }, dispose,
    }))
    const runTeam = vi.fn(async () => { throw new Error('run failed') })
    const tool = registerTool({ startTeam, runTeam }).tool

    await expect(tool.execute(validInput, execution(controller))).rejects.toThrow('Yuqi team start failed')
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('returns a terminal Team result without waiting for stuck controller cleanup', async () => {
    const dispose = vi.fn(() => new Promise<void>(() => {}))
    const startTeam = vi.fn(async () => ({
      teamId: 'team-stuck-disposal', sessionId: 'session-stuck-disposal', controller: { id: 'started-controller' }, dispose,
    }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-stuck-disposal', status: 'cancelled' }, taskIds: ['task-1'] }, reason: 'cancelled',
    }))
    const tool = registerTool({ startTeam, runTeam }).tool

    await expect(tool.execute(validInput, execution(controller))).resolves.toMatchObject({
      teamId: 'team-stuck-disposal', status: 'cancelled', terminal: true,
    })
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
  })

  it('does not invoke the removed post-completion reviewer side path', async () => {
    const dispose = vi.fn(async () => {})
    const startedController = { id: 'started-controller' }
    const startTeam = vi.fn(async () => ({
      teamId: 'team-host-1', sessionId: 'session-host-1', controller: startedController, dispose,
    }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-host-1', status: 'completed' }, taskIds: ['task-1'] }, reason: 'completed',
    }))
    const reviewTeam = vi.fn(async () => { throw new Error('review transport failed') })
    const service = { startTeam, runTeam, reviewTeam }
    const tool = registerTool(service).tool

    await expect(tool.execute(validInput, execution(controller))).resolves.toMatchObject({
      teamId: 'team-host-1',
      status: 'completed',
      terminal: true,
      requiresAttention: false,
    })
    expect(service.reviewTeam).not.toHaveBeenCalled()
    expect(reviewTeam).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it.each([
    ['no-progress', 'recoverable', true],
    ['max-cycles', 'yielded', false],
  ] as const)('maps %s to its non-terminal disposition', async (reason, disposition, requiresAttention) => {
    const dispose = vi.fn(async () => {})
    const startedController = { id: 'started-controller' }
    const startTeam = vi.fn(async () => ({ teamId: 'team-host-1', sessionId: 'session-host-1', controller: startedController, dispose }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-host-1', status: 'running' }, taskIds: ['task-1'] }, reason,
    }))
    const tool = registerTool({ startTeam, runTeam }).tool

    await expect(tool.execute(validInput, execution(controller))).resolves.toMatchObject({
      status: 'running', stopReason: reason, disposition, terminal: false, requiresAttention,
    })
    expect(dispose).not.toHaveBeenCalled()
  })

  it('distinguishes plan confirmation from post-execution task outcomes when paused', async () => {
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({ teamId: 'team-paused', sessionId: 'session-paused', controller: { id: 'started-controller' }, dispose }))
    const runTeam = vi.fn(async () => ({
      projection: {
        team: { id: 'team-paused', status: 'paused' },
        taskIds: ['task-1', 'task-2'],
        tasks: {
          'task-1': { status: 'cancelled', contract: { goal: 'Inspect the cancelled module' } },
          'task-2': { status: 'completed', contract: { goal: 'Inspect the completed module' } },
        },
      },
      reason: 'paused',
    }))
    const readTeamTaskReports = vi.fn(async () => ([{
      taskId: 'task-1', status: 'cancelled', agentSessionId: 'child-paused',
      output: 'Dependency API was unavailable.', truncated: false, stopReason: 'error',
      verificationReasons: [{ checkId: 'api', code: 'interface-failed', detail: 'HTTP 503' }],
    }]))
    const tool = registerTool({ startTeam, runTeam, readTeamTaskReports } as never).tool

    await expect(tool.execute(validInput, execution(controller))).resolves.toMatchObject({
      status: 'paused', stopReason: 'paused', disposition: 'recoverable', terminal: false,
      requiresAttention: true, attentionReason: 'task_outcomes',
      taskOutcomes: [{ taskId: 'task-1', status: 'cancelled', goal: 'Inspect the cancelled module' }],
      taskReports: [{ taskId: 'task-1', stopReason: 'error', output: 'Dependency API was unavailable.', verificationReasons: [{ detail: 'HTTP 503' }] }],
    })
    expect(readTeamTaskReports).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
  })

  it('requests durable cancellation without waiting for child settlement after an abort', async () => {
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({ teamId: 'team-host-1', sessionId: 'session-host-1', controller, dispose }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-host-1', status: 'running' }, taskIds: ['task-1'] }, reason: 'aborted',
    }))
    const abortTeam = vi.fn(async () => ({ team: { id: 'team-host-1', status: 'cancelled' }, taskIds: ['task-1'] }))
    const tool = registerTool({ startTeam, runTeam, abortTeam }).tool
    const signal = new AbortController()
    signal.abort()

    await expect(tool.execute(validInput, execution(controller, signal.signal))).resolves.toMatchObject({
      status: 'cancelled', stopReason: 'cancelled', disposition: 'cancelled', terminal: true, requiresAttention: false,
    })
    expect(abortTeam).toHaveBeenCalledWith({ controller, teamId: 'team-host-1', operationId: 'agent-abort:team-host-1' })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('recovers through durable cancellation when the run driver rejects on abort', async () => {
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({ teamId: 'team-host-1', sessionId: 'session-host-1', controller, dispose }))
    const runTeam = vi.fn(async () => { throw new Error('driver interrupted') })
    const abortTeam = vi.fn(async () => ({ team: { id: 'team-host-1', status: 'cancelled' }, taskIds: ['task-1'] }))
    const tool = registerTool({ startTeam, runTeam, abortTeam }).tool
    const signal = new AbortController()
    signal.abort()

    await expect(tool.execute(validInput, execution(controller, signal.signal))).resolves.toMatchObject({
      status: 'cancelled', stopReason: 'cancelled', disposition: 'cancelled', terminal: true,
    })
    expect(abortTeam).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('returns promptly with reconciliation required when an abort cannot be accepted', async () => {
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({ teamId: 'team-host-1', sessionId: 'session-host-1', controller, dispose }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-host-1', status: 'running' }, taskIds: ['task-1'] }, reason: 'aborted',
    }))
    const abortTeam = vi.fn(async () => ({ team: { id: 'team-host-1', status: 'needs_reconciliation' }, taskIds: ['task-1'] }))
    const tool = registerTool({ startTeam, runTeam, abortTeam }).tool
    const signal = new AbortController()
    signal.abort()

    await expect(tool.execute(validInput, execution(controller, signal.signal))).resolves.toMatchObject({
      status: 'needs_reconciliation', stopReason: 'needs_reconciliation', disposition: 'needs_reconciliation', terminal: false, requiresAttention: true,
    })
    expect(abortTeam).toHaveBeenCalledWith({ controller, teamId: 'team-host-1', operationId: 'agent-abort:team-host-1' })
    expect(dispose).not.toHaveBeenCalled()
  })

  it('fails closed when an aborted run has no durable abort projection', async () => {
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({ teamId: 'team-host-1', sessionId: 'session-host-1', controller, dispose }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-host-1', status: 'running' }, taskIds: ['task-1'] }, reason: 'aborted',
    }))
    const abortTeam = vi.fn(async () => { throw new Error('durable abort unavailable') })
    const tool = registerTool({ startTeam, runTeam, abortTeam }).tool

    await expect(tool.execute(validInput, execution(controller))).resolves.toMatchObject({
      status: 'running', stopReason: 'aborted', disposition: 'needs_reconciliation', terminal: false, requiresAttention: true,
    })
    expect(abortTeam).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
  })

  it('does not start unbounded reconciliation when the immediate abort path fails', async () => {
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({ teamId: 'team-host-1', sessionId: 'session-host-1', controller, dispose }))
    const runTeam = vi.fn(async () => { throw new Error('driver interrupted') })
    const abortTeam = vi.fn(async () => { throw new Error('interrupt unavailable') })
    const tool = registerTool({ startTeam, runTeam, abortTeam }).tool
    const signal = new AbortController()
    signal.abort()

    await expect(tool.execute(validInput, execution(controller, signal.signal)))
      .rejects.toThrow('Yuqi team abort requires reconciliation')
    expect(abortTeam).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
  })

  it.each([
    ['failed', 'failed', 'failed', true],
    ['cancelled', 'cancelled', 'cancelled', true],
    ['needs reconciliation', 'needs_reconciliation', 'needs_reconciliation', false],
    ['still running after abort recovery', 'running', 'aborted', false],
  ] as const)('maps a %s recovered projection correctly', async (_label, status, stopReason, terminal) => {
    const dispose = vi.fn(async () => {})
    const startTeam = vi.fn(async () => ({ teamId: 'team-host-1', sessionId: 'session-host-1', controller, dispose }))
    const runTeam = vi.fn(async () => ({
      projection: { team: { id: 'team-host-1', status: 'running' }, taskIds: ['task-1'] }, reason: 'aborted',
    }))
    const abortTeam = vi.fn(async () => ({ team: { id: 'team-host-1', status }, taskIds: ['task-1'] }))
    const tool = registerTool({ startTeam, runTeam, abortTeam }).tool
    const signal = new AbortController()
    signal.abort()

    await expect(tool.execute(validInput, execution(controller, signal.signal))).resolves.toMatchObject({
      status, stopReason, terminal, requiresAttention: !terminal,
    })
    expect(dispose).toHaveBeenCalledTimes(terminal ? 1 : 0)
  })
})
