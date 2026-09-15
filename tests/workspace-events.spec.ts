import { describe, expect, it } from 'vitest'
import { FileLeaseId, replayTeamEvents, TaskId, WorkspaceId } from '../src/index.ts'
import type { TeamEvent } from '../src/index.ts'
import { contract, event } from './fixtures.ts'

const WRITE_TASK = TaskId('workspace-write')
const READ_TASK = TaskId('workspace-read')
const WORKSPACE_ID = WorkspaceId('workspace-1')
const project = {
  projectRoot: 'F:\\project', repositoryRoot: 'F:\\project', gitCommonDirectory: 'F:\\project\\.git',
  baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: ['F:\\', 'C:\\Users\\user'],
}
const workspace = {
  workspaceId: WORKSPACE_ID, project, worktreePath: 'F:\\yuqi\\team-1', branchName: 'yuqi/team-1', status: 'provisioning' as const,
}
const writeLease = {
  leaseId: FileLeaseId('lease-write'), taskId: WRITE_TASK, mode: 'write' as const, fileScope: ['src/**'], status: 'active' as const,
}
const readLease = {
  leaseId: FileLeaseId('lease-read'), taskId: READ_TASK, mode: 'read' as const, fileScope: ['docs/**'], status: 'active' as const,
}

function base(): readonly TeamEvent[] {
  return [
    event(1000, { type: 'yuqi/team-created', title: 'Workspace', objective: 'Isolate writes' }),
    event(1001, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
    event(1002, { type: 'yuqi/task-created', contract: { ...contract(WRITE_TASK), fileScope: ['src/**'] } }),
    event(1003, { type: 'yuqi/task-created', contract: { ...contract(READ_TASK), authorityMode: 'read-only', fileScope: ['docs/**'] } }),
  ]
}

function ready(): readonly TeamEvent[] {
  return [
    ...base(),
    event(1004, { type: 'yuqi/workspace-provisioning-started', workspace }),
    event(1005, { type: 'yuqi/workspace-provisioned', workspaceId: WORKSPACE_ID }),
  ]
}

describe('workspace and file-lease replay', () => {
  it('rebuilds one ready workspace and lease acquisition/release order', () => {
    const projection = replayTeamEvents([
      ...ready(),
      event(1006, { type: 'yuqi/file-lease-acquired', lease: writeLease }),
      event(1007, { type: 'yuqi/file-lease-acquired', lease: readLease }),
      event(1008, { type: 'yuqi/file-lease-released', leaseId: writeLease.leaseId, taskId: WRITE_TASK, reason: 'settled' }),
    ])
    expect(projection.workspace).toMatchObject({ workspaceId: WORKSPACE_ID, status: 'ready', project: { baselineRef: 'commit-1' } })
    expect(projection.fileLeaseIds).toEqual([writeLease.leaseId, readLease.leaseId])
    expect(projection.fileLeases[writeLease.leaseId]?.status).toBe('released')
    expect(projection.fileLeases[readLease.leaseId]?.status).toBe('active')
  })

  it('moves provisioning or ready workspaces to reconciliation exactly once', () => {
    expect(replayTeamEvents([...base(), event(1010, { type: 'yuqi/workspace-provisioning-started', workspace }), event(1011, { type: 'yuqi/workspace-reconciliation-required', workspaceId: WORKSPACE_ID, reason: 'git uncertain' })]).workspace?.status).toBe('needs_reconciliation')
    expect(replayTeamEvents([...ready(), event(1012, { type: 'yuqi/workspace-reconciliation-required', workspaceId: WORKSPACE_ID, reason: 'missing path' })]).workspace?.status).toBe('needs_reconciliation')
  })

  it.each([
    [[...base(), event(1020, { type: 'yuqi/workspace-provisioned', workspaceId: WORKSPACE_ID })], 'ENTITY_NOT_FOUND'],
    [[...base(), event(1021, { type: 'yuqi/workspace-provisioning-started', workspace }), event(1022, { type: 'yuqi/workspace-provisioned', workspaceId: WorkspaceId('other') })], 'REFERENCE_MISMATCH'],
    [[...ready(), event(1023, { type: 'yuqi/workspace-provisioning-started', workspace: { ...workspace, workspaceId: WorkspaceId('second') } })], 'ENTITY_ALREADY_EXISTS'],
    [[...ready(), event(1024, { type: 'yuqi/workspace-provisioned', workspaceId: WORKSPACE_ID })], 'INVALID_TRANSITION'],
    [[...ready(), event(1025, { type: 'yuqi/workspace-reconciliation-required', workspaceId: WORKSPACE_ID, reason: 'first' }), event(1026, { type: 'yuqi/workspace-reconciliation-required', workspaceId: WORKSPACE_ID, reason: 'again' })], 'INVALID_TRANSITION'],
  ] as const)('rejects invalid workspace histories', (events, code) => {
    expect(() => replayTeamEvents(events)).toThrow(expect.objectContaining({ code }))
  })

  it.each([
    [[...base(), event(1030, { type: 'yuqi/file-lease-acquired', lease: writeLease })], 'INVALID_TRANSITION'],
    [[...ready(), event(1031, { type: 'yuqi/file-lease-acquired', lease: { ...writeLease, taskId: TaskId('missing') } })], 'ENTITY_NOT_FOUND'],
    [[...ready(), event(1032, { type: 'yuqi/file-lease-acquired', lease: { ...writeLease, mode: 'read' } })], 'REFERENCE_MISMATCH'],
    [[...ready(), event(1033, { type: 'yuqi/file-lease-acquired', lease: { ...writeLease, fileScope: ['other/**'] } })], 'REFERENCE_MISMATCH'],
    [[...ready(), event(1034, { type: 'yuqi/file-lease-acquired', lease: writeLease }), event(1035, { type: 'yuqi/file-lease-acquired', lease: writeLease })], 'ENTITY_ALREADY_EXISTS'],
    [[...ready(), event(1036, { type: 'yuqi/file-lease-acquired', lease: writeLease }), event(1037, { type: 'yuqi/file-lease-acquired', lease: { ...readLease, fileScope: ['src/**'] } })], 'REFERENCE_MISMATCH'],
    [[...ready(), event(1038, { type: 'yuqi/file-lease-released', leaseId: FileLeaseId('missing'), taskId: WRITE_TASK })], 'ENTITY_NOT_FOUND'],
    [[...ready(), event(1039, { type: 'yuqi/file-lease-acquired', lease: writeLease }), event(1040, { type: 'yuqi/file-lease-released', leaseId: writeLease.leaseId, taskId: READ_TASK })], 'REFERENCE_MISMATCH'],
    [[...ready(), event(1041, { type: 'yuqi/file-lease-acquired', lease: writeLease }), event(1042, { type: 'yuqi/file-lease-released', leaseId: writeLease.leaseId, taskId: WRITE_TASK }), event(1043, { type: 'yuqi/file-lease-released', leaseId: writeLease.leaseId, taskId: WRITE_TASK })], 'INVALID_TRANSITION'],
  ] as const)('rejects invalid lease histories', (events, code) => {
    expect(() => replayTeamEvents(events)).toThrow(expect.objectContaining({ code }))
  })

  it('rejects a real overlapping writer/reader after both leases match their task contracts', () => {
    const overlappingRead = { ...readLease, fileScope: ['src/**'] }
    const events = [
      ...base().slice(0, 3),
      event(1050, { type: 'yuqi/task-created', contract: { ...contract(READ_TASK), authorityMode: 'read-only', fileScope: ['src/**'] } }),
      event(1051, { type: 'yuqi/workspace-provisioning-started', workspace }),
      event(1052, { type: 'yuqi/workspace-provisioned', workspaceId: WORKSPACE_ID }),
      event(1053, { type: 'yuqi/file-lease-acquired', lease: writeLease }),
      event(1054, { type: 'yuqi/file-lease-acquired', lease: overlappingRead }),
    ]
    expect(() => replayTeamEvents(events)).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }))
  })
})

