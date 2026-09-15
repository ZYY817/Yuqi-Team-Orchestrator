import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DirectWorkspacePort, WorkspacePortRouter } from '../src/host/filesystem/direct-workspace.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('DirectWorkspacePort', () => {
  it('uses an ordinary non-Git directory without creating a worktree', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuqi-direct-'))
    roots.push(root)
    const port = new DirectWorkspacePort()

    const identity = await port.inspect({ projectRoot: root, protectedRoots: [path.join(root, 'not-yet-created')] })
    expect(identity).toMatchObject({ mode: 'direct', projectRoot: path.resolve(root) })
    expect(identity).not.toHaveProperty('gitCommonDirectory')
    expect(identity).not.toHaveProperty('baselineRef')

    const workspace = await port.provision({
      identity,
      workspaceId: 'direct-workspace',
      managedRoot: path.dirname(root),
      worktreePath: root,
      branchName: 'direct',
    })
    expect(workspace).toMatchObject({
      workspaceId: 'direct-workspace',
      worktreePath: path.resolve(root),
      branchName: 'direct',
      status: 'ready',
      project: { mode: 'direct' },
    })
    await expect(port.verify({ workspace, allowedDirtyScopes: [] })).resolves.toEqual(workspace)

    await expect(port.verify({ workspace: { ...workspace, status: 'provisioning' }, allowedDirtyScopes: [] }))
      .rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
  })

  it('rejects redirecting direct mode to a different directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuqi-direct-'))
    const other = await mkdtemp(path.join(os.tmpdir(), 'yuqi-direct-other-'))
    roots.push(root, other)
    const port = new DirectWorkspacePort()
    const identity = await port.inspect({ projectRoot: root, protectedRoots: [] })

    await expect(port.provision({
      identity,
      workspaceId: 'direct-workspace',
      managedRoot: path.dirname(other),
      worktreePath: other,
      branchName: 'direct',
    })).rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
  })

  it('rejects missing and non-directory project roots before building an identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuqi-direct-invalid-'))
    roots.push(root)
    const file = path.join(root, 'file.txt')
    await writeFile(file, 'not a directory', 'utf8')
    const port = new DirectWorkspacePort()

    await expect(port.inspect({ projectRoot: path.join(root, 'missing'), protectedRoots: [] }))
      .rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
    await expect(port.inspect({ projectRoot: file, protectedRoots: [] }))
      .rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
  })

  it('routes direct and non-direct workspace identities to the matching port', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuqi-direct-router-'))
    roots.push(root)
    const direct = new DirectWorkspacePort()
    const git = {
      inspect: async () => ({ mode: 'git' }),
      provision: async (request: { readonly workspaceId: string }) => ({ mode: 'git', workspaceId: request.workspaceId }),
      verify: async () => ({ mode: 'git', verified: true }),
    } as never
    const router = new WorkspacePortRouter(git, direct)
    const identity = await direct.inspect({ projectRoot: root, protectedRoots: [] })
    await expect(router.inspect({ projectRoot: root, protectedRoots: [] })).resolves.toMatchObject({ mode: 'git' })

    const directWorkspace = await router.provision({
      identity, workspaceId: 'router-direct', managedRoot: root, worktreePath: root, branchName: 'direct',
    })
    expect(directWorkspace).toMatchObject({ project: { mode: 'direct' }, status: 'ready' })
    await expect(router.provision({
      identity: { mode: 'git' } as never, workspaceId: 'router-git', managedRoot: root, worktreePath: root, branchName: 'git',
    })).resolves.toEqual({ mode: 'git', workspaceId: 'router-git' })
    await expect(router.verify({ workspace: { project: identity, status: 'ready', worktreePath: root, workspaceId: 'direct' } as never, allowedDirtyScopes: [] }))
      .resolves.toMatchObject({ project: { mode: 'direct' } })
    await expect(router.verify({ workspace: { project: { mode: 'git' }, status: 'ready' } as never, allowedDirtyScopes: [] }))
      .resolves.toEqual({ mode: 'git', verified: true })
    await expect(direct.verify({ workspace: { ...directWorkspace, worktreePath: path.join(root, 'other') }, allowedDirtyScopes: [] }))
      .rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
    await expect(direct.verify({ workspace: { ...directWorkspace, worktreePath: undefined } as never, allowedDirtyScopes: [] }))
      .rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
  })
})
