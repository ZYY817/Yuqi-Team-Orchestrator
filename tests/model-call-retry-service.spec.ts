import { beforeEach, describe, expect, it, vi } from 'vitest'
import { YuqiTeamOrchestratorService } from '../src/host/harness/service.ts'
import { DurableJournalCoordinator } from '../src/application/durable-journal.ts'
import { readModelCallFailure } from '../src/host/harness/model-call-failure.ts'
import { replayTeamEvents } from '../src/domain/projection.ts'
import { canRetryModelCall } from '../src/application/model-call-retry.ts'
import { TeamRunLoopCoordinator } from '../src/application/run-team-loop.ts'
import { AttemptId, WorkspaceId } from '../src/domain/ids.ts'
import { completeTeamEvents, contract, event, TASK_ID, ATTEMPT_ID, TEAM_ID } from './fixtures.ts'
import type { TeamEvent } from '../src/domain/events.ts'

vi.mock('../src/host/harness/model-call-failure.ts', () => ({ readModelCallFailure: vi.fn() }))
beforeEach(() => { vi.mocked(readModelCallFailure).mockReset().mockResolvedValue({ code: 'RATE_LIMIT', status: 429 }) })

function fixture(maxAttempts = 3) {
  const first = { modelProvider: 'deepseek', modelId: 'deepseek-v4' }
  const second = { modelProvider: 'deepseek', modelId: 'next' }
  const policy = { providerScope: { kind: 'controller-only' as const }, teamPolicy: { kind: 'automatic' as const,
    tierCandidates: { quick: [], standard: [first, second], critical: [] } } }
  const workspaceId = WorkspaceId('safe-model-workspace')
  const initial = completeTeamEvents()
  const { modelId: _legacy, ...baseContract } = contract()
  const events: TeamEvent[] = [
    event(1, { type: 'yuqi/team-created', title: 'Model retry', objective: 'Bounded fallback', modelRouting: policy,
      controllerModel: { provider: 'deepseek', model: 'deepseek-v4' } }),
    initial[1]!,
    event(3, { type: 'yuqi/task-created', contract: { ...baseContract, modelRequest: { kind: 'default' }, maxAttempts } }),
    event(20, { type: 'yuqi/workspace-provisioning-started', workspace: { workspaceId,
      project: { projectRoot: 'F:/repo', repositoryRoot: 'F:/repo', gitCommonDirectory: 'F:/repo/.git', baselineRef: 'commit-1', volumeRoot: 'F:/', protectedRoots: [] },
      worktreePath: 'F:/managed/retry', branchName: 'yuqi/retry', status: 'provisioning' } }),
    event(21, { type: 'yuqi/workspace-provisioned', workspaceId }),
    ...initial.slice(3, 8),
    event(9, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'failed' }),
    event(10, { type: 'yuqi/attempt-evidence-recorded', taskId: TASK_ID, attemptId: ATTEMPT_ID, runId: 'run-1',
      agentSessionId: 'session-worker-1', provider: 'spawn', stopReason: 'error', hasAssistantOutput: false, settledAt: '2026-08-15T00:00:10Z' }),
    event(11, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'failed' }),
    event(12, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing', reason: 'task graph settled with retryable terminal tasks' }),
    event(13, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused', reason: 'controller decision required for failed, cancelled, or blocked tasks' }),
  ]
  const commit = vi.fn(async (batch: readonly TeamEvent[]) => { events.push(...batch) })
  const journal = { key: 'safe-retry', read: () => events, commit }
  const service = Object.create(YuqiTeamOrchestratorService.prototype) as YuqiTeamOrchestratorService
  let next = 0
  Object.defineProperties(service, {
    ctx: { value: {} },
    journalFor: { value: () => journal },
    transactions: { value: new DurableJournalCoordinator() },
    progressClock: { value: { nowIso: () => '2026-08-15T00:01:00Z' } },
    progressEventIds: { value: { next: () => `retry-new-${++next}` } },
    modelCatalog: { value: { inspectAutomaticRoutes: vi.fn(async () => [first, second].map(model => ({ model, routable: true, metadataResolved: true }))) } },
  })
  const request = { controller: { session: { id: 'parent' } } as never, teamId: TEAM_ID, signal: new AbortController().signal }
  return { service, journal, events, commit, request, first, second }
}

describe('actual service safe model retry integration', () => {
  it('rechecks a pre-existing system pause before the real pass loop and driver choose the next model', async () => {
    const f = fixture()
    const executeGatedBatch = vi.fn(async (request: { children: { taskId: string; attemptId: string }[] }) => ({
      handles: request.children.map(child => ({ ...child, admission: Promise.resolve(), settled: Promise.resolve() })),
    }))
    Object.defineProperties(f.service, {
      teamRuns: { value: new TeamRunLoopCoordinator() },
      executeGatedBatch: { value: executeGatedBatch },
      readProjectSummary: { value: async () => undefined },
    })
    // Exercise the pass, real loop, driver, resolver and durable retry together.
    await Reflect.apply(Reflect.get(f.service, 'runTeamPass'), f.service, [
      { ...f.request, controller: { session: { id: 'parent' }, options: { provider: 'deepseek' } }, maxConcurrency: 1, maxCycles: 1 },
      f.journal, f.request.signal,
    ])
    expect(executeGatedBatch).toHaveBeenCalledOnce()
    expect(executeGatedBatch.mock.calls[0]?.[0]).toMatchObject({ children: [{ route: { route: f.second } }] })
    expect(replayTeamEvents(f.events).taskRetryOperations['safe-model-call-retry:attempt-1']).toBeDefined()
  })
  it('leaves a user-controlled paused Team paused at the pass entry', async () => {
    const f = fixture()
    f.events.push(event(22, { type: 'yuqi/team-control-requested', operationId: 'user-held' as never, action: 'pause' }))
    Object.defineProperty(f.service, 'teamRuns', { value: new TeamRunLoopCoordinator() })
    const result = await Reflect.apply(Reflect.get(f.service, 'runTeamPass'), f.service, [
      { ...f.request, maxConcurrency: 1 }, f.journal, f.request.signal,
    ])
    expect(result).toMatchObject({ projection: { team: { status: 'paused' } } })
    expect(f.commit).not.toHaveBeenCalled()
  })
  it('persists retry and resumes only system pause; next route excludes the failed model', async () => {
    const f = fixture()
    await f.service.retrySafeModelCalls(f.request)
    const projection = replayTeamEvents(f.events)
    expect(projection.team.status).toBe('running')
    expect(projection.tasks[TASK_ID]?.status).toBe('ready')
    expect(projection.attempts[ATTEMPT_ID]?.status).toBe('failed')
    expect(f.events.at(-1)).toMatchObject({ type: 'yuqi/team-status-changed', reason: expect.stringContaining('RATE_LIMIT') })
    // Durable retry identity preserves exclusion even if the old log is unavailable later.
    vi.mocked(readModelCallFailure).mockResolvedValue(undefined)
    expect(await f.service.resolveTaskModelRoute({ ...f.request, taskId: TASK_ID })).toMatchObject({ route: f.second })
    await f.service.retrySafeModelCalls(f.request)
    expect(f.commit).toHaveBeenCalledTimes(1)
  })
  it('respects explicit one attempt and missing native proof', async () => {
    const limited = fixture(1)
    await limited.service.retrySafeModelCalls(limited.request)
    expect(limited.commit).not.toHaveBeenCalled()
    const missing = fixture()
    vi.mocked(readModelCallFailure).mockResolvedValue(undefined)
    await missing.service.retrySafeModelCalls(missing.request)
    expect(missing.commit).not.toHaveBeenCalled()
  })
  it('honors an explicit budget of five without a hidden three-attempt cap', () => {
    const f = fixture(5), projection = replayTeamEvents(f.events)
    const ids = ['a1', 'a2', 'a3', 'a4'].map(AttemptId)
    const source = { ...projection,
      tasks: { ...projection.tasks, [TASK_ID]: { ...projection.tasks[TASK_ID]!, attemptIds: ids } },
      attempts: Object.fromEntries(ids.map(id => [id, { ...projection.attempts[ATTEMPT_ID]!, id }])),
    }
    expect(canRetryModelCall(source, TASK_ID)).toBe(true)
    expect(canRetryModelCall({ ...source, tasks: { ...source.tasks,
      [TASK_ID]: { ...source.tasks[TASK_ID]!, contract: { ...source.tasks[TASK_ID]!.contract, maxAttempts: 4 } },
    } }, TASK_ID)).toBe(false)
  })
  it('does not override a user pause or a concurrent control event during proof lookup', async () => {
    const paused = fixture()
    paused.events.push(event(22, { type: 'yuqi/team-control-requested', operationId: 'user-pause' as never, action: 'pause' }))
    await paused.service.retrySafeModelCalls(paused.request)
    expect(paused.commit).not.toHaveBeenCalled()
    const race = fixture()
    vi.mocked(readModelCallFailure).mockImplementationOnce(async () => {
      race.events.push(event(23, { type: 'yuqi/team-control-requested', operationId: 'concurrent-pause' as never, action: 'pause' }))
      return { code: 'RATE_LIMIT', status: 429 }
    })
    await race.service.retrySafeModelCalls(race.request)
    expect(race.commit).not.toHaveBeenCalled()
  })
})
