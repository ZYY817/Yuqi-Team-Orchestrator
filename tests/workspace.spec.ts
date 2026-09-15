import { describe, expect, it } from 'vitest'
import {
  acquireFileLease,
  FileLeaseId,
  fileLeaseSchema,
  fixedModelRefSchema,
  leasesConflict,
  projectIdentitySchema,
  resolveFixedModel,
  resolveFixedModelFromPort,
  teamWorkspaceSchema,
  TaskId,
} from '../src/index.ts'
import type { FileLease, FixedModelRef, ModelCatalogEntry, ModelCatalogPort } from '../src/index.ts'

const project = {
  projectRoot: 'F:\\project',
  repositoryRoot: 'F:\\project',
  gitCommonDirectory: 'F:\\project\\.git',
  baselineRef: '0123456789abcdef',
  volumeRoot: 'F:\\',
  protectedRoots: ['F:\\', 'C:\\Users\\user'],
}

const model = (modelId: string, role: FixedModelRef['role'] = 'worker'): FixedModelRef => ({
  subagentProvider: 'default', modelProvider: 'deepseek', modelId, role,
})

const catalog: readonly ModelCatalogEntry[] = [
  { modelProvider: 'deepseek', modelId: 'task-model', available: true },
  { modelProvider: 'deepseek', modelId: 'role-model', available: true },
  { modelProvider: 'deepseek', modelId: 'team-model', available: true },
  { modelProvider: 'deepseek', modelId: 'default-model', available: true },
  { modelProvider: 'deepseek', modelId: 'offline-model', available: false },
]

function lease(overrides: Partial<FileLease> = {}): FileLease {
  return fileLeaseSchema.parse({
    leaseId: 'lease-1', taskId: 'task-1', mode: 'write', fileScope: ['src/**'], status: 'active', ...overrides,
  })
}

describe('C3 workspace values', () => {
  it('parses one project identity, Team workspace, fixed model, and file lease', () => {
    expect(projectIdentitySchema.parse(project)).toEqual(project)
    expect(teamWorkspaceSchema.parse({ workspaceId: 'workspace-1', project, worktreePath: 'F:\\yuqi\\team-1', branchName: 'yuqi/team-1', status: 'ready' })).toMatchObject({ status: 'ready' })
    expect(fixedModelRefSchema.parse(model('task-model'))).toEqual(model('task-model'))
    expect(lease()).toMatchObject({ taskId: 'task-1', mode: 'write', status: 'active' })
  })

  it('rejects duplicate protected roots and unsupported fields', () => {
    expect(projectIdentitySchema.safeParse({ ...project, protectedRoots: ['F:\\', 'F:\\'] }).success).toBe(false)
    expect(teamWorkspaceSchema.safeParse({ workspaceId: 'w', project, worktreePath: 'x', branchName: 'b', status: 'ready', secret: 'no' }).success).toBe(false)
  })
})

describe('file ownership', () => {
  it('admits disjoint writers and overlapping readers without mutating inputs', () => {
    const active = [lease()]
    const disjoint = acquireFileLease({ leaseId: 'lease-2', taskId: 'task-2', mode: 'write', fileScope: ['tests/**'] }, active)
    expect(disjoint).toMatchObject({ leaseId: 'lease-2', status: 'active' })
    expect(active).toHaveLength(1)

    const reader = lease({ leaseId: FileLeaseId('read-1'), mode: 'read' })
    expect(acquireFileLease({ leaseId: 'read-2', taskId: 'task-2', mode: 'read', fileScope: ['src/**'] }, [reader])).toMatchObject({ mode: 'read' })
  })

  it('rejects duplicate ids and overlapping ownership involving a writer', () => {
    expect(() => acquireFileLease({ leaseId: 'lease-1', taskId: 'task-2', mode: 'read', fileScope: ['docs/**'] }, [lease()])).toThrow(/already exists/u)
    expect(() => acquireFileLease({ leaseId: 'lease-2', taskId: 'task-2', mode: 'read', fileScope: ['src/file.ts'] }, [lease()])).toThrow(/conflicts/u)
  })

  it('serializes disjoint writer leases only under strict-writer-serial', () => {
    const active = [lease({ leaseId: FileLeaseId('strict-active'), taskId: TaskId('strict-a'), fileScope: ['src/a/**'] })]
    expect(() => acquireFileLease({
      leaseId: 'strict-next', taskId: 'strict-b', mode: 'write', fileScope: ['src/b/**'],
      directWriteStrategy: 'strict-writer-serial',
    }, active)).toThrow(/conflicts/u)
    expect(acquireFileLease({
      leaseId: 'planned-next', taskId: 'planned-b', mode: 'write', fileScope: ['src/b/**'],
      directWriteStrategy: 'planned-scope-parallel',
    }, active)).toMatchObject({ leaseId: 'planned-next', mode: 'write' })
  })

  it('ignores released leases on either side', () => {
    const active = lease()
    const released = lease({ leaseId: FileLeaseId('released'), status: 'released' })
    expect(leasesConflict(released, active)).toBe(false)
    expect(leasesConflict(active, released)).toBe(false)
  })
})

describe('fixed model selection', () => {
  it.each([
    [{ task: model('task-model'), roles: { worker: model('role-model') }, team: model('team-model'), harnessDefault: model('default-model') }, 'task-model'],
    [{ roles: { worker: model('role-model') }, team: model('team-model'), harnessDefault: model('default-model') }, 'role-model'],
    [{ team: model('team-model'), harnessDefault: model('default-model') }, 'team-model'],
    [{ harnessDefault: model('default-model') }, 'default-model'],
  ] as const)('uses deterministic configuration precedence', (policy, expected) => {
    expect(resolveFixedModel('worker', policy, catalog).modelId).toBe(expected)
  })

  it('rejects a role mismatch and an unavailable exact provider/model pair', () => {
    expect(() => resolveFixedModel('worker', { task: model('task-model', 'verifier'), harnessDefault: model('default-model') }, catalog)).toThrow(/does not match/u)
    expect(() => resolveFixedModel('worker', { task: model('offline-model'), harnessDefault: model('default-model') }, catalog)).toThrow(/unavailable/u)
    expect(() => resolveFixedModel('worker', { task: { ...model('task-model'), modelProvider: 'other' }, harnessDefault: model('default-model') }, catalog)).toThrow(/unavailable/u)
  })

  it('accepts one exact host-resolved route and wraps resolver failures', async () => {
    const exact: ModelCatalogPort = {
      async listModels() { return [] },
      async resolveModel(modelProvider, modelId) { return { modelProvider, modelId, available: true } },
    }
    const policy = { task: model('task-model'), harnessDefault: model('default-model') }
    await expect(resolveFixedModelFromPort('worker', policy, exact)).resolves.toMatchObject({ modelId: 'task-model' })

    const failing: ModelCatalogPort = {
      async listModels() { return [] },
      async resolveModel() { throw new Error('provider offline') },
    }
    await expect(resolveFixedModelFromPort('worker', policy, failing)).rejects.toMatchObject({ code: 'FIXED_MODEL_UNAVAILABLE' })
  })

  it.each([
    [{ modelProvider: 'deepseek', modelId: 'task-model', available: false }],
    [{ modelProvider: 'other', modelId: 'task-model', available: true }],
    [{ modelProvider: 'deepseek', modelId: 'other', available: true }],
  ] as const)('rejects a different or unavailable host route', async resolved => {
    const port: ModelCatalogPort = {
      async listModels() { return [] },
      async resolveModel() { return resolved },
    }
    await expect(resolveFixedModelFromPort('worker', { task: model('task-model'), harnessDefault: model('default-model') }, port)).rejects.toMatchObject({ code: 'FIXED_MODEL_UNAVAILABLE' })
  })
})
