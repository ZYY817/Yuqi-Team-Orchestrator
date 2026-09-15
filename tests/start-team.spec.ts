import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskId, WorkspaceId } from '../src/domain/ids.ts'
import type { TeamTaskContract } from '../src/domain/task-contract.ts'
import type { ProjectIdentity, TeamWorkspace } from '../src/domain/workspace.ts'
import { YuqiOrchestratorError } from '../src/application/errors.ts'
import {
  StartTeamCoordinator,
  type StartTeamBootstrapPort,
  type StartTeamControllerLaunch,
  type StartTeamControllerPort,
  type StartTeamDurableWorkspacePort,
  type StartTeamIdentityPort,
  type StartTeamPhysicalWorkspacePort,
  type StartTeamRecoveryHandle,
  type StartTeamRecoveryStore,
} from '../src/host/harness/start-team.ts'

const identity: ProjectIdentity = {
  projectRoot: 'F:\\project',
  repositoryRoot: 'F:\\project',
  gitCommonDirectory: 'F:\\project\\.git',
  baselineRef: 'inspected-commit',
  volumeRoot: 'F:\\',
  protectedRoots: [],
}

const task: TeamTaskContract = {
  taskId: TaskId('task-1'), revision: 1, goal: 'Build feature', scope: ['src'], nonGoals: ['deploy'], dependencies: [], fileScope: ['src/**'],
  modelRole: 'worker', modelId: 'deepseek-v4', acceptanceCriteria: ['build passes'], authorityMode: 'write-authorized', inputDigest: 'input', baselineRef: 'caller-claimed-commit',
}

const ids: StartTeamIdentityPort = {
  nextTeamId: () => 'team-host-1',
  nextWorkspaceId: () => 'workspace-host-1',
}

function physicalWorkspace(worktreePath: string): TeamWorkspace {
  return {
    workspaceId: WorkspaceId('workspace-host-1'), project: identity, worktreePath, branchName: 'yuqi/team-host-1', status: 'ready',
  }
}

interface Harness {
  readonly physical: StartTeamPhysicalWorkspacePort
  readonly launcher: StartTeamControllerPort<{ readonly id: string }, { readonly model: string }>
  readonly bootstrap: StartTeamBootstrapPort<{ readonly id: string }, { readonly status: string }>
  readonly durable: StartTeamDurableWorkspacePort<{ readonly id: string }>
  readonly calls: string[]
  readonly state: {
    readonly launchRequests: unknown[]
    readonly bootstrapRequests: unknown[]
    readonly durableRequests: unknown[]
    disposeCount: number
    physicalFailure?: unknown
    launchFailure?: unknown
    bootstrapFailure?: unknown
    durableFailure?: unknown
  }
}

function harness(root: string): Harness {
  const calls: string[] = []
  const state: Harness['state'] = {
    launchRequests: [], bootstrapRequests: [], durableRequests: [], disposeCount: 0,
  }
  const workspace = physicalWorkspace(path.join(root, 'workspace-host-1'))
  const physical: StartTeamPhysicalWorkspacePort = {
    async inspect() { calls.push('inspect'); if (state.physicalFailure !== undefined) throw state.physicalFailure; return identity },
    async provision(request) { calls.push('physical-provision'); return state.physicalFailure === undefined ? workspace : Promise.reject(state.physicalFailure) },
  }
  const launcher: Harness['launcher'] = {
    async launch(request) {
      calls.push('launch'); state.launchRequests.push(request)
      if (state.launchFailure !== undefined) throw state.launchFailure
      const launch: StartTeamControllerLaunch<{ readonly id: string }> = {
        sessionId: 'session-host-1', controller: { id: 'controller-host-1' },
        async dispose() { calls.push('dispose'); state.disposeCount += 1 },
      }
      return launch
    },
  }
  const bootstrap: Harness['bootstrap'] = {
    async bootstrap(request) {
      calls.push('bootstrap'); state.bootstrapRequests.push(request)
      if (state.bootstrapFailure !== undefined) throw state.bootstrapFailure
      return { status: 'running' }
    },
  }
  const durable: Harness['durable'] = {
    async provision(request) {
      calls.push('durable-provision'); state.durableRequests.push(request)
      if (state.durableFailure !== undefined) throw state.durableFailure
      return workspace
    },
  }
  return { physical, launcher, bootstrap, durable, calls, state }
}

function request(root: string): {
  readonly title: string
  readonly objective: string
  readonly tasks: readonly TeamTaskContract[]
  readonly projectCwd: string
  readonly controllerModel: { readonly model: string }
  readonly controllerParentSessionId: string
  readonly managedRoot: string
} {
  return {
    title: 'Host-started Team', objective: 'Prove cold start ordering', tasks: [task], projectCwd: 'F:\\project', controllerModel: { model: 'deepseek-v4' }, managedRoot: root,
    controllerParentSessionId: 'entry-session',
  }
}

function recoveryStore(): StartTeamRecoveryStore {
  let current: StartTeamRecoveryHandle | undefined
  return {
    async create(plan) {
      const now = new Date().toISOString()
      current = {
        schemaVersion: 1, recoveryId: plan.teamId, ownerProof: '00000000-0000-4000-8000-000000000001', phase: 'planned',
        teamId: plan.teamId, workspaceId: plan.workspaceId,
        projectRoot: plan.identity.projectRoot, repositoryRoot: plan.identity.repositoryRoot,
        gitCommonDirectory: plan.identity.gitCommonDirectory, baselineRef: plan.identity.baselineRef,
        managedRoot: plan.managedRoot, worktreePath: plan.worktreePath, branchName: plan.branchName,
        createdAt: now, updatedAt: now,
      }
      return current
    },
    async advance(handle, phase, controllerSessionId) {
      current = {
        ...handle, phase, updatedAt: new Date().toISOString(),
        ...(controllerSessionId === undefined ? {} : { controllerSessionId }),
      }
      return current
    },
    async list() { return current === undefined ? [] : [current] },
  }
}

function coordinator(setup: Harness) {
  return new StartTeamCoordinator(setup.physical, setup.launcher, setup.bootstrap, setup.durable, ids, recoveryStore())
}

describe('StartTeamCoordinator', () => {
  it.each([
    ['invalid workspace mode', (root: string) => ({ ...request(root), workspaceMode: 'shared' as never })],
    ['missing controller model', (root: string) => ({ ...request(root), controllerModel: undefined as never })],
    ['invalid locale', (root: string) => ({ ...request(root), locale: 'fr' as never })],
    ['conflicting Host roots', (root: string) => ({ ...request(root), options: { hostRoot: `${root}-other` } })],
    ['missing Git managed root', (root: string) => {
      const { managedRoot: _managedRoot, ...value } = request(root)
      return value
    }],
    ['empty tasks', (root: string) => ({ ...request(root), tasks: [] })],
    ['escaping file scope', (root: string) => ({ ...request(root), tasks: [{ ...task, fileScope: ['../outside'] }] })],
  ] as const)('rejects %s before inspecting or mutating the workspace', async (_label, invalidRequest) => {
    const root = path.resolve('F:\\yuqi-invalid-start')
    const setup = harness(root)
    await expect(coordinator(setup).start(invalidRequest(root))).rejects.toMatchObject({ code: 'INVALID_BATCH' })
    expect(setup.calls).toEqual([])
  })

  it('uses direct workspace only when explicitly selected and never creates a Git recovery manifest', async () => {
    const projectRoot = path.resolve('F:\\direct-project')
    const directIdentity = {
      mode: 'direct' as const, projectRoot, volumeRoot: path.parse(projectRoot).root, protectedRoots: [],
    } as unknown as ProjectIdentity
    const directWorkspace = {
      workspaceId: WorkspaceId('workspace-host-1'), project: directIdentity, worktreePath: projectRoot,
      branchName: 'direct', status: 'ready' as const,
    }
    const create = async (): Promise<StartTeamRecoveryHandle> => { throw new Error('direct mode must not create recovery') }
    const recovery: StartTeamRecoveryStore = { create, async advance(handle) { return handle }, async list() { return [] } }
    const launchRequests: unknown[] = []
    const coordinator = new StartTeamCoordinator(
      {
        async inspect() { return directIdentity },
        async provision(request) {
          expect(request.worktreePath).toBe(projectRoot)
          expect(request.branchName).toBe('direct')
          return directWorkspace
        },
      },
      { async launch(request) { launchRequests.push(request); return { sessionId: 'direct-controller', controller: { id: 'direct' }, async dispose() {} } } },
      { async bootstrap(request) { expect(request.tasks[0]?.baselineRef).toBe(task.baselineRef); return { status: 'running' } } },
      { async provision() { return directWorkspace } },
      ids,
      recovery,
    )
    const { managedRoot: _managedRoot, controllerParentSessionId: _parent, ...base } = request(path.dirname(projectRoot))
    const result = await coordinator.start({ ...base, projectCwd: projectRoot, workspaceMode: 'direct' })
    expect(result.workspace).toEqual(directWorkspace)
    expect(launchRequests).toEqual([{ workspace: directWorkspace, controllerModel: { model: 'deepseek-v4' } }])
  })

  it('persists recovery ownership before physical Git provision and stops if it cannot', async () => {
    const root = path.resolve('F:\\yuqi-recovery-intent-failure')
    const setup = harness(root)
    const create = async (): Promise<StartTeamRecoveryHandle> => { throw new Error('manifest unavailable') }
    const recovery: StartTeamRecoveryStore = { create, async advance(handle) { return handle }, async list() { return [] } }
    const start = new StartTeamCoordinator(setup.physical, setup.launcher, setup.bootstrap, setup.durable, ids, recovery)

    await expect(start.start(request(root))).rejects.toMatchObject({ code: 'INTENT_PERSISTENCE_FAILED' })
    expect(setup.calls).toEqual(['inspect'])
  })

  it('disposes a controller if a post-launch recovery transition cannot persist', async () => {
    const root = path.resolve('F:\\yuqi-recovery-transition-failure')
    const setup = harness(root)
    const base = recoveryStore()
    let advances = 0
    const recovery: StartTeamRecoveryStore = {
      ...base,
      async advance(handle, phase, controllerSessionId) {
        advances += 1
        if (phase === 'controller-launched') throw new Error('manifest update failed')
        return base.advance(handle, phase, controllerSessionId)
      },
    }
    const start = new StartTeamCoordinator(setup.physical, setup.launcher, setup.bootstrap, setup.durable, ids, recovery)

    await expect(start.start(request(root))).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(advances).toBe(4)
    expect(setup.calls).toEqual(['inspect', 'physical-provision', 'launch', 'dispose'])
  })

  it('preserves a specific bootstrap domain error after disposing and recording recovery', async () => {
    const root = path.resolve('F:\\yuqi-bootstrap-domain-failure')
    const setup = harness(root)
    setup.state.bootstrapFailure = new YuqiOrchestratorError('INVALID_BATCH', 'specific durable rejection')
    const start = coordinator(setup)

    await expect(start.start(request(root))).rejects.toMatchObject({ code: 'INVALID_BATCH', message: 'specific durable rejection' })
    expect(setup.state.disposeCount).toBe(1)
  })

  it('classifies Host Session envelope incompatibility as non-recoverable before durable Team state', async () => {
    const root = path.resolve('F:\\yuqi-bootstrap-host-incompatible')
    const setup = harness(root)
    const cause = new Error('Current Harness does not support ignorable downstream Session events; update Harness before starting a Yuqi Team')
    setup.state.bootstrapFailure = cause
    const start = coordinator(setup)

    const result = start.start(request(root))
    await expect(result).rejects.toMatchObject({
      code: 'HOST_SESSION_INCOMPATIBLE',
      message: expect.stringContaining('The Host Session event envelope is incompatible; no durable Team state was created. Update the Host before retrying'),
    })
    await expect(result).rejects.toHaveProperty('cause', cause)
    expect(setup.state.disposeCount).toBe(1)
  })

  it('keeps the dedicated Host Session incompatibility code without reconciliation semantics', async () => {
    const root = path.resolve('F:\\yuqi-bootstrap-host-incompatible-coded')
    const setup = harness(root)
    const cause = new YuqiOrchestratorError('HOST_SESSION_INCOMPATIBLE', 'Host rejected ignorable Session events')
    setup.state.bootstrapFailure = cause

    const result = coordinator(setup).start(request(root))
    await expect(result).rejects.toMatchObject({ code: 'HOST_SESSION_INCOMPATIBLE' })
    await expect(result).rejects.toHaveProperty('cause', cause)
    expect(setup.state.disposeCount).toBe(1)
  })

  it('fails reconciliation when a failed start cannot dispose its exact controller owner', async () => {
    const root = path.resolve('F:\\yuqi-dispose-failure')
    const setup = harness(root)
    setup.state.bootstrapFailure = new Error('bootstrap failed')
    setup.launcher.launch = async () => ({
      sessionId: 'session-host-1', controller: { id: 'controller-host-1' },
      async dispose() { throw new Error('dispose failed') },
    })
    const start = coordinator(setup)
    await expect(start.start(request(root))).rejects.toMatchObject({
      code: 'CONTROLLER_REQUIRES_RECONCILIATION', message: 'The fresh Team controller could not be disposed safely; reconciliation is required',
    })
  })

  it('inspects, physically provisions, launches, bootstraps, and confirms the same workspace', async () => {
    const root = path.resolve('F:\\yuqi-managed-start')
    const setup = harness(root)
    const start = coordinator(setup)

    const result = await start.start({ ...request(root), childPresetId: 'ptc' })

    expect(setup.calls).toEqual(['inspect', 'physical-provision', 'launch', 'bootstrap', 'durable-provision'])
    expect(result).toMatchObject({ teamId: 'team-host-1', sessionId: 'session-host-1', workspace: { workspaceId: 'workspace-host-1', status: 'ready' } })
    expect(result.controller).toEqual({ id: 'controller-host-1' })
    expect(typeof result.dispose).toBe('function')
    expect((setup.state.bootstrapRequests[0] as { tasks: readonly TeamTaskContract[] }).tasks[0]?.baselineRef).toBe(identity.baselineRef)
    expect((setup.state.launchRequests[0] as { workspace: TeamWorkspace }).workspace).toEqual(physicalWorkspace(path.join(root, 'workspace-host-1')))
    expect((setup.state.launchRequests[0] as { parentSessionId: string }).parentSessionId).toBe('entry-session')
    expect((setup.state.launchRequests[0] as { childPresetId: string }).childPresetId).toBe('ptc')
    expect((setup.state.durableRequests[0] as { workspaceId: string; teamId: string }).workspaceId).toBe('workspace-host-1')
    expect((setup.state.durableRequests[0] as { teamId: string }).teamId).toBe('team-host-1')
    expect(setup.state.disposeCount).toBe(0)
    const firstDisposal = result.dispose()
    expect(result.dispose()).toBe(firstDisposal)
    await firstDisposal
    expect(setup.state.disposeCount).toBe(1)
  })

  it('normalizes legacy starts to manual and forwards an explicit reviewer policy unchanged', async () => {
    const root = path.resolve('F:\\yuqi-review-policy-start')
    const legacy = harness(root)
    await coordinator(legacy).start(request(root))
    expect(legacy.state.bootstrapRequests[0]).toMatchObject({
      locale: 'zh',
      reviewPolicy: { mode: 'manual', maxReworkRounds: 2, additionalPrompt: '' },
    })

    const configured = harness(root)
    const reviewPolicy = { mode: 'quality-gate' as const, maxReworkRounds: 3, additionalPrompt: 'inspect migrations' }
    await coordinator(configured).start({ ...request(root), locale: 'en', reviewPolicy })
    expect(configured.state.bootstrapRequests[0]).toMatchObject({ locale: 'en', reviewPolicy })
  })

  it('retries the exact StartedTeam controller disposal after a transient rejection', async () => {
    const root = path.resolve('F:\\yuqi-retry-started-team-disposal')
    const setup = harness(root)
    let disposeCalls = 0
    setup.launcher.launch = async request => ({
      sessionId: 'session-host-1', controller: { id: 'controller-host-1', workspace: request.workspace },
      async dispose() {
        disposeCalls += 1
        if (disposeCalls === 1) throw new Error('transient disposal failure')
      },
    })
    const result = await coordinator(setup).start(request(root))

    await expect(result.dispose()).rejects.toThrow('transient disposal failure')
    await expect(result.dispose()).resolves.toBeUndefined()
    await expect(result.dispose()).resolves.toBeUndefined()
    expect(disposeCalls).toBe(2)
  })

  it('keeps controller launch ownership uncertain when manifest advance and disposal both fail', async () => {
    const root = path.resolve('F:\\yuqi-controller-launch-double-failure')
    const setup = harness(root)
    setup.launcher.launch = async () => ({
      sessionId: 'session-host-1', controller: { id: 'controller-host-1' },
      async dispose() { throw new Error('controller still live') },
    })
    const base = recoveryStore()
    const phases: StartTeamRecoveryHandle['phase'][] = []
    const recovery: StartTeamRecoveryStore = {
      ...base,
      async advance(handle, phase, controllerSessionId) {
        phases.push(phase)
        if (phase === 'controller-launched') throw new Error('manifest unavailable')
        return base.advance(handle, phase, controllerSessionId)
      },
    }

    await expect(new StartTeamCoordinator(setup.physical, setup.launcher, setup.bootstrap, setup.durable, ids, recovery)
      .start(request(root))).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(phases).toEqual(['workspace-provisioned', 'controller-launching', 'controller-launched'])
  })

  it('accepts the explicit Host root in options and never trusts caller baseline', async () => {
    const root = path.resolve('F:\\yuqi-managed-options')
    const setup = harness(root)
    const start = coordinator(setup)
    const { managedRoot: _managedRoot, ...withoutDirectRoot } = request(root)
    await start.start({ ...withoutDirectRoot, options: { hostRoot: root } })
    expect(setup.calls).toContain('physical-provision')
    expect((setup.state.bootstrapRequests[0] as { tasks: readonly TeamTaskContract[] }).tasks[0]?.baselineRef).toBe('inspected-commit')
  })

  it('fails closed on inspect failure before any physical side effect', async () => {
    const root = path.resolve('F:\\yuqi-managed-inspect-failure')
    const setup = harness(root)
    setup.state.physicalFailure = new Error('secret project path')
    const start = coordinator(setup)

    const result = start.start(request(root))
    await expect(result).rejects.toMatchObject({ code: 'GIT_PROJECT_UNSUPPORTED' })
    await expect(result).rejects.not.toThrow('secret project path')
    expect(setup.calls).toEqual(['inspect'])
  })

  it('retains the physical worktree when launch fails and does not attempt disposal', async () => {
    const root = path.resolve('F:\\yuqi-managed-launch-failure')
    const setup = harness(root)
    setup.state.launchFailure = new Error('controller launch failed')
    const start = coordinator(setup)

    await expect(start.start(request(root))).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(setup.calls).toEqual(['inspect', 'physical-provision', 'launch'])
    expect(setup.state.disposeCount).toBe(0)
  })

  it('disposes a launched controller when bootstrap fails while retaining the worktree', async () => {
    const root = path.resolve('F:\\yuqi-managed-bootstrap-failure')
    const setup = harness(root)
    setup.state.bootstrapFailure = new Error('journal append failed')
    const start = coordinator(setup)

    await expect(start.start(request(root))).rejects.toMatchObject({
      code: 'CONTROLLER_REQUIRES_RECONCILIATION',
      message: expect.stringContaining('durable Team state is unknown'),
    })
    expect(setup.calls).toEqual(['inspect', 'physical-provision', 'launch', 'bootstrap', 'dispose'])
    expect(setup.state.disposeCount).toBe(1)
  })

  it('disposes after durable confirmation failure and rejects a mismatched workspace', async () => {
    const root = path.resolve('F:\\yuqi-managed-durable-failure')
    const setup = harness(root)
    setup.state.durableFailure = new Error('durable append failed')
    const start = coordinator(setup)

    await expect(start.start(request(root))).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(setup.state.disposeCount).toBe(1)

    const mismatch = harness(root)
    mismatch.durable.provision = async () => ({ ...physicalWorkspace(path.join(root, 'other')), workspaceId: WorkspaceId('workspace-host-1') })
    const mismatched = coordinator(mismatch)
    await expect(mismatched.start(request(root))).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(mismatch.state.disposeCount).toBe(1)
  })
})
