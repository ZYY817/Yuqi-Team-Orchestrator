import type { TeamConsoleSummary } from '../domain/team-console-contract.ts'

/** A paused Team can only leave pause when the projection still has scheduler work. */
export function teamHasDispatchableWork(summary: Pick<TeamConsoleSummary, 'team' | 'tasks'>): boolean {
  const disposition = summary.team.resumeDisposition
  if (disposition !== undefined) return disposition === 'runnable' || disposition === 'completion-ready'
  const byId = new Map(summary.tasks.map(task => [task.taskId, task]))
  return summary.tasks.some(task => {
    if (task.status === 'ready') return true
    if (task.status !== 'pending') return false
    if (task.dependencyCount === 0) return true
    if (task.dependencies === undefined || task.dependencies.length !== task.dependencyCount) return false
    return task.dependencies.every(dependency => byId.get(dependency.taskId)?.status === 'completed')
  })
}

export function teamTaskActionTarget(summary: Pick<TeamConsoleSummary, 'tasks'>) {
  return summary.tasks.find(task => task.status === 'failed')
    ?? summary.tasks.find(task => task.status === 'blocked' || task.attemptStatus === 'unknown')
}
