import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { TaskId } from '../src/domain/ids.ts'
import type { TeamTaskContract } from '../src/domain/task-contract.ts'
import { teamWorkspaceSchema } from '../src/domain/workspace.ts'
import { NodeGitWorkspacePort } from '../src/host/git/git-workspace.ts'
import {
  FilesystemStartTeamRecoveryStore,
  StartTeamCoordinator,
  type StartTeamIdentityPort,
} from '../src/host/harness/start-team.ts'
import type { ProjectIdentity } from '../src/domain/workspace.ts'

const execFileAsync = promisify(execFile)
const task: TeamTaskContract = {
  taskId: TaskId('task-1'), revision: 1, goal: 'test recovery', scope: ['src'], nonGoals: ['deploy'],
  dependencies: [], fileScope: ['src/**'], modelRole: 'worker', modelId: 'deepseek-v4',
  acceptanceCriteria: ['recovery proven'], authorityMode: 'write-authorized', inputDigest: 'digest', baselineRef: 'pending',
}
const ids: StartTeamIdentityPort = {
  nextTeamId: () => 'team-recovery-1',
  nextWorkspaceId: () => 'workspace-recovery-1',
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })).stdout
}

async function repositoryFixture(prefix: string): Promise<{
  readonly root: string
  readonly projectRoot: string
  readonly managedRoot: string
  readonly identity: ProjectIdentity
}> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  const projectRoot = path.join(root, 'project')
  const managedRoot = path.join(root, 'managed')
  await mkdir(projectRoot)
  await execFileAsync('git', ['init', projectRoot], { windowsHide: true })
  await git(projectRoot, 'config', 'user.email', 'yuqi@example.invalid')
  await git(projectRoot, 'config', 'user.name', 'Yuqi Test')
  await writeFile(path.join(projectRoot, 'README.md'), 'fixture\n', 'utf8')
  await git(projectRoot, 'add', 'README.md')
  await git(projectRoot, 'commit', '-m', 'fixture')
  const identity = await new NodeGitWorkspacePort().inspect({ projectRoot, protectedRoots: [] })
  return { root, projectRoot, managedRoot, identity }
}

function recoveryPlan(fixture: Awaited<ReturnType<typeof repositoryFixture>>, suffix: string) {
  return {
    teamId: `team-${suffix}`,
    workspaceId: `workspace-${suffix}`,
    identity: fixture.identity,
    managedRoot: fixture.managedRoot,
    worktreePath: path.join(fixture.managedRoot, `workspace-${suffix}`),
    branchName: `yuqi/team-${suffix}`,
  }
}

describe('start recovery owner manifest', () => {
  it('rejects a linked custom parent before writing recovery metadata through it', async () => {
    const fixture = await repositoryFixture('yuqi-recovery-custom-link-')
    const actual = path.join(fixture.root, 'actual')
    try {
      await mkdir(actual)
      await symlink(actual, fixture.managedRoot, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(new FilesystemStartTeamRecoveryStore().create(recoveryPlan(fixture, 'linked')))
        .rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
      expect(await readdir(actual)).toEqual([])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
  it('handles absent residue, terminal manifests, corrupt files, and non-eligible cleanup fail-closed', async () => {
    const fixture = await repositoryFixture('yuqi-recovery-empty-')
    const store = new FilesystemStartTeamRecoveryStore()
    try {
      expect(await store.list(path.join(fixture.root, 'missing'))).toEqual([])
      const handle = await store.create(recoveryPlan(fixture, 'empty'))
      await mkdir(path.join(fixture.managedRoot, '.yuqi-start-recovery'), { recursive: true })
      await writeFile(path.join(fixture.managedRoot, '.yuqi-start-recovery', 'ignored.tmp'), 'ignored', 'utf8')
      await writeFile(path.join(fixture.managedRoot, '.yuqi-start-recovery', 'corrupt.json'), '{', 'utf8')
      expect(await store.list(fixture.managedRoot)).toEqual([handle])
      await expect(store.reconcile(handle)).resolves.toEqual({ status: 'cleanup-ready', handle, residue: 'none' })
      const cleaned = await store.cleanup(handle)
      expect(cleaned.phase).toBe('cleaned')
      await expect(store.reconcile(cleaned)).resolves.toEqual({
        status: 'manual', handle: cleaned, reason: 'Recovery phase cleaned is not cleanup-eligible',
      })
      await expect(store.cleanup(cleaned)).rejects.toThrow('not cleanup-eligible')

      const completed = await store.create(recoveryPlan(fixture, 'completed'))
      const provisioned = await store.advance(completed, 'workspace-provisioned')
      const launching = await store.advance(provisioned, 'controller-launching')
      const launched = await store.advance(launching, 'controller-launched', 'controller-completed')
      const bootstrapped = await store.advance(launched, 'team-bootstrapped', 'controller-completed')
      const confirming = await store.advance(bootstrapped, 'durable-confirming', 'controller-completed')
      await store.advance(confirming, 'completed', 'controller-completed')
      expect(await store.list(fixture.managedRoot)).toEqual([])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('cleans a proven branch-only residue and rejects forged or unsafe ownership', async () => {
    const fixture = await repositoryFixture('yuqi-recovery-branch-')
    const store = new FilesystemStartTeamRecoveryStore()
    const plan = recoveryPlan(fixture, 'branch')
    try {
      const handle = await store.create(plan)
      const physical = new NodeGitWorkspacePort()
      await physical.provision({
        identity: fixture.identity, workspaceId: plan.workspaceId, managedRoot: plan.managedRoot,
        worktreePath: plan.worktreePath, branchName: plan.branchName,
      })
      await git(fixture.projectRoot, 'worktree', 'remove', plan.worktreePath)
      await expect(store.reconcile(handle)).resolves.toEqual({ status: 'cleanup-ready', handle, residue: 'branch' })
      await expect(store.cleanup(handle)).resolves.toMatchObject({ phase: 'cleaned' })

      await expect(store.reconcile({ ...handle, ownerProof: '00000000-0000-4000-8000-000000000099' }))
        .rejects.toThrow('owner proof')
      await expect(store.create({
        ...recoveryPlan(fixture, 'unsafe'),
        managedRoot: fixture.projectRoot,
        worktreePath: path.join(fixture.projectRoot, 'unsafe-worktree'),
      })).rejects.toThrow('outside the proven managed workspace boundary')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('enumerates cold manifests without turning their self-declared proof into cleanup authority', async () => {
    const fixture = await repositoryFixture('yuqi-recovery-cold-proof-')
    const writer = new FilesystemStartTeamRecoveryStore()
    try {
      const handle = await writer.create(recoveryPlan(fixture, 'cold-proof'))
      const coldHost = new FilesystemStartTeamRecoveryStore()
      const listed = await coldHost.list(fixture.managedRoot)
      expect(listed).toEqual([handle])
      await expect(coldHost.reconcile(listed[0]!)).rejects.toThrow('not trusted by this Host process')
      await expect(coldHost.cleanup(listed[0]!)).rejects.toThrow('not trusted by this Host process')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('binds every cleanup-authorizing manifest field to the live Host trust snapshot', async () => {
    const fixture = await repositoryFixture('yuqi-recovery-hot-tamper-')
    const store = new FilesystemStartTeamRecoveryStore()
    try {
      const planned = await store.create(recoveryPlan(fixture, 'hot-tamper'))
      const provisioned = await store.advance(planned, 'workspace-provisioned')
      const launching = await store.advance(provisioned, 'controller-launching')
      const target = path.join(fixture.managedRoot, '.yuqi-start-recovery', `${launching.recoveryId}.json`)
      const mutations = [
        { phase: 'workspace-provisioned' },
        { teamId: 'team-forged' },
        { workspaceId: 'workspace-forged' },
        { projectRoot: path.join(fixture.root, 'forged-project') },
        { repositoryRoot: path.join(fixture.root, 'forged-repository') },
        { gitCommonDirectory: path.join(fixture.root, 'forged-git') },
        { baselineRef: 'forged-baseline' },
        { managedRoot: path.join(fixture.root, 'forged-managed') },
        { worktreePath: path.join(fixture.managedRoot, 'forged-worktree') },
        { branchName: 'yuqi/forged-branch' },
        { controllerSessionId: 'controller-forged' },
        { updatedAt: '2026-08-22T00:00:00.000Z' },
      ] as const
      for (const mutation of mutations) {
        await writeFile(target, `${JSON.stringify({ ...launching, ...mutation })}\n`, 'utf8')
        await expect(store.reconcile(launching)).rejects.toThrow('does not match the stored manifest')
        await writeFile(target, `${JSON.stringify(launching)}\n`, 'utf8')
      }
      await expect(store.advance(launching, 'completed', 'controller-forged')).rejects.toThrow('cannot transition')
      await expect(store.reconcile(launching)).resolves.toMatchObject({
        status: 'manual', reason: 'Recovery phase controller-launching is not cleanup-eligible',
      })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('refuses unregistered, dirty, or moved owner facts without deleting them', async () => {
    const fixture = await repositoryFixture('yuqi-recovery-mutated-')
    const store = new FilesystemStartTeamRecoveryStore()
    try {
      const unregisteredPlan = recoveryPlan(fixture, 'unregistered')
      const unregistered = await store.create(unregisteredPlan)
      await mkdir(unregisteredPlan.worktreePath)
      await expect(store.reconcile(unregistered)).resolves.toMatchObject({ status: 'manual', reason: expect.stringContaining('without the exact Git worktree registration') })

      const dirtyPlan = recoveryPlan(fixture, 'dirty')
      const dirty = await store.create(dirtyPlan)
      await new NodeGitWorkspacePort().provision({
        identity: fixture.identity, workspaceId: dirtyPlan.workspaceId, managedRoot: dirtyPlan.managedRoot,
        worktreePath: dirtyPlan.worktreePath, branchName: dirtyPlan.branchName,
      })
      await writeFile(path.join(dirtyPlan.worktreePath, 'untracked.txt'), 'retain me', 'utf8')
      await expect(store.reconcile(dirty)).resolves.toMatchObject({ status: 'manual', reason: expect.stringContaining('contains changes') })
      await rm(path.join(dirtyPlan.worktreePath, 'untracked.txt'))
      await writeFile(path.join(dirtyPlan.worktreePath, 'README.md'), 'changed\n', 'utf8')
      await git(dirtyPlan.worktreePath, 'add', 'README.md')
      await git(dirtyPlan.worktreePath, 'commit', '-m', 'move owner branch')
      await expect(store.reconcile(dirty)).resolves.toMatchObject({ status: 'manual', reason: expect.stringContaining('no longer points') })
      expect(await git(dirtyPlan.worktreePath, 'rev-parse', 'HEAD')).not.toBe(`${fixture.identity.baselineRef}\n`)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it.each([
    ['launcher', 'controller-launching'],
    ['bootstrap', 'bootstrap-failed'],
    ['confirmation', 'confirmation-failed'],
  ] as const)('enumerates and exactly cleans a %s failure residue', async (failure, expectedPhase) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-start-recovery-'))
    const projectRoot = path.join(root, 'project')
    const managedRoot = path.join(root, 'managed')
    const store = new FilesystemStartTeamRecoveryStore()
    const dispose = vi.fn(async () => undefined)
    try {
      await mkdir(projectRoot)
      await execFileAsync('git', ['init', projectRoot], { windowsHide: true })
      await git(projectRoot, 'config', 'user.email', 'yuqi@example.invalid')
      await git(projectRoot, 'config', 'user.name', 'Yuqi Test')
      await writeFile(path.join(projectRoot, 'README.md'), 'fixture\n', 'utf8')
      await git(projectRoot, 'add', 'README.md')
      await git(projectRoot, 'commit', '-m', 'fixture')

      const physical = new NodeGitWorkspacePort()
      const coordinator = new StartTeamCoordinator(
        physical,
        { async launch(request) {
          if (failure === 'launcher') throw new Error('launcher unavailable')
          return { sessionId: 'controller-recovery-1', controller: { workspace: request.workspace }, dispose }
        } },
        { async bootstrap() {
          if (failure === 'bootstrap') throw new Error('bootstrap unavailable')
          return { status: 'running' }
        } },
        { async provision(request) {
          if (failure === 'confirmation') throw new Error('confirmation unavailable')
          return teamWorkspaceSchema.parse({
            workspaceId: request.workspaceId, project: request.identity, worktreePath: request.worktreePath,
            branchName: request.branchName, status: 'ready',
          })
        } },
        ids,
        store,
      )

      const result = coordinator.start({
        title: 'Recovery Team', objective: 'prove exact cleanup', tasks: [task], projectCwd: projectRoot,
        workspaceMode: 'git-worktree', managedRoot, controllerModel: { model: 'deepseek-v4' },
      })
      await expect(result).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
      await expect(result).rejects.toThrow('recovery handle team-recovery-1')

      const handles = await store.list(managedRoot)
      expect(handles).toHaveLength(1)
      const handle = handles[0]!
      expect(handle).toEqual({
        schemaVersion: 1,
        recoveryId: 'team-recovery-1',
        ownerProof: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        phase: expectedPhase,
        teamId: 'team-recovery-1',
        workspaceId: 'workspace-recovery-1',
        projectRoot: path.resolve(projectRoot),
        repositoryRoot: path.resolve(projectRoot),
        gitCommonDirectory: path.resolve(projectRoot, '.git'),
        baselineRef: await git(projectRoot, 'rev-parse', 'HEAD').then(value => value.trim()),
        managedRoot: path.resolve(managedRoot),
        worktreePath: path.resolve(managedRoot, 'workspace-recovery-1'),
        branchName: 'yuqi/team-recovery-1',
        ...(failure === 'launcher' ? {} : { controllerSessionId: 'controller-recovery-1' }),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      })
      if (failure === 'launcher') {
        await expect(store.reconcile(handle)).resolves.toMatchObject({ status: 'manual', reason: expect.stringContaining('not cleanup-eligible') })
        await expect(store.cleanup(handle)).rejects.toThrow('not cleanup-eligible')
        expect((await git(projectRoot, 'worktree', 'list', '--porcelain')).replaceAll('\\', '/'))
          .toContain(path.resolve(managedRoot, 'workspace-recovery-1').replaceAll('\\', '/'))
      } else {
        await expect(store.reconcile(handle)).resolves.toEqual({
          status: 'cleanup-ready', handle, residue: 'worktree-and-branch',
        })
        await expect(store.cleanup(handle)).resolves.toMatchObject({ phase: 'cleaned' })
        expect(await store.list(managedRoot)).toEqual([])
        expect(await git(projectRoot, 'worktree', 'list', '--porcelain')).not.toContain(path.resolve(managedRoot, 'workspace-recovery-1'))
        await expect(execFileAsync('git', ['-C', projectRoot, 'show-ref', '--verify', '--quiet', 'refs/heads/yuqi/team-recovery-1']))
          .rejects.toMatchObject({ code: 1 })
      }
      expect(dispose).toHaveBeenCalledTimes(failure === 'launcher' ? 0 : 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
