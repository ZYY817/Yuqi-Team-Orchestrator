/** Durable, host-neutral workspace, lease, and fixed-model values. */

import { z } from 'zod'
import { fileScopePatternSchema } from './file-scope.ts'
import { AttemptId, FileLeaseId, TaskId, WorkspaceId } from './ids.ts'
import { TASK_MODEL_ROLES } from './task-contract.ts'

const nonEmpty = z.string().trim().min(1)
const uniqueNonEmpty = z.array(nonEmpty).superRefine((items, context) => {
  if (new Set(items).size !== items.length) context.addIssue({ code: 'custom', message: 'values must be unique' })
})

/** Git identity captured before a Team worktree side effect. */
const gitProjectIdentitySchema = z.object({
  projectRoot: nonEmpty,
  repositoryRoot: nonEmpty,
  gitCommonDirectory: nonEmpty,
  baselineRef: nonEmpty,
  volumeRoot: nonEmpty,
  protectedRoots: uniqueNonEmpty,
}).strict()

/** Identity for a normal directory. It deliberately contains no Git facts. */
export const directProjectIdentitySchema = z.object({
  mode: z.literal('direct'),
  projectRoot: nonEmpty,
  volumeRoot: nonEmpty,
  protectedRoots: uniqueNonEmpty,
}).strict()

/** Runtime union; the public type remains Git-compatible for legacy callers. */
const projectIdentityUnionSchema = z.union([gitProjectIdentitySchema, directProjectIdentitySchema])
/** Legacy typed view; runtime still accepts the explicit direct discriminator. */
export const projectIdentitySchema = projectIdentityUnionSchema as unknown as z.ZodType<Readonly<z.output<typeof gitProjectIdentitySchema>>>

/** One managed worktree owned by a Team. */
const teamWorkspaceRecordSchema = z.object({
  workspaceId: nonEmpty.transform(WorkspaceId),
  project: projectIdentitySchema,
  worktreePath: nonEmpty,
  branchName: nonEmpty,
  status: z.enum(['provisioning', 'ready', 'needs_reconciliation']),
}).strict()

export const teamWorkspaceSchema = teamWorkspaceRecordSchema as unknown as z.ZodType<Readonly<{
  workspaceId: WorkspaceId
  project: Readonly<z.output<typeof gitProjectIdentitySchema>>
  worktreePath: string
  branchName: string
  status: 'provisioning' | 'ready' | 'needs_reconciliation'
}>>

export function teamWorkspaceStatusSchema(status: 'provisioning' | 'ready' | 'needs_reconciliation') {
  return teamWorkspaceRecordSchema.and(z.object({ status: z.literal(status) }))
}

/** Fixed runtime route selected without storing credentials. */
export const fixedModelRefSchema = z.object({
  subagentProvider: nonEmpty,
  modelProvider: nonEmpty,
  modelId: nonEmpty,
  role: z.enum(TASK_MODEL_ROLES),
}).strict()

/** File ownership granted to one task inside the Team worktree. */
export const fileLeaseSchema = z.object({
  leaseId: nonEmpty.transform(FileLeaseId),
  taskId: nonEmpty.transform(TaskId),
  /** Present on new batch-intent leases; absent on legacy streams that cannot prove attempt ownership. */
  attemptId: nonEmpty.transform(AttemptId).optional(),
  mode: z.enum(['read', 'write']),
  fileScope: z.array(fileScopePatternSchema),
  status: z.enum(['active', 'released']),
}).strict()

export type GitProjectIdentity = Readonly<z.output<typeof gitProjectIdentitySchema>>
export type DirectProjectIdentity = Readonly<z.output<typeof directProjectIdentitySchema>>
export type ProjectIdentity = GitProjectIdentity
export type TeamWorkspace = Readonly<z.output<typeof teamWorkspaceSchema>>
export interface GitResolutionWorkspaceProof {
  readonly mode?: 'git' | undefined
  readonly workspaceId: string
  readonly projectRoot: string
  readonly repositoryRoot: string
  readonly gitCommonDirectory: string
  readonly baselineRef: string
  readonly volumeRoot: string
  readonly protectedRoots: readonly string[]
  readonly worktreePath: string
  readonly branchName: string
}
export interface DirectResolutionWorkspaceProof {
  readonly mode: 'direct'
  readonly workspaceId: string
  readonly projectRoot: string
  readonly volumeRoot: string
  readonly protectedRoots: readonly string[]
  readonly worktreePath: string
  readonly branchName: string
}
export type ResolutionWorkspaceProof = GitResolutionWorkspaceProof | DirectResolutionWorkspaceProof

export function workspaceProofMatches(proof: ResolutionWorkspaceProof, workspace: TeamWorkspace): boolean {
  if (proof.workspaceId !== workspace.workspaceId || proof.projectRoot !== workspace.project.projectRoot
    || proof.volumeRoot !== workspace.project.volumeRoot
    || JSON.stringify(proof.protectedRoots) !== JSON.stringify(workspace.project.protectedRoots)
    || proof.worktreePath !== workspace.worktreePath || proof.branchName !== workspace.branchName) return false
  const project = workspace.project as unknown as ProjectIdentity | DirectProjectIdentity
  if ('mode' in project && project.mode === 'direct') return proof.mode === 'direct'
  const git = project as ProjectIdentity
  return proof.mode !== 'direct' && proof.repositoryRoot === git.repositoryRoot
    && proof.gitCommonDirectory === git.gitCommonDirectory && proof.baselineRef === git.baselineRef
}
export type FixedModelRef = Readonly<z.output<typeof fixedModelRefSchema>>
export type FileLease = Readonly<z.output<typeof fileLeaseSchema>>
