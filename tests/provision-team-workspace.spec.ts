import { describe, expect, it } from 'vitest'
import {
  DurableJournalCoordinator,
  TeamWorkspaceCoordinator,
  WorkspaceId,
  replayTeamEvents,
} from '../src/index.ts'
import type {
  Clock,
  EventIdSource,
  GitWorkspacePort,
  ProjectIdentity,
  ProvisionTeamWorkspaceRequest,
  VerifyTeamWorkspaceRequest,
  TeamEvent,
  TeamEventJournal,
  TeamWorkspace,
} from '../src/index.ts'
import { ATTEMPT_ID, completeTeamEvents, event, TASK_ID, TEAM_ID } from './fixtures.ts'

class ClockStub implements Clock {
  #index = 0
  nowIso(): string { return `2026-08-15T18:00:${String(this.#index++).padStart(2, '0')}Z` }
}

class Ids implements EventIdSource {
  #index = 0
  next(): string { return `workspace-coordinator-${this.#index++}` }
}

class Journal implements TeamEventJournal {
  readonly key: string
  readonly events: unknown[]
  readonly transactions: TeamEvent[][] = []
  failAt = -1
  constructor(events: readonly unknown[], key = 'workspace-controller') { this.events = [...events]; this.key = key }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> {
    const ordinal = this.transactions.length + 1
    if (ordinal === this.failAt) throw new Error('workspace flush failed')
    this.transactions.push([...events])
    this.events.push(...events)
  }
}

class GitStub implements GitWorkspacePort {
  readonly calls: ProvisionTeamWorkspaceRequest[] = []
  readonly verifyCalls: VerifyTeamWorkspaceRequest[] = []
  failure: unknown
  returnedPath: string | undefined
  entered: (() => void) | undefined
  barrier: Promise<void> | undefined
  inspect(): Promise<ProjectIdentity> { throw new Error('not used') }
  async verify(request: VerifyTeamWorkspaceRequest): Promise<TeamWorkspace> {
    this.verifyCalls.push(request)
    if (this.failure !== undefined) throw this.failure
    return { ...request.workspace, worktreePath: this.returnedPath ?? request.workspace.worktreePath }
  }
  async provision(request: ProvisionTeamWorkspaceRequest): Promise<TeamWorkspace> {
    this.calls.push(request)
    this.entered?.()
    if (this.barrier !== undefined) await this.barrier
    if (this.failure !== undefined) throw this.failure
    return {
      workspaceId: WorkspaceId(request.workspaceId),
      project: request.identity,
      worktreePath: this.returnedPath ?? request.worktreePath,
      branchName: request.branchName,
      status: 'ready',
    }
  }
}

const identity: ProjectIdentity = {
  projectRoot: 'F:\\project',
  repositoryRoot: 'F:\\project',
  gitCommonDirectory: 'F:\\project\\.git',
  baselineRef: 'baseline-1',
  volumeRoot: 'F:\\',
  protectedRoots: ['F:\\'],
}

function baseEvents(): readonly TeamEvent[] {
  return [
    event(1200, { type: 'yuqi/team-created', title: 'Workspace coordinator', objective: 'Provision safely' }),
    event(1201, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
  ]
}

function request(overrides: Partial<Parameters<TeamWorkspaceCoordinator['provision']>[0]> = {}) {
  return {
    teamId: TEAM_ID,
    workspaceId: 'workspace-1',
    identity,
    managedRoot: 'F:\\yuqi-managed',
    worktreePath: 'F:\\yuqi-managed\\team-1',
    branchName: 'yuqi/team-1',
    ...overrides,
  }
}

describe('TeamWorkspaceCoordinator', () => {
  it('persists provisioning intent before Git and confirms the exact ready workspace', async () => {
    const journal = new Journal(baseEvents())
    const git = new GitStub()
    let release!: () => void
    git.barrier = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }); git.entered = entered
    const coordinator = new TeamWorkspaceCoordinator(new ClockStub(), new Ids(), git)

    const provisioning = coordinator.provision(request({ signal: new AbortController().signal }), journal)
    await started
    expect(journal.transactions).toHaveLength(1)
    expect(journal.transactions[0]?.map(item => item.type)).toEqual(['yuqi/workspace-provisioning-started'])
    expect(replayTeamEvents(journal.read()).workspace?.status).toBe('provisioning')
    release()

    await expect(provisioning).resolves.toMatchObject({ workspaceId: 'workspace-1', status: 'ready' })
    expect(journal.transactions[1]?.map(item => item.type)).toEqual(['yuqi/workspace-provisioned'])
    expect(replayTeamEvents(journal.read()).workspace?.status).toBe('ready')
    await coordinator.dispose()
  })

  it('singleflights an identical request, reuses a durable ready fact, and rejects another active request', async () => {
    const journal = new Journal(baseEvents())
    const git = new GitStub()
    let release!: () => void
    git.barrier = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }); git.entered = entered
    const coordinator = new TeamWorkspaceCoordinator(new ClockStub(), new Ids(), git)
    const first = coordinator.provision(request(), journal)
    await started
    expect(coordinator.provision(request(), journal)).toBe(first)
    await expect(coordinator.provision(request({ workspaceId: 'workspace-2' }), journal))
      .rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    release()
    const created = await first
    await expect(coordinator.provision(request(), journal)).resolves.toEqual(created)
    await expect(coordinator.provision(request({ workspaceId: 'workspace-2' }), journal))
      .rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    expect(git.calls).toHaveLength(1)
  })

  it('records reconciliation when Git fails or returns a mismatched workspace', async () => {
    const failedJournal = new Journal(baseEvents(), 'failed-git')
    const failedGit = new GitStub(); failedGit.failure = new Error('git failed')
    const failed = new TeamWorkspaceCoordinator(new ClockStub(), new Ids(), failedGit)
    await expect(failed.provision(request(), failedJournal)).rejects.toMatchObject({ code: 'WORKSPACE_REQUIRES_RECONCILIATION' })
    expect(replayTeamEvents(failedJournal.read()).workspace?.status).toBe('needs_reconciliation')

    const mismatchJournal = new Journal(baseEvents(), 'mismatch-git')
    const mismatchGit = new GitStub(); mismatchGit.returnedPath = 'F:\\other\\team'
    const mismatch = new TeamWorkspaceCoordinator(new ClockStub(), new Ids(), mismatchGit)
    await expect(mismatch.provision(request(), mismatchJournal)).rejects.toMatchObject({ code: 'WORKSPACE_REQUIRES_RECONCILIATION' })
    expect(replayTeamEvents(mismatchJournal.read()).workspace?.status).toBe('needs_reconciliation')
  })

  it('re-proves live Git facts before execution and durably blocks drift', async () => {
    const readyEvents = [
      ...baseEvents(),
      event(1212, { type: 'yuqi/workspace-provisioning-started', workspace: {
        workspaceId: WorkspaceId('workspace-1'), project: identity, worktreePath: request().worktreePath,
        branchName: request().branchName, status: 'provisioning',
      } }),
      event(1213, { type: 'yuqi/workspace-provisioned', workspaceId: WorkspaceId('workspace-1') }),
    ]
    const git = new GitStub()
    const coordinator = new TeamWorkspaceCoordinator(new ClockStub(), new Ids(), git)
    const journal = new Journal(readyEvents, 'verify-ready')
    await expect(coordinator.verifyReady({
      teamId: TEAM_ID, workspaceId: 'workspace-1', worktreePath: request().worktreePath,
    }, journal)).resolves.toMatchObject({ status: 'ready' })
    expect(git.verifyCalls).toHaveLength(1)

    git.returnedPath = 'F:\\other\\team'
    await expect(coordinator.verifyReady({
      teamId: TEAM_ID, workspaceId: 'workspace-1', worktreePath: request().worktreePath,
    }, journal)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(replayTeamEvents(journal.read()).workspace?.status).toBe('needs_reconciliation')
  })

  it('uses the whole workspace boundary after a writer admission instead of treating fileScope as proof', async () => {
    const readyEvents = [
      ...completeTeamEvents().slice(0, 16),
      event(1212, { type: 'yuqi/workspace-provisioning-started', workspace: {
        workspaceId: WorkspaceId('workspace-1'), project: identity, worktreePath: request().worktreePath,
        branchName: request().branchName, status: 'provisioning',
      } }),
      event(1213, { type: 'yuqi/workspace-provisioned', workspaceId: WorkspaceId('workspace-1') }),
    ]
    const git = new GitStub()
    const coordinator = new TeamWorkspaceCoordinator(new ClockStub(), new Ids(), git)
    const journal = new Journal(readyEvents, 'verify-completed-output')

    await expect(coordinator.verifyReady({
      teamId: TEAM_ID, workspaceId: 'workspace-1', worktreePath: request().worktreePath,
    }, journal)).resolves.toMatchObject({ status: 'ready' })

    expect(git.verifyCalls[0]?.allowedDirtyScopes).toEqual(['**'])
    await coordinator.dispose()
  })

  it('keeps partial output from an admitted cancelled writer inside the recovery boundary', async () => {
    const readyEvents = [
      ...completeTeamEvents().slice(0, 8),
      event(1209, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'cancelled' }),
      event(1210, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'cancelled' }),
      event(1211, { type: 'yuqi/workspace-provisioning-started', workspace: {
        workspaceId: WorkspaceId('workspace-1'), project: identity, worktreePath: request().worktreePath,
        branchName: request().branchName, status: 'provisioning',
      } }),
      event(1212, { type: 'yuqi/workspace-provisioned', workspaceId: WorkspaceId('workspace-1') }),
    ]
    const git = new GitStub()
    const coordinator = new TeamWorkspaceCoordinator(new ClockStub(), new Ids(), git)

    await expect(coordinator.verifyReady({
      teamId: TEAM_ID, workspaceId: 'workspace-1', worktreePath: request().worktreePath,
    }, new Journal(readyEvents, 'verify-cancelled-output'))).resolves.toMatchObject({ status: 'ready' })

    expect(git.verifyCalls[0]?.allowedDirtyScopes).toEqual(['**'])
    await coordinator.dispose()
  })

  it('does not trust a cancelled write task that never admitted a child', async () => {
    const readyEvents = [
      ...completeTeamEvents().slice(0, 5),
      event(1209, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'cancelled' }),
      event(1210, { type: 'yuqi/workspace-provisioning-started', workspace: {
        workspaceId: WorkspaceId('workspace-1'), project: identity, worktreePath: request().worktreePath,
        branchName: request().branchName, status: 'provisioning',
      } }),
      event(1211, { type: 'yuqi/workspace-provisioned', workspaceId: WorkspaceId('workspace-1') }),
    ]
    const git = new GitStub()
    const coordinator = new TeamWorkspaceCoordinator(new ClockStub(), new Ids(), git)

    await expect(coordinator.verifyReady({
      teamId: TEAM_ID, workspaceId: 'workspace-1', worktreePath: request().worktreePath,
    }, new Journal(readyEvents, 'verify-never-admitted-output'))).resolves.toMatchObject({ status: 'ready' })

    expect(git.verifyCalls[0]?.allowedDirtyScopes).toEqual([])
    await coordinator.dispose()
  })

  it('rejects invalid live-verification requests before Git', async () => {
    const git = new GitStub()
    const coordinator = new TeamWorkspaceCoordinator(new ClockStub(), new Ids(), git)
    await expect(coordinator.verifyReady({
      teamId: TEAM_ID, workspaceId: 'workspace-1', worktreePath: request().worktreePath,
    }, new Journal(baseEvents(), 'verify-missing'))).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
    await expect(coordinator.verifyReady({
      teamId: 'other-team', workspaceId: 'workspace-1', worktreePath: request().worktreePath,
    }, new Journal(baseEvents(), 'verify-team'))).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    expect(git.verifyCalls).toHaveLength(0)
  })

  it('rejects live verification while provisioning and after disposal', async () => {
    const git = new GitStub()
    let release!: () => void
    git.barrier = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }); git.entered = entered
    const coordinator = new TeamWorkspaceCoordinator(new ClockStub(), new Ids(), git)
    const journal = new Journal(baseEvents(), 'verify-lifecycle')
    const provisioning = coordinator.provision(request(), journal)
    await started
    await expect(coordinator.verifyReady({
      teamId: TEAM_ID, workspaceId: 'workspace-1', worktreePath: request().worktreePath,
    }, journal)).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    release()
    await provisioning
    await coordinator.dispose()
    await expect(coordinator.verifyReady({
      teamId: TEAM_ID, workspaceId: 'workspace-1', worktreePath: request().worktreePath,
    }, journal)).rejects.toMatchObject({ code: 'SERVICE_DISPOSED' })
  })

  it('fails before Git for another Team, unfinished durable state, or intent persistence failure', async () => {
    const git = new GitStub()
    const coordinator = new TeamWorkspaceCoordinator(new ClockStub(), new Ids(), git)
    await expect(coordinator.provision(request({ teamId: 'other-team' }), new Journal(baseEvents(), 'other-team')))
      .rejects.toMatchObject({ code: 'TEAM_MISMATCH' })

    const unfinished = new Journal([
      ...baseEvents(),
      event(1210, {
        type: 'yuqi/workspace-provisioning-started',
        workspace: { workspaceId: WorkspaceId('workspace-1'), project: identity, worktreePath: request().worktreePath, branchName: request().branchName, status: 'provisioning' },
      }),
    ], 'unfinished')
    await expect(coordinator.provision(request(), unfinished)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })

    const reconciliation = new Journal([
      ...unfinished.events,
      event(1211, { type: 'yuqi/workspace-reconciliation-required', workspaceId: WorkspaceId('workspace-1'), reason: 'uncertain' }),
    ], 'already-reconciling')
    await expect(coordinator.provision(request(), reconciliation)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })

    const persistence = new Journal(baseEvents(), 'intent-failure'); persistence.failAt = 1
    await expect(coordinator.provision(request(), persistence)).rejects.toMatchObject({ code: 'WORKSPACE_PERSISTENCE_FAILED' })
    expect(git.calls).toHaveLength(0)
  })

  it('poisons the controller if Git succeeds but durable confirmation fails', async () => {
    const journal = new Journal(baseEvents()); journal.failAt = 2
    const git = new GitStub()
    const coordinator = new TeamWorkspaceCoordinator(new ClockStub(), new Ids(), git)
    await expect(coordinator.provision(request(), journal)).rejects.toMatchObject({ code: 'WORKSPACE_PERSISTENCE_FAILED' })
    expect(git.calls).toHaveLength(1)
    expect(replayTeamEvents(journal.read()).workspace?.status).toBe('provisioning')
    await expect(coordinator.provision(request(), journal)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(git.calls).toHaveLength(1)
  })

  it('poisons the controller if reconciliation itself cannot be persisted', async () => {
    const journal = new Journal(baseEvents()); journal.failAt = 2
    const git = new GitStub(); git.failure = new Error('git failed')
    const coordinator = new TeamWorkspaceCoordinator(new ClockStub(), new Ids(), git)
    await expect(coordinator.provision(request(), journal)).rejects.toMatchObject({ code: 'WORKSPACE_PERSISTENCE_FAILED' })
    await expect(coordinator.provision(request(), journal)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
  })

  it('drains active provisioning and disposes idempotently without owning an injected transaction boundary', async () => {
    const journal = new Journal(baseEvents())
    const git = new GitStub()
    let release!: () => void
    git.barrier = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }); git.entered = entered
    const transactions = new DurableJournalCoordinator()
    const coordinator = new TeamWorkspaceCoordinator(new ClockStub(), new Ids(), git, transactions)
    const provisioning = coordinator.provision(request(), journal)
    await started
    const disposal = coordinator.dispose()
    expect(coordinator.dispose()).toBe(disposal)
    release()
    await expect(provisioning).resolves.toMatchObject({ status: 'ready' })
    await disposal
    await expect(coordinator.provision(request(), journal)).rejects.toMatchObject({ code: 'SERVICE_DISPOSED' })

    const secondJournal = new Journal(baseEvents(), 'still-usable')
    await expect(transactions.run(secondJournal, async () => 'available')).resolves.toBe('available')
    await transactions.dispose()
  })
})
