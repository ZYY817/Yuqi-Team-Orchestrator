import { execFile } from 'node:child_process'
import { chmod, lstat, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeGitWorkspacePort, WorkspaceId } from '../src/index.ts'

const run = promisify(execFile)
const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuqi-git-workspace-'))
  temporaryRoots.push(root)
  return root
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
  return result.stdout.trim()
}

async function cleanRepository(): Promise<{ root: string; repository: string; baseline: string }> {
  const root = await temporaryRoot()
  const repository = path.join(root, 'repository')
  await mkdir(repository)
  await git(repository, 'init')
  await git(repository, 'config', 'user.name', 'Yuqi Test')
  await git(repository, 'config', 'user.email', 'yuqi@example.invalid')
  await writeFile(path.join(repository, 'README.md'), '# fixture\n', 'utf8')
  await git(repository, 'add', 'README.md')
  await git(repository, 'commit', '-m', 'initial')
  return { root, repository, baseline: await git(repository, 'rev-parse', 'HEAD') }
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop()!
    await rm(root, { recursive: true, force: true })
  }
})

describe('NodeGitWorkspacePort inspection', () => {
  it('accepts a clean repository whose baseline commit has no tracked files', async () => {
    const root = await temporaryRoot()
    const repository = path.join(root, 'empty-repository')
    await mkdir(repository)
    await git(repository, 'init')
    await git(repository, 'config', 'user.name', 'Yuqi Test')
    await git(repository, 'config', 'user.email', 'yuqi@example.invalid')
    await git(repository, 'commit', '--allow-empty', '-m', 'empty baseline')
    await expect(new NodeGitWorkspacePort().inspect({ projectRoot: repository, protectedRoots: [] }))
      .resolves.toMatchObject({ repositoryRoot: path.resolve(repository) })
  })
  it('captures a clean top-level repository identity without changing it', async () => {
    const fixture = await cleanRepository()
    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [path.parse(fixture.repository).root] })
    expect(identity).toMatchObject({
      projectRoot: path.resolve(fixture.repository),
      repositoryRoot: path.resolve(fixture.repository),
      baselineRef: fixture.baseline,
      volumeRoot: path.parse(fixture.repository).root,
    })
    expect(await git(fixture.repository, 'status', '--porcelain')).toBe('')
  })

  it('accepts a selected project directory inside a repository and still rejects invalid repository states', async () => {
    const root = await temporaryRoot()
    const port = new NodeGitWorkspacePort()
    await expect(port.inspect({ projectRoot: root, protectedRoots: [] })).rejects.toMatchObject({ code: 'GIT_COMMAND_FAILED' })

    const fixture = await cleanRepository()
    const subdirectory = path.join(fixture.repository, 'website')
    await mkdir(subdirectory)
    await writeFile(path.join(subdirectory, 'package.json'), '{}\n', 'utf8')
    await git(fixture.repository, 'add', 'website/package.json')
    await git(fixture.repository, 'commit', '-m', 'add nested project')
    await expect(port.inspect({ projectRoot: subdirectory, protectedRoots: [] })).resolves.toMatchObject({
      projectRoot: path.resolve(subdirectory),
      repositoryRoot: path.resolve(fixture.repository),
    })

    await writeFile(path.join(fixture.repository, 'dirty.txt'), 'dirty', 'utf8')
    await expect(port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })).rejects.toMatchObject({
      code: 'GIT_PROJECT_UNSUPPORTED',
      message: expect.stringContaining('dirty.txt'),
    })
    await rm(path.join(fixture.repository, 'dirty.txt'))

    await git(fixture.repository, 'checkout', '--detach', fixture.baseline)
    await expect(port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })).rejects.toMatchObject({ code: 'GIT_PROJECT_UNSUPPORTED' })
  })

  it('rejects source changes hidden by Git index flags', async () => {
    const fixture = await cleanRepository()
    await git(fixture.repository, 'update-index', '--assume-unchanged', 'README.md')
    await writeFile(path.join(fixture.repository, 'README.md'), '# hidden source change\n', 'utf8')
    expect(await git(fixture.repository, 'status', '--porcelain')).toBe('')
    await expect(new NodeGitWorkspacePort().inspect({ projectRoot: fixture.repository, protectedRoots: [] }))
      .rejects.toMatchObject({
        code: 'GIT_PROJECT_UNSUPPORTED',
        message: 'Git assume-unchanged, skip-worktree, sparse, and nonstandard index flags are not supported in Developer Preview',
      })
  })

  it('rejects missing paths, invalid timeout configuration, and an unavailable Git executable', async () => {
    const root = await temporaryRoot()
    expect(() => new NodeGitWorkspacePort('git', 0)).toThrow(RangeError)
    await expect(new NodeGitWorkspacePort().inspect({ projectRoot: path.join(root, 'missing'), protectedRoots: [] })).rejects.toMatchObject({ code: 'GIT_PROJECT_UNSUPPORTED' })
    await expect(new NodeGitWorkspacePort('definitely-missing-yuqi-git').inspect({ projectRoot: root, protectedRoots: [] })).rejects.toMatchObject({ code: 'GIT_COMMAND_FAILED' })
  })

  it('fails closed when a safety path exists but realpath cannot resolve it', async () => {
    const fixture = await cleanRepository()
    const loop = path.join(fixture.root, 'realpath-loop')
    await symlink(loop, loop, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(new NodeGitWorkspacePort().inspect({ projectRoot: fixture.repository, protectedRoots: [loop] }))
      .rejects.toMatchObject({ code: 'GIT_PROJECT_UNSUPPORTED' })
  })

  it('rejects bare repositories and submodules, and normalizes absent protected roots', async () => {
    const root = await temporaryRoot()
    const bare = path.join(root, 'bare.git')
    await run('git', ['init', '--bare', bare], { encoding: 'utf8', windowsHide: true })
    const port = new NodeGitWorkspacePort()
    await expect(port.inspect({ projectRoot: bare, protectedRoots: [] })).rejects.toMatchObject({ code: 'GIT_PROJECT_UNSUPPORTED' })

    const child = await cleanRepository()
    const parent = await cleanRepository()
    await run('git', ['-c', 'protocol.file.allow=always', '-C', parent.repository, 'submodule', 'add', child.repository, 'vendor/child'], { encoding: 'utf8', windowsHide: true })
    await git(parent.repository, 'commit', '-am', 'add submodule')
    await expect(port.inspect({ projectRoot: path.join(parent.repository, 'vendor', 'child'), protectedRoots: [] })).rejects.toMatchObject({ code: 'GIT_PROJECT_UNSUPPORTED' })
    await expect(port.inspect({ projectRoot: parent.repository, protectedRoots: [] })).rejects.toMatchObject({ code: 'GIT_PROJECT_UNSUPPORTED' })

    const absent = path.join(root, 'absent-protected-root')
    const identity = await port.inspect({ projectRoot: child.repository, protectedRoots: [absent] })
    expect(identity.protectedRoots).toEqual([path.resolve(absent)])
  })
})

describe('NodeGitWorkspacePort provisioning', () => {
  it('interprets dirty scopes relative to a selected nested project', async () => {
    const fixture = await cleanRepository()
    const projectRoot = path.join(fixture.repository, 'website')
    await mkdir(path.join(projectRoot, 'src'), { recursive: true })
    await writeFile(path.join(projectRoot, 'src', 'base.css'), 'body {}\n', 'utf8')
    await git(fixture.repository, 'add', 'website/src/base.css')
    await git(fixture.repository, 'commit', '-m', 'add website')

    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot, protectedRoots: [] })
    const managedRoot = path.join(fixture.root, 'managed-nested')
    const worktreePath = path.join(managedRoot, 'team-nested')
    const workspace = await port.provision({
      identity,
      workspaceId: 'workspace-nested',
      managedRoot,
      worktreePath,
      branchName: 'yuqi/nested-project',
    })

    await writeFile(path.join(worktreePath, 'website', 'src', 'base.css'), 'body { color: red; }\n', 'utf8')
    await expect(port.verify({ workspace, allowedDirtyScopes: ['src/**'] })).resolves.toEqual(workspace)
    await writeFile(path.join(worktreePath, 'outside.txt'), 'outside\n', 'utf8')
    await expect(port.verify({ workspace, allowedDirtyScopes: ['src/**'] }))
      .rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
  })

  it('creates one clean managed worktree and returns it idempotently', async () => {
    const fixture = await cleanRepository()
    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [path.parse(fixture.repository).root] })
    const managedRoot = path.join(fixture.root, 'managed')
    const worktreePath = path.join(managedRoot, 'team-1')
    const request = { identity, workspaceId: 'workspace-1', managedRoot, worktreePath, branchName: 'yuqi/team-1', signal: new AbortController().signal }

    const created = await port.provision(request)
    expect(created).toMatchObject({ workspaceId: 'workspace-1', worktreePath: path.resolve(worktreePath), branchName: 'yuqi/team-1', status: 'ready' })
    expect(await git(worktreePath, 'rev-parse', 'HEAD')).toBe(fixture.baseline)
    expect(await git(worktreePath, 'status', '--porcelain')).toBe('')
    expect(await git(fixture.repository, 'status', '--porcelain')).toBe('')
    await expect(port.provision(request)).resolves.toEqual(created)
    await expect(port.verify({ workspace: created, allowedDirtyScopes: [] })).resolves.toEqual(created)
    await expect(port.verify({ workspace: { ...created, workspaceId: WorkspaceId('workspace-other') }, allowedDirtyScopes: [] }))
      .rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    await expect(port.verify({ workspace: { ...created, status: 'provisioning' }, allowedDirtyScopes: [] }))
      .rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    await git(worktreePath, 'mv', 'README.md', 'RENAMED.md')
    await expect(port.verify({ workspace: created, allowedDirtyScopes: ['README.md', 'RENAMED.md'] })).resolves.toEqual(created)
    await git(worktreePath, 'mv', 'RENAMED.md', 'README.md')
    await expect(port.inspect({ projectRoot: worktreePath, protectedRoots: [] })).resolves.toMatchObject({ gitCommonDirectory: created.project.gitCommonDirectory })

    const detached = path.join(fixture.root, 'detached-worktree')
    await git(fixture.repository, 'worktree', 'add', '--detach', detached, fixture.baseline)
    await expect(port.provision(request)).resolves.toEqual(created)

    await writeFile(path.join(worktreePath, 'dirty.txt'), 'dirty', 'utf8')
    await expect(port.verify({ workspace: created, allowedDirtyScopes: ['dirty.txt'] })).resolves.toEqual(created)
    await expect(port.verify({ workspace: created, allowedDirtyScopes: [] })).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    await expect(port.provision(request)).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    const restartedPort = new NodeGitWorkspacePort()
    await expect(restartedPort.verify({ workspace: created, allowedDirtyScopes: [] }))
      .rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    await rm(path.join(worktreePath, 'dirty.txt'))
    await expect(restartedPort.verify({ workspace: created, allowedDirtyScopes: [] })).resolves.toEqual(created)
  }, 30_000)

  it('fails closed when baseline changes, a branch conflicts, or an existing target is not the requested worktree', async () => {
    const fixture = await cleanRepository()
    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })
    const managedRoot = path.join(fixture.root, 'managed')

    await writeFile(path.join(fixture.repository, 'next.txt'), 'next', 'utf8')
    await git(fixture.repository, 'add', 'next.txt')
    await git(fixture.repository, 'commit', '-m', 'next')
    await expect(port.provision({ identity, workspaceId: 'w', managedRoot, worktreePath: path.join(managedRoot, 'baseline'), branchName: 'yuqi/baseline' })).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })

    const current = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })
    await git(fixture.repository, 'branch', 'yuqi/existing')
    await expect(port.provision({ identity: current, workspaceId: 'w', managedRoot, worktreePath: path.join(managedRoot, 'branch'), branchName: 'yuqi/existing' })).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })

    const occupied = path.join(managedRoot, 'occupied')
    await mkdir(occupied, { recursive: true })
    await expect(port.provision({ identity: current, workspaceId: 'w', managedRoot, worktreePath: occupied, branchName: 'yuqi/occupied' })).rejects.toMatchObject({ code: 'GIT_COMMAND_FAILED' })
  })

  it('rejects unsafe target geometry and invalid branch names before creating a worktree', async () => {
    const fixture = await cleanRepository()
    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [fixture.root] })
    const managedRoot = path.join(fixture.root, 'managed')

    await expect(port.provision({ identity, workspaceId: 'w', managedRoot, worktreePath: path.join(managedRoot, 'nested', 'team'), branchName: 'yuqi/nested' })).rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
    await expect(port.provision({ identity, workspaceId: 'w', managedRoot: fixture.repository, worktreePath: path.join(fixture.repository, 'team'), branchName: 'yuqi/in-repo' })).rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
    await expect(port.provision({ identity, workspaceId: 'w', managedRoot, worktreePath: path.join(managedRoot, 'bad-branch'), branchName: '..' })).rejects.toMatchObject({ code: 'GIT_COMMAND_FAILED' })

    if (process.platform === 'win32') {
      await expect(port.provision({ identity, workspaceId: 'w', managedRoot, worktreePath: path.join(managedRoot, 'bad<name'), branchName: 'yuqi/bad-path' })).rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })

      const controlRoot = path.join(fixture.root, 'managed-control-character')
      await expect(port.provision({ identity, workspaceId: 'w-control', managedRoot: controlRoot, worktreePath: path.join(controlRoot, 'team\u0001bad'), branchName: 'yuqi/bad-control-path' })).rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
      await expect(pathExistsForTest(controlRoot)).resolves.toBe(false)

      const otherVolume = identity.volumeRoot.toLowerCase().startsWith('z:') ? 'Y:\\yuqi-managed' : 'Z:\\yuqi-managed'
      await expect(port.provision({ identity, workspaceId: 'w', managedRoot: otherVolume, worktreePath: path.join(otherVolume, 'team'), branchName: 'yuqi/cross-volume' })).rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
      const uncRoot = '\\\\server\\share\\yuqi-managed'
      await expect(port.provision({ identity, workspaceId: 'w', managedRoot: uncRoot, worktreePath: path.join(uncRoot, 'team'), branchName: 'yuqi/unc' })).rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
    }
  })

  it('rejects a managed-root junction whose real parent differs from the requested target parent', async () => {
    const fixture = await cleanRepository()
    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })
    const actualRoot = path.join(fixture.root, 'actual-managed')
    const linkedRoot = path.join(fixture.root, 'linked-managed')
    await mkdir(actualRoot)
    await symlink(actualRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(port.provision({ identity, workspaceId: 'w', managedRoot: linkedRoot, worktreePath: path.join(linkedRoot, 'team'), branchName: 'yuqi/junction' })).rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
  })

  it('does not create directories through a junction in an existing managed-root ancestor', async () => {
    const fixture = await cleanRepository()
    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })
    const actualParent = path.join(fixture.root, 'protected-actual')
    const linkedParent = path.join(fixture.root, 'linked-parent')
    await mkdir(actualParent)
    await symlink(actualParent, linkedParent, process.platform === 'win32' ? 'junction' : 'dir')
    const managedRoot = path.join(linkedParent, 'new-managed')
    const actualCreated = path.join(actualParent, 'new-managed')

    await expect(port.provision({
      identity,
      workspaceId: 'workspace-parent-junction',
      managedRoot,
      worktreePath: path.join(managedRoot, 'team'),
      branchName: 'yuqi/parent-junction',
    })).rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
    await expect(pathExistsForTest(actualCreated)).resolves.toBe(false)

    const existingActual = path.join(actualParent, 'existing-managed')
    await mkdir(existingActual)
    const existingAlias = path.join(linkedParent, 'existing-managed')
    await expect(port.provision({
      identity,
      workspaceId: 'workspace-existing-parent-junction',
      managedRoot: existingAlias,
      worktreePath: path.join(existingAlias, 'team'),
      branchName: 'yuqi/existing-parent-junction',
    })).rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
    await expect(pathExistsForTest(path.join(existingActual, 'team'))).resolves.toBe(false)
  })

  it('never creates a worktree inside an external Git common metadata directory', async () => {
    const root = await temporaryRoot()
    const repository = path.join(root, 'repository')
    const metadata = path.join(root, 'metadata')
    await mkdir(repository)
    await run('git', ['init', '--separate-git-dir', metadata, repository], { encoding: 'utf8', windowsHide: true })
    await git(repository, 'config', 'user.name', 'Yuqi Test')
    await git(repository, 'config', 'user.email', 'yuqi@example.invalid')
    await writeFile(path.join(repository, 'README.md'), '# separate metadata\n', 'utf8')
    await git(repository, 'add', 'README.md')
    await git(repository, 'commit', '-m', 'initial')

    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: repository, protectedRoots: [] })
    const target = path.join(identity.gitCommonDirectory, 'yuqi-team')
    await expect(port.provision({
      identity,
      workspaceId: 'workspace-metadata',
      managedRoot: identity.gitCommonDirectory,
      worktreePath: target,
      branchName: 'yuqi/metadata',
    })).rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
    await expect(pathExistsForTest(target)).resolves.toBe(false)
  })

  it('never nests a managed worktree inside another registered user worktree', async () => {
    const fixture = await cleanRepository()
    const otherWorktree = path.join(fixture.root, 'other-worktree')
    await git(fixture.repository, 'worktree', 'add', '-b', 'user/other-worktree', otherWorktree, fixture.baseline)
    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })
    const managedRoot = path.join(otherWorktree, 'managed')

    await expect(port.provision({
      identity,
      workspaceId: 'workspace-nested-other',
      managedRoot,
      worktreePath: path.join(managedRoot, 'team'),
      branchName: 'yuqi/nested-other',
    })).rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
    await expect(pathExistsForTest(managedRoot)).resolves.toBe(false)
    expect(await git(otherWorktree, 'status', '--porcelain')).toBe('')
  })

  it('honors an already-aborted signal without creating a worktree', async () => {
    const fixture = await cleanRepository()
    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })
    const controller = new AbortController(); controller.abort(new Error('cancelled'))
    const managedRoot = path.join(fixture.root, 'managed')
    await expect(port.provision({ identity, workspaceId: 'w', managedRoot, worktreePath: path.join(managedRoot, 'cancelled'), branchName: 'yuqi/cancelled', signal: controller.signal })).rejects.toMatchObject({ code: 'GIT_COMMAND_FAILED' })
  })

  it('singleflights concurrent identical requests and reuses a verified worktree while the source is dirty', async () => {
    const fixture = await cleanRepository()
    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })
    const managedRoot = path.join(fixture.root, 'managed')
    const request = {
      identity,
      workspaceId: 'workspace-concurrent',
      managedRoot,
      worktreePath: path.join(managedRoot, 'team'),
      branchName: 'yuqi/concurrent',
    }

    const [first, second] = await Promise.all([port.provision(request), port.provision(request)])
    expect(second).toEqual(first)
    expect((await git(fixture.repository, 'worktree', 'list', '--porcelain')).match(/worktree /g)).toHaveLength(2)

    await writeFile(path.join(fixture.repository, 'user-change.txt'), 'do not touch', 'utf8')
    await expect(port.provision(request)).resolves.toEqual(first)
    expect(await git(fixture.repository, 'status', '--porcelain')).toContain('user-change.txt')

    await expect(port.provision({ ...request, workspaceId: 'workspace-other-owner' }))
      .rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
  })

  it.runIf(process.platform === 'win32')('singleflights Windows case aliases of the same physical request', async () => {
    const fixture = await cleanRepository()
    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })
    const managedRoot = path.join(fixture.root, 'managed-case')
    const request = {
      identity,
      workspaceId: 'workspace-case',
      managedRoot,
      worktreePath: path.join(managedRoot, 'team'),
      branchName: 'yuqi/case-alias',
    }
    const alias = { ...request, managedRoot: managedRoot.toUpperCase(), worktreePath: path.join(managedRoot, 'team').toUpperCase() }
    const [first, second] = await Promise.all([port.provision(request), port.provision(alias)])
    expect(second).toEqual(first)
    expect((await git(fixture.repository, 'worktree', 'list', '--porcelain')).match(/worktree /g)).toHaveLength(2)
  })

  it('serializes the physical target and rejects a concurrent conflicting branch signature', async () => {
    const fixture = await cleanRepository()
    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })
    const managedRoot = path.join(fixture.root, 'managed-signature')
    const base = {
      identity,
      workspaceId: 'workspace-signature',
      managedRoot,
      worktreePath: path.join(managedRoot, 'team'),
    }
    const results = await Promise.allSettled([
      port.provision({ ...base, branchName: 'yuqi/branch-a' }),
      port.provision({ ...base, branchName: 'yuqi/branch-b' }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    expect((await git(fixture.repository, 'branch', '--list', 'yuqi/branch-*')).split(/\r?\n/).filter(Boolean)).toHaveLength(1)
  })

  it('rejects a lookalike clone that is not registered in the source repository', async () => {
    const fixture = await cleanRepository()
    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })
    const managedRoot = path.join(fixture.root, 'managed')
    const target = path.join(managedRoot, 'spoof')
    await mkdir(managedRoot)
    await run('git', ['clone', '--quiet', fixture.repository, target], { encoding: 'utf8', windowsHide: true })
    await git(target, 'branch', '-m', 'yuqi/spoof')

    await expect(port.provision({
      identity,
      workspaceId: 'workspace-spoof',
      managedRoot,
      worktreePath: target,
      branchName: 'yuqi/spoof',
    })).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
  })

  it('revalidates the real target and rejects a junction to a protected registered worktree', async () => {
    const fixture = await cleanRepository()
    const actualRoot = path.join(fixture.root, 'actual')
    const actualTarget = path.join(actualRoot, 'protected-team')
    await mkdir(actualRoot)
    await git(fixture.repository, 'worktree', 'add', '-b', 'yuqi/protected', actualTarget, fixture.baseline)

    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [actualTarget] })
    const managedRoot = path.join(fixture.root, 'managed')
    const linkedTarget = path.join(managedRoot, 'team')
    await mkdir(managedRoot)
    await symlink(actualTarget, linkedTarget, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(port.provision({
      identity,
      workspaceId: 'workspace-protected',
      managedRoot,
      worktreePath: linkedTarget,
      branchName: 'yuqi/protected',
    })).rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
  })

  it('rejects a sibling junction alias instead of assigning one physical worktree to another workspace', async () => {
    const fixture = await cleanRepository()
    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })
    const managedRoot = path.join(fixture.root, 'managed-alias')
    const realTarget = path.join(managedRoot, 'real')
    await port.provision({
      identity,
      workspaceId: 'workspace-real',
      managedRoot,
      worktreePath: realTarget,
      branchName: 'yuqi/real',
    })
    const aliasTarget = path.join(managedRoot, 'alias')
    await symlink(realTarget, aliasTarget, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(port.provision({
      identity,
      workspaceId: 'workspace-alias',
      managedRoot,
      worktreePath: aliasTarget,
      branchName: 'yuqi/real',
    })).rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
  })

  it('disables repository hooks during creation and rejects risky repository-local Git execution config', async () => {
    const fixture = await cleanRepository()
    const hooksDirectory = path.join(fixture.repository, '.git', 'hooks')
    const marker = path.join(fixture.repository, 'hook-ran.txt')
    const hook = path.join(hooksDirectory, 'post-checkout')
    await writeFile(hook, `#!/bin/sh\nprintf unsafe > "${marker.replaceAll('\\', '/')}"\n`, 'utf8')
    await chmod(hook, 0o755)

    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })
    const managedRoot = path.join(fixture.root, 'managed')
    await port.provision({
      identity,
      workspaceId: 'workspace-hooks',
      managedRoot,
      worktreePath: path.join(managedRoot, 'team'),
      branchName: 'yuqi/hooks',
    })
    await expect(pathExistsForTest(marker)).resolves.toBe(false)

    const risky = await cleanRepository()
    await git(risky.repository, 'config', 'filter.yuqi.process', 'unsafe-filter-process --sentinel')
    await expect(port.inspect({ projectRoot: risky.repository, protectedRoots: [] })).rejects.toMatchObject({ code: 'GIT_PROJECT_UNSUPPORTED' })

    const riskyCore = await cleanRepository()
    await git(riskyCore.repository, 'config', 'core.hooksPath', '.unsafe-hooks')
    await expect(port.inspect({ projectRoot: riskyCore.repository, protectedRoots: [] })).rejects.toMatchObject({ code: 'GIT_PROJECT_UNSUPPORTED' })
  }, 10_000)

  it('requires explicit reconciliation after a worktree-add side effect becomes uncertain', async () => {
    const fixture = await cleanRepository()
    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })
    const refBlocker = path.join(fixture.repository, '.git', 'refs', 'heads', 'yuqi')
    await mkdir(path.dirname(refBlocker), { recursive: true })
    await writeFile(refBlocker, `${fixture.baseline}\n`, 'utf8')
    const managedRoot = path.join(fixture.root, 'managed')

    await expect(port.provision({
      identity,
      workspaceId: 'workspace-uncertain',
      managedRoot,
      worktreePath: path.join(managedRoot, 'team'),
      branchName: 'yuqi/blocked',
    })).rejects.toMatchObject({
      code: 'WORKSPACE_REQUIRES_RECONCILIATION',
      message: 'Git worktree creation did not reach a provably complete state',
    })
  })

  it('rejects active tracked-file filters before their external process can execute', async () => {
    const fixture = await cleanRepository()
    await writeFile(path.join(fixture.repository, '.gitattributes'), '*.txt filter=yuqi-postcondition\n', 'utf8')
    await writeFile(path.join(fixture.repository, 'payload.txt'), 'payload\n', 'utf8')
    await git(fixture.repository, 'add', '.gitattributes', 'payload.txt')
    await git(fixture.repository, 'commit', '-m', 'add filtered payload')

    const marker = path.join(fixture.repository, 'filter-mutated-source.txt')
    const globalConfig = path.join(fixture.root, 'isolated-global-config')
    await run('git', ['config', '--file', globalConfig, 'filter.yuqi-postcondition.smudge', `tee ${marker.replaceAll('\\', '/')}`], {
      encoding: 'utf8', windowsHide: true,
    })
    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    try {
      const port = new NodeGitWorkspacePort()
      await expect(port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })).rejects.toMatchObject({
        code: 'GIT_PROJECT_UNSUPPORTED',
        message: 'Tracked files with Git filter attributes are not supported in Developer Preview',
      })
      expect(await pathExistsForTest(marker)).toBe(false)
    } finally {
      if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig
    }
  })

  it('rechecks external-execution gates before inspecting an existing worktree', async () => {
    const fixture = await cleanRepository()
    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })
    const managedRoot = path.join(fixture.root, 'managed')
    const request = {
      identity,
      workspaceId: 'workspace-reuse-filter',
      managedRoot,
      worktreePath: path.join(managedRoot, 'team'),
      branchName: 'yuqi/reuse-filter',
    }
    await port.provision(request)

    const infoDirectory = path.join(identity.gitCommonDirectory, 'info')
    await mkdir(infoDirectory, { recursive: true })
    await writeFile(path.join(infoDirectory, 'attributes'), 'README.md filter=yuqi-reuse\n', 'utf8')
    const marker = path.join(fixture.repository, 'reuse-filter-ran.txt')
    const globalConfig = path.join(fixture.root, 'reuse-global-config')
    await run('git', ['config', '--file', globalConfig, 'filter.yuqi-reuse.clean', `tee ${marker.replaceAll('\\', '/')}`], {
      encoding: 'utf8', windowsHide: true,
    })
    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    try {
      await expect(port.provision(request)).rejects.toMatchObject({
        code: 'GIT_PROJECT_UNSUPPORTED',
        message: 'Tracked files with Git filter attributes are not supported in Developer Preview',
      })
      expect(await pathExistsForTest(marker)).toBe(false)
    } finally {
      if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig
    }
  })

  it('rejects dirty working-tree attributes before status can execute their filter', async () => {
    const fixture = await cleanRepository()
    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })
    const managedRoot = path.join(fixture.root, 'managed-dirty-attributes')
    const request = {
      identity,
      workspaceId: 'workspace-dirty-attributes',
      managedRoot,
      worktreePath: path.join(managedRoot, 'team'),
      branchName: 'yuqi/dirty-attributes',
    }
    await port.provision(request)
    await writeFile(path.join(request.worktreePath, '.gitattributes'), 'README.md filter=yuqi-dirty\n', 'utf8')
    await writeFile(path.join(request.worktreePath, 'README.md'), '# fixture\n', 'utf8')

    const marker = path.join(fixture.repository, 'dirty-filter-ran.txt')
    const globalConfig = path.join(fixture.root, 'dirty-filter-global-config')
    await run('git', ['config', '--file', globalConfig, 'filter.yuqi-dirty.clean', `tee ${marker.replaceAll('\\', '/')}`], {
      encoding: 'utf8', windowsHide: true,
    })
    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    try {
      await expect(port.provision(request)).rejects.toMatchObject({
        code: 'GIT_PROJECT_UNSUPPORTED',
        message: 'Tracked files with Git filter attributes are not supported in Developer Preview',
      })
      expect(await pathExistsForTest(marker)).toBe(false)
    } finally {
      if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig
    }
  }, 15_000)

  it('rejects hidden modifications when reusing an existing managed worktree', async () => {
    const fixture = await cleanRepository()
    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })
    const managedRoot = path.join(fixture.root, 'managed-hidden-change')
    const request = {
      identity,
      workspaceId: 'workspace-hidden-change',
      managedRoot,
      worktreePath: path.join(managedRoot, 'team'),
      branchName: 'yuqi/hidden-change',
    }
    await port.provision(request)
    await git(request.worktreePath, 'update-index', '--assume-unchanged', 'README.md')
    await writeFile(path.join(request.worktreePath, 'README.md'), '# hidden managed change\n', 'utf8')
    expect(await git(request.worktreePath, 'status', '--porcelain')).toBe('')
    await expect(port.provision(request)).rejects.toMatchObject({ code: 'GIT_PROJECT_UNSUPPORTED' })
  }, 15_000)

  it('does not expose raw Git errors or executable details in public failures', async () => {
    const root = await temporaryRoot()
    const secret = 'SENTINEL_DO_NOT_EXPOSE'
    await expect(new NodeGitWorkspacePort(`missing-${secret}`).inspect({ projectRoot: root, protectedRoots: [] }))
      .rejects.toMatchObject({ code: 'GIT_COMMAND_FAILED', message: 'Git inspection failed' })
  })

  it('rejects a NUL-containing target before filesystem or Git mutation', async () => {
    const fixture = await cleanRepository()
    const port = new NodeGitWorkspacePort()
    const identity = await port.inspect({ projectRoot: fixture.repository, protectedRoots: [] })
    const managedRoot = path.join(fixture.root, 'managed')
    await expect(port.provision({
      identity,
      workspaceId: 'workspace-nul',
      managedRoot,
      worktreePath: `${path.join(managedRoot, 'team')}\0suffix`,
      branchName: 'yuqi/nul',
    })).rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
    await expect(pathExistsForTest(managedRoot)).resolves.toBe(false)
  })
})

async function pathExistsForTest(input: string): Promise<boolean> {
  try {
    await lstat(input)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
