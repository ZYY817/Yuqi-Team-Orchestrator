/** Translate one durable workspace between Git-repository and selected-project roots. */

import path from 'node:path'
import { YuqiOrchestratorError } from '../application/errors.ts'
import type { DirectProjectIdentity, ProjectIdentity, TeamWorkspace } from '../domain/workspace.ts'

/** Absolute execution root inside the Team worktree for the originally selected project. */
export function workspaceProjectRoot(workspace: TeamWorkspace): string {
  const project = workspace.project as unknown as ProjectIdentity | DirectProjectIdentity
  if (isDirectProject(project)) return path.resolve(workspace.worktreePath)
  const relative = safeProjectRelativePath(project as ProjectIdentity)
  return path.resolve(workspace.worktreePath, relative)
}

function isDirectProject(project: ProjectIdentity | DirectProjectIdentity): project is DirectProjectIdentity {
  return 'mode' in project && project.mode === 'direct'
}

/** Convert project-relative task scopes to the repository-relative paths emitted by Git. */
export function repositoryRelativeScopes(
  project: ProjectIdentity,
  scopes: readonly string[],
): readonly string[] {
  const relative = safeProjectRelativePath(project).split(path.sep).filter(Boolean).join('/')
  if (relative === '') return scopes
  return scopes.map(scope => `${relative}/${scope}`)
}

function safeProjectRelativePath(project: ProjectIdentity): string {
  const relative = path.relative(project.repositoryRoot, project.projectRoot)
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new YuqiOrchestratorError(
      'UNSAFE_WORKSPACE_PATH',
      'The selected project directory is outside its durable Git repository',
    )
  }
  return relative
}
