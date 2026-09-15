import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/agent/index.ts'
import { YuqiTeamOrchestratorService } from '../src/host/harness/service.ts'
import { readTeamEventsFromSession, TEAM_SESSION_EVENT, TEAM_PARENT_PROJECTION_EVENT, TEAM_PARENT_BINDING_EVENT } from '../src/host/harness/session-journal.ts'
import { ControlOperationId, FileLeaseId, TaskId, WorkspaceId, replayTeamEvents, planTeamSchedule, type TeamEvent } from '../src/index.ts'
import { completeTeamEvents, contract, event } from './fixtures.ts'

function paused(facts: readonly TeamEvent[] = completeTeamEvents().slice(0, 4)): TeamEvent[] {
  return [...facts,
    event(80, { type: 'yuqi/workspace-provisioning-started', workspace: {
      workspaceId: WorkspaceId('scope-workspace'),
      project: { projectRoot: 'F:/repo', repositoryRoot: 'F:/repo', gitCommonDirectory: 'F:/repo/.git', baselineRef: 'commit-1', volumeRoot: 'F:/', protectedRoots: [] },
      worktreePath: 'F:/managed/scope', branchName: 'yuqi/scope', status: 'provisioning',
    } }),
    event(81, { type: 'yuqi/workspace-provisioned', workspaceId: WorkspaceId('scope-workspace') }),
    event(82, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
    event(83, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' }),
  ]
}

function setup(facts = paused()) {
  const ctx = new Context()
  const session = Session.create(SessionId(`scope-${Math.random()}`))
  for (const fact of facts) session.append(TEAM_SESSION_EVENT, { event: fact })
  const flush = vi.fn(async () => true)
  ctx.provide('sessions', { get: () => session, flush } as never)
  ctx.provide('sessionPersistence', { load: async () => undefined } as never)
  const startContinuable = vi.fn()
  ctx.provide('subagents', { startContinuable } as never)
  ctx.provide('llm', {} as never)
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: 'F:/repo' }) } as never)
  const service = new YuqiTeamOrchestratorService(ctx)
  const controller = { id: session.id, session, options: {}, ctx } as unknown as Agent
  const request = { controller, teamId: 'team-1', taskId: 'task-1', fileScope: ['src/**', 'package.json'], operationId: 'scope-1' }
  const read = () => readTeamEventsFromSession(session)
  return { ctx, service, controller, request, read, flush, startContinuable }
}

describe('task file scope control', () => {
  it('atomically revises a failed task, preserves evidence and authority, and replays idempotently', async () => {
    const facts = [...completeTeamEvents().slice(0, 10),
      event(40, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: 'attempt-1' as never, from: 'settled', to: 'failed' }),
      event(41, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'failed' }),
    ]
    const h = setup(paused(facts))
    const before = replayTeamEvents(h.read())
    const next = await h.service.setTaskFileScope(h.request)
    expect(next.team.status).toBe('paused')
    expect(next.tasks['task-1']).toMatchObject({ status: 'ready', verificationAttemptFloor: 2, contract: {
      revision: 2, fileScope: ['package.json', 'src/**'], authorityMode: 'write-authorized',
    } })
    expect(next.tasks['task-1']!.contract.inputDigest).not.toBe(before.tasks['task-1']!.contract.inputDigest)
    expect(next.attempts).toEqual(before.attempts)
    expect(next.verifications).toEqual(before.verifications)
    expect(h.read().slice(-2).map(fact => (fact as TeamEvent).type)).toEqual(['yuqi/task-retry-requested', 'yuqi/task-revised'])
    expect(h.flush).toHaveBeenCalledTimes(1)
    expect(h.startContinuable).not.toHaveBeenCalled()
    expect(await h.service.setTaskFileScope({ ...h.request, fileScope: [' package.json ', 'src/**', 'src/**'] })).toEqual(next)
    const restarted = setup(h.read() as TeamEvent[])
    expect(await restarted.service.setTaskFileScope({ ...h.request, controller: restarted.controller })).toEqual(next)
    await expect(h.service.setTaskFileScope({ ...h.request, fileScope: ['other.ts'] })).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await expect(h.service.setTaskFileScope({ ...h.request, taskId: 'other-task' })).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
  })

  it('serializes duplicate and distinct revisions and leaves shared files to the scheduler', async () => {
    const h = setup(paused([...completeTeamEvents().slice(0, 4),
      event(30, { type: 'yuqi/task-created', contract: { ...contract(TaskId('task-2')), fileScope: ['package.json'] } }),
    ]))
    await Promise.all([h.service.setTaskFileScope(h.request), h.service.setTaskFileScope(h.request)])
    expect(replayTeamEvents(h.read()).tasks['task-1']!.contract.revision).toBe(2)
    await Promise.all(['scope-2', 'scope-3'].map(operationId => h.service.setTaskFileScope({ ...h.request, operationId })))
    const next = replayTeamEvents(h.read())
    expect(next.tasks['task-1']!.contract.revision).toBe(4)
    expect(next.team.status).toBe('paused')
    const running = replayTeamEvents([...h.read(), event(90, { type: 'yuqi/team-status-changed', from: 'paused', to: 'running' })])
    expect(planTeamSchedule(running, { maxConcurrency: 2 }).dispatchTaskIds).toHaveLength(1)
    const count = h.read().length
    await h.service.setTaskFileScope(h.request)
    expect(h.read()).toHaveLength(count)
  })

  it.each(['pending', 'blocked', 'cancelled'] as const)('revises unfinished %s tasks without granting authority', async status => {
    const facts: TeamEvent[] = completeTeamEvents().slice(0, 3).map(fact => fact.type === 'yuqi/task-created'
      ? { ...fact, contract: { ...fact.contract, authorityMode: 'read-only' as const } } : fact)
    if (status !== 'pending') facts.push(event(39, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'pending', to: status }))
    const h = setup(paused(facts))
    const next = await h.service.setTaskFileScope(h.request)
    expect(next.tasks['task-1']!.contract.authorityMode).toBe('read-only')
    expect(next.tasks['task-1']!.status).toBe(status === 'pending' ? 'pending' : 'ready')
    expect(next.attempts).toEqual({})
  })

  it.each([[], ['../secret'], ['/absolute'], ['C:/absolute'], ['src\\file'], ['.']].map(fileScope => ({ fileScope })))('rejects invalid scope $fileScope without persistence', async ({ fileScope }) => {
    const h = setup()
    await expect(h.service.setTaskFileScope({ ...h.request, fileScope })).rejects.toMatchObject({ code: 'INVALID_BATCH' })
    expect(h.flush).not.toHaveBeenCalled()
  })

  it('rejects wrong identities and reused non-scope operations', async () => {
    const h = setup()
    await expect(h.service.setTaskFileScope({ ...h.request, teamId: 'other-team' })).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    await expect(h.service.setTaskFileScope({ ...h.request, taskId: 'missing' })).rejects.toMatchObject({ code: 'CONTROL_NOT_ALLOWED' })
    await expect(h.service.setTaskFileScope({ ...h.request, operationId: 'invalid id' })).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    h.controller.session.append(TEAM_SESSION_EVENT, { event: event(92, { type: 'yuqi/team-control-requested', action: 'pause', operationId: ControlOperationId('scope-1') }) })
    await expect(h.service.setTaskFileScope(h.request)).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    expect(h.flush).not.toHaveBeenCalled()
  })

  it.each(['running', 'pausing', 'completed', 'human', 'lease', 'attempt', 'verification', 'workspace'])(
    'rejects unsafe state %s without persistence', async state => {
      let facts = paused()
      if (state === 'running') facts = facts.slice(0, -2)
      if (state === 'pausing') facts = facts.slice(0, -1)
      if (state === 'completed') facts = paused(completeTeamEvents().slice(0, -1))
      if (state === 'attempt') facts = paused(completeTeamEvents().slice(0, 8))
      if (state === 'verification') facts = paused(completeTeamEvents().slice(0, 13))
      if (state === 'workspace') facts = facts.filter(fact => !fact.type.startsWith('yuqi/workspace-'))
      if (state === 'human') facts.push(event(92, { type: 'yuqi/task-manual-acquired', taskId: TaskId('task-1'), operationId: ControlOperationId('human'), workspacePath: 'F:/managed/scope' }))
      if (state === 'lease') facts.push(event(92, { type: 'yuqi/file-lease-acquired', lease: {
        leaseId: FileLeaseId('scope-lease'), taskId: TaskId('task-1'), mode: 'write', fileScope: ['src/**'], status: 'active',
      } }))
      const h = setup(facts)
      await expect(h.service.setTaskFileScope(h.request)).rejects.toMatchObject({ code: 'CONTROL_NOT_ALLOWED' })
      expect(h.flush).not.toHaveBeenCalled()
    },
  )

  it('fails closed on live executor residue and persistence failure', async () => {
    const h = setup(paused([...completeTeamEvents().slice(0, 10),
      event(40, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: 'attempt-1' as never, from: 'settled', to: 'failed' }),
      event(41, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'failed' }),
    ]))
    const executor = (h.service as unknown as { batchExecutor: { hasActiveAttempt: () => boolean } }).batchExecutor
    const live = vi.spyOn(executor, 'hasActiveAttempt').mockReturnValue(true)
    await expect(h.service.setTaskFileScope(h.request)).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    expect(h.flush).not.toHaveBeenCalled()
    live.mockRestore()
    h.flush.mockRejectedValueOnce(new Error('disk failure'))
    await expect(h.service.setTaskFileScope(h.request)).rejects.toMatchObject({ code: 'INTENT_PERSISTENCE_FAILED' })
    await expect(h.service.setTaskFileScope(h.request)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
  })

  it('exposes scope through the bound agent tool and calls the real service without resume', async () => {
    const h = setup()
    const parent = Session.create(SessionId('scope-parent'))
    parent.append(TEAM_PARENT_PROJECTION_EVENT, { controllerSessionId: String(h.controller.id), sourceEventCount: h.read().length, events: h.read() })
    h.controller.session.append(TEAM_PARENT_BINDING_EVENT, { parentSessionId: String(parent.id), generation: 1, operationId: 'bind', boundAt: '2026-09-06T00:00:00Z' })
    vi.spyOn(h.service, 'resolveTeamController').mockResolvedValue(h.controller)
    const resume = vi.spyOn(h.service, 'resumeTeam')
    const definitions: ToolDefinition[] = []
    h.ctx.provide('tools', { register: (tool: ToolDefinition) => definitions.push(tool) } as never)
    apply(h.ctx)
    const tool = definitions.find(tool => tool.name === 'yuqi_team_control')!
    const exec = { agent: { id: parent.id, session: parent }, signal: new AbortController().signal } as ToolRunContext
    const input = { action: 'scope', taskId: 'task-1', fileScope: ['src/**', 'package.json'], requestId: 'scope-request' }
    await expect(tool.execute(input, exec)).resolves.toMatchObject({ accepted: true, status: 'paused', taskId: 'task-1' })
    const persistedCalls = h.flush.mock.calls.length // Includes the parent projection bridge.
    await tool.execute(input, exec)
    expect(replayTeamEvents(h.read()).tasks['task-1']!.contract.revision).toBe(2)
    expect(resume).not.toHaveBeenCalled()
    for (const bad of [{ ...input, taskId: undefined }, { ...input, requestId: undefined }, { ...input, fileScope: undefined }, { ...input, action: 'pause' }, { ...input, authorityMode: 'full-access' }]) {
      await expect(tool.execute(bad, exec)).rejects.toThrow()
    }
    await expect(tool.execute({ ...input, teamId: 'wrong' }, exec)).rejects.toThrow(/identity mismatch/)
    expect(h.flush).toHaveBeenCalledTimes(persistedCalls)
  })
})
