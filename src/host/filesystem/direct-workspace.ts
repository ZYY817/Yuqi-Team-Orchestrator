/** Direct workspace adapter for projects that do not opt into Git isolation. */

import { access, stat, realpath } from 'node:fs/promises'
import path from 'node:path'
import type {
  GitWorkspacePort,
  InspectGitProjectRequest,
  ProvisionTeamWorkspaceRequest,
  VerifyTeamWorkspaceRequest,
} from '../../application/workspace-ports.ts'
import { YuqiOrchestratorError } from '../../application/errors.ts'
import { WorkspaceId } from '../../domain/ids.ts'
import { directProjectIdentitySchema, teamWorkspaceSchema } from '../../domain/workspace.ts'
import type { ProjectIdentity, TeamWorkspace } from '../../domain/workspace.ts'

/**
 * Uses the selected project directory as the controller cwd. No `git`
 * executable is invoked and no Git identity is manufactured. The interface
 * remains compatible with the existing workspace coordinator so durable
 * journal/scheduler/lease code can be shared by both modes.
 */
export class DirectWorkspacePort implements GitWorkspacePort {
  async inspect(request: InspectGitProjectRequest): Promise<ProjectIdentity> {
    request.signal?.throwIfAborted()
    const projectRoot = await existingDirectory(request.projectRoot)
    const identity = directProjectIdentitySchema.parse({
      mode: 'direct',
      projectRoot,
      volumeRoot: path.parse(projectRoot).root,
      protectedRoots: await Promise.all(request.protectedRoots.map(normalizedPath)),
    })
    return identity as unknown as ProjectIdentity
  }

  async provision(request: ProvisionTeamWorkspaceRequest): Promise<TeamWorkspace> {
    request.signal?.throwIfAborted()
    const identity = directProjectIdentitySchema.parse(request.identity)
    const projectRoot = await existingDirectory(identity.projectRoot)
    if (!samePath(projectRoot, request.worktreePath)) {
      throw new YuqiOrchestratorError('UNSAFE_WORKSPACE_PATH', 'Direct mode must use the selected project directory as its workspace')
    }
    return workspace(identity, request.workspaceId, projectRoot)
  }

  async verify(request: VerifyTeamWorkspaceRequest): Promise<TeamWorkspace> {
    request.signal?.throwIfAborted()
    const candidate = request.workspace as unknown as { readonly project?: unknown; readonly status?: string; readonly worktreePath?: string; readonly workspaceId?: string }
    if (candidate.status !== 'ready') throw new YuqiOrchestratorError('WORKSPACE_CONFLICT', 'Only a durable ready workspace can be verified for execution')
    const identity = directProjectIdentitySchema.parse(candidate.project)
    const projectRoot = await existingDirectory(identity.projectRoot)
    if (!samePath(projectRoot, candidate.worktreePath ?? '')) {
      throw new YuqiOrchestratorError('UNSAFE_WORKSPACE_PATH', 'The direct workspace path no longer matches the project directory')
    }
    return workspace(identity, String(candidate.workspaceId), projectRoot)
  }
}

/** Routes durable workspace checks without making Git a prerequisite. */
export class WorkspacePortRouter implements GitWorkspacePort {
  constructor(private readonly git: GitWorkspacePort, private readonly direct: DirectWorkspacePort) {}

  inspect(request: InspectGitProjectRequest): Promise<ProjectIdentity> { return this.git.inspect(request) }

  provision(request: ProvisionTeamWorkspaceRequest): Promise<TeamWorkspace> {
    return isDirect(request.identity) ? this.direct.provision(request) : this.git.provision(request)
  }

  verify(request: VerifyTeamWorkspaceRequest): Promise<TeamWorkspace> {
    return isDirect((request.workspace as unknown as { readonly project?: unknown }).project)
      ? this.direct.verify(request)
      : this.git.verify(request)
  }
}

function workspace(identity: ReturnType<typeof directProjectIdentitySchema.parse>, workspaceId: string, projectRoot: string): TeamWorkspace {
  return teamWorkspaceSchema.parse({
    workspaceId: WorkspaceId(workspaceId),
    project: identity,
    worktreePath: projectRoot,
    branchName: 'direct',
    status: 'ready',
  })
}

async function existingDirectory(input: string): Promise<string> {
  try {
    await access(input)
    const resolved = path.resolve(await realpath(input))
    if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory')
    return resolved
  } catch (cause) {
    throw new YuqiOrchestratorError('UNSAFE_WORKSPACE_PATH', 'The selected project directory does not exist or cannot be resolved', { cause })
  }
}

async function normalizedPath(input: string): Promise<string> {
  try { return path.resolve(await realpath(input)) } catch { return path.resolve(input) }
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isDirect(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { readonly mode?: unknown }).mode === 'direct'
}
