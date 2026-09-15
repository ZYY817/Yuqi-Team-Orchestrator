import { describe, expect, it, vi } from 'vitest'
import { TeamBootstrapCoordinator } from '../src/application/bootstrap-team.ts'
import { DurableJournalCoordinator } from '../src/application/durable-journal.ts'
import type { TeamEvent } from '../src/domain/events.ts'
import { replayTeamEvents, type TeamProjection } from '../src/domain/projection.ts'
import { WorkspaceId } from '../src/domain/ids.ts'
import { YuqiTeamOrchestratorService } from '../src/host/harness/service.ts'
import { contract, completeTeamEvents, event } from './fixtures.ts'
import { StartTeamCoordinator } from '../src/host/harness/start-team.ts'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import path from 'node:path'

describe('durable admission concurrency', () => {
  it('carries admission through the real start coordinator and service bootstrap into the journal', async () => {
    const root = process.cwd()
    const identity = { projectRoot: root, repositoryRoot: root, gitCommonDirectory: path.join(root, '.git'),
      baselineRef: 'baseline', volumeRoot: path.parse(root).root, protectedRoots: [] }
    const events: TeamEvent[] = []
    let sequence = 0
    const teamBootstrap = new TeamBootstrapCoordinator({ nowIso: () => new Date().toISOString() },
      { next: () => `start-snapshot-${sequence++}` }, new DurableJournalCoordinator())
    const journal = { key: 'start-snapshot', read: () => events, commit: async (next: readonly TeamEvent[]) => { events.push(...next) } }
    const controller = { id: 'controller', session: Session.create(SessionId('controller')) }
    const host = { teamBootstrap, assertVerificationReadiness: () => {}, journalFor: () => journal }
    const coordinator = new StartTeamCoordinator<typeof controller, { provider: string; model: string }, TeamProjection>(
      { inspect: async () => identity, provision: async request => ({ workspaceId: WorkspaceId(request.workspaceId),
        project: identity, worktreePath: request.worktreePath, branchName: request.branchName, status: 'ready' as const }) },
      { launch: async () => ({ sessionId: controller.id, controller, dispose: async () => {} }) },
      { bootstrap: request => YuqiTeamOrchestratorService.prototype.bootstrapTeam.call(host as never, request as never) },
      { provision: async request => ({ workspaceId: request.workspaceId as never,
        project: identity, worktreePath: request.worktreePath, branchName: request.branchName, status: 'ready' as const }) },
    )
    const started = await coordinator.start({ title: 'Admission', objective: 'Carry snapshot', tasks: [contract()],
      projectCwd: root, workspaceMode: 'direct', controllerModel: { provider: 'mock', model: 'model' }, maxConcurrency: 10 })
    expect(started.bootstrap.team.maxConcurrency).toBe(10)
    expect(events[0]).toMatchObject({ type: 'yuqi/team-created', maxConcurrency: 10 })
    await started.dispose()
  })

  it('persists and replays the snapshot, fencing conflicting bootstrap retries', async () => {
    const events: TeamEvent[] = []
    let sequence = 0
    const coordinator = new TeamBootstrapCoordinator({ nowIso: () => new Date().toISOString() },
      { next: () => `concurrency-${sequence++}` }, new DurableJournalCoordinator())
    const journal = { key: 'snapshot', read: () => events, commit: async (next: readonly TeamEvent[]) => { events.push(...next) } }
    const request = { teamId: 'snapshot', title: 'Snapshot', objective: 'Persist admission', maxConcurrency: 10, tasks: [contract()] }
    const first = await coordinator.bootstrap(request, journal)
    expect(first.team.maxConcurrency).toBe(10)
    expect(events[0]).toMatchObject({ type: 'yuqi/team-created', maxConcurrency: 10 })
    expect(replayTeamEvents(JSON.parse(JSON.stringify(events))).team.maxConcurrency).toBe(10)
    await expect(coordinator.bootstrap(request, journal)).resolves.toEqual(first)
    await expect(coordinator.bootstrap({ ...request, maxConcurrency: 3 }, journal)).rejects.toThrow('conflicts')
  })

  it.each([0, 101, 1.5])('rejects invalid persisted concurrency %s', value => {
    expect(() => event(1, { type: 'yuqi/team-created', title: 'T', objective: 'O', maxConcurrency: value })).toThrow()
  })

  it.each([10, undefined])('cold recovery uses persisted %s, falling back only for legacy logs', async saved => {
    const events = [...completeTeamEvents().slice(0, 4)]
    if (saved !== undefined) events[0] = event(1, { type: 'yuqi/team-created', title: 'Yuqi Team', objective: 'Build the plugin', maxConcurrency: saved })
    const projection = replayTeamEvents(JSON.parse(JSON.stringify(events)))
    const controller = { id: 'cold-controller' }
    const journal = { key: 'cold-controller' }
    let globalValue = 3
    const global = vi.fn(() => globalValue)
    const register = vi.fn()
    const runTeamPass = vi.fn(async () => undefined)
    const methods = YuqiTeamOrchestratorService.prototype as unknown as {
      restoreRecoveredTeamRunner(controller: unknown, teamId: string, journalKey: string): Promise<void>
      recoverDormantRunningTeam(controller: unknown, journal: unknown, teamId: string): Promise<void>
    }
    const host = {
      recoveredControllers: new Map([[controller.id, { agent: controller, dispose: async () => {} }]]),
      controllerAgents: { get: () => controller },
      projectionForTeam: () => projection,
      journalFor: () => journal,
      maxConcurrencyLimit: global,
      teamRunnerSupervisor: { canWake: () => false, register },
      runTeamPass,
      wakeTeamRunner: vi.fn(),
      restoreRecoveredTeamRunner: methods.restoreRecoveredTeamRunner,
    }
    await methods.recoverDormantRunningTeam.call(host, controller, journal, 'team-1')
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrency: saved ?? 3 }))
    if (saved !== undefined) expect(global).not.toHaveBeenCalled()
    // Subsequent global edits cannot retarget the restored runner's closure.
    globalValue = 1
    await register.mock.calls[0]![0].run(new AbortController().signal)
    expect(runTeamPass).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrency: saved ?? 3 }), journal, expect.any(AbortSignal))
  })
})
