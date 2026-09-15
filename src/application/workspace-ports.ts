/** Host-neutral boundaries for Git workspace provisioning and public model catalogs. */

import type { ProjectIdentity, TeamWorkspace } from '../domain/workspace.ts'

export interface InspectGitProjectRequest {
  readonly projectRoot: string
  readonly protectedRoots: readonly string[]
  readonly signal?: AbortSignal
}

export interface ProvisionTeamWorkspaceRequest {
  readonly identity: ProjectIdentity
  readonly workspaceId: string
  readonly managedRoot: string
  readonly worktreePath: string
  readonly branchName: string
  readonly signal?: AbortSignal
}

export interface VerifyTeamWorkspaceRequest {
  readonly workspace: TeamWorkspace
  readonly allowedDirtyScopes: readonly string[]
  readonly signal?: AbortSignal
}

/** Narrow Git boundary; application code never constructs shell commands. */
export interface GitWorkspacePort {
  inspect(request: InspectGitProjectRequest): Promise<ProjectIdentity>
  provision(request: ProvisionTeamWorkspaceRequest): Promise<TeamWorkspace>
  verify(request: VerifyTeamWorkspaceRequest): Promise<TeamWorkspace>
}

export interface ModelCatalogEntry {
  readonly modelProvider: string
  readonly modelId: string
  readonly available: boolean
  readonly displayName?: string
}

/** Public, non-secret model inventory exposed by the host. */
export interface ModelCatalogPort {
  listModels(modelProvider: string, signal?: AbortSignal): Promise<readonly ModelCatalogEntry[]>
  resolveModel(modelProvider: string, modelId: string, signal?: AbortSignal): Promise<ModelCatalogEntry>
}
